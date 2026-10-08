/**
 * EMET - the invite/refresh security chain (multi-user report v2, 2026-10-01;
 * Alex approved the fix).
 *
 *   Defect 1: a refresh grant replaced the stored scopes with whatever was
 *             requested, so any read-only token could refresh to `emet` / `*`.
 *   Defect 2: an invite's person id was the slug of its display name, and an
 *             existing person with that slug was reused - "Alex" became alex.
 *   R6:       the refresh path had no invite-freeze check, so an invite token
 *             outlived a re-freeze by rotating for ever.
 *
 * And the regression that matters most: a passphrase token (every live host
 * and bot) refreshes exactly as before. In-memory store; invites stay frozen in
 * this process - the one end-to-end redeem runs in a child process with
 * EMET_INVITES=1 set only there.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoOAuthProvider, tokenDigest, INVITE_GRANT } from '../src/oauth-provider.js';
import { scopesNotGranted, isFullScopeList, scopesAllow } from '../src/scopes.js';
import { allocateGuestPersonId, INVITES_FROZEN } from '../src/invites.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

import { memDb } from './memstore.js';
function setup({ frozen } = {}) {
  const db = memDb();
  const opts = { passphrase: 'p', issuerUrl: 'https://emet.example', fetch: async () => ({ ok: false, status: 404 }) };
  if (frozen !== undefined) opts.invitesFrozen = () => frozen;
  const provider = new MongoOAuthProvider(() => db, opts);
  db.collection('persons').insertOne({ person_id: 'alex', display_name: 'Alex', role: 'owner' });
  const tokens = () => db.collection(`${provider.prefix}oauth_tokens`);
  return { db, provider, tokens };
}
const client = { client_id: 'c1' };
const oauthCode = async (p) => {
  try { await p; } catch (e) { return { code: typeof e.toResponseObject === 'function' ? e.toResponseObject().error : null, message: e.message }; }
  return { code: 'ok' };
};

console.log('\n=== Invite / refresh security chain ===');

await testGroup('scopesNotGranted - the subset rule, aliases expanded on both sides', () => {
  test('a full grant ([] / emet / *) covers any request', () => {
    for (const g of [[], ['emet'], ['*'], ['emet.read', '*']]) {
      for (const r of [['emet'], ['*'], ['emet.read'], ['emet.write'], ['offline_access']]) {
        assert.deepStrictEqual(scopesNotGranted(g, r), [], `${g} vs ${r}`);
      }
    }
  });
  test('a read-only grant refuses emet, *, and emet.write', () => {
    assert.deepStrictEqual(scopesNotGranted(['emet.read'], ['emet']), ['emet']);
    assert.deepStrictEqual(scopesNotGranted(['emet.read'], ['*']), ['*']);
    assert.deepStrictEqual(scopesNotGranted(['emet.read'], ['emet.write']), ['emet.write']);
    assert.deepStrictEqual(scopesNotGranted(['emet.read'], ['emet.read', 'emet.write']), ['emet.write']);
  });
  test('a read-only grant keeps or narrows: emet.read, or nothing', () => {
    assert.deepStrictEqual(scopesNotGranted(['emet.read'], ['emet.read']), []);
    assert.deepStrictEqual(scopesNotGranted(['emet.read'], []), []);
  });
  test('an unknown scope not granted is refused on a restricted grant', () => {
    assert.deepStrictEqual(scopesNotGranted(['emet.read'], ['offline_access']), ['offline_access']);
  });
  test('read+write granted: emet expands to exactly that, so it is not wider', () => {
    assert.deepStrictEqual(scopesNotGranted(['emet.read', 'emet.write'], ['emet']), []);
    assert.deepStrictEqual(scopesNotGranted(['emet.write'], ['emet']), ['emet']);
  });
  test('isFullScopeList agrees with scopesAllow on what is full', () => {
    for (const g of [[], ['emet'], ['*']]) { assert.strictEqual(isFullScopeList(g), true); assert.strictEqual(scopesAllow(g, 'write_doc'), true); }
    assert.strictEqual(isFullScopeList(['emet.read']), false);
    assert.strictEqual(scopesAllow(['emet.read'], 'write_doc'), false);
  });
});

await testGroup('REGRESSION: a passphrase token refreshes exactly as before', async () => {
  const { provider, tokens } = setup({ frozen: true });
  const code = await provider.createAuthorizationCode({ client_id: 'c1', redirect_uri: 'https://h/cb', code_challenge: 'x', scopes: [], subject: null, source_tag: 'laptop' });
  const first = await provider.exchangeAuthorizationCode(client, code, undefined, 'https://h/cb');
  let second;
  await test('the passphrase code mints a full token for the owner, with no invite marker', async () => {
    const row = await tokens().findOne({ token: tokenDigest(first.refresh_token), kind: 'refresh' });
    assert.deepStrictEqual(row.scopes, []);
    assert.strictEqual(row.subject, 'alex');
    assert.ok(!('issued_via' in row), 'passphrase rows keep their shape');
  });
  await test('refresh with no scope keeps the full grant, rotates, and works with invites frozen', async () => {
    second = await provider.exchangeRefreshToken(client, first.refresh_token, undefined, null);
    assert.ok(second.access_token && second.refresh_token !== first.refresh_token);
    const v = await provider.verifyAccessToken(second.access_token);
    assert.deepStrictEqual(v.scopes, []);
    assert.strictEqual(v.extra.subject, 'alex');
    const old = await tokens().findOne({ token: tokenDigest(first.refresh_token), kind: 'refresh' });
    assert.strictEqual(typeof old.rotated_at, 'number');
  });
  await test('refresh asking for emet, *, or emet.read is still honoured (a full grant covers it)', async () => {
    let rt = second.refresh_token;
    for (const s of [['emet'], ['*']]) {
      const out = await provider.exchangeRefreshToken(client, rt, s, null);
      assert.strictEqual(out.scope, s.join(' '));
      rt = out.refresh_token;
    }
    const narrowed = await provider.exchangeRefreshToken(client, rt, ['emet.read'], null);
    assert.strictEqual(narrowed.scope, 'emet.read');
  });
  await test('an empty scope string from the SDK ([""]) counts as none requested', async () => {
    const p2 = setup({ frozen: true });
    const t = await p2.provider._issueTokens('c1', [], null, null, null, null, 'laptop');
    const out = await p2.provider.exchangeRefreshToken(client, t.refresh_token, [''], null);
    assert.deepStrictEqual((await p2.provider.verifyAccessToken(out.access_token)).scopes, []);
  });
  await test('a legacy passphrase token (subject "owner", no person row) refreshes with invites frozen', async () => {
    const p3 = setup({ frozen: true });
    const t = await p3.provider._issueTokens('c1', [], null, 'owner', null, null, 'laptop');
    const out = await p3.provider.exchangeRefreshToken(client, t.refresh_token, [], null);
    assert.ok(out.access_token);
  });
  await test('with the real invite gate (frozen in this process), a passphrase refresh still works', async () => {
    assert.strictEqual(INVITES_FROZEN, true);
    const db = memDb();
    db.collection('persons').insertOne({ person_id: 'alex', role: 'owner' });
    const real = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example', fetch: async () => ({}) });
    const t = await real._issueTokens('c1', [], null, null, null, null, 'laptop');
    assert.ok((await real.exchangeRefreshToken(client, t.refresh_token, undefined, null)).access_token);
  });
});

await testGroup('Defect 1: a read-only invite (no name collision) cannot refresh wider', async () => {
  const { db, provider, tokens } = setup({ frozen: false });
  db.collection('persons').insertOne({ person_id: 'alice', display_name: 'Alice', role: 'member' });
  const code = await provider.createAuthorizationCode({ client_id: 'c1', redirect_uri: 'https://h/cb', code_challenge: 'x', scopes: ['emet.read'], subject: 'alice', issued_via: INVITE_GRANT, source_tag: 'laptop' });
  const first = await provider.exchangeAuthorizationCode(client, code, undefined, 'https://h/cb');
  for (const ask of [['emet'], ['*'], ['emet.write'], ['emet.read', 'emet.write'], ['emet.read', '*']]) {
    await test(`refresh to ${ask.join(' ')} is refused with invalid_scope`, async () => {
      const r = await oauthCode(provider.exchangeRefreshToken(client, first.refresh_token, ask, null));
      assert.strictEqual(r.code, 'invalid_scope', JSON.stringify(r));
    });
  }
  await test('a refused refresh does not rotate the token (it still works)', async () => {
    const row = await tokens().findOne({ token: tokenDigest(first.refresh_token), kind: 'refresh' });
    assert.strictEqual(row.rotated_at, undefined);
  });
  let kept;
  await test('refresh with no scope keeps emet.read, subject and invite marker', async () => {
    kept = await provider.exchangeRefreshToken(client, first.refresh_token, undefined, null);
    const v = await provider.verifyAccessToken(kept.access_token);
    assert.deepStrictEqual(v.scopes, ['emet.read']);
    assert.strictEqual(v.extra.subject, 'alice');
    const row = await tokens().findOne({ token: tokenDigest(kept.refresh_token), kind: 'refresh' });
    assert.strictEqual(row.issued_via, INVITE_GRANT);
  });
  await test('refresh asking for exactly emet.read is allowed', async () => {
    const out = await provider.exchangeRefreshToken(client, kept.refresh_token, ['emet.read'], null);
    assert.strictEqual(out.scope, 'emet.read');
  });
  await test('a narrowed passphrase token cannot widen back either', async () => {
    const t = await provider._issueTokens('c1', ['emet.read'], null, null, null, null, 'laptop');
    const r = await oauthCode(provider.exchangeRefreshToken(client, t.refresh_token, ['emet'], null));
    assert.strictEqual(r.code, 'invalid_scope');
  });
});

await testGroup('Defect 2: an invite name never selects an existing person', async () => {
  const persons = memDb().collection('persons');
  await persons.insertOne({ person_id: 'alex', display_name: 'Alex', role: 'owner' });
  await test('"Alex", "ALEX", "Aléx", " alex! " do not resolve to the owner', async () => {
    for (const n of ['Alex', 'ALEX', 'Aléx', ' alex! ']) assert.strictEqual(await allocateGuestPersonId(persons, n), 'alex-2', n);
  });
  await test('the next free suffix is used', async () => {
    await persons.insertOne({ person_id: 'alex-2', role: 'member' });
    assert.strictEqual(await allocateGuestPersonId(persons, 'Alex'), 'alex-3');
  });
  await test('an existing member is not reused either', async () => {
    await persons.insertOne({ person_id: 'alice', role: 'member' });
    assert.strictEqual(await allocateGuestPersonId(persons, 'Alice'), 'alice-2');
  });
  await test('a fresh name keeps its plain slug', async () => assert.strictEqual(await allocateGuestPersonId(persons, 'Bob'), 'bob'));
  await test('a name that slugs to nothing is "guest", never the legacy owner subject', async () => {
    assert.strictEqual(await allocateGuestPersonId(persons, '!!!'), 'guest');
    assert.strictEqual(await allocateGuestPersonId(persons, ''), 'guest');
  });
  await test('"Owner" is reserved', async () => assert.strictEqual(await allocateGuestPersonId(persons, 'Owner'), 'owner-2'));
  await test('a long name stays within 40 characters with its suffix', async () => {
    const long = 'k'.repeat(60);
    await persons.insertOne({ person_id: 'k'.repeat(36), role: 'member' });
    const id = await allocateGuestPersonId(persons, long);
    assert.ok(id.length <= 40 && id.endsWith('-2'), id);
  });
  await test('end to end (child process, EMET_INVITES=1 there only): an invite named "Alex" redeems as a new member', () => {
    const script = `
      import { createInvite, redeemInvite } from './src/invites.js';
      const bags = {};
      const db = { collection(n) { const rows = bags[n] || (bags[n] = []); return {
        async insertOne(r) { rows.push(r); },
        async findOne(q) { return rows.find((r) => Object.entries(q).every(([k, v]) => r[k] === v)) || null; },
        async updateOne(s, u) { const r = rows.find((x) => x.digest === s.digest); if (r) Object.assign(r, u.$set); },
        async findOneAndUpdate(q, u) {
          const r = rows.find((x) => Object.entries(q).every(([k, v]) => x[k] === v));
          if (!r) return null;
          if (u && u.$set) Object.assign(r, u.$set);
          return { ...r };
        },
        async createIndex() { return 'ok'; } }; } };
      await db.collection('persons').insertOne({ person_id: 'alex', display_name: 'Alex', role: 'owner' });
      const inv = await createInvite(db, { display_name: 'Alex', created_by: 'alex' });
      const r = await redeemInvite(db, inv.code);
      console.log(JSON.stringify({ r, persons: bags.persons }));`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env: { ...process.env, EMET_INVITES: '1' }, encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    const { r, persons: ps } = JSON.parse(out.stdout.trim().split('\n').pop());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.person_id, 'alex-2');
    assert.deepStrictEqual(r.scopes, ['emet.read']);
    assert.strictEqual(ps.length, 2);
    assert.deepStrictEqual(ps[0], { person_id: 'alex', display_name: 'Alex', role: 'owner' });
    assert.strictEqual(ps[1].role, 'member');
  });
});

await testGroup('R6: an invite token stops refreshing while invites are frozen', async () => {
  await test('marked invite token, frozen: refused with invalid_grant, and not rotated', async () => {
    const { db, provider, tokens } = setup({ frozen: true });
    db.collection('persons').insertOne({ person_id: 'alice', role: 'member' });
    const t = await provider._issueTokens('c1', ['emet.read'], null, 'alice', INVITE_GRANT, null, 'laptop');
    const r = await oauthCode(provider.exchangeRefreshToken(client, t.refresh_token, undefined, null));
    assert.strictEqual(r.code, 'invalid_grant', JSON.stringify(r));
    const row = await tokens().findOne({ token: tokenDigest(t.refresh_token), kind: 'refresh' });
    assert.strictEqual(row.rotated_at, undefined);
  });
  await test('marked invite token, unfrozen: refreshes', async () => {
    const { provider } = setup({ frozen: false });
    const t = await provider._issueTokens('c1', ['emet.read'], null, 'alice', INVITE_GRANT, null, 'laptop');
    assert.ok((await provider.exchangeRefreshToken(client, t.refresh_token, undefined, null)).access_token);
  });
  await test('a token issued before the marker existed, whose subject is an invited member: refused while frozen', async () => {
    const { db, provider } = setup({ frozen: true });
    db.collection('persons').insertOne({ person_id: 'alice', role: 'member' });
    const t = await provider._issueTokens('c1', ['emet.read'], null, 'alice', null, null, 'laptop');
    const r = await oauthCode(provider.exchangeRefreshToken(client, t.refresh_token, undefined, null));
    assert.strictEqual(r.code, 'invalid_grant');
  });
  await test('the owner subject is never treated as an invite (passphrase hosts and bots keep refreshing)', async () => {
    const { provider } = setup({ frozen: true });
    const t = await provider._issueTokens('c1', ['emet.read', 'emet.write'], null, 'alex', null, null, 'laptop');
    assert.ok((await provider.exchangeRefreshToken(client, t.refresh_token, undefined, null)).access_token);
  });
  await test('the full chain is closed: invite "Alex" → alex-2, read-only, cannot refresh to emet', async () => {
    const { db, provider } = setup({ frozen: false });
    const persons = db.collection('persons');
    const id = await allocateGuestPersonId(persons, 'Alex');
    assert.strictEqual(id, 'alex-2');
    await persons.insertOne({ person_id: id, role: 'member' });
    const t = await provider._issueTokens('c1', ['emet.read'], null, id, INVITE_GRANT, null, 'laptop');
    assert.strictEqual((await oauthCode(provider.exchangeRefreshToken(client, t.refresh_token, ['emet'], null))).code, 'invalid_scope');
  });
});

testGroup('approve route marks invite grants (review nit P4g, 2026-10-02)', () => {
  // The /approve handler is the only place a code is issued for an invite redemption. If it stopped
  // passing issued_via, new invite tokens would carry no marker and rely on the legacy role:'member'
  // lookup alone. Source pin on the createAuthorizationCode call in src/http-remote.js.
  test('createAuthorizationCode in /approve passes issued_via = the invite marker when an invite was redeemed', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'http-remote.js'), 'utf8');
    const call = src.match(/provider\.createAuthorizationCode\(\{([\s\S]*?)\}\)/);
    assert.ok(call, 'createAuthorizationCode call not found in src/http-remote.js');
    assert.ok(/subject:\s*inviteSubject\s*\|\|\s*null/.test(call[1]), 'subject must come from the redeemed invite');
    const m = call[1].match(/issued_via:\s*inviteSubject\s*\?\s*\(inviteDoor === 'member' \? 'member' : 'invite'\)\s*:\s*null/);
    assert.ok(m, 'issued_via must be the door marker (member or invite) exactly when a code was redeemed, else null');
    assert.strictEqual(INVITE_GRANT, 'invite');
  });
});

summary('INVITE / REFRESH CHAIN TEST SUMMARY');
