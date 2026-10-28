/**
 * Break-glass recovery (R4b).
 *
 * One stable URL on Railway EMET: /owner/break-glass. The owner passphrase
 * session is the only credential. A member or guest grant does not open it,
 * and no AI client is required. Each authenticated use is logged and counted
 * on emet_status.break_glass.
 *
 * Revoke ends one grant through MongoOAuthProvider.revokeGrantById. That
 * door still deletes that one family. Rotate-all and per-member revoke are
 * separate confirmed actions on this page. They stamp and retain. Memory
 * rows already written stay.
 */

import express from 'express';
import { COLLECTION_PREFIX } from './database.js';
import { BREAK_GLASS, grantView, logGrantId } from './grants.js';
import { timingSafeEqualStr } from './oauth-provider.js';
import { noteBreakGlassUse, recordAccessDecision, breakGlassMetric } from './deep-links.js';
import { AuditOperation } from './logger.js';
import {
  noteRotationRefused, normalizeRotationRequest, describeRotation, commitRotation,
  rotationForms, rotationConfirmForm, rotationTriggerAllowed
} from './rotate.js';
import {
  esc, sendHtml, loginForm, mountOwnerLogin, createOwnerGate
} from './owner-session.js';

export { breakGlassMetric };

export const BREAK_GLASS_ACTION_MAX = 30;
const ACTION_WINDOW_MS = 15 * 60 * 1000;
const revocations = [];

export function retainedRevocations() {
  return revocations.map((row) => ({ ...row }));
}

export function _resetBreakGlassForTests() {
  revocations.length = 0;
  actionHits.clear();
}

const actionHits = new Map();

/**
 * The owner session is the credential. A guest or member grant is not.
 * presentedDoor is ignored on purpose: this page does not read a bearer.
 */
export function breakGlassAuthorized(session, presentedDoor = null) {
  if (presentedDoor === 'guest' || presentedDoor === 'member') return false;
  return !!(session && session.csrf);
}

function allowAction(id, now, max) {
  const t = now();
  const kept = (actionHits.get(id) || []).filter((ts) => t - ts < ACTION_WINDOW_MS);
  if (kept.length >= max) {
    actionHits.set(id, kept);
    const retryAfterS = Math.max(1, Math.ceil((kept[0] + ACTION_WINDOW_MS - t) / 1000));
    return { allowed: false, retryAfterS };
  }
  kept.push(t);
  actionHits.set(id, kept);
  return { allowed: true, retryAfterS: 0 };
}

function audit(logger, details) {
  if (logger && typeof logger.audit === 'function') {
    logger.audit(AuditOperation.BREAK_GLASS, details);
  }
}

async function listLiveGrants(db, prefix) {
  if (!db) return [];
  const rows = await db.collection(`${prefix}oauth_tokens`).find({}).toArray();
  const byFamily = new Map();
  for (const row of rows) {
    if (!row || row.superseded_by || row.retired === true) continue;
    const view = grantView(row);
    if (!view || !view.grant_id) continue;
    const prev = byFamily.get(view.grant_id);
    if (!prev || row.kind === 'access') byFamily.set(view.grant_id, view);
  }
  return [...byFamily.values()].sort((a, b) => String(a.grant_id).localeCompare(String(b.grant_id)));
}

function rememberRevocation(record) {
  revocations.push(record);
  if (revocations.length > 500) revocations.shift();
}

async function revokeOneGrant(provider, grantId) {
  const safe = logGrantId(grantId);
  if (safe === 'none' || grantId === 'unknown' || grantId === '*' || grantId === 'all') {
    return { ok: false, note: 'Name one grant. Rotate-all is a separate confirmed action.' };
  }
  if (!provider || typeof provider.revokeGrantById !== 'function') {
    return { ok: false, note: 'The store is unavailable. Nothing was revoked.' };
  }
  const result = await provider.revokeGrantById(safe);
  if (!result || !result.ok) {
    if (result && result.reason === 'missing') return { ok: false, note: 'That grant is not in the live set. Nothing was revoked.' };
    if (result && result.reason === 'unavailable') return { ok: false, note: 'The store is unavailable. Nothing was revoked.' };
    return { ok: false, note: 'Name one grant. Rotate-all is a separate confirmed action.' };
  }
  rememberRevocation({
    grant_id: result.grant_id,
    at: new Date().toISOString(),
    effect: 'revoked',
    door: result.door,
    retained: true,
    rung: 'R4'
  });
  return { ok: true, grant_id: result.grant_id, door: result.door };
}

