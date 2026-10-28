/**
 * R5 household rotate-all and per-member revoke.
 * Invites.js freezes its door flags at import, so this file sets the
 * environment before importing the modules that redeem a code.
 */
process.env.EMET_INVITES = '1';
process.env.EMET_MEMBER_ACCESS = '1';
process.env.EMET_SUBKEYS = '1';
process.env.EMET_SUBKEY_PEPPER = 'pepper-pepper-pepper-pepper-pepper-32b';
process.env.EMET_RECORD_DOCS = 'bots/intake-bot/HANDOFF.md,bots/hub-bot/HANDOFF.md';
process.env.EMET_SOURCE_TAGS = 'hub-bot,intake-bot,cowork-cloud';
process.env.EMET_OAUTH_PASSPHRASE = 'owner-secret-value';

const { test, testGroup, summary } = await import('./harness.js');
const assert = (await import('node:assert/strict')).default;
const fs = (await import('node:fs')).default;
const express = (await import('express')).default;
const { makeStore, withEnv, withStore } = await import('./memstore.js');
const { createMemoryStore } = await import('../src/subkey-store.js');
const { ApproveThrottle } = await import('../src/approve-throttle.js');
const { MongoOAuthProvider, tokenDigest } = await import('../src/oauth-provider.js');
const { mountChooser } = await import('../src/chooser.js');
const { mountBreakGlass, _resetBreakGlassForTests } = await import('../src/break-glass.js');
const { createOwnerGate } = await import('../src/owner-session.js');
const { _resetDeepLinksForTests, mintDeepLink, setChooserPublicUrl, setInstanceIdForTests, currentInstanceId } = await import('../src/deep-links.js');
const { _resetChooserForTests } = await import('../src/chooser.js');
const { redeemInvite, createMemberAccess } = await import('../src/invites.js');
const { rotationTriggerAllowed, _resetRotationForTests, rotateMetric, rotateStartupLine, credentialBlocked, HOUSEHOLD_EPOCH_ID } = await import('../src/rotate.js');
const { ROTATE_ALL, MEMBER_REVOKE, OWL_KILL } = await import('../src/grants.js');
const { useMemoryErrorLog } = await import('../src/error-log.js');

console.log('\n=== R5 rotate-all ===');

