/**
 * HTTP pages for the admin password.
 *
 * Create, rotate, and recover happen here. The password is not an MCP
 * argument and it is not written into a document.
 */

import crypto from 'node:crypto';
import express from 'express';
import { esc, sendHtml, loginForm, clearOwnerCookie } from './owner-session.js';
import {
  ADMIN_PASSWORD_URL,
  adminPasswordIsSet,
  createAdminPassword,
  rotateAdminPassword,
  recoverAdminPassword
} from './admin-password.js';

const PASS_MIN = 8;

function dbOf(options) {
  try {
    const db = typeof options.db === 'function' ? options.db() : options.db;
    return db || null;
  } catch {
    return null;
  }
}

function connectCheck(provider) {
  return (input) => {
    try { return Boolean(provider && typeof provider.checkPassphrase === 'function' && provider.checkPassphrase(input) === true); }
    catch { return false; }
  };
}

function codesHtml(codes) {
  const items = (codes || []).map((code) => `<li><code>${esc(code)}</code></li>`).join('');
  return `<h2>Recovery codes</h2>
<p>Save these codes now. They are shown once. Each code can set a new admin password. The connect passphrase cannot.</p>
<ul>
${items}
</ul>`;
}

function proofConfigured(provider) {
  if (!provider) return false;
  if (typeof provider.passphrase === 'string' && provider.passphrase) return true;
  return Boolean(provider.passphraseVerifier);
}

function createForm(needsProof) {
  const proof = needsProof
    ? `<label>Connect passphrase <input type="password" name="connect_passphrase" autocomplete="current-password" required></label>
<p>This confirms the owner. It is not saved, and it is not the admin password. An owner Authorize access token in Authorization: Bearer is the same confirmation.</p>`
    : '';
  return `<h1>Admin password</h1>
<p>This password opens settings: the chooser, grants, approvals, and break-glass. The connect passphrase stays on the connect page. The two secrets are separate.</p>
<form method="post" action="${ADMIN_PASSWORD_URL}">
${proof}
<label>Admin password <input type="password" name="password" autocomplete="new-password" required></label>
<label>Confirm <input type="password" name="confirm" autocomplete="new-password" required></label>
<button type="submit">Save admin password</button>
</form>
<p>Recovery, after a password exists, is <a href="${ADMIN_PASSWORD_URL}/recover">${ADMIN_PASSWORD_URL}/recover</a>.</p>`;
}

function alreadySetBody() {
  return `<h1>Admin password</h1>
<p>An admin password is already set. Sign in on the chooser with that password. Changing it uses the current admin password. The connect passphrase stays where it is.</p>
<p><a href="/owner/chooser">Chooser</a></p>
<p><a href="${ADMIN_PASSWORD_URL}/rotate">Change the admin password</a></p>
<p><a href="${ADMIN_PASSWORD_URL}/recover">Use a recovery code</a></p>`;
}

function rotateForm(csrf) {
  return `<h1>Change the admin password</h1>
<p>The current admin password confirms the change. The connect passphrase is left as it is.</p>
<form method="post" action="${ADMIN_PASSWORD_URL}/rotate">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label>Current admin password <input type="password" name="current" autocomplete="current-password" required></label>
<label>New admin password <input type="password" name="password" autocomplete="new-password" required></label>
<label>Confirm <input type="password" name="confirm" autocomplete="new-password" required></label>
<button type="submit">Change admin password</button>
</form>`;
}

function recoverForm() {
  return `<h1>Recover the admin password</h1>
<p>Enter a recovery code from the page that created the admin password, or the host recovery token. Then choose a new admin password. The connect passphrase is refused here.</p>
<form method="post" action="${ADMIN_PASSWORD_URL}/recover">
<label>Recovery code <input type="password" name="proof" autocomplete="off" required></label>
<label>New admin password <input type="password" name="password" autocomplete="new-password" required></label>
<label>Confirm <input type="password" name="confirm" autocomplete="new-password" required></label>
<button type="submit">Set a new admin password</button>
</form>`;
}