function grantRows(grants, kept, csrf) {
  const live = grants.length
    ? `<table><thead><tr><th>Grant</th><th>Door</th><th>Client</th><th>Tag</th><th></th></tr></thead><tbody>
${grants.map((g) => `<tr><td><code>${esc(g.grant_id)}</code></td><td>${esc(g.door || '')}</td><td>${esc(g.client_id || '')}</td><td>${esc(g.source_tag || '')}</td><td>
<form method="post" action="/owner/break-glass/revoke">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="grant_id" value="${esc(g.grant_id)}">
<button type="submit">Revoke</button>
</form>
</td></tr>`).join('\n')}
</tbody></table>`
    : '<p>No live grants.</p>';
  const retained = kept.length
    ? `<ul>${kept.map((row) => `<li><code>${esc(row.grant_id)}</code> ${esc(row.effect)} ${esc(row.at)}</li>`).join('')}</ul>`
    : '<p>No retained revocations in this process.</p>';
  return `<h2>Live grants</h2>${live}<h2>Retained revocations</h2>${retained}`;
}

function panel(session, grants, kept, note, extraHtml = '') {
  const csrf = session.csrf;
  const body = grantRows(grants, kept, csrf);
  const noteHtml = note ? `<p class="note">${esc(note)}</p>` : '';
  return `${noteHtml}<h1>Break-glass</h1>
<p>Owner session only. Path <code>${esc(BREAK_GLASS.path)}</code>. This page does not accept a member or guest grant. Rotate-all is the confirmed section below.</p>
${body}
${rotationForms(csrf)}
<h2>Re-issue one door</h2>
<form method="post" action="/owner/break-glass/reissue">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Tag <input type="text" name="tag" maxlength="80"></label>
<label><input type="radio" name="door" value="guest" checked> Guest</label>
<label><input type="radio" name="door" value="member"> Member</label>
<label><input type="radio" name="door" value="owner"> Owner</label>
<button type="submit">Re-issue</button>
</form>
<h2>Clear a lockout</h2>
<form method="post" action="/owner/break-glass/clear">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Address <input type="text" name="ip" maxlength="80" placeholder="optional passphrase-form address"></label>
<button type="submit" name="scope" value="address">Clear that address</button>
<button type="submit" name="scope" value="tools">Clear tool lockout</button>
</form>
<p>The chooser is <a href="/owner/chooser">/owner/chooser</a>.</p>
${extraHtml || ''}`;
}

/**
 * @param {import('express').Express} app
 * @param {{ gate?: object, checkPassphrase?: Function, throttle?: object, ownerId?: string | Function, db?: object | Function, provider?: object, prefix?: string, rateLimiter?: object, logger?: object, now?: () => number, actionMax?: number }} options
 */