const SECRET = 'owner-secret-value';
const OWNER = 'alex';
const CLIENT = { client_id: 'bot-client' };
const errorLog = useMemoryErrorLog();
const audits = [];
const provider = new MongoOAuthProvider(() => holder.db, { passphrase: SECRET, cimd: false });
const throttle = new ApproveThrottle();
const holder = { deps: null, db: null };
const gate = createOwnerGate({
  checkPassphrase: (input) => provider.checkPassphrase(input),
  throttle
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
  logger: { audit(op, details) { audits.push({ op, details }); } },
  actionMax: 500
};
mountChooser(app, human);
mountBreakGlass(app, human);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

function cookiePair(setCookie) {
  assert.ok(setCookie, 'expected a cookie');
  return setCookie.split(';')[0];
}
async function login(next = '/owner/break-glass') {
  const res = await fetch(`${base}/owner/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passphrase: SECRET, next }).toString()
  });
  assert.equal(res.status, 303, await res.text());
  return cookiePair(res.headers.get('set-cookie'));
}
async function csrfOf(cookie) {
  const page = await fetch(`${base}/owner/break-glass`, { headers: { cookie } });
  const html = await page.text();
  assert.equal(page.status, 200, html);
  const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
  assert.ok(match, html);
  return { html, csrf: match[1] };
}
function post(path, cookie, fields, extraHeaders = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders };
  if (cookie) headers.cookie = cookie;
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString()
  });
}
function quiet(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ value, lines, error: null }))
    .catch((error) => ({ value: null, lines, error }))
    .finally(() => { console.error = orig; });
}
function futureIso() {
  return new Date(Date.now() + 86400000).toISOString();
}
async function issue(tag, { subject = 'alex', via = 'owner', scopes = ['emet.read', 'emet.write'] } = {}) {
  const out = await provider._issueTokens('bot-client', scopes, null, subject, via, null, tag);
  const row = await holder.db.collection('emet_oauth_tokens').findOne({ token: tokenDigest(out.access_token), kind: 'access' });
  return { ...out, family: row.family };
}
async function plantSubkeys(store, rows) {
  await store.mutate((data) => {
    data.keys = data.keys || {};
    data.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    for (const row of rows) data.keys[row.key_id] = { history: [], expires_at: futureIso(), ...row };
    return true;
  });
}

function resetSurfaces() {
  _resetDeepLinksForTests();
  _resetChooserForTests();
  _resetBreakGlassForTests();
  _resetRotationForTests();
  errorLog.entries.length = 0;
  audits.length = 0;
  setChooserPublicUrl('https://railway-emet.example');
  holder.deps = { subkeys: createMemoryStore() };
}

try {
  await testGroup('trigger', async () => {
    await test('an owner session may rotate, and a grant may not', () => {
      const session = { csrf: 'a'.repeat(64) };
      assert.equal(rotationTriggerAllowed({ session }), true);
      assert.equal(rotationTriggerAllowed({ session, authorization: 'Bearer stolen-token' }), false);
      assert.equal(rotationTriggerAllowed({ session, door: 'member' }), false);
      assert.equal(rotationTriggerAllowed({ session, door: 'guest' }), false);
      assert.equal(rotationTriggerAllowed({ session, door: 'owner' }), false);
      assert.equal(rotationTriggerAllowed({}), false);
      assert.equal(ROTATE_ALL.implemented, true);
      assert.equal(ROTATE_ALL.grace_window_seconds, null);
      assert.equal(ROTATE_ALL.confirm, 'rotate-all');
      assert.equal(MEMBER_REVOKE.implemented, true);
      assert.equal(MEMBER_REVOKE.confirm, 'revoke-member');
      assert.equal(OWL_KILL.implemented, true);
      assert.equal(OWL_KILL.delete_wiring, false);
      const dispatch = fs.readFileSync(new URL('../src/dispatch.js', import.meta.url), 'utf8');
      const tools = fs.readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');
      assert.equal(dispatch.includes('emet_rotate'), false);
      assert.equal(tools.includes('emet_rotate'), false);
      assert.match(rotateStartupLine(), /rotate-all path=\/owner\/break-glass/);
      assert.match(rotateStartupLine(), /grace_window_seconds=null/);
    });
  });

  await testGroup('generation recurrence', async () => {
    await test('a generation behind the epoch is refused with no stamp, and a stamp still refuses the current generation', async () => {
      resetSurfaces();
      const store = makeStore();
      holder.db = store;
      const db = store;
      const tokens = db.collection('emet_oauth_tokens');
      const codes = db.collection('emet_oauth_codes');
      const old = await issue('intake-bot');
      const oldCode = await provider.createAuthorizationCode({
        client_id: 'bot-client', redirect_uri: 'https://h/cb', code_challenge: 'x',
        scopes: ['emet.read', 'emet.write'], subject: 'alex', issued_via: 'owner', source_tag: 'intake-bot'
      });
      const oldAccess = await tokens.findOne({ token: tokenDigest(old.access_token), kind: 'access' });
      const oldRefresh = await tokens.findOne({ token: tokenDigest(old.refresh_token), kind: 'refresh' });
      const oldCodeRow = await codes.findOne({ code: tokenDigest(oldCode) });
      assert.equal(oldAccess.rotation_generation, 0);
      assert.equal(oldRefresh.rotation_generation, 0);
      assert.equal(oldCodeRow.rotation_generation, 0);
      assert.equal(oldAccess.superseded_by, undefined);
      assert.equal(oldRefresh.superseded_by, undefined);
      assert.equal(oldCodeRow.superseded_by, undefined);
      assert.notEqual(oldAccess.retired, true);

      await db.collection('emet_rotations').updateOne(
        { _id: HOUSEHOLD_EPOCH_ID },
        { $set: { kind: 'household_epoch', generation: 1, deleted: false } },
        { upsert: true }
      );
      await tokens.updateOne({ _id: oldAccess._id }, { $unset: { rotation_generation: '' } });
      await tokens.updateOne({ _id: oldRefresh._id }, { $set: {
        rotated_at: Math.floor(Date.now() / 1000),
        grace_replacement: {
          access_token: 'grace-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'grace-refresh-token'
        }
      } });
      const behind = await tokens.findOne({ _id: oldAccess._id });
      const behindRefresh = await tokens.findOne({ _id: oldRefresh._id });
      assert.equal(behind.rotation_generation, undefined);
      assert.equal(behind.superseded_by, undefined);
      assert.notEqual(behind.retired, true);
      assert.equal(behindRefresh.rotation_generation, 0);
      assert.equal(behindRefresh.superseded_by, undefined);
      assert.equal(await credentialBlocked(db, 'emet_', behind), true, 'generation compare did not refuse an unstamped token');
      assert.equal((await db.collection('emet_rotations').findOne({ _id: HOUSEHOLD_EPOCH_ID })).generation, 1);

      const current = await issue('hub-bot');
      const currentAccess = await tokens.findOne({ token: tokenDigest(current.access_token), kind: 'access' });
      const currentRefresh = await tokens.findOne({ token: tokenDigest(current.refresh_token), kind: 'refresh' });
      assert.equal(currentAccess.rotation_generation, 1);
      assert.equal(currentAccess.superseded_by, undefined);
      assert.equal(await credentialBlocked(db, 'emet_', currentAccess), false, 'generation compare refused the current generation');

      await assert.rejects(() => provider.verifyAccessToken(old.access_token), /revoked by rotation/);
      const afterAccess = await tokens.findOne({ _id: oldAccess._id });
      assert.equal(afterAccess.superseded_by, undefined);
      assert.notEqual(afterAccess.retired, true);
      assert.equal(afterAccess.rotation_generation, undefined);
      const seen = await provider.verifyAccessToken(current.access_token);
      assert.equal(seen.extra.grantId, current.family);

      await assert.rejects(() => provider.exchangeRefreshToken(CLIENT, old.refresh_token, undefined, null), (err) => {
        assert.match(err.message, /revoked by rotation/);
        assert.match(err.message, /No grace window/);
        assert.equal(err.message.includes('grace-access-token'), false);
        return true;
      });
      const afterRefresh = await tokens.findOne({ _id: oldRefresh._id });
      assert.equal(afterRefresh.superseded_by, undefined);
      assert.equal(afterRefresh.rotation_generation, 0);

      const countBefore = (await tokens.find({}).toArray()).length;
      await assert.rejects(() => provider.exchangeAuthorizationCode(CLIENT, oldCode, undefined, 'https://h/cb'), /revoked by rotation/);
      assert.equal((await tokens.find({}).toArray()).length, countBefore);
      const afterCode = await codes.findOne({ _id: oldCodeRow._id });
      assert.equal(afterCode.superseded_by, undefined);
      assert.equal(afterCode.rotation_generation, 0);
      assert.equal(afterCode.used, false);

      await tokens.updateOne({ _id: currentRefresh._id }, { $set: { retired: true } });
      const retiredOnly = await tokens.findOne({ _id: currentRefresh._id });
      assert.equal(retiredOnly.rotation_generation, 1);
      assert.equal(retiredOnly.superseded_by, undefined);
      assert.equal(retiredOnly.retired, true);
      assert.equal(await credentialBlocked(db, 'emet_', retiredOnly), true, 'retired stamp did not refuse the current generation');
      await assert.rejects(() => provider.exchangeRefreshToken(CLIENT, current.refresh_token, undefined, null), /revoked by rotation/);

      await tokens.updateOne({ _id: currentAccess._id }, { $set: { superseded_by: 'stamp-only', retired: true } });
      const stamped = await tokens.findOne({ _id: currentAccess._id });
      assert.equal(stamped.rotation_generation, 1);
      assert.equal(stamped.superseded_by, 'stamp-only');
      assert.equal(await credentialBlocked(db, 'emet_', stamped), true, 'superseded_by did not refuse the current generation');
      await assert.rejects(() => provider.verifyAccessToken(current.access_token), /revoked by rotation/);
    });
  });

  await testGroup('household rotate-all', async () => {
    await test('old credentials die on the next request, each bot gets one invite, and break-glass still opens', async () => {
      resetSurfaces();
      const store = makeStore();
      holder.db = store;
      const db = store;
      await db.collection('persons').insertOne({ person_id: 'alex', display_name: 'the owner', role: 'owner' });
      await db.collection('persons').insertOne({ person_id: 'ada', display_name: 'Ada', role: 'member', door: 'member' });
      const moleA = await issue('intake-bot');
      const moleB = await issue('intake-bot');
      const hub = await issue('hub-bot');
      const ada = await issue(null, { subject: 'ada', via: 'member', scopes: ['emet.read', 'emet.write'] });
      const laptop = await issue('laptop');
      assert.notEqual(moleA.family, moleB.family);
      const moleRefresh = await db.collection('emet_oauth_tokens').findOne({ token: tokenDigest(moleA.refresh_token), kind: 'refresh' });
      await db.collection('emet_oauth_tokens').updateOne({ _id: moleRefresh._id }, { $set: {
        rotated_at: Math.floor(Date.now() / 1000),
        grace_replacement: { access_token: 'grace-access-token', token_type: 'bearer', expires_in: 3600, refresh_token: 'grace-refresh-token' }
      } });
      const pendingCode = await provider.createAuthorizationCode({
        client_id: 'bot-client', redirect_uri: 'https://h/cb', code_challenge: 'x',
        scopes: ['emet.read', 'emet.write'], subject: 'alex', issued_via: 'owner', source_tag: 'intake-bot'
      });
      await db.collection('documents').insertOne({ _id: 'hist-intake', doc_id: 'bots/intake-bot/HANDOFF.md', grant_id: moleA.family });
      const oldInvite = await createMemberAccess(db, { created_by: OWNER, display_name: 'intake-bot', source_tag: 'intake-bot' });
      const linkMole = mintDeepLink({ kind: 'deny', grant_id: moleA.family, tag: 'intake-bot', door: 'member', correlationId: 'abcdefabcdefabcd' });
      const linkBlaster = mintDeepLink({ kind: 'deny', grant_id: hub.family, tag: 'hub-bot', door: 'member', correlationId: 'abcdefabcdefabcd' });
      await plantSubkeys(holder.deps.subkeys, [
        { key_id: 'intake', tag: 'intake-bot', status: 'grace', grace_until: futureIso() },
        { key_id: 'hub', tag: 'hub-bot', status: 'active', live_session_id: 'open-b' }
      ]);
      await holder.deps.subkeys.mutate((data) => {
        data.sessions.push({ open_id: 'open-b', key_id: 'hub', state: 'live', session_id: 'base-b' });
        return true;
      });
      const before = await provider.verifyAccessToken(moleA.access_token);
      assert.equal(before.extra.grantId, moleA.family);
      assert.ok((await db.collection('emet_oauth_tokens').findOne({ family: moleA.family, kind: 'access' })).expiresAt * 1000 > Date.now());

      const cookieA = await login();
      const cookieB = await login();
      const { csrf, html: chooserless } = await csrfOf(cookieA);
      assert.match(chooserless, /Rotate every credential/);
      const chooser = await fetch(`${base}/owner/chooser`, { headers: { cookie: cookieA } });
      assert.match(await chooser.text(), /Rotate every credential/);

      const anonymous = await post('/owner/break-glass/rotate-all', null, { csrf, confirm: 'rotate-all' });
      assert.equal(anonymous.status, 401);
      const bearer = await post('/owner/break-glass/rotate-all', cookieA, { csrf, confirm: 'rotate-all' }, { authorization: 'Bearer member-grant' });
      const bearerHtml = await bearer.text();
      assert.equal(bearer.status, 403, bearerHtml);
      assert.match(bearerHtml, /Nothing was revoked/);
      assert.equal((await provider.verifyAccessToken(moleA.access_token)).extra.grantId, moleA.family);

      const review = await post('/owner/break-glass/rotate-all', cookieA, { csrf, stage: 'review' });
      const reviewHtml = await review.text();
      assert.equal(review.status, 200, reviewHtml);
      assert.match(reviewHtml, /Nothing was revoked/);
      assert.equal((await provider.verifyAccessToken(hub.access_token)).extra.grantId, hub.family);

      const { value: committed, lines, error: commitError } = await quiet(() => post('/owner/break-glass/rotate-all', cookieA, { csrf, confirm: 'rotate-all' }));
      assert.equal(commitError, null);
      const html = await committed.text();
      assert.equal(committed.status, 200, html);
      assert.match(html, /Rotate-all committed/);
      assert.match(html, /\/owner\/chooser/);
      assert.match(html, /correlation_id [0-9a-f]{16}/);
      const moleCode = /intake-bot member ([0-9a-f]{32})/.exec(html);
      const blasterCode = /hub-bot member ([0-9a-f]{32})/.exec(html);
      const adaCode = /Ada member ([0-9a-f]{32})/.exec(html);
      assert.ok(moleCode && blasterCode && adaCode, html);
      assert.equal(html.includes('laptop member') || html.includes('laptop guest'), false);
      const codes = [moleCode[1], blasterCode[1], adaCode[1]];
      assert.equal(new Set(codes).size, 3);
      const joined = lines.join('\n');
      assert.match(joined, /decider=alex/);
      assert.match(joined, /scope=household/);
      assert.match(joined, /correlation_id=[0-9a-f]{16}/);
      assert.match(joined, /revoked=11/);
      assert.match(joined, /invites=3/);
      for (const code of codes) assert.equal(joined.includes(code), false, 'invite code leaked to the log');
      assert.equal(joined.includes(SECRET), false);
      const audit = audits.find((row) => row.op === 'ROTATE_ALL');
      assert.ok(audit);
      assert.equal(JSON.stringify(audit.details).includes(moleCode[1]), false);
      assert.equal(audit.details.invites, 3);
      assert.equal(audit.details.decider, 'alex');

      const event = (await db.collection('emet_rotations').find({ kind: 'rotation_event' }).toArray())[0];
      assert.equal(event.deleted, false);
      assert.equal(event.retained, true);
      assert.equal(event.grace_window_seconds, null);
      assert.equal(event.scope, 'household');
      assert.equal(event.invites_issued, 3);
      assert.equal(event.revoked_grants, 5);
      assert.equal(event.revoked_subkeys, 2);
      assert.equal(event.revoked_sessions, 1);
      assert.equal(event.revoked_deep_links, 2);
      assert.equal(event.retired_invites, 1);
      assert.equal(event.grant_ids.length, 5);
      assert.equal((await db.collection('emet_rotations').findOne({ _id: 'household-epoch' })).generation, 1);
      const kept = await db.collection('emet_oauth_tokens').find({ family: moleA.family }).toArray();
      assert.ok(kept.length >= 2);
      assert.ok(kept.every((row) => row.superseded_by === event._id && row.retired === true && row.deleted !== true));
      const history = await db.collection('documents').findOne({ _id: 'hist-intake' });
      assert.equal(history.grant_id, moleA.family);

      const refused = await quiet(() => provider.verifyAccessToken(moleA.access_token));
      const err = refused.error;
      assert.ok(err, 'expected the old access token to be refused');
      assert.match(err.message, /revoked by rotation/);
      assert.match(err.message, /No grace window/);
      assert.match(err.message, /\/owner\/chooser/);
      assert.match(err.message, /grant_id: /);
      assert.equal(err.grant_id, moleA.family);
      assert.match(err.correlation_id, /^[0-9a-f]{16}$/);
      assert.match(refused.lines.join('\n'), new RegExp(`grant_id=${moleA.family}`));
      assert.match(refused.lines.join('\n'), new RegExp(`correlation_id=${err.correlation_id}`));
      assert.equal(err.message.includes('expired'), false);
      const logged = errorLog.entries.find((row) => row.emet_code === 'EMET-AUTH-041' && row.grant_id === moleA.family);
      assert.ok(logged);
      await assert.rejects(() => provider.verifyAccessToken(moleB.access_token), /revoked by rotation/);
      await assert.rejects(() => provider.verifyAccessToken(ada.access_token), /revoked by rotation/);
      await assert.rejects(() => provider.verifyAccessToken(laptop.access_token), /revoked by rotation/);
      await assert.rejects(() => provider.exchangeRefreshToken(CLIENT, moleA.refresh_token, undefined, null), (err) => {
        assert.match(err.message, /revoked by rotation/);
        assert.match(err.message, /No grace window/);
        assert.equal(err.message.includes('grace-access-token'), false);
        return true;
      });
      const familiesBeforeCode = (await db.collection('emet_oauth_tokens').find({}).toArray()).length;
      await assert.rejects(() => provider.exchangeAuthorizationCode(CLIENT, pendingCode, undefined, 'https://h/cb'), /revoked by rotation/);
      assert.equal((await db.collection('emet_oauth_tokens').find({}).toArray()).length, familiesBeforeCode);

      const oldRedeem = await redeemInvite(db, oldInvite.code);
      assert.equal(oldRedeem.reason, 'retired');
      const instance = currentInstanceId();
      setInstanceIdForTests('other-instance');
      const wrong = await redeemInvite(db, moleCode[1]);
      assert.equal(wrong.reason, 'wrong_instance');
      setInstanceIdForTests(instance);
      const redeemed = await redeemInvite(db, moleCode[1]);
      assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
      const replay = await redeemInvite(db, moleCode[1]);
      assert.equal(replay.reason, 'used');
      const freshAuth = await provider.createAuthorizationCode({
        client_id: 'bot-client', redirect_uri: 'https://h/cb', code_challenge: 'x',
        scopes: redeemed.scopes, subject: redeemed.person_id, issued_via: 'member', source_tag: 'intake-bot'
      });
      const fresh = await provider.exchangeAuthorizationCode(CLIENT, freshAuth, undefined, 'https://h/cb');
      const freshView = await provider.verifyAccessToken(fresh.access_token);
      assert.notEqual(freshView.extra.grantId, moleA.family);
      await assert.rejects(() => provider.verifyAccessToken(moleA.access_token), /revoked by rotation/);

      const keys = await holder.deps.subkeys.snapshot();
      assert.equal(keys.keys.intake.status, 'revoked');
      assert.notEqual(keys.keys.intake.status, 'grace');
      assert.equal(keys.keys.intake.deleted, false);
      assert.equal(keys.keys.intake.superseded_by, event._id);
      assert.equal(keys.keys.hub.status, 'revoked');
      assert.equal(keys.sessions.find((row) => row.open_id === 'open-b').state, 'revoked');
      assert.ok(keys.sessions.find((row) => row.open_id === 'open-b'));

      const moleLink = await fetch(`${base}/owner/chooser?d=${encodeURIComponent(linkMole.token)}`);
      const moleLinkHtml = await moleLink.text();
      assert.equal(moleLink.status, 400, moleLinkHtml);
      assert.match(moleLinkHtml, /revoked by rotation/);
      assert.equal(moleLinkHtml.includes('already used'), false);
      const blasterLink = await fetch(`${base}/owner/chooser?d=${encodeURIComponent(linkBlaster.token)}`);
      assert.equal(blasterLink.status, 400);

      const still = await fetch(`${base}/owner/break-glass`, { headers: { cookie: cookieA } });
      assert.equal(still.status, 200, await still.text());
      const other = await fetch(`${base}/owner/break-glass`, { headers: { cookie: cookieB } });
      assert.equal(other.status, 401);

      process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
      const status = await withEnv({ EMET_SUBKEYS: undefined }, () => withStore(store, async () => {
        const { dispatchTool } = await import('../src/dispatch.js');
        return dispatchTool('emet_status', {}, { dbManager: store, logger: null });
      }));
      const data = JSON.parse(status.content[0].text).data;
      assert.equal(data.rotate_all.rung, 'R5');
      assert.equal(data.rotate_all.grace_window_seconds, null);
      assert.equal(data.rotate_all.last_scope, 'household');
      assert.equal(data.rotate_all.last_invites, 3);
      assert.equal(data.rotate_all.last_decider, 'alex');
      assert.ok(data.rotate_all.events >= 1);
      assert.equal(rotateMetric().last_revoked, 11);
    });
  });

  await testGroup('per-member revoke', async () => {
    await test('revoking A refuses A immediately and leaves B working', async () => {
      resetSurfaces();
      const store = makeStore();
      holder.db = store;
      const db = store;
      await db.collection('persons').insertOne({ person_id: 'alex', display_name: 'the owner', role: 'owner' });
      const intake = await issue('intake-bot');
      const hub = await issue('hub-bot');
      await db.collection('documents').insertOne({ _id: 'hist-a', doc_id: 'bots/intake-bot/HANDOFF.md', grant_id: intake.family });
      const linkMole = mintDeepLink({ kind: 'deny', grant_id: intake.family, tag: 'intake-bot', door: 'member', correlationId: 'abcdefabcdefabcd' });
      const linkBlaster = mintDeepLink({ kind: 'deny', grant_id: hub.family, tag: 'hub-bot', door: 'member', correlationId: 'abcdefabcdefabcd' });
      await plantSubkeys(holder.deps.subkeys, [
        { key_id: 'intake', tag: 'intake-bot', status: 'grace', grace_until: futureIso() },
        { key_id: 'hub', tag: 'hub-bot', status: 'active', live_session_id: 'open-b' }
      ]);
      await holder.deps.subkeys.mutate((data) => {
        data.sessions.push({ open_id: 'open-b', key_id: 'hub', state: 'live', session_id: 'base-b' });
        return true;
      });
      const cookie = await login();
      const { csrf } = await csrfOf(cookie);
      const review = await post('/owner/break-glass/revoke-member', cookie, { csrf, tag: 'intake-bot', issue_invite: '1', stage: 'review' });
      assert.match(await review.text(), /Nothing was revoked/);
      assert.equal((await provider.verifyAccessToken(intake.access_token)).extra.grantId, intake.family);

      const owner = await post('/owner/break-glass/revoke-member', cookie, { csrf, person_id: 'alex', confirm: 'revoke-member' });
      const ownerHtml = await owner.text();
      assert.equal(owner.status, 400, ownerHtml);
      assert.match(ownerHtml, /Nothing was revoked/);
      const star = await post('/owner/break-glass/revoke-member', cookie, { csrf, tag: '*', confirm: 'revoke-member' });
      assert.equal(star.status, 400);
      const everyone = await post('/owner/break-glass/revoke-member', cookie, { csrf, tag: 'all', confirm: 'revoke-member' });
      assert.equal(everyone.status, 400);
      assert.equal((await provider.verifyAccessToken(intake.access_token)).extra.grantId, intake.family);
      assert.equal((await provider.verifyAccessToken(hub.access_token)).extra.grantId, hub.family);

      const { value: committed, lines, error: commitError } = await quiet(() => post('/owner/break-glass/revoke-member', cookie, {
        csrf, tag: 'intake-bot', issue_invite: '1', confirm: 'revoke-member'
      }));
      assert.equal(commitError, null);
      const html = await committed.text();
      assert.equal(committed.status, 200, html);
      assert.match(html, /Member revoke committed/);
      const moleCode = /intake-bot member ([0-9a-f]{32})/.exec(html);
      assert.ok(moleCode, html);
      assert.equal(/hub-bot member [0-9a-f]{32}/.test(html), false, 'B received an invite');
      assert.equal(lines.join('\n').includes(moleCode[1]), false, 'invite code leaked to the log');
      assert.equal((await db.collection('emet_rotations').findOne({ _id: 'household-epoch' })), null);

      await assert.rejects(() => provider.verifyAccessToken(intake.access_token), /revoked by rotation/);
      assert.equal((await provider.verifyAccessToken(hub.access_token)).extra.grantId, hub.family);
      const moleRows = await db.collection('emet_oauth_tokens').find({ family: intake.family }).toArray();
      assert.ok(moleRows.length >= 1);
      assert.ok(moleRows.every((row) => row.superseded_by && row.deleted !== true));
      const blasterRows = await db.collection('emet_oauth_tokens').find({ family: hub.family }).toArray();
      assert.ok(blasterRows.every((row) => !row.superseded_by));
      assert.equal((await db.collection('documents').findOne({ _id: 'hist-a' })).grant_id, intake.family);
      const keys = await holder.deps.subkeys.snapshot();
      assert.equal(keys.keys.intake.status, 'revoked');
      assert.equal(keys.keys.intake.history.some((row) => row.superseded_by), true);
      assert.equal(keys.keys.hub.status, 'active');
      assert.equal(keys.sessions.find((row) => row.open_id === 'open-b').state, 'live');
      const molePage = await fetch(`${base}/owner/chooser?d=${encodeURIComponent(linkMole.token)}`);
      assert.equal(molePage.status, 400);
      assert.match(await molePage.text(), /revoked by rotation/);
      const blasterPage = await fetch(`${base}/owner/chooser?d=${encodeURIComponent(linkBlaster.token)}`, { redirect: 'manual' });
      assert.equal(blasterPage.status, 303, await blasterPage.text());
      const fresh = (await db.collection('invites').find({}).toArray()).filter((row) => row.rotation_event_id && !row.retired_at);
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0].source_tag, 'intake-bot');
      const redeemed = await redeemInvite(db, moleCode[1]);
      assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
      const replay = await redeemInvite(db, moleCode[1]);
      assert.equal(replay.reason, 'used');
      await assert.rejects(() => provider.verifyAccessToken(intake.access_token), /revoked by rotation/);
      assert.equal((await provider.verifyAccessToken(hub.access_token)).extra.grantId, hub.family);
      assert.equal((await db.collection('emet_oauth_tokens').findOne({ family: hub.family, kind: 'access' })).rotation_generation, 0);
    });
  });
} finally {
  server.close();
}

summary('R5 rotate-all');
