/**
 * R4 chooser, refusal deep links, and break-glass.
 * Expiry, replay, cross-scope, owner-only grants, and AI-free recovery.
 */

import assert from 'node:assert/strict';
import express from 'express';
import { test, testGroup, summary } from './harness.js';
import { makeStore, withEnv, withStore } from './memstore.js';
import { createMemoryStore } from '../src/subkey-store.js';
import { ApproveThrottle, DEFAULT_MAX_FAILURES } from '../src/approve-throttle.js';
import { MongoOAuthProvider } from '../src/oauth-provider.js';
import { RateLimiter } from '../src/tools.js';
import { handleError } from '../src/tools.js';
import { ValidationError } from '../src/validation.js';
import {
  _resetDeepLinksForTests, mintDeepLink, presentDeepLink, deepLinkContainsRaw,
  deepLinkTtlMs, setChooserPublicUrl, setInstanceIdForTests, currentInstanceId,
  accessDecisions, breakGlassMetric, breakGlassStartupLine, noteBreakGlassUse
} from '../src/deep-links.js';
import { mountChooser, _resetChooserForTests } from '../src/chooser.js';
import { mountBreakGlass, _resetBreakGlassForTests, breakGlassAuthorized, retainedRevocations } from '../src/break-glass.js';
import { mountOwnerApprovals } from '../src/owner-approvals.js';
import { createOwnerGate, ownerMayGrant, SESSION_MS } from '../src/owner-session.js';
import { DEEP_LINK, OWL_KILL } from '../src/grants.js';
import { guardClaimedTag, _resetClaimedTagForTests } from '../src/claimed-tag.js';

console.log('\n=== R4 chooser and break-glass ===');

const SECRET = 'owner-secret-value';
const PEPPER = 'pepper-pepper-pepper-pepper-pepper-32b';
const OWNER = 'alex';
const REG = ['hub-bot', 'intake-bot', 'cowork-cloud'];
const ON = {
  EMET_SUBKEYS: '1',
  EMET_SUBKEY_PEPPER: PEPPER,
  EMET_SOURCE_TAGS: REG.join(','),
  EMET_RECORD_DOCS: 'bots/hub-bot/HANDOFF.md,bots/intake-bot/HANDOFF.md',
  EMET_OAUTH_PASSPHRASE: SECRET,
  EMET_DEEP_LINK_TTL_MINUTES: undefined
};

const provider = new MongoOAuthProvider(() => holder.db, { passphrase: SECRET, cimd: false });
const throttle = new ApproveThrottle();
const clock = { t: Date.now() };
const holder = { deps: null, db: null };
const rateLimiter = new RateLimiter(null);
const gate = createOwnerGate({
  checkPassphrase: (input) => provider.checkPassphrase(input),
  throttle,
  now: () => clock.t
});
const app = express();
app.set('trust proxy', 1);
const human = {
  gate,
  throttle,
  deps: () => holder.deps,
  ownerId: OWNER,
  db: () => holder.db,
  provider,
  prefix: 'emet_',
  rateLimiter,
  now: () => clock.t
};
mountChooser(app, human);
mountBreakGlass(app, human);
mountOwnerApprovals(app, human);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