function problemHtml(reason) {
  if (reason === 'store_unavailable') return '<p>The store is unavailable. Nothing was saved.</p>';
  if (reason === 'already_set') return alreadySetBody();
  if (reason === 'unset') return '<p>Set the admin password first. Nothing was changed.</p>';
  if (reason === 'confirm') return '<p>The admin password and the confirmation do not match. Nothing was saved.</p>';
  if (reason === 'password_length') return `<p>Choose an admin password of at least ${PASS_MIN} characters. Nothing was saved.</p>`;
  if (reason === 'bad_password') return '<p>The current admin password does not match. Nothing was changed.</p>';
  if (reason === 'connect_passphrase_rejected') return '<p>The connect passphrase does not recover the admin password. Nothing was changed.</p>';
  if (reason === 'bad_recovery') return '<p>That recovery code does not match. Nothing was changed.</p>';
  if (reason === 'recovery_used') return '<p>That host recovery token was already used. Nothing was changed.</p>';
  if (reason === 'form_expired') return '<p>The form expired. Sign in again. Nothing was changed.</p>';
  if (reason === 'owner_proof_required') return '<p>Confirm the owner with the connect passphrase or an owner Authorize token. That proof is not the admin password. Nothing was saved.</p>';
  if (reason === 'throttled') return '<p>Too many attempts. Try again later.</p>';
  return '<p>Something went wrong. Nothing was saved.</p>';
}

function savedHtml(intro, codes) {
  return `<h1>Admin password saved</h1>
<p>${intro}</p>
${codesHtml(codes)}
<p><a href="/owner/chooser">Sign in at the chooser</a></p>`;
}

/**
 * @param {import('express').Express} app
 * @param {{ db?: object | Function, gate?: object, throttle?: object, provider?: object }} options
 */
