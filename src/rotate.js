/**
 * Household rotate-all (R5a) and per-member revoke (R5b).
 *
 * The owner passphrase session is the only trigger. An AI or MCP grant is
 * not a session. Confirm is a second step: a review post does not revoke.
 *
 * Revocation is a household generation plus a superseded_by pointer. Rows
 * stay. The 60-second refresh grace is not consulted once a credential is
 * inside this generation or marked superseded. Fresh invites are new rows.
 * An old grant is never made live again.
 *
 * Railway EMET checks the generation on the next token request. This module
 * does not call a deploy target.
 */

import { COLLECTION_PREFIX } from './database.js';
import { setting } from './env.js';
import { assignCode, newCorrelationId } from './error-codes.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { doorFromIssuedVia, grantIdFromFamily, logClientId, logDoor, logGrantId } from './grants.js';
import { isOwlIdentity } from './owl.js';
import { isBotTag } from './session-graph.js';
import { currentInstanceId, retireUnusedDeepLinks } from './deep-links.js';
import { esc } from './owner-session.js';

export const HOUSEHOLD_EPOCH_ID = 'household-epoch';
const ROTATIONS = 'rotations';
const LIVE_SUBKEY = new Set(['pending', 'approved', 'active', 'grace']);

const metric = {
  events: 0,
  last_at: null,
  last_correlation_id: null,
  last_decider: null,
  last_revoked: null,
  last_invites: null,
  last_scope: null
};

export function _resetRotationForTests() {
  metric.events = 0;
  metric.last_at = null;
  metric.last_correlation_id = null;
  metric.last_decider = null;
  metric.last_revoked = null;
  metric.last_invites = null;
  metric.last_scope = null;
}

export function rotateMetric() {
  return {
    rung: 'R5',
    path: '/owner/break-glass',
    grace_window_seconds: null,
    events: metric.events,
    last_at: metric.last_at,
    last_correlation_id: metric.last_correlation_id,
    last_decider: metric.last_decider,
    last_revoked: metric.last_revoked,
    last_invites: metric.last_invites,
    last_scope: metric.last_scope,
    since_process_start: true
  };
}

export function rotateStartupLine() {
  return `[emet] rotate-all path=/owner/break-glass rung=R5 events=${metric.events} grace_window_seconds=null`;
}

export function rotationTriggerAllowed({ session, authorization, door } = {}) {
  if (door === 'member' || door === 'guest' || door === 'owner') return false;
  if (typeof authorization === 'string' && /^bearer\s+\S+/i.test(authorization.trim())) return false;
  return !!(session && session.csrf);
}

function safeDecider(id) {
  const text = typeof id === 'string' && id.trim() ? id.trim() : 'owner';
  return text.replace(/[\r\n\s]+/g, '_').slice(0, 80);
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 80 || /[\r\n]/.test(text)) return null;
  return text;
}

/**
 * Member scope names one tag or one person. `*`, `all`, and the owner person
 * are not a member. Household scope ignores both fields.
 */
export function normalizeRotationRequest({ scope, tag, personId } = {}) {
  if (scope !== 'member') return { ok: true, scope: 'household', tag: null, personId: null };
  if (tag === '*' || tag === 'all' || personId === '*' || personId === 'all') {
    return { ok: false, reason: 'one_subject' };
  }
  const tagOk = cleanName(tag);
  const personOk = cleanName(personId);
  if ((typeof tag === 'string' && tag.trim() && !tagOk) || (typeof personId === 'string' && personId.trim() && !personOk)) {
    return { ok: false, reason: 'one_subject' };
  }
  if (!tagOk && !personOk) return { ok: false, reason: 'one_subject' };
  return { ok: true, scope: 'member', tag: tagOk, personId: personOk };
}

export async function currentHouseholdGeneration(db, prefix = COLLECTION_PREFIX) {
  if (!db || typeof db.collection !== 'function') return 0;
  const row = await db.collection(`${prefix}${ROTATIONS}`).findOne({ _id: HOUSEHOLD_EPOCH_ID });
  const n = row && row.generation;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * True when this stored credential must be refused. Reads the epoch every time.
 * The stamp and the generation are both load-bearing. A row the stamp missed
 * is still behind the epoch. A row at the current generation is still dead
 * when it carries superseded_by or retired. tests/rotate-r5.test.js fails if
 * the generation compare is removed or always false.
 */
export async function credentialBlocked(db, prefix, doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.superseded_by || doc.retired === true) return true;
  const generation = await currentHouseholdGeneration(db, prefix);
  if (!generation) return false;
  const tokenGen = Number.isInteger(doc.rotation_generation) ? doc.rotation_generation : 0;
  return tokenGen < generation;
}

