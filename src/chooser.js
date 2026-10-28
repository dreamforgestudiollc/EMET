/**
 * Owner / member / guest chooser (R4a).
 *
 * A deep link opens this page and is consumed on that open. The owner
 * passphrase session is what grants a door. Guest is the least-privilege
 * default. Owner and member require that same session. The link itself
 * grants nothing.
 *
 * Pending sub-keys from the retired /owner/approvals path are listed here.
 * Their records stay in the sub-key store.
 *
 * Prepared writer requests are listed here too. Master Hub prepares.
 * The server validates. This owner session decides. The request row stays.
 */

import crypto from 'node:crypto';
import express from 'express';
import { setting } from './env.js';
import { DOORS } from './grants.js';
import { timingSafeEqualStr } from './oauth-provider.js';
import {
  presentDeepLink, deepLinkTtlMs, recordAccessDecision, bindGrantId, bindTag, bindDoor
} from './deep-links.js';
import {
  esc, sendHtml, loginForm, ownerPageActor, ownerMayGrant, mountOwnerLogin, readCookie, createOwnerGate
} from './owner-session.js';
import { rotationForms } from './rotate.js';

const CHOOSER_COOKIE = 'emet_chooser';
const REASON_MAX = 500;
const STORE_MESSAGE = 'The sub-key store is unavailable.';
const opened = new Map();

export function _resetChooserForTests() {
  opened.clear();
}

function sweepOpened(now) {
  for (const [id, row] of opened) if (!row || row.expires <= now) opened.delete(id);
}

function stashOf(req, now) {
  sweepOpened(now);
  const raw = readCookie(req, CHOOSER_COOKIE);
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
  return opened.get(raw) || null;
}

function pendingSubkeys(data) {
  return Object.values((data && data.keys) || {})
    .filter((k) => k && k.status === 'pending' && k.key_id && k.tag)
    .sort((a, b) => String(a.requested_at || '').localeCompare(String(b.requested_at || '')) || String(a.key_id).localeCompare(String(b.key_id)));
}

function retainedSubkeys(data) {
  return Object.values((data && data.keys) || {})
    .filter((k) => k && k.status && k.status !== 'pending' && k.key_id && k.tag)
    .sort((a, b) => String(a.tag).localeCompare(String(b.tag)) || String(a.key_id).localeCompare(String(b.key_id)));
}

function historyLine(row) {
  const events = Array.isArray(row.history) ? row.history : [];
  if (!events.length) return esc(row.status);
  return events.map((ev) => {
    if (!ev) return '';
    return esc([ev.event, ev.via, ev.at].filter(Boolean).join(' '));
  }).filter(Boolean).join('<br>');
}

function writerSection(session, writers) {
  if (!session) return '';
  if (writers == null) return '<h2>Writer requests</h2><p>Writer requests could not be listed. Nothing was changed.</p>';
  if (!writers.length) return '<h2>Writer requests</h2><p>No writer requests are on file.</p>';
  const body = writers.map((row) => {
    const buttons = row.status === 'validated'
      ? `<form method="post" action="/owner/chooser/writer">
<input type="hidden" name="csrf" value="${esc(session.csrf)}">
<input type="hidden" name="request_id" value="${esc(row.request_id)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`
      : '';
    return `<tr><td>${esc(row.claimed_tag)}</td><td>${esc(row.door)}</td><td>${esc(row.status)}</td><td>${esc(row.preparer)}</td><td>${esc(row.validator)}</td><td>${esc(row.correlation_id)}</td><td>${buttons}</td></tr>`;
  }).join('\n');
  return `<h2>Writer requests</h2>
<p>Master Hub prepares. The server validates. Only this owner session decides.</p>
<table><thead><tr><th>Tag</th><th>Door</th><th>Status</th><th>Preparer</th><th>Validator</th><th>Correlation</th><th></th></tr></thead><tbody>${body}</tbody></table>`;
}

function doorRadios() {
  return `<fieldset>
<legend>Door</legend>
<label><input type="radio" name="decision" value="guest" checked> Guest</label>
<label><input type="radio" name="decision" value="member"> Member</label>
<label><input type="radio" name="decision" value="owner"> Owner</label>
</fieldset>
<p>Guest is the least-privilege default. Only this owner session can grant owner or member.</p>`;
}

