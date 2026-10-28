/**
 * Door grants (R2 design scaffolding, 2026-10-26).
 *
 * A grant is one OAuth consent: the token `family` already minted in
 * oauth-provider.js. This module names that id and the three doors. It does
 * not issue or revoke tokens, and it does not decide who may write.
 *
 * Rotate-all (R5) is implemented beside break-glass. The owl MCP clone
 * account (R6) is retired and retained. Its wiring stays so a later rung
 * cannot delete that record in silence. Claude/ChatGPT write-versus-guest
 * is open; this file does not pick it.
 */

export const DOORS = Object.freeze(['owner', 'member', 'guest']);

/** Stored `issued_via` values. Guest keeps the historical marker `invite`. */
export const ISSUED_VIA = Object.freeze({
  owner: 'owner',
  member: 'member',
  guest: 'invite'
});

/**
 * Door of a stored token. Null means the row has no door marker (legacy).
 * Do not guess owner from a missing field: older passphrase tokens omitted it.
 */
export function doorFromIssuedVia(issuedVia) {
  if (issuedVia === ISSUED_VIA.member) return 'member';
  if (issuedVia === ISSUED_VIA.guest) return 'guest';
  if (issuedVia === ISSUED_VIA.owner) return 'owner';
  return null;
}

/** The grant id is the token family. Blank is not a grant. Never minted here. */
export function grantIdFromFamily(family) {
  if (typeof family !== 'string') return null;
  const id = family.trim();
  return id || null;
}

/** Door copied onto an HTTP actor. Stdio is not an HTTP door. */
export function httpDoor(door) {
  if (door === 'owner' || door === 'member' || door === 'guest') return door;
  return null;
}