const ROTATED_INTRO = 'this credential was revoked by rotation. Re-onboard: keyed link, owner sign-in, assign the tag, initialize via /owner/chooser. No grace window.';

/** Log grant_id and correlation_id, then refuse. The invite code is not logged. */
export async function refuseRotatedCredential(doc, kind = 'access') {
  const correlation_id = newCorrelationId();
  const grant_id = logGrantId(grantIdFromFamily(doc && doc.family));
  const door = doorFromIssuedVia(doc && doc.issued_via) || 'unknown';
  console.error(`[emet] credential-revoked grant_id=${grant_id} correlation_id=${correlation_id} reonboard=/owner/chooser`);
  try {
    const { insertErrorLog } = await import('./error-log.js');
    await insertErrorLog({
      emet_code: 'EMET-AUTH-041',
      class_code: 'INTERNAL_ERROR',
      tool: kind === 'refresh' ? 'oauth_refresh' : (kind === 'code' ? 'oauth_code' : 'oauth_access'),
      transport: 'http',
      caller: 'unregistered',
      role: 'guest',
      client_id: logClientId(doc && doc.client_id),
      grant_id,
      door: logDoor(door),
      correlation_id
    });
  } catch {
    console.error('[emet] credential-revoked error-log write failed');
  }
  const message = `${ROTATED_INTRO} grant_id: ${grant_id}. correlation_id: ${correlation_id}`;
  const err = assignCode(kind === 'access' ? new InvalidTokenError(message) : new InvalidGrantError(message), 'EMET-AUTH-041');
  err.correlation_id = correlation_id;
  err.grant_id = grant_id;
  throw err;
}

function noteCommitted(record) {
  metric.events += 1;
  metric.last_at = record.at;
  metric.last_correlation_id = record.correlation_id;
  metric.last_decider = record.decider;
  metric.last_revoked = record.revoked;
  metric.last_invites = record.invites_issued;
  metric.last_scope = record.scope;
  console.error(`[emet] rotate-all scope=${record.scope} decider=${record.decider} correlation_id=${record.correlation_id} revoked=${record.revoked} invites=${record.invites_issued}`);
}

export function noteRotationRefused(reason, decider) {
  const why = String(reason || 'refused').replace(/[^a-z_]/g, '').slice(0, 40) || 'refused';
  console.error(`[emet] rotate-all refused reason=${why} decider=${safeDecider(decider)}`);
}

function blankSubject() {
  return { tag: null, person_id: null, display_name: null, door: 'guest', writer: false };
}

function mergeSubject(subjects, key, fields) {
  const prev = subjects.get(key) || blankSubject();
  const writer = prev.writer || fields.writer || fields.door === 'member';
  subjects.set(key, {
    tag: fields.tag || prev.tag,
    person_id: fields.person_id || prev.person_id,
    display_name: fields.display_name || prev.display_name || fields.tag || fields.person_id || 'member',
    door: writer ? 'member' : 'guest',
    writer
  });
}

function consider(subjects, item) {
  const tag = cleanName(item.tag);
  const person_id = cleanName(item.person_id);
  const door = item.door === 'member' || item.door === 'guest' ? item.door : null;
  const bot = !!(tag && isBotTag(tag));
  const subkey = item.kind === 'subkey';
  const memberDoor = door === 'member' || door === 'guest';
  const personRow = item.kind === 'person';
  if (personRow && item.role === 'owner') return;
  if (!bot && !subkey && !memberDoor && !personRow) return;
  // An owner-door grant's subject is the owner, shared by every bot on that
  // login. The bot's identity is the tag. Only a member or guest door, or a
  // person row, binds person_id.
  const identityPerson = (memberDoor || personRow) ? person_id : null;
  let key = null;
  if (tag && (bot || subkey || memberDoor)) key = `tag:${tag}`;
  else if (identityPerson) key = `person:${identityPerson}`;
  if (!key) return;
  if (identityPerson) {
    for (const [existingKey, prev] of subjects) {
      if (prev.person_id === identityPerson && existingKey !== key) {
        const fields = {
          tag: tag || prev.tag,
          person_id: identityPerson,
          display_name: item.display_name || prev.display_name,
          door: door || prev.door,
          writer: bot || subkey || door === 'member' || prev.writer
        };
        subjects.delete(existingKey);
        if (existingKey.startsWith('tag:') && key.startsWith('person:')) key = existingKey;
        mergeSubject(subjects, key, fields);
        return;
      }
    }
  }
  mergeSubject(subjects, key, {
    tag,
    person_id: identityPerson,
    display_name: item.display_name || tag || identityPerson,
    door,
    writer: bot || subkey || door === 'member'
  });
}