async function loadKeys(deps) {
  if (setting('SUBKEYS') !== '1') return { skipped: true, rows: [], retained: [] };
  const { loadSubkeyRecords } = await import('./subkeys.js');
  const data = await loadSubkeyRecords(deps);
  return { skipped: false, rows: pendingSubkeys(data), retained: retainedSubkeys(data) };
}

function bindingFields(binding) {
  if (!binding) return '';
  return `<input type="hidden" name="bind_grant" value="${esc(binding.grant_id)}">
<input type="hidden" name="bind_tag" value="${esc(binding.tag)}">
<input type="hidden" name="bind_door" value="${esc(binding.door)}">`;
}

function pageBody({ session, stash, keys, writers, note }) {
  const parts = [];
  if (note) parts.push(`<p class="note">${esc(note)}</p>`);
  if (!session) {
    parts.push(loginForm('/owner/chooser'));
    parts.push('<p>Break-glass recovery, with no AI client, is <a href="/owner/break-glass">/owner/break-glass</a>.</p>');
    return parts.join('\n');
  }
  const binding = stash && stash.binding;
  if (binding) {
    parts.push(`<h1>Chooser</h1>
<p>This link is for grant <code>${esc(binding.grant_id)}</code>, tag <code>${esc(binding.tag)}</code>, door <code>${esc(binding.door)}</code> (${esc(binding.kind)}). correlation_id <code>${esc(binding.correlation_id)}</code>. The link grants nothing.</p>`);
  } else {
    parts.push('<h1>Chooser</h1><p>No refusal link is open. Guest is selected unless you choose another door.</p>');
  }
  const tagField = binding
    ? `<p>Tag <code>${esc(binding.tag)}</code></p>`
    : `<label>Tag <input type="text" name="tag" maxlength="80" autocomplete="off"></label>`;
  parts.push(`<form method="post" action="/owner/chooser/decide">
<input type="hidden" name="csrf" value="${esc(session.csrf)}">
${bindingFields(binding)}
${tagField}
${doorRadios()}
<button type="submit">Grant this door</button>
</form>`);
  if (keys && keys.skipped) {
    parts.push('<p>Sub-keys are off in this process. Nothing was listed from that store.</p>');
  } else if (keys) {
    if (!keys.rows.length) parts.push('<h2>Pending sub-keys</h2><p>No pending sub-key requests.</p>');
    else {
      const body = keys.rows.map((row) => `<tr><td>${esc(row.tag)}</td><td>${esc(String(row.key_id).slice(0, 8))}</td><td>${esc(row.requested_at || '')}</td><td>
<form method="post" action="/owner/chooser/subkey">
<input type="hidden" name="csrf" value="${esc(session.csrf)}">
<input type="hidden" name="key_id" value="${esc(row.key_id)}">
<input type="text" name="reason" maxlength="${REASON_MAX}" placeholder="Reason (optional)">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</td></tr>`).join('\n');
      parts.push(`<h2>Pending sub-keys</h2>
<table>
<thead><tr><th>Tag</th><th>Key</th><th>Requested</th><th></th></tr></thead>
<tbody>${body}</tbody>
</table>`);
    }
    parts.push('<h2>Retained records</h2>');
    if (!keys.retained.length) parts.push('<p>No earlier sub-key decisions are in this store.</p>');
    else {
      const body = keys.retained.map((row) => `<tr><td>${esc(row.tag)}</td><td>${esc(row.status)}</td><td>${historyLine(row)}</td></tr>`).join('\n');
      parts.push(`<table><thead><tr><th>Tag</th><th>Status</th><th>History</th></tr></thead><tbody>${body}</tbody></table>`);
    }
  }
  parts.push(writerSection(session, writers));
  parts.push(rotationForms(session.csrf));
  parts.push('<p>Break-glass recovery is <a href="/owner/break-glass">/owner/break-glass</a>.</p>');
  return parts.join('\n');
}

