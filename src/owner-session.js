/**
 * Owner passphrase session shared by the chooser and break-glass.
 *
 * This is the owner factor from OWNER_PAGE: the same passphrase as OAuth
 * consent, the same per-address lockout, and no grant id. A member or guest
 * grant is not this session.
 */

import crypto from 'node:crypto';
import express from 'express';

export const SESSION_MS = 15 * 60 * 1000;
export const COOKIE_NAME = 'emet_owner';
const SESSION_MAX = 200;
const NEXT_OK = new Set(['/owner/chooser', '/owner/break-glass']);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    return part.slice(i + 1).trim();
  }
  return null;
}

export function htmlPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #12141a; color: #e8e6e0; margin: 0; padding: 24px; line-height: 1.45; }
  a { color: #8eb4d6; }
  button, input, select { font: inherit; }
  button { margin-right: 8px; }
  table { border-collapse: collapse; }
  td, th { text-align: left; padding: 4px 10px 4px 0; vertical-align: top; }
  code { color: #d9c27a; }
  .note { color: #d9a441; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function sendHtml(res, status, body, title = 'EMET') {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.send(htmlPage(title, body));
}

export function ownerPageActor(personId) {
  return {
    transport: 'http',
    authenticated: true,
    personId,
    ownerId: personId,
    sourceTag: 'owner',
    sourceBasis: 'login',
    clientId: null,
    grantId: null
  };
}

/**
 * A door grant requires this session. Guest is the default only after the
 * owner is signed in. A missing session cannot grant owner or member.
 */
export function ownerMayGrant(session, decision) {
  if (!session || !session.csrf) return false;
  return decision === 'owner' || decision === 'member' || decision === 'guest';
}

export function createOwnerGate({ checkPassphrase, throttle, now = Date.now } = {}) {
  const sessions = new Map();

  function sweep() {
    const t = now();
    for (const [id, row] of sessions) if (!row || row.expires <= t) sessions.delete(id);
    while (sessions.size > SESSION_MAX) sessions.delete(sessions.keys().next().value);
  }

  function sessionOf(req) {
    sweep();
    const raw = readCookie(req, COOKIE_NAME);
    if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
    const row = sessions.get(raw);
    if (!row) return null;
    return { csrf: row.csrf, expires: row.expires, id: raw };
  }

  function login(req, res) {
    const next = NEXT_OK.has(req.body && req.body.next) ? req.body.next : '/owner/break-glass';
    const limit = throttle.check(req.ip);
    if (!limit.allowed) {
      res.locals.reason = 'throttled';
      res.setHeader('Retry-After', String(limit.retryAfterS));
      sendHtml(res, 429, '<p>Too many attempts. Try again later.</p>', 'EMET owner');
      return;
    }
    const passphrase = (req.body && req.body.passphrase) || '';
    let ok = false;
    try { ok = checkPassphrase(passphrase) === true; }
    catch (e) {
      console.error('[emet] owner passphrase check', e && e.message ? e.message : e);
      res.locals.reason = 'passphrase_check_error';
      sendHtml(res, 500, '<p>Something went wrong.</p>', 'EMET owner');
      return;
    }
    if (!ok) {
      throttle.recordFailure(req.ip);
      res.locals.reason = 'bad_passphrase';
      sendHtml(res, 401, '<p>Incorrect passphrase.</p>', 'EMET owner');
      return;
    }
    throttle.recordSuccess(req.ip);
    sweep();
    const id = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(32).toString('hex');
    sessions.set(id, { csrf, expires: now() + SESSION_MS });
    res.cookie(COOKIE_NAME, id, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/owner',
      maxAge: SESSION_MS,
      secure: req.secure === true
    });
    res.locals.reason = 'owner_session';
    res.redirect(303, next);
  }

  function endOtherSessions(keepId) {
    if (typeof keepId !== 'string' || !keepId) return 0;
    let ended = 0;
    for (const id of [...sessions.keys()]) {
      if (id === keepId) continue;
      sessions.delete(id);
      ended += 1;
    }
    return ended;
  }

  return { sessionOf, login, now, endOtherSessions };
}

export function mountOwnerLogin(app, gate) {
  if (app.get('emetOwnerLogin')) return;
  app.set('emetOwnerLogin', true);
  app.post('/owner/login', express.urlencoded({ extended: false }), (req, res) => gate.login(req, res));
}

export function loginForm(nextPath) {
  const next = NEXT_OK.has(nextPath) ? nextPath : '/owner/break-glass';
  return `<h1>Owner</h1>
<p>Enter the owner passphrase. A member or guest grant does not sign this page in.</p>
<form method="post" action="/owner/login">
<input type="hidden" name="next" value="${esc(next)}">
<label>Passphrase <input type="password" name="passphrase" autocomplete="current-password"></label>
<button type="submit">Continue</button>
</form>`;
}
