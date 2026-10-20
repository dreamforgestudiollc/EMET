/**
 * Owner approval page for pending sub-keys. The passphrase is the OAuth
 * consent passphrase. emet_client_approve still refuses a login deciding a
 * sub-key whose tag is that login's own tag.
 */

import assert from 'node:assert/strict';
import express from 'express';
import { test, testGroup, summary } from './harness.js';
import { withEnv } from './memstore.js';
import { createMemoryStore } from '../src/subkey-store.js';
import { mountOwnerApprovals, SESSION_MS } from '../src/owner-approvals.js';
import { MongoOAuthProvider } from '../src/oauth-provider.js';
import { ApproveThrottle } from '../src/approve-throttle.js';
import { setting } from '../src/env.js';

console.log('\n=== owner approval page ===');

const SECRET = 'owner-secret-value';
const PEPPER = 'pepper-pepper-pepper-pepper-pepper-32b';
const OWNER = 'alex';
const REG = ['hub-bot', 'intake-bot', 'cowork-cloud'];
const ON = {
  EMET_SUBKEYS: '1',
  EMET_SUBKEY_PEPPER: PEPPER,
  EMET_SOURCE_TAGS: REG.join(','),
  EMET_RECORD_DOCS: 'bots/hub-bot/HANDOFF.md,bots/intake-bot/HANDOFF.md',
  EMET_OAUTH_PASSPHRASE: SECRET
};
const OFF = { ...ON, EMET_SUBKEYS: undefined };

const provider = new MongoOAuthProvider(() => { throw new Error('no db'); }, { passphrase: SECRET });
const throttle = new ApproveThrottle();
const clock = { t: Date.now() };
const holder = { deps: null };
const app = express();
app.set('trust proxy', 1);
mountOwnerApprovals(app, {
  checkPassphrase: (input) => provider.checkPassphrase(input),
  throttle,
  deps: () => holder.deps,
  ownerId: OWNER,
  now: () => clock.t
});
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