export function mountBreakGlass(app, options = {}) {
  const now = options.now || Date.now;
  const max = Number.isInteger(options.actionMax) && options.actionMax > 0 ? options.actionMax : BREAK_GLASS_ACTION_MAX;
  const gate = options.gate || createOwnerGate({
    checkPassphrase: options.checkPassphrase,
    throttle: options.throttle,
    now
  });
  mountOwnerLogin(app, gate);
  const parseBody = express.urlencoded({ extended: false });
  const prefix = typeof options.prefix === 'string' ? options.prefix : COLLECTION_PREFIX;
  const dbOf = () => (typeof options.db === 'function' ? options.db() : options.db);
  const depsOf = () => (typeof options.deps === 'function' ? options.deps() : (options.deps || null));

  async function resolveOwner() {
    try {
      const id = await (typeof options.ownerId === 'function' ? options.ownerId() : options.ownerId);
      return (typeof id === 'string' && id.trim()) || null;
    } catch { return null; }
  }

  function refuseGrant(res) {
    res.locals.reason = 'break_glass_owner_only';
    sendHtml(res, 401, `${loginForm('/owner/break-glass')}<p>A member or guest grant cannot open this page.</p>`, 'EMET break-glass');
  }

  async function render(req, res, note, count = true, extraHtml = '') {
    const session = gate.sessionOf(req);
    if (!breakGlassAuthorized(session)) {
      refuseGrant(res);
      return;
    }
    if (count) {
      const limit = allowAction(session.id, now, max);
      if (!limit.allowed) {
        noteBreakGlassUse('rate_limited', { decider: 'owner', grant_id: 'none' });
        res.locals.reason = 'break_glass_rate';
        res.setHeader('Retry-After', String(limit.retryAfterS));
        sendHtml(res, 429, '<p>Too many break-glass actions. Try again later.</p>', 'EMET break-glass');
        return;
      }
      const personId = await resolveOwner();
      noteBreakGlassUse('view', { decider: personId || 'owner', grant_id: 'none' });
      audit(options.logger, { action: 'view', grant_id: 'none', decider: personId || 'owner' });
    }
    let grants = [];
    let db = null;
    try { db = dbOf() || null; } catch { db = null; }
    try {
      grants = await listLiveGrants(db, prefix);
    } catch {
      res.locals.reason = 'grant_store';
      sendHtml(res, 503, '<p>The grant store is unavailable.</p>', 'EMET break-glass');
      return;
    }
    sendHtml(res, 200, panel(session, grants, retainedRevocations(), note, extraHtml), 'EMET break-glass');
  }

  function requireSession(req, res) {
    const session = gate.sessionOf(req);
    if (!breakGlassAuthorized(session)) {
      refuseGrant(res);
      return null;
    }
    const posted = (req.body && req.body.csrf) || '';
    if (!timingSafeEqualStr(posted, session.csrf)) {
      res.locals.reason = 'bad_csrf';
      sendHtml(res, 403, '<p>The form expired. Reload the page and try again.</p>', 'EMET break-glass');
      return null;
    }
    const limit = allowAction(session.id, now, max);
    if (!limit.allowed) {
      noteBreakGlassUse('rate_limited', { decider: 'owner', grant_id: 'none' });
      res.locals.reason = 'break_glass_rate';
      res.setHeader('Retry-After', String(limit.retryAfterS));
      sendHtml(res, 429, '<p>Too many break-glass actions. Try again later.</p>', 'EMET break-glass');
      return null;
    }
    return session;
  }

  app.get('/owner/break-glass', (req, res) => {
    render(req, res).catch((e) => {
      console.error('[emet] break-glass', e && e.message ? e.message : e);
      if (!res.headersSent) {
        res.locals.reason = 'break_glass_error';
        sendHtml(res, 500, '<p>Something went wrong.</p>', 'EMET break-glass');
      }
    });
  });

  app.post('/owner/break-glass/rotate-all', parseBody, (req, res) => {
    rotate(req, res, 'household').catch((e) => {
      console.error('[emet] rotate-all', e && e.message ? e.message : e);
      if (!res.headersSent) sendHtml(res, 500, '<p>Something went wrong. Nothing was revoked.</p>', 'EMET break-glass');
    });
  });

  app.post('/owner/break-glass/revoke-member', parseBody, (req, res) => {
    rotate(req, res, 'member').catch((e) => {
      console.error('[emet] revoke-member', e && e.message ? e.message : e);
      if (!res.headersSent) sendHtml(res, 500, '<p>Something went wrong. Nothing was revoked.</p>', 'EMET break-glass');
    });
  });

  app.post('/owner/break-glass/revoke', parseBody, (req, res) => {
    revoke(req, res).catch((e) => {
      console.error('[emet] break-glass revoke', e && e.message ? e.message : e);
      if (!res.headersSent) sendHtml(res, 500, '<p>Something went wrong. Nothing was revoked.</p>', 'EMET break-glass');
    });
  });

  app.post('/owner/break-glass/reissue', parseBody, (req, res) => {
    reissue(req, res).catch((e) => {
      console.error('[emet] break-glass reissue', e && e.message ? e.message : e);
      if (!res.headersSent) sendHtml(res, 500, '<p>Something went wrong. Nothing was issued.</p>', 'EMET break-glass');
    });
  });

  app.post('/owner/break-glass/clear', parseBody, (req, res) => {
    clearLockout(req, res).catch((e) => {
      console.error('[emet] break-glass clear', e && e.message ? e.message : e);
      if (!res.headersSent) sendHtml(res, 500, '<p>Something went wrong.</p>', 'EMET break-glass');
    });
  });

  async function revoke(req, res) {
    const session = requireSession(req, res);
    if (!session) return;
    const grantId = typeof (req.body && req.body.grant_id) === 'string' ? req.body.grant_id.trim() : '';
    if (grantId === '*' || grantId === 'all' || grantId === '') {
      const personId = await resolveOwner();
      noteBreakGlassUse('revoke_refused', { decider: personId || 'owner', grant_id: 'none' });
      res.locals.reason = 'not_rotate_all';
      sendHtml(res, 400, '<p>Name one grant. Rotate-all is a separate confirmed action. Nothing was revoked.</p>', 'EMET break-glass');
      return;
    }
    const personId = await resolveOwner();
    let result;
    try {
      result = await revokeOneGrant(options.provider, grantId);
    } catch {
      res.locals.reason = 'grant_store';
      sendHtml(res, 503, '<p>The grant store is unavailable. Nothing was revoked.</p>', 'EMET break-glass');
      return;
    }
    noteBreakGlassUse('revoke', { decider: personId || 'owner', grant_id: result.grant_id || grantId });
    recordAccessDecision({
      grant_id: result.grant_id || 'unknown',
      correlation_id: 'none',
      decider: personId || 'owner',
      decision: result.ok ? 'revoke' : 'revoke_refused',
      surface: 'break_glass',
      door: result.door || 'guest',
      tag: 'unknown',
      kind: 'break_glass',
      issued: false
    });
    audit(options.logger, { action: 'revoke', grant_id: logGrantId(result.grant_id || grantId), decider: personId || 'owner' });
    if (!result.ok) {
      res.locals.reason = 'revoke_refused';
      await render(req, res, result.note, false);
      return;
    }
    res.locals.reason = 'grant_revoked';
    await render(req, res, `Revoked ${result.grant_id}. The revocation is retained.`, false);
  }

  function rotationAudit(details) {
    if (options.logger && typeof options.logger.audit === 'function') {
      options.logger.audit(AuditOperation.ROTATE_ALL, details);
    }
  }

  async function rotate(req, res, kind) {
    const session = requireSession(req, res);
    if (!session) return;
    const authorization = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    if (!rotationTriggerAllowed({ session, authorization })) {
      const personId = await resolveOwner();
      noteRotationRefused('grant', personId);
      res.locals.reason = 'rotate_grant_refused';
      sendHtml(res, 403, '<p>An AI, member, or guest grant cannot rotate credentials. Nothing was revoked.</p>', 'EMET break-glass');
      return;
    }
    const personId = await resolveOwner();
    const scope = kind === 'member' ? 'member' : 'household';
    const spec = normalizeRotationRequest({
      scope,
      tag: req.body && req.body.tag,
      personId: req.body && req.body.person_id
    });
    if (!spec.ok) {
      noteRotationRefused(spec.reason || 'one_subject', personId);
      res.locals.reason = 'rotate_refused';
      sendHtml(res, 400, '<p>Name one member or bot. Nothing was revoked.</p>', 'EMET break-glass');
      return;
    }
    let db = null;
    try { db = dbOf() || null; } catch { db = null; }
    if (!db) {
      res.locals.reason = 'grant_store';
      sendHtml(res, 503, '<p>The store is unavailable. Nothing was revoked.</p>', 'EMET break-glass');
      return;
    }
    const expected = spec.scope === 'member' ? 'revoke-member' : 'rotate-all';
    const confirm = req.body && req.body.confirm;
    if (confirm !== expected) {
      const picture = await describeRotation({
        db, prefix, deps: depsOf(), scope: spec.scope, tag: spec.tag, personId: spec.personId
      });
      if (!picture.ok) {
        const text = picture.reason === 'owner_is_not_a_member'
          ? 'The owner is not a member. Nothing was revoked.'
          : 'Name one member or bot. Nothing was revoked.';
        noteRotationRefused(picture.reason || 'refused', personId);
        res.locals.reason = 'rotate_refused';
        sendHtml(res, 400, `<p>${esc(text)}</p>`, 'EMET break-glass');
        return;
      }
      const summary = `Review only. Nothing was revoked. Grants ${picture.grants}. Sub-keys ${picture.subkeys}. Sessions ${picture.sessions}. Subjects ${picture.subjects.length}.`;
      const fields = spec.scope === 'member'
        ? {
          tag: spec.tag || '',
          person_id: spec.personId || '',
          issue_invite: req.body && req.body.issue_invite === '1' ? '1' : ''
        }
        : {};
      res.locals.reason = 'rotate_review';
      await render(req, res, summary, false, rotationConfirmForm({
        csrf: session.csrf,
        action: spec.scope === 'member' ? '/owner/break-glass/revoke-member' : '/owner/break-glass/rotate-all',
        confirm: expected,
        fields
      }));
      return;
    }
    const result = await commitRotation({
      db,
      prefix,
      deps: depsOf(),
      scope: spec.scope,
      tag: spec.tag,
      personId: spec.personId,
      issueInvite: spec.scope === 'household' || (req.body && req.body.issue_invite === '1'),
      decider: personId || 'owner'
    });
    if (!result.ok) {
      const text = result.reason === 'owner_is_not_a_member'
        ? 'The owner is not a member. Nothing was revoked.'
        : 'Name one member or bot. Nothing was revoked.';
      noteRotationRefused(result.reason || 'refused', personId);
      res.locals.reason = 'rotate_refused';
      sendHtml(res, 400, `<p>${esc(text)}</p>`, 'EMET break-glass');
      return;
    }
    if (spec.scope === 'household' && typeof gate.endOtherSessions === 'function') gate.endOtherSessions(session.id);
    rotationAudit({
      scope: result.scope,
      decider: result.decider,
      correlation_id: result.correlation_id,
      revoked: result.revoked,
      invites: result.invites_issued
    });
    const shown = result.invites.map((row) => `${row.display_name || row.tag || row.person_id || 'member'} ${row.door} ${row.code}`).join('; ');
    const label = result.scope === 'household' ? 'Rotate-all' : 'Member revoke';
    res.locals.reason = 'rotated';
    await render(req, res, `${label} committed. correlation_id ${result.correlation_id}. revoked ${result.revoked}. invites ${result.invites_issued}. ${shown} Re-onboard: keyed link, owner sign-in, assign the tag, initialize via /owner/chooser.`, false);
  }

  async function reissue(req, res) {
    const session = requireSession(req, res);
    if (!session) return;
    const rawDoor = req.body && req.body.door;
    const door = rawDoor === 'owner' || rawDoor === 'member' ? rawDoor : 'guest';
    const tag = typeof (req.body && req.body.tag) === 'string' && req.body.tag.trim() ? req.body.tag.trim().slice(0, 80) : '';
    const personId = await resolveOwner();
    if (!personId) {
      sendHtml(res, 400, '<p>The owner id is unavailable. Nothing was issued.</p>', 'EMET break-glass');
      return;
    }
    if (door !== 'owner' && !tag) {
      sendHtml(res, 400, '<p>A tag is required for member or guest. Nothing was issued.</p>', 'EMET break-glass');
      return;
    }
    let note = 'Owner door is the passphrase consent on this host. This page did not mint a token.';
    let issued = false;
    if (door !== 'owner') {
      let db = null;
      try { db = dbOf() || null; } catch { db = null; }
      if (!db) note = 'The store is unavailable. Nothing was issued.';
      else {
        try {
          if (door === 'member') {
            const { createMemberAccess } = await import('./invites.js');
            const invite = await createMemberAccess(db, { created_by: personId, display_name: tag, source_tag: tag });
            issued = true;
            note = `Member code, shown once: ${invite.code}`;
          } else {
            const { createInvite } = await import('./invites.js');
            const invite = await createInvite(db, { created_by: personId, display_name: tag, source_tag: tag });
            issued = true;
            note = `Guest code, shown once: ${invite.code}`;
          }
        } catch (e) {
          if (e && e.code === 'INVITES_FROZEN') note = 'EMET Guest Access is off on this install. Nothing was issued.';
          else if (e && e.code === 'MEMBER_ACCESS_FROZEN') note = 'EMET Member Access is off on this install. Nothing was issued.';
          else note = 'That door did not issue a code. Nothing was issued.';
        }
      }
    }
    noteBreakGlassUse('reissue', { decider: personId, grant_id: 'none' });
    recordAccessDecision({
      grant_id: 'unknown',
      correlation_id: 'none',
      decider: personId,
      decision: 'reissue',
      surface: 'break_glass',
      door,
      tag: tag || 'unknown',
      kind: 'break_glass',
      issued
    });
    audit(options.logger, { action: 'reissue', door, decider: personId, issued });
    res.locals.reason = issued ? 'reissued' : 'reissue_recorded';
    await render(req, res, note, false);
  }

  async function clearLockout(req, res) {
    const session = requireSession(req, res);
    if (!session) return;
    const scope = req.body && req.body.scope;
    const personId = await resolveOwner();
    if (scope === 'tools') {
      const n = options.rateLimiter && typeof options.rateLimiter.clearToolLockout === 'function'
        ? options.rateLimiter.clearToolLockout()
        : 0;
      noteBreakGlassUse('clear_tool_lockout', { decider: personId || 'owner', grant_id: 'none' });
      recordAccessDecision({
        grant_id: 'unknown', correlation_id: 'none', decider: personId || 'owner',
        decision: 'clear_tool_lockout', surface: 'break_glass', kind: 'break_glass', issued: false
      });
      audit(options.logger, { action: 'clear_tool_lockout', decider: personId || 'owner', buckets: n });
      res.locals.reason = 'tool_lockout_cleared';
      await render(req, res, `Tool lockout cleared (${n}). Grants were not revoked.`, false);
      return;
    }
    const ip = typeof (req.body && req.body.ip) === 'string' ? req.body.ip.trim().slice(0, 80) : '';
    if (!ip || /[\r\n]/.test(ip)) {
      res.locals.reason = 'address_required';
      sendHtml(res, 400, '<p>Name one address. Nothing was cleared.</p>', 'EMET break-glass');
      return;
    }
    if (options.throttle && typeof options.throttle.clearAddress === 'function') options.throttle.clearAddress(ip);
    noteBreakGlassUse('clear_address', { decider: personId || 'owner', grant_id: 'none' });
    recordAccessDecision({
      grant_id: 'unknown', correlation_id: 'none', decider: personId || 'owner',
      decision: 'clear_address', surface: 'break_glass', kind: 'break_glass', issued: false
    });
    audit(options.logger, { action: 'clear_address', decider: personId || 'owner' });
    res.locals.reason = 'address_cleared';
    await render(req, res, 'Passphrase lockout cleared for that address.', false);
  }
}