function tokenInScope(row, spec) {
  if (spec.scope === 'household') return true;
  if (spec.tag && row.source_tag === spec.tag) return true;
  if (spec.personId && row.subject === spec.personId) return true;
  return false;
}

function inviteInScope(row, spec) {
  if (spec.scope === 'household') return true;
  if (spec.tag && row.source_tag === spec.tag) return true;
  if (spec.personId && row.person_id === spec.personId) return true;
  return false;
}

async function readAll(db, name) {
  const col = db.collection(name);
  if (!col || typeof col.find !== 'function') return [];
  const cursor = col.find({});
  if (!cursor || typeof cursor.toArray !== 'function') return [];
  return cursor.toArray();
}

async function subkeyPicture(deps) {
  if (setting('SUBKEYS') !== '1') return { keys: {}, sessions: [], skipped: true };
  try {
    const { loadSubkeyRecords } = await import('./subkeys.js');
    const snap = await loadSubkeyRecords(deps || {});
    return { keys: (snap && snap.keys) || {}, sessions: (snap && snap.sessions) || [], skipped: false };
  } catch {
    return { keys: {}, sessions: [], skipped: false, unavailable: true };
  }
}

async function loadPicture(db, prefix, spec, deps) {
  const tokens = await readAll(db, `${prefix}oauth_tokens`);
  const codes = await readAll(db, `${prefix}oauth_codes`);
  const invites = await readAll(db, 'invites');
  const persons = await readAll(db, 'persons');
  const subkeys = await subkeyPicture(deps);
  const scopedTokens = tokens.filter((row) => row && tokenInScope(row, spec) && !row.superseded_by);
  const scopedCodes = codes.filter((row) => row && tokenInScope(row, spec) && !row.superseded_by);
  const grantIds = [...new Set(scopedTokens.map((row) => row.family).filter(Boolean))];
  const subjects = new Map();
  for (const row of scopedTokens) {
    consider(subjects, {
      kind: 'grant',
      tag: row.source_tag,
      person_id: row.subject,
      door: doorFromIssuedVia(row.issued_via),
      display_name: row.source_tag || row.subject
    });
  }
  for (const row of invites) {
    if (!row || row.used_at || row.retired_at || row.superseded_by) continue;
    if (!inviteInScope(row, spec)) continue;
    consider(subjects, {
      kind: 'grant',
      tag: row.source_tag,
      person_id: row.person_id,
      door: row.door === 'member' ? 'member' : 'guest',
      display_name: row.display_name || row.source_tag
    });
  }
  const tags = new Set();
  if (spec.scope === 'member' && spec.tag) tags.add(spec.tag);
  for (const row of scopedTokens) if (row.source_tag) tags.add(row.source_tag);
  for (const row of invites) {
    if (row && inviteInScope(row, spec) && row.source_tag) tags.add(row.source_tag);
  }
  const keyRows = Object.values(subkeys.keys || {});
  for (const row of keyRows) {
    if (!row || !row.tag) continue;
    if (spec.scope === 'member' && !tags.has(row.tag)) continue;
    if (!LIVE_SUBKEY.has(row.status)) continue;
    consider(subjects, { kind: 'subkey', tag: row.tag, door: 'member', display_name: row.tag });
  }
  for (const person of persons) {
    if (!person || person.role !== 'member') continue;
    if (spec.scope === 'member' && spec.personId && person.person_id !== spec.personId) continue;
    if (spec.scope === 'member' && !spec.personId) continue;
    consider(subjects, {
      kind: 'person',
      role: person.role,
      person_id: person.person_id,
      door: person.door === 'member' ? 'member' : 'guest',
      display_name: person.display_name || person.person_id
    });
  }
  let sessions = 0;
  for (const row of subkeys.sessions || []) {
    if (!row || (row.state !== 'live' && row.state !== 'opening')) continue;
    if (spec.scope === 'member') {
      const key = keyRows.find((item) => item && item.key_id === row.key_id);
      if (!key || !tags.has(key.tag)) continue;
    }
    sessions += 1;
  }
  const liveSubkeys = keyRows.filter((row) => {
    if (!row || !LIVE_SUBKEY.has(row.status)) return false;
    if (spec.scope === 'member' && !tags.has(row.tag)) return false;
    return true;
  }).length;
  return {
    tokenIds: scopedTokens.map((row) => row._id).filter((id) => id != null),
    codeIds: scopedCodes.map((row) => row._id).filter((id) => id != null),
    grantIds,
    subjects: [...subjects.values()],
    subkeys: liveSubkeys,
    sessions,
    subkeysUnavailable: subkeys.unavailable === true,
    tagSet: spec.scope === 'household' ? null : tags
  };
}