async function issueDoor(db, door, tag, decider) {
  if (door === 'owner') {
    return { issued: false, note: 'Owner door is the passphrase consent on this host. This page did not mint a token.' };
  }
  if (!db) return { issued: false, note: 'The store is unavailable. Nothing was issued.' };
  try {
    if (door === 'member') {
      const { createMemberAccess } = await import('./invites.js');
      const invite = await createMemberAccess(db, { created_by: decider, display_name: tag, source_tag: tag });
      return { issued: true, invite };
    }
    const { createInvite } = await import('./invites.js');
    const invite = await createInvite(db, { created_by: decider, display_name: tag, source_tag: tag });
    return { issued: true, invite };
  } catch (e) {
    if (e && e.code === 'INVITES_FROZEN') return { issued: false, note: 'EMET Guest Access is off on this install. Nothing was issued.' };
    if (e && e.code === 'MEMBER_ACCESS_FROZEN') return { issued: false, note: 'EMET Member Access is off on this install. Nothing was issued.' };
    return { issued: false, note: 'That door did not issue a code. Nothing was issued.' };
  }
}

/**
 * @param {import('express').Express} app
 * @param {{ gate?: object, checkPassphrase?: Function, throttle?: object, deps?: object | Function, ownerId?: string | Function, db?: object | Function, now?: () => number }} options
 */
