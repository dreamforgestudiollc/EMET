/**
 * Owl MCP clone account (R6).
 *
 * The account `user-EMET--owl` was a second OAuth client so an approval
 * queued by one grant could be decided by another client_id. R6 retires
 * that role. the owner decides a new writer on /owner/chooser. Master Hub
 * prepares the request. The server validates it. This account does not
 * approve.
 *
 * ISO 9001 7.5.3 / ISO 13485 4.2.5: supersede, retire, retain. Rows are
 * not deleted. A startup check fails loudly (stderr and the owl
 * retirement metric; the process does not exit) when an owl grant is
 * active again. Rotate-all (R5) already revokes every grant; the invite step
 * skips this account so a rotation does not hand it a fresh code. This
 * module does not call Railway EMET and does not run a rotation.
 */

import { COLLECTION_PREFIX } from './database.js';
import { assignCode, newCorrelationId } from './error-codes.js';
import { OWL_ACCOUNT, doorFromIssuedVia, grantIdFromFamily, logClientId, logDoor, logGrantId } from './grants.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const POINTER = 'this owl MCP clone account was retired by R6. A new writer is prepared by Master Hub, validated on the server, and decided by the owner at /owner/chooser. This account cannot approve. Records are retained.';
const MARKER_ID = 'owl-mcp-clone';

const metric = {
  ok: null,
  active: null,
  last_line: null,
  checked_at: null
};

export function _resetOwlForTests() {
  metric.ok = null;
  metric.active = null;
  metric.last_line = null;
  metric.checked_at = null;
}

export function owlRetirementMetric() {
  return {
    rung: 'R6',
    account: OWL_ACCOUNT,
    status: 'retired',
    retained: true,
    deleted: false,
    validator: 'server',
    decision_path: '/owner/chooser',
    ok: metric.ok,
    active: metric.active,
    last_line: metric.last_line,
    checked_at: metric.checked_at,
    since_process_start: true
  };
}

/** Exact account identity. A substring is not a match. */
export function isOwlIdentity(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value === OWL_ACCOUNT;
  if (typeof value !== 'object') return false;
  const fields = [
    value.clientId, value.client_id, value.sourceTag, value.source_tag,
    value.effectiveTag, value.client_name, value.clientName, value.tag
  ];
  return fields.some((field) => field === OWL_ACCOUNT);
}

function notRetired(doc) {
  return !(doc && (doc.superseded_by || doc.retired === true || doc.used === true));
}

function unexpired(doc, now) {
  const expMs = Number.isFinite(doc && doc.expiresAtMs)
    ? doc.expiresAtMs
    : (Number.isFinite(doc && doc.expiresAt) ? doc.expiresAt * 1000 : null);
  if (expMs == null) return true;
  return expMs > now;
}

async function readAll(db, name) {
  if (!db || typeof db.collection !== 'function') return [];
  try {
    const col = db.collection(name);
    if (!col || typeof col.find !== 'function') return [];
    const cursor = col.find({});
    if (!cursor || typeof cursor.toArray !== 'function') return [];
    return await cursor.toArray();
  } catch {
    return [];
  }
}

/**
 * The account id, plus any registered client whose name or id is that
 * account. A token may carry an opaque registration id.
 */
export async function owlClientIds(db, prefix = COLLECTION_PREFIX) {
  const ids = new Set([OWL_ACCOUNT]);
  const clients = await readAll(db, `${prefix}oauth_clients`);
  for (const client of clients) {
    if (client && isOwlIdentity(client) && typeof client.client_id === 'string' && client.client_id) {
      ids.add(client.client_id);
    }
  }
  return ids;
}

function rowIsOwl(doc, ids) {
  if (isOwlIdentity(doc)) return true;
  return typeof doc.client_id === 'string' && ids.has(doc.client_id);
}

/** Refused on use. A retired, superseded, or spent row is history and stays readable. */
export async function owlCredentialBlocked(db, prefix, doc) {
  if (!doc || typeof doc !== 'object' || !notRetired(doc)) return false;
  if (isOwlIdentity(doc)) return true;
  if (!db || typeof doc.client_id !== 'string' || !doc.client_id) return false;
  const ids = await owlClientIds(db, prefix);
  return ids.has(doc.client_id);
}

