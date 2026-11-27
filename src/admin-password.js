/**
 * Owner admin password for settings.
 *
 * This secret is not the connect passphrase. It has its own collection, its
 * own salt, and its own optional pepper (EMET_ADMIN_PEPPER). Nothing here
 * reads EMET_OAUTH_PASSPHRASE into the hash. Recovery takes a function for
 * the connect check so a connect passphrase can be refused without this
 * module importing the connect store.
 *
 * The hash, salt, and recovery-code hashes stay in owner_credentials. They
 * are not documents and they are not memory-layer rows.
 */

import crypto from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2';
import { setting } from './env.js';

export const ADMIN_CREDENTIALS_COLLECTION = 'owner_credentials';
export const ADMIN_CREDENTIAL_ID = 'admin';
export const ADMIN_PASSWORD_URL = '/owner/admin-password';

const PASS_MIN = 8;
const PASS_MAX = 200;
const RECOVERY_COUNT = 8;
const T = 2;
const M = 19456;
const P = 1;
const DK = 32;

let pepperWarned = false;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    try { crypto.timingSafeEqual(ab, Buffer.alloc(ab.length)); } catch { /* length already differs */ }
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Pepper for the admin hash. A pepper that matches the connect passphrase is ignored. */
export function adminPepper() {
  const pepper = setting('ADMIN_PEPPER') || '';
  const connect = setting('OAUTH_PASSPHRASE') || '';
  if (pepper && connect && safeEqual(pepper, connect)) {
    if (!pepperWarned) {
      pepperWarned = true;
      console.error('[emet] EMET_ADMIN_PEPPER matches the connect passphrase, so it is ignored');
    }
    return '';
  }
  return pepper;
}

function collection(db) {
  if (!db || typeof db.collection !== 'function') return null;
  return db.collection(ADMIN_CREDENTIALS_COLLECTION);
}

function passwordBytes(password, pepper) {
  const pw = Buffer.from(String(password), 'utf8');
  if (!pepper) return pw;
  return Buffer.concat([
    Buffer.from('emet-admin-v1\0', 'utf8'),
    Buffer.from(pepper, 'utf8'),
    Buffer.from('\0', 'utf8'),
    pw
  ]);
}

function lengthProblem(password, confirm) {
  const pass = typeof password === 'string' ? password : '';
  const again = typeof confirm === 'string' ? confirm : '';
  if (pass.length > PASS_MAX || again.length > PASS_MAX) return { ok: false, status: 400, reason: 'password_length' };
  if (pass.length < PASS_MIN) return { ok: false, status: 400, reason: 'password_length' };
  if (!safeEqual(pass, again)) return { ok: false, status: 400, reason: 'confirm' };
  return null;
}

async function hashPassword(password, pepper) {
  const salt = crypto.randomBytes(16);
  const hash = Buffer.from(await argon2idAsync(passwordBytes(password, pepper), salt, { t: T, m: M, p: P, dkLen: DK }));
  return {
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    t: T,
    m: M,
    p: P,
    dkLen: DK,
    peppered: Boolean(pepper)
  };
}

async function verifyHash(password, row) {
  if (!row || row.algorithm !== 'argon2id' || typeof row.hash !== 'string' || typeof row.salt !== 'string') return false;
  const pepper = row.peppered ? adminPepper() : '';
  if (row.peppered && !pepper) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(row.salt, 'hex');
    expected = Buffer.from(row.hash, 'hex');
  } catch {
    return false;
  }
  const dkLen = Number(row.dkLen) || DK;
  if (salt.length < 8 || expected.length !== dkLen || row.salt.length !== salt.length * 2 || row.hash.length !== expected.length * 2) return false;
  const hash = Buffer.from(await argon2idAsync(passwordBytes(password, pepper), salt, {
    t: Number(row.t) || T,
    m: Number(row.m) || M,
    p: Number(row.p) || P,
    dkLen
  }));
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(hash, expected);
}