export function mountChooser(app, options = {}) {
  const now = options.now || Date.now;
  const gate = options.gate || createOwnerGate({
    checkPassphrase: options.checkPassphrase,
    throttle: options.throttle,
    now
  });
  mountOwnerLogin(app, gate);
  const parseBody = express.urlencoded({ extended: false });
  const depsOf = () => (typeof options.deps === 'function' ? options.deps() : options.deps);
  const dbOf = () => (typeof options.db === 'function' ? options.db() : options.db);

  async function resolveOwner() {
    try {
      const id = await (typeof options.ownerId === 'function' ? options.ownerId() : options.ownerId);
      return (typeof id === 'string' && id.trim()) || null;
    } catch { return null; }
  }

  function prefixOf() {
    return typeof options.prefix === 'string' && options.prefix ? options.prefix : 'emet_';
  }

  async function render(req, res, note) {
    const session = gate.sessionOf(req);
    let keys = null;
    let writers = null;
    if (session) {
      try {
        keys = await loadKeys(depsOf());
      } catch {
        res.locals.reason = 'subkey_store';
        sendHtml(res, 503, `<p>${STORE_MESSAGE}</p>`, 'EMET chooser');
        return;
      }
      try {
        const { listWriterRequests } = await import('./writer-approval.js');
        writers = await listWriterRequests(dbOf(), prefixOf());
      } catch {
        writers = null;
      }
    }
    sendHtml(res, 200, pageBody({ session, stash: stashOf(req, now()), keys, writers, note }), 'EMET chooser');
  }

  app.get('/owner/chooser', (req, res) => {
    const token = typeof req.query.d === 'string' ? req.query.d : '';
    if (token) {
      const openedLink = presentDeepLink(token, {}, now());
      if (!openedLink.ok) {
        res.locals.reason = openedLink.reason;
        const text = {
          expired: 'This link has expired. Nothing was granted.',
          replay: 'This link was already used. Nothing was granted.',
          wrong_instance: 'This link is for another instance. Nothing was granted.',
          wrong_scope: 'This link does not match that client, tag, or door. Nothing was granted.',
          rotated: 'This link was revoked by rotation. Nothing was granted. Sign in, assign the tag, and initialize from the chooser.',
          unknown: 'This link is not valid. Nothing was granted.'
        }[openedLink.reason] || 'This link is not valid. Nothing was granted.';
        const clientError = openedLink.reason === 'expired' || openedLink.reason === 'replay' || openedLink.reason === 'wrong_scope' || openedLink.reason === 'wrong_instance' || openedLink.reason === 'rotated';
        sendHtml(res, clientError ? 400 : 404, `<p>${esc(text)}</p><p><a href="/owner/chooser">Chooser</a></p>`, 'EMET chooser');
        return;
      }
      const nonce = crypto.randomBytes(32).toString('hex');
      const ttl = Math.max(1000, openedLink.binding ? deepLinkTtlMs() : 1000);
      opened.set(nonce, { binding: openedLink.binding, expires: now() + ttl });
      res.cookie(CHOOSER_COOKIE, nonce, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/owner',
        maxAge: ttl,
        secure: req.secure === true
      });
      res.locals.reason = 'chooser_opened';
      res.redirect(303, '/owner/chooser');
      return;
    }
    render(req, res).catch((e) => {
      console.error('[emet] chooser', e && e.message ? e.message : e);
      if (!res.headersSent) {
        res.locals.reason = 'chooser_error';
        sendHtml(res, 500, '<p>Something went wrong.</p>', 'EMET chooser');
      }
    });
  });

  app.post('/owner/chooser/decide', parseBody, (req, res) => {
    finishDecide(req, res).catch((e) => {
      console.error('[emet] chooser decide', e && e.message ? e.message : e);
      if (!res.headersSent) {
        res.locals.reason = 'chooser_decide_error';
        sendHtml(res, 500, '<p>Something went wrong. Nothing was granted.</p>', 'EMET chooser');
      }
    });
  });

  app.post('/owner/chooser/writer', parseBody, (req, res) => {
    finishWriter(req, res).catch((e) => {
      console.error('[emet] chooser writer', e && e.message ? e.message : e);
      if (!res.headersSent) {
        res.locals.reason = 'chooser_writer_error';
        sendHtml(res, 500, '<p>Something went wrong. Nothing was changed.</p>', 'EMET chooser');
      }
    });
  });

  app.post('/owner/chooser/subkey', parseBody, (req, res) => {
    finishSubkey(req, res).catch((e) => {
      console.error('[emet] chooser subkey', e && e.message ? e.message : e);
      if (!res.headersSent) {
        res.locals.reason = 'chooser_subkey_error';
        sendHtml(res, 500, '<p>Something went wrong. Nothing was changed.</p>', 'EMET chooser');
      }
    });
  });

  function postedBinding(body) {
    if (!body || (body.bind_grant == null && body.bind_tag == null && body.bind_door == null)) return null;
    return {
      grant_id: bindGrantId(body.bind_grant),
      tag: bindTag(body.bind_tag),
      door: bindDoor(body.bind_door)
    };
  }

  async function finishDecide(req, res) {
    const session = gate.sessionOf(req);
    const raw = req.body && req.body.decision;
    const decision = DOORS.includes(raw) ? raw : (raw == null || raw === '' ? 'guest' : null);
    if (!ownerMayGrant(session, decision || 'guest')) {
      res.locals.reason = 'owner_only';
      sendHtml(res, 401, '<p>Only the owner session can grant a door. Nothing was granted.</p>', 'EMET chooser');
      return;
    }
    if (!decision) {
      res.locals.reason = 'bad_decision';
      sendHtml(res, 400, '<p>Door must be owner, member, or guest. Nothing was granted.</p>', 'EMET chooser');
      return;
    }
    const posted = (req.body && req.body.csrf) || '';
    if (!timingSafeEqualStr(posted, session.csrf)) {
      res.locals.reason = 'bad_csrf';
      sendHtml(res, 403, '<p>The form expired. Reload the page and try again.</p>', 'EMET chooser');
      return;
    }
    const stash = stashOf(req, now());
    const claimed = postedBinding(req.body);
    if (stash && stash.binding) {
      const bound = stash.binding;
      if (!claimed || claimed.grant_id !== bound.grant_id || claimed.tag !== bound.tag || claimed.door !== bound.door) {
        res.locals.reason = 'wrong_scope';
        sendHtml(res, 403, '<p>That link is bound to a different client, tag, or door. Nothing was granted.</p>', 'EMET chooser');
        return;
      }
    }
    const personId = await resolveOwner();
    if (!personId) {
      res.locals.reason = 'owner_unavailable';
      sendHtml(res, 400, '<p>The owner id is unavailable. Nothing was granted.</p>', 'EMET chooser');
      return;
    }
    const binding = stash && stash.binding;
    const tag = binding ? binding.tag : bindTag(req.body && req.body.tag);
    if ((decision === 'member' || decision === 'guest') && tag === 'unknown') {
      res.locals.reason = 'tag_required';
      sendHtml(res, 400, '<p>A tag is required for member or guest. Nothing was granted.</p>', 'EMET chooser');
      return;
    }
    let db = null;
    try { db = dbOf() || null; } catch { db = null; }
    const issued = await issueDoor(db, decision, tag === 'unknown' ? 'owner' : tag, personId);
    recordAccessDecision({
      grant_id: binding ? binding.grant_id : 'unknown',
      correlation_id: binding ? binding.correlation_id : 'none',
      decider: personId,
      decision,
      surface: 'chooser',
      door: decision,
      tag,
      kind: binding ? binding.kind : 'direct',
      issued: issued.issued
    });
    if (stash) opened.delete(readCookie(req, CHOOSER_COOKIE));
    res.locals.reason = issued.issued ? 'door_issued' : 'door_recorded';
    const bits = [`Recorded ${decision} for ${tag}.`];
    if (issued.note) bits.push(issued.note);
    if (issued.invite && issued.invite.code) bits.push(`Invite code, shown once: ${issued.invite.code}`);
    await render(req, res, bits.join(' '));
  }

  async function finishSubkey(req, res) {
    const session = gate.sessionOf(req);
    if (!session) {
      res.locals.reason = 'no_owner_session';
      sendHtml(res, 401, '<p>Sign in again. Nothing was changed.</p>', 'EMET chooser');
      return;
    }
    const posted = (req.body && req.body.csrf) || '';
    if (!timingSafeEqualStr(posted, session.csrf)) {
      res.locals.reason = 'bad_csrf';
      sendHtml(res, 403, '<p>The form expired. Reload the page and try again.</p>', 'EMET chooser');
      return;
    }
    const decision = req.body && req.body.decision;
    const keyId = typeof (req.body && req.body.key_id) === 'string' ? req.body.key_id.trim() : '';
    const reason = typeof (req.body && req.body.reason) === 'string' ? req.body.reason.trim() : '';
    if (decision !== 'approve' && decision !== 'deny') {
      res.locals.reason = 'bad_decision';
      sendHtml(res, 400, '<p>Decision must be approve or deny. Nothing was changed.</p>', 'EMET chooser');
      return;
    }
    if (reason.length > REASON_MAX) {
      res.locals.reason = 'reason_too_long';
      sendHtml(res, 400, '<p>The reason is too long. Nothing was changed.</p>', 'EMET chooser');
      return;
    }
    const personId = await resolveOwner();
    if (!personId) {
      res.locals.reason = 'owner_unavailable';
      sendHtml(res, 400, '<p>The owner id is unavailable. Nothing was changed.</p>', 'EMET chooser');
      return;
    }
    const { decideSubkeyIfPending } = await import('./subkeys.js');
    let result = null;
    try {
      result = await decideSubkeyIfPending(depsOf(), ownerPageActor(personId), personId, {
        key_id: keyId, decision, reason, via: 'owner_chooser'
      }, new Date(now()));
    } catch (e) {
      if (e && e.attributionRefusal && !/sub-key store/.test(String(e.message))) {
        res.locals.reason = 'decide_refused';
        sendHtml(res, 400, `<p>${esc(e.message)}</p>`, 'EMET chooser');
        return;
      }
      res.locals.reason = 'subkey_store';
      sendHtml(res, 503, `<p>${STORE_MESSAGE}</p>`, 'EMET chooser');
      return;
    }
    if (!result) {
      res.locals.reason = 'not_pending';
      sendHtml(res, 400, '<p>That sub-key is not awaiting approval. Nothing was changed.</p>', 'EMET chooser');
      return;
    }
    recordAccessDecision({
      grant_id: 'unknown',
      correlation_id: 'none',
      decider: personId,
      decision,
      surface: 'chooser',
      tag: result.tag,
      kind: 'legacy_subkey',
      issued: false
    });
    res.locals.reason = decision === 'approve' ? 'subkey_approved' : 'subkey_denied';
    const verb = decision === 'approve' ? 'Approved' : 'Denied';
    await render(req, res, `${verb} ${result.tag}.`);
  }

  async function finishWriter(req, res) {
    const session = gate.sessionOf(req);
    if (!session) {
      res.locals.reason = 'no_owner_session';
      sendHtml(res, 401, '<p>Only the owner session can grant a writer.</p>', 'EMET chooser');
      return;
    }
    const posted = (req.body && req.body.csrf) || '';
    if (!timingSafeEqualStr(posted, session.csrf)) {
      res.locals.reason = 'bad_csrf';
      sendHtml(res, 403, '<p>The form expired. Reload the page and try again.</p>', 'EMET chooser');
      return;
    }
    const decision = req.body && req.body.decision;
    const requestId = typeof (req.body && req.body.request_id) === 'string' ? req.body.request_id.trim() : '';
    if (decision !== 'approve' && decision !== 'deny') {
      res.locals.reason = 'bad_decision';
      sendHtml(res, 400, '<p>Decision must be approve or deny. Nothing was changed.</p>', 'EMET chooser');
      return;
    }
    const personId = await resolveOwner();
    if (!personId) {
      res.locals.reason = 'owner_unavailable';
      sendHtml(res, 400, '<p>The owner id is unavailable. Nothing was changed.</p>', 'EMET chooser');
      return;
    }
    let db = null;
    try { db = dbOf() || null; } catch { db = null; }
    const { claimWriterDecision, releaseWriterClaim, stampWriterIssued } = await import('./writer-approval.js');
    let recorded;
    try {
      recorded = await claimWriterDecision(db, prefixOf(), {
        requestId,
        decision,
        decider: personId,
        ownerSession: true
      }, new Date(now()));
    } catch (e) {
      res.locals.reason = 'not_validated';
      sendHtml(res, 400, `<p>${esc(e && e.message ? e.message : 'That writer request is not awaiting a decision. Nothing was changed.')}</p>`, 'EMET chooser');
      return;
    }
    let issued = { issued: false };
    if (decision === 'approve') {
      try {
        issued = await issueDoor(db, recorded.door, recorded.claimed_tag, personId);
        if (!issued.issued) {
          res.locals.reason = 'writer_not_issued';
          sendHtml(res, 400, `<p>${esc(issued.note || 'That door did not issue a code. Nothing was changed.')}</p>`, 'EMET chooser');
          return;
        }
        recorded = await stampWriterIssued(db, prefixOf(), { requestId });
      } catch (e) {
        res.locals.reason = 'writer_refused';
        sendHtml(res, 400, `<p>${esc(e && e.message ? e.message : 'Nothing was changed.')}</p>`, 'EMET chooser');
        return;
      } finally {
        if (!issued.issued) await releaseWriterClaim(db, prefixOf(), { requestId }, new Date(now()));
      }
    }
    recordAccessDecision({
      grant_id: recorded.grant_id || 'unknown',
      correlation_id: recorded.correlation_id || 'none',
      decider: personId,
      decision,
      surface: 'chooser',
      door: recorded.door,
      tag: recorded.claimed_tag,
      kind: 'writer',
      issued: issued.issued
    });
    res.locals.reason = decision === 'approve' ? 'writer_approved' : 'writer_denied';
    const bits = [`Recorded ${decision} for ${recorded.claimed_tag}.`];
    if (issued.note) bits.push(issued.note);
    if (issued.invite && issued.invite.code) bits.push(`Invite code, shown once: ${issued.invite.code}`);
    if (issued.issued && recorded.claimed_tag === 'grok-project') {
      let sophiaNote = 'The BOUND door listing was not written. The invite code above is still the door.';
      try {
        const { sophiaListingAfterWriterIssue } = await import('./bound-door.js');
        const listing = await sophiaListingAfterWriterIssue({
          recorded, issued, deps: depsOf(), by: personId, now: new Date(now())
        });
        if (listing.written) sophiaNote = 'Listed grok-project as its own door.';
      } catch { /* the invite still stands */ }
      bits.push(sophiaNote);
    }
    await render(req, res, bits.join(' '));
  }
}