export function mountAdminPassword(app, options = {}) {
  const parseBody = express.urlencoded({ extended: false });
  const gate = options.gate;
  const throttle = options.throttle;
  const provider = options.provider;

  app.get(ADMIN_PASSWORD_URL, (req, res) => {
    showCreate(req, res).catch((e) => fail(res, e));
  });
  app.post(ADMIN_PASSWORD_URL, parseBody, (req, res) => {
    finishCreate(req, res).catch((e) => fail(res, e));
  });
  app.get(`${ADMIN_PASSWORD_URL}/rotate`, (req, res) => {
    showRotate(req, res);
  });
  app.post(`${ADMIN_PASSWORD_URL}/rotate`, parseBody, (req, res) => {
    finishRotate(req, res).catch((e) => fail(res, e));
  });
  app.get(`${ADMIN_PASSWORD_URL}/recover`, (_req, res) => {
    res.locals.reason = 'admin_recover_form';
    sendHtml(res, 200, recoverForm(), 'EMET admin password');
  });
  app.post(`${ADMIN_PASSWORD_URL}/recover`, parseBody, (req, res) => {
    finishRecover(req, res).catch((e) => fail(res, e));
  });

  function fail(res, e) {
    console.error('[emet] admin password', e && e.message ? e.message : e);
    if (!res.headersSent) {
      res.locals.reason = 'admin_password_error';
      sendHtml(res, 500, '<p>Something went wrong. Nothing was saved.</p>', 'EMET admin password');
    }
  }

  function limited(req, res) {
    if (!throttle) return false;
    const limit = throttle.check(req.ip);
    if (limit.allowed) return false;
    res.locals.reason = 'throttled';
    res.setHeader('Retry-After', String(limit.retryAfterS));
    sendHtml(res, 429, problemHtml('throttled'), 'EMET admin password');
    return true;
  }

  function noteAttempt(req, ok) {
    if (!throttle) return;
    if (ok) throttle.recordSuccess(req.ip);
    else throttle.recordFailure(req.ip);
  }

  async function showCreate(_req, res) {
    const db = dbOf(options);
    if (!db) {
      res.locals.reason = 'store_unavailable';
      sendHtml(res, 503, problemHtml('store_unavailable'), 'EMET admin password');
      return;
    }
    if (await adminPasswordIsSet(db)) {
      res.locals.reason = 'admin_password_set';
      sendHtml(res, 200, alreadySetBody(), 'EMET admin password');
      return;
    }
    res.locals.reason = 'admin_password_form';
    sendHtml(res, 200, createForm(true), 'EMET admin password');
  }

  async function ownerProof(req, body) {
    if (gate && typeof gate.sessionOf === 'function' && gate.sessionOf(req)) return true;
    // An unset connect passphrase is not proof. No owner session and no
    // presented secret refuses the create, and no recovery codes are minted.
    if (!proofConfigured(provider)) return false;
    const presented = typeof body.connect_passphrase === 'string' ? body.connect_passphrase : '';
    try {
      if (presented && provider.checkPassphrase(presented) === true) return true;
    } catch { /* a failed check is not proof */ }
    const header = req.headers && (req.headers.authorization || req.headers.Authorization);
    const bearer = typeof header === 'string' ? /^Bearer\s+(\S+)/i.exec(header) : null;
    if (!bearer || typeof provider.verifyAccessToken !== 'function') return false;
    try {
      const auth = await provider.verifyAccessToken(bearer[1]);
      return Boolean(auth && auth.extra && auth.extra.door === 'owner');
    } catch {
      return false;
    }
  }

  async function finishCreate(req, res) {
    if (limited(req, res)) return;
    const body = req.body || {};
    const db = dbOf(options);
    if (await adminPasswordIsSet(db)) {
      const result = await createAdminPassword(db, body.password, body.confirm);
      noteAttempt(req, false);
      res.locals.reason = result.reason || 'already_set';
      sendHtml(res, result.status, problemHtml(result.reason), 'EMET admin password');
      return;
    }
    if (!await ownerProof(req, body)) {
      noteAttempt(req, false);
      res.locals.reason = 'owner_proof_required';
      sendHtml(res, 401, problemHtml('owner_proof_required'), 'EMET admin password');
      return;
    }
    const result = await createAdminPassword(db, body.password, body.confirm);
    noteAttempt(req, result.ok === true);
    res.locals.reason = result.ok ? 'admin_password_created' : (result.reason || 'admin_password_refused');
    const html = result.ok
      ? savedHtml('Sign in on the chooser with this admin password. The connect passphrase is unchanged.', result.recovery_codes)
      : problemHtml(result.reason);
    sendHtml(res, result.status, html, 'EMET admin password');
  }

  function showRotate(req, res) {
    const session = gate && gate.sessionOf(req);
    if (!session) {
      res.locals.reason = 'admin_rotate_login';
      sendHtml(res, 200, loginForm(`${ADMIN_PASSWORD_URL}/rotate`, { credential: 'admin' }), 'EMET admin password');
      return;
    }
    res.locals.reason = 'admin_rotate_form';
    sendHtml(res, 200, rotateForm(session.csrf), 'EMET admin password');
  }

  async function finishRotate(req, res) {
    if (limited(req, res)) return;
    const session = gate && gate.sessionOf(req);
    const body = req.body || {};
    const csrf = typeof body.csrf === 'string' ? body.csrf : '';
    const expected = session && typeof session.csrf === 'string' ? session.csrf : '';
    const a = Buffer.from(csrf);
    const b = Buffer.from(expected);
    if (!session || a.length === 0 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.locals.reason = 'form_expired';
      sendHtml(res, 403, problemHtml('form_expired'), 'EMET admin password');
      return;
    }
    const result = await rotateAdminPassword(dbOf(options), body.current, body.password, body.confirm);
    noteAttempt(req, result.ok === true);
    if (result.ok && gate && typeof gate.endAllSessions === 'function') {
      gate.endAllSessions();
      clearOwnerCookie(res);
    }
    res.locals.reason = result.ok ? 'admin_password_rotated' : (result.reason || 'admin_password_refused');
    const html = result.ok
      ? savedHtml('The admin password is changed. Sign in again with the new one. The connect passphrase is unchanged.', result.recovery_codes)
      : problemHtml(result.reason);
    sendHtml(res, result.status, html, 'EMET admin password');
  }

  async function finishRecover(req, res) {
    if (limited(req, res)) return;
    const body = req.body || {};
    const result = await recoverAdminPassword(dbOf(options), {
      proof: body.proof,
      password: body.password,
      confirm: body.confirm,
      connectPassphrase: connectCheck(provider)
    });
    noteAttempt(req, result.ok === true);
    if (result.ok && gate && typeof gate.endAllSessions === 'function') {
      gate.endAllSessions();
      clearOwnerCookie(res);
    }
    res.locals.reason = result.ok ? 'admin_password_recovered' : (result.reason || 'admin_password_refused');
    const html = result.ok
      ? savedHtml('The admin password is replaced. The connect passphrase is unchanged.', result.recovery_codes)
      : problemHtml(result.reason);
    sendHtml(res, result.status, html, 'EMET admin password');
  }
}