async function ownerPersonRefused(db, spec) {
  if (spec.scope !== 'member' || !spec.personId) return false;
  const person = await db.collection('persons').findOne({ person_id: spec.personId });
  return !!(person && person.role === 'owner');
}

export async function describeRotation({ db, prefix = COLLECTION_PREFIX, deps = null, scope, tag, personId } = {}) {
  if (!db) return { ok: false, reason: 'unavailable' };
  const spec = normalizeRotationRequest({ scope, tag, personId });
  if (!spec.ok) return spec;
  if (await ownerPersonRefused(db, spec)) return { ok: false, reason: 'owner_is_not_a_member' };
  const picture = await loadPicture(db, prefix, spec, deps);
  return {
    ok: true,
    scope: spec.scope,
    grants: picture.grantIds.length,
    subkeys: picture.subkeys,
    sessions: picture.sessions,
    subjects: picture.subjects.map((row) => ({
      tag: row.tag,
      person_id: row.person_id,
      door: row.door,
      display_name: row.display_name
    })),
    subkeys_unavailable: picture.subkeysUnavailable
  };
}

export async function commitRotation({
  db,
  prefix = COLLECTION_PREFIX,
  deps = null,
  scope,
  tag,
  personId,
  issueInvite = true,
  decider,
  correlationId,
  now = new Date()
} = {}) {
  if (!db) return { ok: false, reason: 'unavailable' };
  const spec = normalizeRotationRequest({ scope, tag, personId });
  if (!spec.ok) return spec;
  if (await ownerPersonRefused(db, spec)) return { ok: false, reason: 'owner_is_not_a_member' };
  const picture = await loadPicture(db, prefix, spec, deps);
  const at = now instanceof Date ? now : new Date(now);
  const atIso = at.toISOString();
  const eventId = newCorrelationId();
  const correlation_id = typeof correlationId === 'string' && /^[0-9a-f]{16}$/.test(correlationId) ? correlationId : newCorrelationId();
  const who = safeDecider(decider);
  const event = {
    _id: eventId,
    kind: 'rotation_event',
    scope: spec.scope,
    status: 'committed',
    at: atIso,
    at_ms: at.getTime(),
    decider: who,
    correlation_id,
    tag: spec.tag,
    person_id: spec.personId,
    grant_ids: picture.grantIds,
    superseded_pointer: eventId,
    retained: true,
    deleted: false,
    grace_window_seconds: null
  };
  const { openRotationEvent, finishRotationEvent } = await import('./oauth-provider.js');
  await openRotationEvent(db, prefix, {
    event,
    epochId: HOUSEHOLD_EPOCH_ID,
    household: spec.scope === 'household',
    epochSet: {
      kind: 'household_epoch',
      status: 'committed',
      at: atIso,
      at_ms: at.getTime(),
      event_id: eventId,
      decider: who,
      correlation_id
    },
    tokenIds: picture.tokenIds,
    codeIds: picture.codeIds,
    at: atIso
  });
  let subkeys = { revoked: 0, sessions: 0, unavailable: picture.subkeysUnavailable };
  try {
    const { retireSubkeysForRotation } = await import('./subkeys.js');
    subkeys = await retireSubkeysForRotation(deps, {
      eventId,
      tags: spec.scope === 'household' ? null : picture.tagSet,
      now: at
    });
  } catch {
    subkeys = { revoked: 0, sessions: 0, unavailable: true };
  }
  const deepLinks = retireUnusedDeepLinks(eventId, spec.scope === 'household'
    ? { all: true }
    : { tag: spec.tag, grantIds: picture.grantIds }, at.getTime());
  const { retireUnusedInvites, createRotationInvite } = await import('./invites.js');
  const retiredInvites = await retireUnusedInvites(db, {
    eventId,
    at: atIso,
    household: spec.scope === 'household',
    tag: spec.tag,
    personId: spec.personId
  });
  const invites = [];
  let inviteFailures = 0;
  if (issueInvite !== false) {
    for (const subject of picture.subjects) {
      if (isOwlIdentity({ source_tag: subject.tag, tag: subject.tag })) continue;
      try {
        const made = await createRotationInvite(db, {
          created_by: who,
          display_name: subject.display_name,
          door: subject.door === 'member' ? 'member' : 'guest',
          source_tag: subject.tag,
          instance_id: currentInstanceId(),
          rotation_event_id: eventId
        });
        invites.push({
          tag: subject.tag,
          person_id: subject.person_id,
          door: made.door,
          display_name: made.display_name,
          code: made.code
        });
      } catch {
        inviteFailures += 1;
      }
    }
  }
  const revoked = picture.grantIds.length + (subkeys.revoked || 0) + (subkeys.sessions || 0) + deepLinks + retiredInvites;
  const record = {
    at: atIso,
    scope: spec.scope,
    decider: who,
    correlation_id,
    revoked,
    invites_issued: invites.length
  };
  await finishRotationEvent(db, prefix, eventId, {
    revoked_grants: picture.grantIds.length,
    revoked_subkeys: subkeys.revoked || 0,
    revoked_sessions: subkeys.sessions || 0,
    revoked_deep_links: deepLinks,
    retired_invites: retiredInvites,
    invites_issued: invites.length,
    invite_failures: inviteFailures,
    invite_subjects: picture.subjects.map((row) => row.tag || row.person_id),
    subkeys_unavailable: subkeys.unavailable === true,
    revoked
  });
  noteCommitted(record);
  return {
    ok: true,
    event_id: eventId,
    correlation_id,
    decider: who,
    scope: spec.scope,
    revoked,
    revoked_grants: picture.grantIds.length,
    revoked_subkeys: subkeys.revoked || 0,
    revoked_sessions: subkeys.sessions || 0,
    revoked_deep_links: deepLinks,
    retired_invites: retiredInvites,
    invites_issued: invites.length,
    invite_failures: inviteFailures,
    grant_ids: picture.grantIds,
    subjects: picture.subjects.map((row) => ({ tag: row.tag, person_id: row.person_id, door: row.door })),
    invites
  };
}