/** A family is randTok(16): 22 base64url characters. A bearer is longer, so it cannot be stored as a grant id. */
const GRANT_RE = /^[A-Za-z0-9_-]{1,22}$/;
const CLIENT_RE = /^[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{1,200}$/;

/** Log-safe grant id. Anything else, including a bearer, becomes `none`. */
export function logGrantId(id) {
  return typeof id === 'string' && GRANT_RE.test(id) ? id : 'none';
}

/** Log-safe client id. Stdio is kept. Anything else unrecognised is `unknown`. */
export function logClientId(id) {
  if (id === 'stdio') return 'stdio';
  if (typeof id === 'string' && CLIENT_RE.test(id) && !/\s/.test(id)) return id;
  return 'unknown';
}

/** Log-safe door. Null and anything off the list are `unknown`. */
export function logDoor(door) {
  if (door === 'owner' || door === 'member' || door === 'guest' || door === 'stdio') return door;
  return 'unknown';
}

/**
 * Read-only view of one token row for a diagnostic. No token, digest, or
 * secret. R2 does not list a household; a caller sees their own grant on
 * emet_initialize. A household listing is a later owner-only tool.
 */
export function grantView(tokenRow) {
  if (!tokenRow || typeof tokenRow !== 'object') return null;
  return {
    grant_id: grantIdFromFamily(tokenRow.family),
    client_id: typeof tokenRow.client_id === 'string' ? tokenRow.client_id : null,
    door: doorFromIssuedVia(tokenRow.issued_via),
    source_tag: typeof tokenRow.source_tag === 'string' ? tokenRow.source_tag : null
  };
}

/**
 * Identity fields for an audit line. Sanitized. Not a token.
 * @param {{ clientId?: string, grantId?: string, door?: string }} actor
 */
export function auditIdentity(actor) {
  const a = actor && typeof actor === 'object' ? actor : {};
  return {
    client_id: logClientId(a.clientId),
    grant_id: logGrantId(a.grantId),
    door: logDoor(a.transport === 'http' ? a.door : (a.transport === 'stdio' ? 'stdio' : a.door))
  };
}

/**
 * TOOL_CALL audit details. Identity is sanitized here so both transports
 * record the same fields. Parameter names only; never argument values.
 */
export function toolCallAuditDetails(actor, fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  return {
    tool: f.tool,
    success: f.success,
    durationMs: f.durationMs,
    params: f.params,
    ...auditIdentity(actor)
  };
}

/**
 * R5 rotate-all. Owner session only, with an explicit confirm.
 * grace_window_seconds is null on purpose: the owner locked revoke-all plus fresh
 * invites, with no grace window (2026-10-25). The 60-second refresh-rotation
 * grace in oauth-provider.js is a different control (one client lost one
 * refresh response). It is not a household grace and must not be reused as one.
 */
export const ROTATE_ALL = Object.freeze({
  rung: 'R5',
  implemented: true,
  grace_window_seconds: null,
  effect: 'revoke every grant and sub-key, then issue fresh invites',
  trigger: 'owner session',
  confirm: 'rotate-all',
  path: '/owner/break-glass/rotate-all'
});

/**
 * R5b. Revoke one member or one bot. Does not bump the household generation,
 * so every other credential keeps working. Same confirm rule, no grace.
 */
export const MEMBER_REVOKE = Object.freeze({
  rung: 'R5b',
  implemented: true,
  grace_window_seconds: null,
  effect: 'revoke one member or bot; leave every other credential working',
  trigger: 'owner session',
  confirm: 'revoke-member',
  path: '/owner/break-glass/revoke-member'
});

/** The owl MCP clone account. Exact string. A substring is not this account. */
export const OWL_ACCOUNT = 'user-EMET--owl';

/**
 * R6. The owl MCP clone account was a second OAuth client used only to get a
 * different client_id. R6 retires it. the owner decides a new writer on the
 * chooser. Master Hub prepares. The server validates. Rows stay.
 * delete_wiring stays false: the name and the historical grants are retained.
 */
export const OWL_KILL = Object.freeze({
  rung: 'R6',
  implemented: true,
  delete_wiring: false,
  account: OWL_ACCOUNT,
  status: 'retired',
  superseded_by: 'R6',
  retained: true,
  deleted: false,
  validator: 'server',
  decision_path: '/owner/chooser',
  path: 'refuse the owl MCP clone account; retain its grants and logs; the owner decides a new writer on /owner/chooser'
});

/**
 * R6a validator. The server-side check is what runs. the owner can later name
 * another existing reviewer credential. The owl account is not a choice.
 */
export const WRITER_VALIDATOR = Object.freeze({
  rung: 'R6a',
  implemented: 'server',
  alex_choice_open: true,
  options: Object.freeze(['server', 'existing-reviewer-credential']),
  not_an_option: OWL_ACCOUNT,
  note: 'The server-side check is what runs. the owner can later name another existing reviewer credential. The owl account is not a choice.'
});

/** Claude and ChatGPT: write-capable member or read-only guest. Not decided. */
export const CLAUDE_CHATGPT_DOOR = Object.freeze({
  decided: false,
  door: null
});

/**
 * The passphrase session is an owner factor, not a writer grant. It has no
 * grant id. R4 folds the decision page onto /owner/chooser. /owner/approvals
 * is retired and retained: it answers with a pointer and does not delete records.
 */
export const OWNER_PAGE = Object.freeze({
  is_grant: false,
  door: 'owner',
  grant_id: null,
  decision_path: '/owner/chooser',
  retired_path: '/owner/approvals'
});

/**
 * R4 deep link. Proposed lifetime is 15 minutes, for the owner to set.
 * EMET_DEEP_LINK_TTL_MINUTES may narrow that to 1–60. It does not grant a door.
 */
export const DEEP_LINK = Object.freeze({
  rung: 'R4',
  ttl_ms: 15 * 60 * 1000,
  ttl_proposal: '15 minutes, for the owner to set',
  single_use: true,
  instance_scoped: true,
  grants_access: false
});

/** R4 break-glass. Owner passphrase only. Not a member or guest grant. */
export const BREAK_GLASS = Object.freeze({
  rung: 'R4',
  path: '/owner/break-glass',
  owner_session_only: true,
  reachable_by_member_or_guest_grant: false
});

/**
 * The old owner-approvals path. Superseded, retired, retained.
 * Pending rows are listed on the chooser. They are not copied and not deleted.
 */
export const OWNER_APPROVALS_RETIRED = Object.freeze({
  rung: 'R4',
  status: 'retired',
  path: '/owner/approvals',
  superseded_by: '/owner/chooser',
  retained: true,
  deleted: false
});