export async function listActiveOwlGrants(db, prefix = COLLECTION_PREFIX, now = Date.now()) {
  const ids = await owlClientIds(db, prefix);
  const rows = [
    ...(await readAll(db, `${prefix}oauth_tokens`)),
    ...(await readAll(db, `${prefix}oauth_codes`))
  ];
  return rows.filter((doc) => doc && notRetired(doc) && unexpired(doc, now) && rowIsOwl(doc, ids));
}

/**
 * One retained marker. Insert once. Later calls do not delete it and do
 * not clear a previous retirement. Historical grants are a different collection.
 */
export async function ensureOwlRetirementMarker(db, prefix = COLLECTION_PREFIX, now = new Date()) {
  if (!db || typeof db.collection !== 'function') return null;
  const col = db.collection(`${prefix}owl_retirement`);
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const existing = await col.findOne({ _id: MARKER_ID });
  if (existing) return existing;
  const row = {
    _id: MARKER_ID,
    account: OWL_ACCOUNT,
    status: 'retired',
    superseded_by: 'R6',
    rung: 'R6',
    retained: true,
    deleted: false,
    validator: 'server',
    decision_path: '/owner/chooser',
    at,
    note: 'Historical grants and logs stay readable. This marker does not delete them.'
  };
  await col.insertOne(row);
  return row;
}

export async function owlStartupCheck(db, prefix = COLLECTION_PREFIX, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  let active = [];
  let failed = false;
  try {
    await ensureOwlRetirementMarker(db, prefix, at);
    active = await listActiveOwlGrants(db, prefix, at.getTime());
  } catch {
    failed = true;
  }
  const ok = !failed && active.length === 0;
  const line = ok
    ? `[emet] owl-retirement check=pass account=${OWL_ACCOUNT} active=0 rung=R6`
    : `[emet] OWL RETIREMENT CHECK FAILED account=${OWL_ACCOUNT} active=${failed ? 'unknown' : active.length} rung=R6 pointer=/owner/chooser`;
  metric.ok = ok;
  metric.active = failed ? null : active.length;
  metric.last_line = line;
  metric.checked_at = at.toISOString();
  if (!ok) console.error(line);
  return {
    ok,
    active: failed ? null : active.length,
    line,
    grant_ids: active.map((doc) => logGrantId(grantIdFromFamily(doc && doc.family)))
  };
}

/**
 * Boot check for both entry points. Stdio (`index.js`) and the remote
 * server (`http-remote.js`) call this. It logs the check line and does
 * not exit. A failure is stderr plus `owlRetirementMetric`.
 */
export async function runStartupChecks(db, { prefix = COLLECTION_PREFIX, log } = {}) {
  const write = typeof log === 'function' ? log : console.error;
  let line;
  try {
    const owl = await owlStartupCheck(db, prefix);
    line = owl.line;
  } catch {
    line = `[emet] OWL RETIREMENT CHECK FAILED account=${OWL_ACCOUNT} active=unknown rung=R6 pointer=/owner/chooser`;
  }
  write(line);
  return { line, exited: false };
}

/** Log grant_id and correlation_id, then refuse. No token and no invite code. */
export async function refuseOwlCredential(doc, kind = 'access') {
  const correlation_id = newCorrelationId();
  const grant_id = logGrantId(grantIdFromFamily(doc && doc.family));
  const door = doorFromIssuedVia(doc && doc.issued_via) || 'unknown';
  console.error(`[emet] owl-retired grant_id=${grant_id} correlation_id=${correlation_id} pointer=/owner/chooser`);
  try {
    const { insertErrorLog } = await import('./error-log.js');
    await insertErrorLog({
      emet_code: 'EMET-AUTH-042',
      class_code: 'INTERNAL_ERROR',
      tool: kind === 'refresh' ? 'oauth_refresh' : (kind === 'code' || kind === 'issue' ? 'oauth_code' : 'oauth_access'),
      transport: 'http',
      caller: 'unregistered',
      role: 'guest',
      client_id: logClientId(doc && (doc.client_id || doc.clientId)),
      grant_id,
      door: logDoor(door),
      correlation_id
    });
  } catch {
    console.error('[emet] owl-retired error-log write failed');
  }
  const message = `${POINTER} grant_id: ${grant_id}. correlation_id: ${correlation_id}`;
  const err = kind === 'access' ? new InvalidTokenError(message) : new InvalidGrantError(message);
  err.correlation_id = correlation_id;
  err.grant_id = grant_id;
  throw assignCode(err, 'EMET-AUTH-042');
}
