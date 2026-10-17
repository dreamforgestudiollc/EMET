/**
 * Owner page for pending sub-key requests.
 *
 * Mounted only when EMET_SUBKEYS=1. The passphrase is the one the OAuth
 * consent page already checks (MongoOAuthProvider.checkPassphrase against
 * EMET_OAUTH_PASSPHRASE), and a wrong guess shares that form's per-address
 * lockout. A correct passphrase opens a session that lasts 15 minutes.
 * Approve and Deny post that session's CSRF token and call
 * decideSubkeyIfPending for the posted key_id. The history event records
 * the real owner id and via owner_page. emet_client_approve is unchanged.
 */

import crypto from 'node:crypto';
import express from 'express';
import { timingSafeEqualStr } from './oauth-provider.js';
import { decideSubkeyIfPending, loadSubkeyRecords } from './subkeys.js';

const COOKIE_NAME = 'emet_owner';
export const SESSION_MS = 15 * 60 * 1000;
const SESSION_MAX = 200;
const REASON_MAX = 500;
const STORE_MESSAGE = 'The sub-key store is unavailable.';
const NOT_PENDING = 'That sub-key is not awaiting approval. Nothing was changed.';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readCookie(req, name) {
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

function ownerActor(personId) {
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

function page(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EMET owner approvals</title>
<style>
  body { font-family: system-ui, sans-serif; background: #12141a; color: #e8e6e0; margin: 0; padding: 24px; }
  button { font: inherit; margin-right: 8px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function sendHtml(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.send(page(body));
}

function pendingRows(data) {
  return Object.values((data && data.keys) || {})
    .filter((k) => k && k.status === 'pending' && k.key_id && k.tag)
    .sort((a, b) => String(a.requested_at || '').localeCompare(String(b.requested_at || '')) || String(a.key_id).localeCompare(String(b.key_id)));
}

function listHtml(rows, csrf, note) {
  const noteHtml = note ? `<p>${esc(note)}</p>` : '';
  if (!rows.length) return `${noteHtml}<h1>Pending sub-keys</h1><p>No pending sub-key requests.</p>`;
  const body = rows.map((row) => {
    const prefix = esc(String(row.key_id).slice(0, 8));
    return `<tr><td>${esc(row.tag)}</td><td>${prefix}</td><td>${esc(row.requested_at || '')}</td><td>
<form method="post" action="/owner/approvals/decide">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="key_id" value="${esc(row.key_id)}">
<input type="text" name="reason" maxlength="${REASON_MAX}" placeholder="Reason (optional)">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</td></tr>`;
  }).join('\n');
  return `${noteHtml}<h1>Pending sub-keys</h1>
<table>
<thead><tr><th>Tag</th><th>Key</th><th>Requested</th><th></th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

function notPending(res) {
  res.locals.reason = 'not_pending';
  sendHtml(res, 400, `<p>${NOT_PENDING}</p>`);
}

/**
 * @param {import('express').Express} app
 * @param {{ checkPassphrase: (input: string) => boolean, throttle: { check: Function, recordFailure: Function, recordSuccess: Function }, deps: object | Function, ownerId: string | Function, now?: () => number }} options
 */
export function mountOwnerApprovals(app, options = {}) {
  const checkPassphrase = options.checkPassphrase;
  const throttle = options.throttle;
  const now = options.now || Date.now;
  const sessions = new Map();
  const parseBody = express.urlencoded({ extended: false });
  const depsOf = () => (typeof options.deps === 'function' ? options.deps() : options.deps);

  async function resolveOwner() {
    try { const id = await (typeof options.ownerId === 'function' ? options.ownerId() : options.ownerId); return (typeof id === 'string' && id.trim()) || null; }
    catch { return null; }
  }

  function sweep() {
    const t = now();
    for (const [id, row] of sessions) if (!row || row.expires <= t) sessions.delete(id);
    while (sessions.size > SESSION_MAX) sessions.delete(sessions.keys().next().value);
  }

  function sessionOf(req) {
    sweep();
    const raw = readCookie(req, COOKIE_NAME);
    if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
    return sessions.get(raw) || null;
  }

  async function renderList(req, res, note) {
    const session = sessionOf(req);
    if (!session) {
      sendHtml(res, 200, `<h1>Owner approvals</h1>
<p>Enter the owner passphrase.</p>
<form method="post" action="/owner/approvals/login">
<label>Passphrase <input type="password" name="passphrase" autocomplete="current-password"></label>
<button type="submit">Continue</button>
</form>`);
      return;
    }
    let rows = [];
    try {
      rows = pendingRows(await loadSubkeyRecords(depsOf()));
    } catch {
      res.locals.reason = 'subkey_store';
      sendHtml(res, 503, `<p>${STORE_MESSAGE}</p>`);
      return;
    }
    sendHtml(res, 200, listHtml(rows, session.csrf, note));
  }

  app.get('/owner/approvals', (req, res) => {
    renderList(req, res).catch((e) => {
      console.error('[emet] owner approvals', e && e.message ? e.message : e);
      if (!res.headersSent) {
        res.locals.reason = 'owner_approvals_error';
        sendHtml(res, 500, '<p>Something went wrong.</p>');
      }
    });
  });

  app.post('/owner/approvals/login', parseBody, (req, res) => {
    const limit = throttle.check(req.ip);
    if (!limit.allowed) {
      res.locals.reason = 'throttled';
      res.setHeader('Retry-After', String(limit.retryAfterS));
      sendHtml(res, 429, '<p>Too many attempts. Try again later.</p>');
      return;
    }
    const passphrase = (req.body && req.body.passphrase) || '';
    let ok = false;
    try { ok = checkPassphrase(passphrase) === true; }
    catch (e) {
      console.error('[emet] owner passphrase check', e && e.message ? e.message : e);
      res.locals.reason = 'passphrase_check_error';
      sendHtml(res, 500, '<p>Something went wrong.</p>');
      return;
    }
    if (!ok) {
      throttle.recordFailure(req.ip);
      res.locals.reason = 'bad_passphrase';
      sendHtml(res, 401, '<p>Incorrect passphrase.</p>');
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
    res.redirect(303, '/owner/approvals');
  });

  app.post('/owner/approvals/decide', parseBody, (req, res) => {
    const session = sessionOf(req);
    if (!session) {
      res.locals.reason = 'no_owner_session';
      sendHtml(res, 401, '<p>Sign in again.</p>');
      return;
    }
    const posted = (req.body && req.body.csrf) || '';
    if (!timingSafeEqualStr(posted, session.csrf)) {
      res.locals.reason = 'bad_csrf';
      sendHtml(res, 403, '<p>The form expired. Reload the page and try again.</p>');
      return;
    }
    const decision = req.body && req.body.decision;
    const keyId = typeof (req.body && req.body.key_id) === 'string' ? req.body.key_id.trim() : '';
    const reason = typeof (req.body && req.body.reason) === 'string' ? req.body.reason.trim() : '';
    if (decision !== 'approve' && decision !== 'deny') {
      res.locals.reason = 'bad_decision';
      sendHtml(res, 400, '<p>Decision must be approve or deny. Nothing was changed.</p>');
      return;
    }
    if (reason.length > REASON_MAX) {
      res.locals.reason = 'reason_too_long';
      sendHtml(res, 400, '<p>The reason is too long. Nothing was changed.</p>');
      return;
    }
    finishDecide(req, res, keyId, decision, reason).catch((e) => {
      console.error('[emet] owner decide', e && e.message ? e.message : e);
      if (!res.headersSent) {
        res.locals.reason = 'owner_decide_error';
        sendHtml(res, 500, '<p>Something went wrong. Nothing was changed.</p>');
      }
    });
  });

  async function finishDecide(req, res, keyId, decision, reason) {
    const personId = await resolveOwner();
    if (!personId) {
      res.locals.reason = 'owner_unavailable';
      sendHtml(res, 400, '<p>The owner id is unavailable. Nothing was changed.</p>');
      return;
    }
    let result = null;
    try {
      result = await decideSubkeyIfPending(depsOf(), ownerActor(personId), personId, {
        key_id: keyId, decision, reason, via: 'owner_page'
      }, new Date(now()));
    } catch (e) {
      if (e && e.attributionRefusal && !/sub-key store/.test(String(e.message))) {
        res.locals.reason = 'decide_refused';
        sendHtml(res, 400, `<p>${esc(e.message)}</p>`);
        return;
      }
      res.locals.reason = 'subkey_store';
      sendHtml(res, 503, `<p>${STORE_MESSAGE}</p>`);
      return;
    }
    if (!result) {
      notPending(res);
      return;
    }
    res.locals.reason = decision === 'approve' ? 'subkey_approved' : 'subkey_denied';
    const verb = decision === 'approve' ? 'Approved' : 'Denied';
    await renderList(req, res, `${verb} ${result.tag}.`);
  }
}