function newRecoveryCodes() {
  const codes = [];
  const recovery = [];
  for (let i = 0; i < RECOVERY_COUNT; i++) {
    const code = crypto.randomBytes(16).toString('base64url');
    const salt = crypto.randomBytes(16);
    const hash = crypto.createHash('sha256').update(salt).update(Buffer.from(code, 'utf8')).digest('hex');
    codes.push(code);
    recovery.push({ salt: salt.toString('hex'), hash });
  }
  return { codes, recovery };
}

function recoveryIndex(proof, recovery) {
  if (!Array.isArray(recovery)) return -1;
  const text = Buffer.from(String(proof ?? ''), 'utf8');
  let found = -1;
  for (let i = 0; i < recovery.length; i++) {
    const row = recovery[i] || {};
    let salt;
    let expected;
    try {
      salt = Buffer.from(String(row.salt || ''), 'hex');
      expected = Buffer.from(String(row.hash || ''), 'hex');
    } catch {
      continue;
    }
    if (!salt.length || expected.length !== 32) continue;
    const hash = crypto.createHash('sha256').update(salt).update(text).digest();
    if (hash.length === expected.length && crypto.timingSafeEqual(hash, expected)) found = i;
  }
  return found;
}

function hostRecoveryToken() {
  const token = setting('ADMIN_RECOVERY') || '';
  const connect = setting('OAUTH_PASSPHRASE') || '';
  if (!token) return '';
  if (connect && safeEqual(token, connect)) return '';
  return token;
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(Buffer.from(String(token), 'utf8')).digest('hex');
}

async function writeCredential(col, prior, hashed, recovery, extra = {}) {
  const now = new Date();
  const version = prior && prior.hash ? (Number(prior.version) || 1) + 1 : 1;
  const doc = {
    algorithm: 'argon2id',
    ...hashed,
    recovery,
    version,
    consumed_host_recovery: Array.isArray(prior && prior.consumed_host_recovery) ? prior.consumed_host_recovery : [],
    created_at: (prior && prior.created_at) || now,
    rotated_at: prior && prior.hash ? now : null,
    ...extra
  };
  if (prior) {
    await col.updateOne({ _id: ADMIN_CREDENTIAL_ID }, { $set: doc });
  } else {
    await col.insertOne({ _id: ADMIN_CREDENTIAL_ID, ...doc });
  }
  return doc;
}

export async function adminPasswordIsSet(db) {
  const col = collection(db);
  if (!col) return false;
  const row = await col.findOne({ _id: ADMIN_CREDENTIAL_ID });
  return Boolean(row && typeof row.hash === 'string' && row.hash.length > 0);
}

/** The version stamped on owner console sessions. 0 when no password is set. */
export async function adminPasswordVersion(db) {
  const col = collection(db);
  if (!col) return 0;
  const row = await col.findOne({ _id: ADMIN_CREDENTIAL_ID });
  if (!row || typeof row.hash !== 'string' || !row.hash) return 0;
  const version = Number(row.version);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

let afterAdminPasswordChange = async () => {};

/** The HTTP host registers this. It ends owner console sessions. This file does not import that store. */
export function setAdminPasswordRotatedHook(fn) {
  afterAdminPasswordChange = typeof fn === 'function' ? fn : async () => {};
}

async function endOwnerConsole(db) {
  try { await afterAdminPasswordChange(db); }
  catch (err) {
    console.error('[emet] console sessions were not cleared', err && err.message ? err.message : err);
  }
}

/** Boolean and URL only. The hash, salt, pepper, and codes are not included. */
export async function adminPasswordPublicStatus(db) {
  return {
    admin_password_set: await adminPasswordIsSet(db),
    admin_password_url: ADMIN_PASSWORD_URL
  };
}

export async function verifyAdminPassword(db, password) {
  const text = typeof password === 'string' ? password : '';
  if (text.length < PASS_MIN || text.length > PASS_MAX) return false;
  const col = collection(db);
  if (!col) return false;
  const row = await col.findOne({ _id: ADMIN_CREDENTIAL_ID });
  if (!row) return false;
  try { return await verifyHash(text, row) === true; }
  catch { return false; }
}

export async function createAdminPassword(db, password, confirm) {
  const col = collection(db);
  if (!col) return { ok: false, status: 503, reason: 'store_unavailable' };
  const existing = await col.findOne({ _id: ADMIN_CREDENTIAL_ID });
  if (existing && existing.hash) return { ok: false, status: 409, reason: 'already_set' };
  const problem = lengthProblem(password, confirm);
  if (problem) return problem;
  const { codes, recovery } = newRecoveryCodes();
  try {
    await writeCredential(col, null, await hashPassword(password, adminPepper()), recovery);
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, status: 409, reason: 'already_set' };
    throw err;
  }
  return { ok: true, status: 200, recovery_codes: codes };
}