export function rotationForms(csrf) {
  const token = esc(csrf);
  return `<h2>Rotate every credential</h2>
<p>Owner session only. An AI client, a member grant, and a guest grant cannot run this. Review does not revoke. Confirming revokes every grant, sub-key, sub-key session, and unused deep link immediately. There is no grace window. Each known bot or member receives one new invite. Old grants stay retired.</p>
<form method="post" action="/owner/break-glass/rotate-all">
<input type="hidden" name="csrf" value="${token}">
<button type="submit" name="stage" value="review">Review rotate-all</button>
</form>
<h2>Revoke one member or bot</h2>
<form method="post" action="/owner/break-glass/revoke-member">
<input type="hidden" name="csrf" value="${token}">
<label>Tag <input type="text" name="tag" maxlength="80" autocomplete="off"></label>
<label>Person <input type="text" name="person_id" maxlength="80" autocomplete="off"></label>
<label><input type="checkbox" name="issue_invite" value="1"> Issue one fresh invite for that member</label>
<button type="submit" name="stage" value="review">Review revoke</button>
</form>`;
}

export function rotationConfirmForm({ csrf, action, confirm, fields = {} }) {
  const hidden = Object.entries(fields)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`)
    .join('');
  return `<form method="post" action="${esc(action)}">
<input type="hidden" name="csrf" value="${esc(csrf)}">
${hidden}
<button type="submit" name="confirm" value="${esc(confirm)}">Confirm</button>
</form>`;
}
