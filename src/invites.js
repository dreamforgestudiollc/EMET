import crypto from 'crypto';
import { slugPersonId } from './persons.js';
import { setting } from './env.js';

const COLLECTION = 'invites';

export function inviteDigest(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

export function mintInviteCode() {
  return crypto.randomBytes(16).toString('hex');
}

/** Off unless EMET_INVITES=1. Single-person assistant installs stay off.
 *  Household or project installs that are meant to be shared turn it on. */
export const INVITES_FROZEN = setting('INVITES') !== '1';
export const INVITES_FROZEN_REASON =
  'EMET Guest Access is off on this install. It is the door for a second person with read access to a household or project store. A single-person assistant store stays private. EMET Member Access is a different door, a second person with the owner\u2019s access, and it is not available unless EMET_MEMBER_ACCESS=1. A later shared space is separate and does not copy a personal EMET into the room.';

/** Off unless EMET_MEMBER_ACCESS=1. Separate from guest access. */
export const MEMBER_ACCESS_FROZEN = setting('MEMBER_ACCESS') !== '1';
export const MEMBER_ACCESS_FROZEN_REASON =
  'EMET Member Access is off on this install. It is a different door from EMET Guest Access: a one-time code for a new person with read and write access, never the owner identity. A single-person assistant store stays private.';
export const MEMBER_SCOPES = Object.freeze(['emet.read', 'emet.write']);
/** Both doors shut: the refusal names both, and how each is turned on. */
export const DOORS_FROZEN_REASON =
  'Both doors for a second person are off on this install: EMET Guest Access (read access; turned on with EMET_INVITES=1) and EMET Member Access (read and write access, never the owner; turned on with EMET_MEMBER_ACCESS=1). A single-person assistant store stays private.';

export async function createInvite(db, { created_by, display_name, scopes = ['emet.read'], days = 14, source_tag = null } = {}) {
  if (INVITES_FROZEN) {
    const err = new Error(INVITES_FROZEN_REASON);
    err.code = 'INVITES_FROZEN';
    throw err;
  }
  const requested = Array.isArray(scopes) && scopes.length ? scopes : ['emet.read'];
  if (requested.length !== 1 || requested[0] !== 'emet.read') {
    const err = new Error('A guest invite accepts only emet.read');
    err.code = 'GUEST_SCOPE';
    throw err;
  }
  const code = mintInviteCode();
  const now = Date.now();
  const row = {
    digest: inviteDigest(code),
    display_name: String(display_name || 'guest').trim() || 'guest',
    scopes: ['emet.read'],
    created_by: created_by || null,
    created_at: new Date(now),
    expires_at: new Date(now + Math.max(1, Number(days) || 14) * 86400000),
    used_at: null,
    person_id: null,
    door: 'guest',
    source_tag: source_tag || null
  };
  await db.collection(COLLECTION).insertOne(row);
  return { code, display_name: row.display_name, scopes: row.scopes, expires_at: row.expires_at, door: 'guest' };
}

export async function createMemberAccess(db, { created_by, display_name, days = 14, source_tag = null } = {}) {
  if (MEMBER_ACCESS_FROZEN) {
    const err = new Error(MEMBER_ACCESS_FROZEN_REASON);
    err.code = 'MEMBER_ACCESS_FROZEN';
    throw err;
  }
  const code = mintInviteCode();
  const now = Date.now();
  const row = {
    digest: inviteDigest(code),
    display_name: String(display_name || 'member').trim() || 'member',
    scopes: [...MEMBER_SCOPES],
    created_by: created_by || null,
    created_at: new Date(now),
    expires_at: new Date(now + Math.max(1, Number(days) || 14) * 86400000),
    used_at: null,
    person_id: null,
    door: 'member',
    source_tag: source_tag || null
  };
  await db.collection(COLLECTION).insertOne(row);
  return { code, display_name: row.display_name, scopes: row.scopes, expires_at: row.expires_at, door: 'member', source_tag: row.source_tag };
}

/**
 * A redeemed invite always gets a NEW person (multi-user report v2, defect 2,
 * 2026-10-01). Until then the guest's id was the slug of the display name the
 * invite carried, and an existing person with that slug was silently reused:
 * an invite named "Alex" (or "ALEX", "Alex!") redeemed as the owner, wrote as
 * the owner and passed the owner-only invite check. A display name is a label,
 * not a credential, so it never selects an existing identity:
 *   - the slug is a starting point; if any person already holds it, or it is a
 *     reserved subject ('owner', the legacy owner subject and slugPersonId's
 *     empty fallback), the next free `<slug>-2`, `<slug>-3`, ... is used;
 *   - an empty slug becomes 'guest'.
 * Disambiguating rather than refusing keeps a redeem from failing on a name the
 * guest cannot change; the owner sees the guest's own id in the persons
 * collection. Linking a second device to an existing member is a deliberate,
 * owner-side act for a later cut, never an inference from a name.
 */
export const RESERVED_PERSON_IDS = Object.freeze(['owner']);
export async function allocateGuestPersonId(persons, display_name) {
  const raw = String(display_name || '').trim();
  let base = slugPersonId(raw);
  if (base === 'owner' && !/owner/i.test(raw)) base = 'guest';
  base = base.slice(0, 36).replace(/-+$/, '') || 'guest';
  const taken = async (id) => RESERVED_PERSON_IDS.includes(id) || !!(await persons.findOne({ person_id: id }));
  if (!(await taken(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base}-${n}`;
    if (!(await taken(id))) return id;
  }
  throw new Error('could not allocate a person id for this invite');
}

function claimedRow(result) {
  if (!result) return null;
  if (Object.prototype.hasOwnProperty.call(result, 'value')) return result.value || null;
  return result;
}

export async function redeemInvite(db, code) {
  // Both doors shut: refuse before any lookup, so a frozen install never says whether a code exists.
  if (INVITES_FROZEN && MEMBER_ACCESS_FROZEN) return { ok: false, reason: 'frozen', message: DOORS_FROZEN_REASON };
  if (!code || !String(code).trim()) return { ok: false, reason: 'missing' };
  const col = db.collection(COLLECTION);
  const digest = inviteDigest(String(code).trim());
  const row = await col.findOne({ digest });
  if (!row) return { ok: false, reason: 'unknown' };
  const door = row.door === 'member' ? 'member' : 'guest';
  if (door === 'member' ? MEMBER_ACCESS_FROZEN : INVITES_FROZEN) {
    return { ok: false, reason: 'frozen', message: door === 'member' ? MEMBER_ACCESS_FROZEN_REASON : INVITES_FROZEN_REASON };
  }
  if (row.used_at) return { ok: false, reason: 'used' };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  // One winner. A second redeem that still sees the unread row loses the
  // conditional update and creates no person.
  const claimed = claimedRow(await col.findOneAndUpdate(
    { digest, used_at: null },
    { $set: { used_at: new Date() } }
  ));
  if (!claimed) return { ok: false, reason: 'used' };
  const persons = db.collection('persons');
  try { await persons.createIndex({ person_id: 1 }, { unique: true }); } catch { /* an index miss never blocks a redeem that can still insert */ }
  const scopes = door === 'member' ? [...MEMBER_SCOPES] : ['emet.read'];
  let person_id = null;
  let saved = false;
  for (let attempt = 0; attempt < 5 && !saved; attempt++) {
    person_id = await allocateGuestPersonId(persons, claimed.display_name || row.display_name);
    try {
      await persons.insertOne({
        person_id,
        display_name: claimed.display_name || row.display_name,
        role: 'member',
        // Which door created this person: 'guest' (EMET Guest Access) or 'member' (EMET Member Access).
        // Refresh checks the matching flag (oauth-provider.js _tokenDoor).
        door,
        created_at: new Date()
      });
      saved = true;
    } catch (e) {
      if (!(e && (e.code === 11000 || /duplicate/i.test(String(e.message || ''))))) throw e;
    }
  }
  if (!saved) throw new Error('could not allocate a person id for this invite');
  await col.updateOne({ digest }, { $set: { person_id } });
  return { ok: true, person_id, scopes, display_name: claimed.display_name || row.display_name, door, source_tag: claimed.source_tag || row.source_tag || null };
}