function memDeps() {
  return { subkeys: createMemoryStore() };
}
function requester() {
  return {
    personId: OWNER, ownerId: OWNER, clientId: 'bot-client', grantId: 'bot-grant',
    transport: 'http', authenticated: true, sourceTag: 'hub-bot', sourceBasis: 'login'
  };
}
function freshHolder() {
  holder.deps = memDeps();
  for (const ip of [...throttle.failures.keys()]) throttle.recordSuccess(ip);
}
async function requestPending(tag, registry = REG) {
  const sk = await import('../src/subkeys.js');
  return sk.requestSubkey(holder.deps, requester(), { tag }, registry, new Date('2026-10-15T16:00:00Z'));
}
function cookiePair(setCookie) {
  assert.ok(setCookie, 'expected a session cookie');
  return setCookie.split(';')[0];
}
async function login(passphrase, { proto } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (proto) headers['x-forwarded-proto'] = proto;
  return fetch(`${base}/owner/approvals/login`, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: new URLSearchParams({ passphrase }).toString()
  });
}
function assertPageHeaders(res) {
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
}
async function authed() {
  const res = await login(SECRET, { proto: 'https' });
  assert.equal(res.status, 303);
  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\/owner/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /Max-Age=900/);
  const cookie = cookiePair(setCookie);
  const page = await fetch(`${base}/owner/approvals`, { headers: { cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assertPageHeaders(page);
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
  assert.ok(csrf, 'csrf field missing');
  return { cookie, csrf: csrf[1], html };
}
async function decide(cookie, fields) {
  return fetch(`${base}/owner/approvals/decide`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  });
}
function ownerCaller() {
  return {
    personId: OWNER, ownerId: OWNER, clientId: 'host', grantId: 'host-grant',
    transport: 'http', authenticated: true, sourceTag: 'cowork-cloud', sourceBasis: 'login'
  };
}

try {
  await testGroup('owner approval page', async () => {
    await test('no passphrase or a wrong one is refused', async () => withEnv(ON, async () => {
      freshHolder();
      const empty = await login('');
      assert.equal(empty.status, 401);
      assert.equal(empty.headers.get('set-cookie'), null);
      assert.match(await empty.text(), /Incorrect passphrase/);
      const wrong = await login('nope');
      assert.equal(wrong.status, 401);
      assert.equal(wrong.headers.get('set-cookie'), null);
      for (let i = 0; i < 3; i++) assert.equal((await login('nope')).status, 401);
      const limited = await login('nope');
      assert.equal(limited.status, 429);
      assert.match(limited.headers.get('retry-after') || '', /^[1-9]/);
      assert.equal(limited.headers.get('set-cookie'), null);
    }));

    await test('an approval with the passphrase works', async () => withEnv(ON, async () => {
      freshHolder();
      const pending = await requestPending('intake-bot');
      const denied = await requestPending('cowork-cloud');
      const { cookie, csrf, html } = await authed();
      assert.match(html, /intake-bot/);
      assert.match(html, new RegExp(pending.key_id.slice(0, 8)));
      assert.match(html, /2026-10-15T16:00:00.000Z/);
      assert.match(html, />Approve</);
      assert.match(html, />Deny</);
      assert.match(html, /name="reason"/);
      const res = await decide(cookie, { csrf, key_id: pending.key_id, decision: 'approve', reason: 'ship it' });
      const body = await res.text();
      assert.equal(res.status, 200, body);
      assert.match(body, /Approved intake-bot/);
      const deniedRes = await decide(cookie, { csrf, key_id: denied.key_id, decision: 'deny' });
      assert.equal(deniedRes.status, 200);
      assert.match(await deniedRes.text(), /Denied cowork-cloud/);
      const sk = await import('../src/subkeys.js');
      const data = await sk.loadSubkeyRecords(holder.deps);
      assert.equal(data.keys[pending.key_id].status, 'approved');
      assert.equal(data.keys[denied.key_id].status, 'denied');
      const approved = data.keys[pending.key_id].history.find((e) => e.event === 'approve');
      assert.equal(approved.via, 'owner_page');
      assert.equal(approved.by, `owner (${OWNER})`);
      assert.equal(approved.reason, 'ship it');
      const deniedEv = data.keys[denied.key_id].history.find((e) => e.event === 'deny');
      assert.equal(deniedEv.via, 'owner_page');
      assert.equal(deniedEv.by, `owner (${OWNER})`);
      assert.equal(deniedEv.reason, undefined);
      assert.equal(JSON.stringify(data).includes(SECRET), false);
      const plain = await login(SECRET);
      assert.equal(plain.status, 303);
      assert.doesNotMatch(plain.headers.get('set-cookie') || '', /Secure/);
    }));

    await test('a reason longer than 500 characters is refused', async () => withEnv(ON, async () => {
      freshHolder();
      const pending = await requestPending('intake-bot');
      const { cookie, csrf } = await authed();
      const res = await decide(cookie, { csrf, key_id: pending.key_id, decision: 'approve', reason: 'x'.repeat(501) });
      const body = await res.text();
      assert.equal(res.status, 400, body);
      assert.match(body, /too long/);
      const sk = await import('../src/subkeys.js');
      assert.equal((await sk.loadSubkeyRecords(holder.deps)).keys[pending.key_id].status, 'pending');
    }));

    await test('CSRF is refused', async () => withEnv(ON, async () => {
      freshHolder();
      const pending = await requestPending('intake-bot');
      const { cookie, csrf } = await authed();
      const missing = await decide(cookie, { key_id: pending.key_id, decision: 'approve' });
      assert.equal(missing.status, 403);
      const wrong = await decide(cookie, { csrf: '0'.repeat(64), key_id: pending.key_id, decision: 'approve' });
      assert.equal(wrong.status, 403);
      const swapped = csrf.slice(1) + (csrf[0] === 'a' ? 'b' : 'a');
      const mismatch = await decide(cookie, { csrf: swapped, key_id: pending.key_id, decision: 'deny' });
      assert.equal(mismatch.status, 403);
      const sk = await import('../src/subkeys.js');
      assert.equal((await sk.loadSubkeyRecords(holder.deps)).keys[pending.key_id].status, 'pending');
    }));

    await test('a non-pending key is refused', async () => withEnv(ON, async () => {
      freshHolder();
      const pending = await requestPending('intake-bot');
      const other = await requestPending('cowork-cloud');
      const sk = await import('../src/subkeys.js');
      await sk.decideSubkeyIfPending(holder.deps, ownerCaller(), OWNER, { tag: 'cowork-cloud', decision: 'approve' });
      const { cookie, csrf } = await authed();
      const unknown = await decide(cookie, { csrf, key_id: 'a'.repeat(32), decision: 'approve' });
      assert.equal(unknown.status, 400);
      assert.match(await unknown.text(), /not awaiting approval/);
      const decided = await decide(cookie, { csrf, key_id: other.key_id, decision: 'deny' });
      const decidedBody = await decided.text();
      assert.equal(decided.status, 400, decidedBody);
      assert.match(decidedBody, /not awaiting approval/);
      const data = await sk.loadSubkeyRecords(holder.deps);
      assert.equal(data.keys[pending.key_id].status, 'pending');
      assert.equal(data.keys[other.key_id].status, 'approved');
    }));

    await test('a key id that is not the pending row is refused', async () => withEnv(ON, async () => {
      freshHolder();
      const first = await requestPending('intake-bot');
      const other = await requestPending('cowork-cloud');
      const sk = await import('../src/subkeys.js');
      const missed = await sk.decideSubkeyIfPending(holder.deps, ownerCaller(), OWNER, {
        tag: 'intake-bot', key_id: 'b'.repeat(32), decision: 'approve'
      });
      assert.equal(missed, null);
      await assert.rejects(
        () => sk.decideSubkeyIfPending(holder.deps, ownerCaller(), OWNER, {
          tag: 'intake-bot', key_id: other.key_id, decision: 'approve'
        }),
        /does not match the tag/
      );
      await sk.decideSubkeyIfPending(holder.deps, ownerCaller(), OWNER, { tag: 'intake-bot', decision: 'approve' });
      const again = await requestPending('intake-bot');
      const { cookie, csrf } = await authed();
      const stale = await decide(cookie, { csrf, key_id: first.key_id, decision: 'deny' });
      assert.equal(stale.status, 400);
      assert.match(await stale.text(), /not awaiting approval/);
      const data = await sk.loadSubkeyRecords(holder.deps);
      assert.equal(data.keys[first.key_id].status, 'approved');
      assert.equal(data.keys[again.key_id].status, 'pending');
      assert.equal(data.keys[other.key_id].status, 'pending');
    }));

    await test('a tag is escaped, and a session expires', async () => withEnv(ON, async () => {
      freshHolder();
      const tag = `a<b>&"'`;
      const pending = await requestPending(tag, [...REG, tag]);
      const { cookie, csrf, html } = await authed();
      assert.match(html, /a&lt;b&gt;&amp;&quot;&#39;/);
      assert.equal(html.includes('<b>'), false);
      assert.equal(html.includes(`value="${tag}"`), false);
      clock.t += SESSION_MS;
      const expired = await fetch(`${base}/owner/approvals`, { headers: { cookie } });
      assert.match(await expired.text(), /Enter the owner passphrase/);
      const res = await decide(cookie, { csrf, key_id: pending.key_id, decision: 'approve' });
      assert.equal(res.status, 401);
      const sk = await import('../src/subkeys.js');
      assert.equal((await sk.loadSubkeyRecords(holder.deps)).keys[pending.key_id].status, 'pending');
    }));

    await test('the login page sends no-store and frame-ancestors', async () => withEnv(ON, async () => {
      freshHolder();
      const page = await fetch(`${base}/owner/approvals`);
      assert.equal(page.status, 200);
      assertPageHeaders(page);
      assert.match(await page.text(), /Enter the owner passphrase/);
    }));

    await test('a store failure uses a fixed message', async () => withEnv(ON, async () => {
      freshHolder();
      await requestPending('intake-bot');
      const { cookie } = await authed();
      holder.deps.subkeys.snapshot = async () => { throw new Error('secret-mongo-uri'); };
      const page = await fetch(`${base}/owner/approvals`, { headers: { cookie } });
      const text = await page.text();
      assert.equal(page.status, 503);
      assert.match(text, /The sub-key store is unavailable/);
      assert.equal(text.includes('secret-mongo-uri'), false);
    }));

    await test('the flag off returns the same 404 as any other unknown path', async () => withEnv(OFF, async () => {
      assert.notEqual(setting('SUBKEYS'), '1');
      const off = express();
      const offServer = await new Promise((resolve) => { const s = off.listen(0, '127.0.0.1', () => resolve(s)); });
      const offBase = `http://127.0.0.1:${offServer.address().port}`;
      try {
        const hit = (path, method = 'GET') => fetch(`${offBase}${path}`, {
          method,
          headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
          body: method === 'POST' ? 'passphrase=secret&decision=approve' : undefined
        });
        const owner = await hit('/owner/approvals');
        const other = await hit('/no-such-route');
        assert.equal(owner.status, 404);
        assert.equal(owner.status, other.status);
        assert.equal(await owner.text(), (await other.text()).replaceAll('/no-such-route', '/owner/approvals'));
        const posted = await hit('/owner/approvals/login', 'POST');
        const postedOther = await hit('/no-such-route', 'POST');
        assert.equal(posted.status, 404);
        assert.equal(await posted.text(), (await postedOther.text()).replaceAll('/no-such-route', '/owner/approvals/login'));
        assert.equal(posted.headers.get('set-cookie'), null);
      } finally {
        offServer.close();
      }
    }));

    await test('emet_client_approve still refuses a login deciding its own sub-key tag', async () => withEnv(ON, async () => {
      freshHolder();
      const pending = await requestPending('intake-bot');
      const att = await import('../src/attribution.js');
      att._resetForTests();
      const actor = {
        personId: OWNER, ownerId: OWNER, clientId: 'other-client', grantId: 'other-grant',
        transport: 'http', authenticated: true, sourceTag: 'intake-bot', sourceBasis: 'login'
      };
      await assert.rejects(
        () => att.clientApprove(holder.deps, actor, OWNER, { tag: 'intake-bot', decision: 'approve' }),
        /may not decide its own approval/
      );
      const sk = await import('../src/subkeys.js');
      assert.equal((await sk.loadSubkeyRecords(holder.deps)).keys[pending.key_id].status, 'pending');
    }));
  });
} finally {
  server.close();
}

summary('owner approval page');