export async function rotateAdminPassword(db, current, password, confirm) {
  const col = collection(db);
  if (!col) return { ok: false, status: 503, reason: 'store_unavailable' };
  const existing = await col.findOne({ _id: ADMIN_CREDENTIAL_ID });
  if (!existing || !existing.hash) return { ok: false, status: 409, reason: 'unset' };
  if (!await verifyAdminPassword(db, current)) return { ok: false, status: 401, reason: 'bad_password' };
  const problem = lengthProblem(password, confirm);
  if (problem) return problem;
  const { codes, recovery } = newRecoveryCodes();
  await writeCredential(col, existing, await hashPassword(password, adminPepper()), recovery);
  await endOwnerConsole(db);
  return { ok: true, status: 200, recovery_codes: codes };
}

/**
 * Replace the admin password with a recovery code or the host recovery token.
 * A proof that satisfies the connect passphrase is refused before either of
 * those checks can succeed.
 */
export async function recoverAdminPassword(db, { proof, password, confirm, connectPassphrase } = {}) {
  const col = collection(db);
  if (!col) return { ok: false, status: 503, reason: 'store_unavailable' };
  const presented = typeof proof === 'string' ? proof : '';
  let connect = false;
  try { connect = typeof connectPassphrase === 'function' && connectPassphrase(presented) === true; }
  catch { connect = false; }
  if (connect) return { ok: false, status: 401, reason: 'connect_passphrase_rejected' };
  const problem = lengthProblem(password, confirm);
  if (problem) return problem;
  const existing = await col.findOne({ _id: ADMIN_CREDENTIAL_ID });
  const host = hostRecoveryToken();
  let viaHost = false;
  if (host && safeEqual(presented, host)) {
    const digest = tokenDigest(host);
    const used = existing && Array.isArray(existing.consumed_host_recovery) ? existing.consumed_host_recovery : [];
    if (used.includes(digest)) return { ok: false, status: 401, reason: 'recovery_used' };
    viaHost = true;
  }
  const index = viaHost ? -1 : recoveryIndex(presented, existing && existing.recovery);
  if (!viaHost && index < 0) return { ok: false, status: 401, reason: 'bad_recovery' };
  const { codes, recovery } = newRecoveryCodes();
  const extra = {};
  if (viaHost) {
    const digest = tokenDigest(host);
    const used = existing && Array.isArray(existing.consumed_host_recovery) ? existing.consumed_host_recovery.slice() : [];
    used.push(digest);
    extra.consumed_host_recovery = used;
  }
  await writeCredential(col, existing, await hashPassword(password, adminPepper()), recovery, extra);
  await endOwnerConsole(db);
  return { ok: true, status: 200, recovery_codes: codes, via: viaHost ? 'host' : 'code' };
}

/** Stdio, a bearer, and a connect passphrase are not an admin session. */
export function transportIsAdminSession() {
  return false;
}