function reset() {
  _resetDeepLinksForTests();
  _resetChooserForTests();
  _resetBreakGlassForTests();
  clock.t = Date.now();
  holder.deps = { subkeys: createMemoryStore() };
  holder.db = null;
  setChooserPublicUrl('https://railway-emet.example');
  for (const ip of [...throttle.failures.keys()]) throttle.recordSuccess(ip);
}
function cookiePair(setCookie) {
  assert.ok(setCookie, 'expected a cookie');
  return setCookie.split(';')[0];
}
function cookiesOf(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return raw.map((row) => row.split(';')[0]).filter(Boolean).join('; ');
}
async function postLogin(passphrase, next = '/owner/break-glass') {
  return fetch(`${base}/owner/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passphrase, next }).toString()
  });
}
async function login(next, { proto } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (proto) headers['x-forwarded-proto'] = proto;
  return fetch(`${base}/owner/login`, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body: new URLSearchParams({ passphrase: SECRET, next }).toString()
  });
}
async function ownerCookie() {
  const res = await login('/owner/chooser', { proto: 'https' });
  assert.equal(res.status, 303, await res.text());
  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Secure/);
  return cookiePair(setCookie);
}
function quiet(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.join(' ')); };
  const done = (value) => ({ value, lines });
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then((value) => done(value)).finally(() => { console.error = orig; });
    }
    console.error = orig;
    return Promise.resolve(done(out));
  } catch (e) {
    console.error = orig;
    throw e;
  }
}
function memApprovals(initial) {
  const store = { content: initial, version: initial == null ? null : 1 };
  return {
    readDoc: async () => {
      if (store.content == null) throw new Error('Document not found: emet/CLIENT_APPROVALS.md');
      return { content: store.content, version: store.version };
    },
    writeDoc: async (_id, content, expected) => {
      if ((expected ?? null) !== (store.version ?? null)) {
        const err = new Error('conflict');
        err.versionConflict = true;
        throw err;
      }
      store.content = content;
      store.version = (store.version || 0) + 1;
      return { version: store.version };
    }
  };
}

try {
  await testGroup('deep links', async () => {
    await test('the proposed TTL is 15 minutes and a bad setting does not lengthen it', () => withEnv(ON, () => {
      reset();
      assert.strictEqual(DEEP_LINK.ttl_ms, 15 * 60 * 1000);
      assert.match(DEEP_LINK.ttl_proposal, /15 minutes/);
      assert.strictEqual(deepLinkTtlMs(), 15 * 60 * 1000);
      return withEnv({ EMET_DEEP_LINK_TTL_MINUTES: '99999' }, () => {
        assert.strictEqual(deepLinkTtlMs(), 15 * 60 * 1000);
      });
    }));

    await test('an expired token is refused', () => {
      reset();
      const minted = mintDeepLink({ kind: 'deny', grant_id: 'fam-1', tag: 'intake', door: 'guest', correlationId: 'abcdefabcdefabcd', now: 1_000, ttlMs: 1_000 });
      const expired = presentDeepLink(minted.token, {}, 2_000);
      assert.equal(expired.ok, false);
      assert.equal(expired.reason, 'expired');
    });

    await test('a replayed token is refused', () => {
      reset();
      const minted = mintDeepLink({ kind: 'deny', grant_id: 'fam-1', tag: 'intake', door: 'guest', now: 5_000, ttlMs: 60_000 });
      const first = presentDeepLink(minted.token, {}, 5_000);
      assert.equal(first.ok, true);
      const again = presentDeepLink(minted.token, {}, 5_100);
      assert.equal(again.ok, false);
      assert.equal(again.reason, 'replay');
      assert.equal(deepLinkContainsRaw(minted.token), false);
    });

    await test('a token used against another instance, client, tag, or door is refused', () => {
      reset();
      const here = currentInstanceId();
      const minted = mintDeepLink({ kind: 'rename_pending', grant_id: 'fam-1', tag: 'intake', door: 'guest', now: 5_000, ttlMs: 60_000 });
      setInstanceIdForTests('other-instance');
      const wrongInstance = presentDeepLink(minted.token, {}, 5_000);
      assert.equal(wrongInstance.reason, 'wrong_instance');
      setInstanceIdForTests(here);
      const stillGood = presentDeepLink(minted.token, {}, 5_000);
      assert.equal(stillGood.ok, true, 'a wrong instance does not consume the link');

      const client = mintDeepLink({ kind: 'deny', grant_id: 'fam-1', tag: 'intake', door: 'guest', now: 5_000, ttlMs: 60_000 });
      assert.equal(presentDeepLink(client.token, { grantId: 'fam-2' }, 5_000).reason, 'wrong_scope');
      assert.equal(presentDeepLink(client.token, {}, 5_000).reason, 'replay');

      const tag = mintDeepLink({ kind: 'deny', grant_id: 'fam-1', tag: 'intake', door: 'guest', now: 5_000, ttlMs: 60_000 });
      assert.equal(presentDeepLink(tag.token, { tag: 'other' }, 5_000).reason, 'wrong_scope');

      const door = mintDeepLink({ kind: 'onboarding_required', grant_id: 'fam-1', tag: 'intake', door: 'guest', now: 5_000, ttlMs: 60_000 });
      assert.equal(presentDeepLink(door.token, { door: 'owner' }, 5_000).reason, 'wrong_scope');
    });

    await test('a refusal payload carries the link, the reason, and the correlation id', () => {
      reset();
      const err = new ValidationError('source', '"intake" was denied as a client on this store; it may read only. Nothing was written.', { code: 'EMET-AUTH-039' });
      err.chooser = { kind: 'deny', grant_id: 'fam-deny-1', tag: 'intake', door: 'member' };
      const res = handleError(err, 'save_to_layer');
      const body = JSON.parse(res.content[0].text);
      assert.match(body.error.correlation_id, /^[0-9a-f]{16}$/);
      assert.match(body.error.message, /denied as a client/);
      assert.match(body.error.chooser_url, /^https:\/\/railway-emet\.example\/owner\/chooser\?d=[A-Za-z0-9_-]+$/);
      assert.ok(body.error.message.includes(body.error.chooser_url));
      assert.ok(body.error.message.includes(body.error.correlation_id));
      assert.equal(body.error.message.includes(SECRET), false);
      const token = new URL(body.error.chooser_url).searchParams.get('d');
      assert.equal(deepLinkContainsRaw(token), false);
      assert.equal(presentDeepLink(token, {}, Date.now()).ok, true);
      assert.equal(presentDeepLink(token, {}, Date.now()).reason, 'replay');
    });

    await test('a claimed-tag refusal after the kill date carries a link bound to unknown', () => withEnv({ ...ON, EMET_CLAIMED_TAG_KILL_DATE: '2020-01-01' }, () => {
      reset();
      _resetClaimedTagForTests();
      let thrown = null;
      try {
        guardClaimedTag({ transport: 'http', grant_id: null, sourceFrom: 'declared', caller: 'intake', tool: 'write_doc', now: new Date('2026-10-27T00:00:00Z') });
      } catch (e) { thrown = e; }
      assert.equal(thrown.emetCode, 'EMET-AUTH-040');
      assert.equal(thrown.chooser.kind, 'claimed_tag');
      assert.equal(thrown.chooser.grant_id, 'unknown');
      const res = handleError(thrown, 'write_doc');
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.error.emet_code, 'EMET-AUTH-040');
      assert.match(body.error.message, /Nothing was written/);
      assert.match(body.error.chooser_url, /\/owner\/chooser\?d=/);
      const token = new URL(body.error.chooser_url).searchParams.get('d');
      const opened = presentDeepLink(token, {}, Date.now());
      assert.equal(opened.ok, true);
      assert.equal(opened.binding.grant_id, 'unknown');
      assert.equal(opened.binding.tag, 'intake');
      assert.equal(opened.binding.door, 'guest');
    }));
  });

  await testGroup('chooser', async () => {
    await test('a non-owner cannot grant owner or member', async () => {
      reset();
      assert.equal(ownerMayGrant(null, 'owner'), false);
      assert.equal(ownerMayGrant(null, 'member'), false);
      assert.equal(ownerMayGrant({ csrf: 'abc' }, 'owner'), true);
      const ownerPost = await fetch(`${base}/owner/chooser/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'owner', tag: 'intake' }).toString()
      });
      assert.equal(ownerPost.status, 401);
      const memberPost = await fetch(`${base}/owner/chooser/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'member', tag: 'intake' }).toString()
      });
      assert.equal(memberPost.status, 401);
      assert.equal(accessDecisions().some((row) => row.decision === 'owner' || row.decision === 'member'), false);
    });

    await test('guest is the default, and the decision log records the grant id', async () => {
      reset();
      const minted = mintDeepLink({
        kind: 'onboarding_required', grant_id: 'fam-choos-1', tag: 'intake', door: 'guest',
        correlationId: '0123456789abcdef', now: Date.now(), ttlMs: 60_000
      });
      const opened = await fetch(minted.url.replace('https://railway-emet.example', base), { redirect: 'manual' });
      assert.equal(opened.status, 303);
      const chooserCookie = cookiesOf(opened);
      const again = await fetch(minted.url.replace('https://railway-emet.example', base), { redirect: 'manual' });
      assert.equal(again.status, 400);
      assert.match(await again.text(), /already used/);
      const owner = await ownerCookie();
      const page = await fetch(`${base}/owner/chooser`, { headers: { cookie: `${owner}; ${chooserCookie}` } });
      const html = await page.text();
      assert.equal(page.status, 200, html);
      assert.match(html, /value="guest" checked/);
      assert.match(html, /fam-choos-1/);
      assert.match(html, /0123456789abcdef/);
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)[1];
      const posted = await fetch(`${base}/owner/chooser/decide`, {
        method: 'POST',
        headers: { cookie: `${owner}; ${chooserCookie}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf, bind_grant: 'fam-choos-1', bind_tag: 'intake', bind_door: 'guest'
        }).toString()
      });
      const body = await posted.text();
      assert.equal(posted.status, 200, body);
      assert.match(body, /Recorded guest/);
      const row = accessDecisions().find((item) => item.grant_id === 'fam-choos-1');
      assert.ok(row, JSON.stringify(accessDecisions()));
      assert.equal(row.decision, 'guest');
      assert.equal(row.correlation_id, '0123456789abcdef');
      assert.equal(row.decider, OWNER);
      assert.equal(JSON.stringify(accessDecisions()).includes(SECRET), false);
    });

    await test('a posted door, client, or tag other than the link is refused', async () => {
      reset();
      const minted = mintDeepLink({
        kind: 'deny', grant_id: 'fam-scope-1', tag: 'intake', door: 'guest',
        correlationId: 'fedcba9876543210', now: Date.now(), ttlMs: 60_000
      });
      const opened = await fetch(minted.url.replace('https://railway-emet.example', base), { redirect: 'manual' });
      const chooserCookie = cookiesOf(opened);
      const owner = await ownerCookie();
      const page = await fetch(`${base}/owner/chooser`, { headers: { cookie: `${owner}; ${chooserCookie}` } });
      const html = await page.text();
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)[1];
      const tampered = await fetch(`${base}/owner/chooser/decide`, {
        method: 'POST',
        headers: { cookie: `${owner}; ${chooserCookie}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf, decision: 'owner', bind_grant: 'fam-other', bind_tag: 'intake', bind_door: 'guest'
        }).toString()
      });
      assert.equal(tampered.status, 403);
      assert.match(await tampered.text(), /different client, tag, or door/);
      assert.equal(accessDecisions().some((row) => row.decision === 'owner'), false);
      const badDoor = await fetch(`${base}/owner/chooser/decide`, {
        method: 'POST',
        headers: { cookie: `${owner}; ${chooserCookie}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          csrf, decision: 'member', bind_grant: 'fam-scope-1', bind_tag: 'not-intake', bind_door: 'owner'
        }).toString()
      });
      assert.equal(badDoor.status, 403);
    });

    await test('deny and rename_pending refusals carry a chooser binding', async () => {
      reset();
      const att = await import('../src/attribution.js');
      att._resetForTests();
      const deniedDoc = att.renderApprovals({
        approved: {}, pending: {}, denied: { intake: { by: 'owner', at: '2026-01-01T00:00:00.000Z' } }, clients: {}
      });
      const actor = {
        personId: OWNER, ownerId: OWNER, clientId: 'bot', grantId: 'fam-deny-1', door: 'member',
        transport: 'http', authenticated: true, sourceTag: 'cowork-cloud', sourceBasis: 'login'
      };
      await assert.rejects(
        () => att.preflight({ db: null, deps: memApprovals(deniedDoc), registry: ['cowork-cloud'], ownerId: OWNER }, actor, { source: 'intake' }, 'save_to_layer'),
        (e) => e.chooser && e.chooser.kind === 'deny' && e.chooser.grant_id === 'fam-deny-1' && e.chooser.door === 'member'
      );
      att._resetForTests();
      const renameDoc = att.renderApprovals({
        approved: { 'old-tag': { client_id: 'bot', at: '2026-01-01T00:00:00.000Z' } },
        pending: {}, denied: {},
        clients: { bot: { tags: { 'old-tag': { declared_name: 'old-tag' } } } }
      });
      await assert.rejects(
        () => att.preflight({ db: null, deps: memApprovals(renameDoc), registry: ['cowork-cloud'], ownerId: OWNER }, actor, { source: 'new-name' }, 'save_to_layer'),
        (e) => e.chooser && e.chooser.kind === 'rename_pending' && e.chooser.tag === 'new-name'
      );
    });

    await test('a legacy approval stays readable and a pending one is listed on the chooser', async () => withEnv(ON, async () => {
      reset();
      const sk = await import('../src/subkeys.js');
      const asker = {
        personId: OWNER, ownerId: OWNER, clientId: 'bot-client', grantId: 'bot-grant',
        transport: 'http', authenticated: true, sourceTag: 'hub-bot', sourceBasis: 'login'
      };
      const kept = await sk.requestSubkey(holder.deps, asker, { tag: 'intake-bot' }, REG, new Date('2026-10-15T16:00:00Z'));
      await sk.decideSubkeyIfPending(holder.deps, {
        personId: OWNER, ownerId: OWNER, clientId: null, grantId: null,
        transport: 'http', authenticated: true, sourceTag: 'owner', sourceBasis: 'login'
      }, OWNER, { key_id: kept.key_id, decision: 'approve', via: 'owner_page' }, new Date('2026-10-15T17:00:00Z'));
      const pending = await sk.requestSubkey(holder.deps, asker, { tag: 'cowork-cloud' }, REG, new Date('2026-10-16T16:00:00Z'));
      const owner = await ownerCookie();
      const page = await fetch(`${base}/owner/chooser`, { headers: { cookie: owner } });
      const html = await page.text();
      assert.equal(page.status, 200, html);
      assert.match(html, /intake-bot/);
      assert.match(html, /owner_page/);
      assert.match(html, /approved/);
      assert.match(html, /cowork-cloud/);
      assert.match(html, />Approve</);
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)[1];
      const decided = await fetch(`${base}/owner/chooser/subkey`, {
        method: 'POST',
        headers: { cookie: owner, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, key_id: pending.key_id, decision: 'deny', reason: 'not yet' }).toString()
      });
      assert.equal(decided.status, 200, await decided.clone().text());
      const data = await sk.loadSubkeyRecords(holder.deps);
      assert.equal(data.keys[kept.key_id].status, 'approved');
      assert.equal(data.keys[kept.key_id].history.some((ev) => ev.via === 'owner_page'), true);
      assert.equal(data.keys[pending.key_id].status, 'denied');
      assert.equal(data.keys[pending.key_id].history.some((ev) => ev.via === 'owner_chooser'), true);
      const retired = await fetch(`${base}/owner/approvals`);
      assert.equal(retired.status, 410);
      assert.match(await retired.text(), /\/owner\/chooser/);
      assert.equal((await sk.loadSubkeyRecords(holder.deps)).keys[kept.key_id].status, 'approved');
    }));

    await test('a session expires, and a bad CSRF grants nothing', async () => {
      reset();
      const owner = await ownerCookie();
      const page = await fetch(`${base}/owner/chooser`, { headers: { cookie: owner } });
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await page.text())[1];
      clock.t += SESSION_MS;
      const expired = await fetch(`${base}/owner/chooser/decide`, {
        method: 'POST',
        headers: { cookie: owner, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, decision: 'owner', tag: 'intake' }).toString()
      });
      assert.equal(expired.status, 401);
      clock.t = Date.now();
      const fresh = await ownerCookie();
      const again = await fetch(`${base}/owner/chooser`, { headers: { cookie: fresh } });
      const csrf2 = /name="csrf" value="([0-9a-f]{64})"/.exec(await again.text())[1];
      const bad = await fetch(`${base}/owner/chooser/decide`, {
        method: 'POST',
        headers: { cookie: fresh, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: '0'.repeat(64), decision: 'member', tag: 'intake' }).toString()
      });
      assert.equal(bad.status, 403);
      assert.equal(csrf2.length, 64);
      assert.equal(accessDecisions().some((row) => row.decision === 'owner' || row.decision === 'member'), false);
    });
  });

  await testGroup('break-glass', async () => {
    await test('a member or guest grant does not authorize break-glass', () => {
      assert.equal(breakGlassAuthorized(null, 'member'), false);
      assert.equal(breakGlassAuthorized(null, 'guest'), false);
      assert.equal(breakGlassAuthorized({ csrf: 'abc' }, 'member'), false);
      assert.equal(breakGlassAuthorized({ csrf: 'abc' }), true);
    });

    await test('the owner recovers from a browser when every AI grant is locked out', async () => withEnv(ON, async () => {
      reset();
      holder.db = makeStore();
      const tokens = holder.db.collection('emet_oauth_tokens');
      await tokens.insertOne({
        token: 'digest-secret-value-not-a-grant', hashed: true, kind: 'access', client_id: 'bot-client',
        family: 'fam-keep-1', issued_via: 'invite', source_tag: 'guest-tag', scopes: ['emet.read']
      });
      await tokens.insertOne({
        token: 'other-digest-secret-value', hashed: true, kind: 'access', client_id: 'bot-client',
        family: 'fam-drop-1', issued_via: 'member', source_tag: 'member-tag', scopes: ['emet.read', 'emet.write']
      });
      for (let i = 0; i < 30; i++) rateLimiter.recordRequest('emet_status', 'ai|bot');
      assert.equal(rateLimiter.checkLimit('emet_status', 'ai|bot').allowed, false);

      const { lines } = await quiet(async () => {
        const locked = await fetch(`${base}/owner/break-glass`, {
          headers: { authorization: 'Bearer member-grant-token-value' }
        });
        const lockedHtml = await locked.text();
        assert.equal(locked.status, 401);
        assert.match(lockedHtml, /passphrase/i);
        assert.equal(lockedHtml.includes('fam-keep-1'), false);
        assert.equal(lockedHtml.includes('digest-secret-value'), false);
        const signed = await login('/owner/break-glass');
        assert.equal(signed.status, 303);
        const cookie = cookiePair(signed.headers.get('set-cookie'));
        const page = await fetch(`${base}/owner/break-glass`, { headers: { cookie } });
        const html = await page.text();
        assert.equal(page.status, 200, html);
        assert.match(html, /fam-keep-1/);
        assert.match(html, /fam-drop-1/);
        assert.equal(html.includes('digest-secret-value'), false);
        assert.equal(html.includes(SECRET), false);
        assert.match(html, /value="guest" checked/);
        const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)[1];
        const all = await fetch(`${base}/owner/break-glass/revoke`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, grant_id: '*' }).toString()
        });
        assert.equal(all.status, 400);
        assert.equal((await tokens.find({ family: 'fam-keep-1' }).toArray()).length, 1);
        assert.equal((await tokens.find({ family: 'fam-drop-1' }).toArray()).length, 1);
        const dropped = await fetch(`${base}/owner/break-glass/revoke`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, grant_id: 'fam-drop-1' }).toString()
        });
        const droppedHtml = await dropped.text();
        assert.equal(dropped.status, 200, droppedHtml);
        assert.match(droppedHtml, /Revoked fam-drop-1/);
        assert.match(droppedHtml, /fam-keep-1/);
        assert.equal((await tokens.find({ family: 'fam-drop-1' }).toArray()).length, 0);
        assert.equal((await tokens.find({ family: 'fam-keep-1' }).toArray()).length, 1);
        assert.equal(retainedRevocations().some((row) => row.grant_id === 'fam-drop-1' && row.retained === true), true);
        const cleared = await fetch(`${base}/owner/break-glass/clear`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, scope: 'tools' }).toString()
        });
        assert.equal(cleared.status, 200, await cleared.text());
        assert.equal(rateLimiter.checkLimit('emet_status', 'ai|bot').allowed, true);
        const reissued = await fetch(`${base}/owner/break-glass/reissue`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, door: 'owner', tag: 'alex' }).toString()
        });
        const reissueHtml = await reissued.text();
        assert.equal(reissued.status, 200, reissueHtml);
        assert.match(reissueHtml, /did not mint a token/);
        assert.equal(JSON.stringify(accessDecisions()).includes(SECRET), false);
      });
      const joined = lines.join('\n');
      assert.equal(joined.includes(SECRET), false);
      assert.equal(joined.includes('digest-secret-value'), false);
      assert.match(joined, /break-glass action=view/);
      assert.match(joined, /action=revoke/);
      assert.match(joined, /action=reissue/);
      assert.match(joined, /action=clear_tool_lockout/);
      assert.ok(breakGlassMetric().uses >= 1);
      assert.equal(breakGlassMetric().path, '/owner/break-glass');
      assert.equal(breakGlassMetric().rung, 'R4');
      assert.match(breakGlassStartupLine(), /\/owner\/break-glass/);
      assert.equal(OWL_KILL.implemented, true);
      assert.equal(OWL_KILL.delete_wiring, false);
    }));

    await test('bad passphrases on /owner/login return 429, and clear_address allows login again', async () => {
      reset();
      const cookie = await ownerCookie();
      const page = await fetch(`${base}/owner/break-glass`, { headers: { cookie } });
      const html = await page.text();
      assert.equal(page.status, 200, html);
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)[1];
      for (let i = 0; i < DEFAULT_MAX_FAILURES; i++) {
        const bad = await postLogin('nope');
        assert.equal(bad.status, 401, `attempt ${i + 1}`);
        assert.equal(bad.headers.get('set-cookie'), null);
      }
      const limited = await postLogin('nope');
      assert.equal(limited.status, 429);
      assert.match(limited.headers.get('retry-after') || '', /^[1-9]/);
      assert.equal(limited.headers.get('set-cookie'), null);
      const blocked = await postLogin(SECRET);
      assert.equal(blocked.status, 429);
      const lockedIp = [...throttle.failures.keys()][0];
      assert.equal(typeof lockedIp, 'string');
      assert.ok(lockedIp.length > 0);
      const cleared = await fetch(`${base}/owner/break-glass/clear`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, scope: 'address', ip: lockedIp }).toString()
      });
      const clearedHtml = await cleared.text();
      assert.equal(cleared.status, 200, clearedHtml);
      assert.match(clearedHtml, /cleared for that address/);
      const again = await postLogin(SECRET);
      assert.equal(again.status, 303);
      assert.match(again.headers.get('set-cookie') || '', /emet_owner=/);
    });

    await test('break-glass posts without an owner session are refused', async () => {
      reset();
      for (const path of ['/owner/break-glass/revoke', '/owner/break-glass/reissue', '/owner/break-glass/clear', '/owner/break-glass/rotate-all', '/owner/break-glass/revoke-member']) {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf: 'abc', grant_id: 'fam-keep-1', door: 'guest', tag: 'intake', scope: 'tools' }).toString()
        });
        assert.equal(res.status, 401, path);
      }
    });

    await test('break-glass actions are rate-limited', async () => {
      reset();
      const limited = express();
      limited.set('trust proxy', 1);
      const localGate = createOwnerGate({
        checkPassphrase: (input) => provider.checkPassphrase(input),
        throttle,
        now: () => clock.t
      });
      mountBreakGlass(limited, { ...human, gate: localGate, actionMax: 2, db: () => null });
      const localServer = await new Promise((resolve) => { const s = limited.listen(0, '127.0.0.1', () => resolve(s)); });
      const localBase = `http://127.0.0.1:${localServer.address().port}`;
      try {
        const signed = await fetch(`${localBase}/owner/login`, {
          method: 'POST', redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ passphrase: SECRET, next: '/owner/break-glass' }).toString()
        });
        const cookie = cookiePair(signed.headers.get('set-cookie'));
        const first = await fetch(`${localBase}/owner/break-glass`, { headers: { cookie } });
        assert.equal(first.status, 200);
        const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await first.text())[1];
        const second = await fetch(`${localBase}/owner/break-glass/revoke`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, grant_id: 'fam-keep-1' }).toString()
        });
        assert.notEqual(second.status, 429);
        const third = await fetch(`${localBase}/owner/break-glass`, { headers: { cookie } });
        assert.equal(third.status, 429);
      } finally {
        localServer.close();
      }
    });

    await test('emet_status carries the break-glass metric', async () => {
      reset();
      process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
      const before = breakGlassMetric().uses;
      noteBreakGlassUse('view', { decider: OWNER, grant_id: 'none' });
      const db = makeStore();
      const { dispatchTool } = await import('../src/dispatch.js');
      const res = await withStore(db, () => dispatchTool('emet_status', {}, { dbManager: db, logger: null }));
      const data = JSON.parse(res.content[0].text).data;
      assert.equal(data.break_glass.path, '/owner/break-glass');
      assert.equal(data.break_glass.rung, 'R4');
      assert.equal(data.break_glass.since_process_start, true);
      assert.ok(data.break_glass.uses >= before + 1);
      assert.ok(data.break_glass.last_at);
    });
  });
} finally {
  server.close();
  if (rateLimiter.cleanupInterval) clearInterval(rateLimiter.cleanupInterval);
}

summary('R4 chooser and break-glass');
