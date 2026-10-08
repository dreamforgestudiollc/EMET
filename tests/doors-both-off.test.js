/**
 * EMET - the two doors, with BOTH off (EMET_INVITES and EMET_MEMBER_ACCESS unset): the default install.
 * invites.js reads its flags at module load, so this file clears the environment BEFORE importing
 * anything that reads them; each env combination has its own file.
 *   - a code is refused before any lookup, so a shut install never says whether a code exists
 *   - the refusal names both doors and how each is turned on
 *   - the owner's (passphrase) token still refreshes; guest and member tokens do not
 */
for (const k of ['EMET_INVITES', 'CASCADE_INVITES', 'EMET_MEMBER_ACCESS', 'CASCADE_MEMBER_ACCESS']) delete process.env[k];
const { test, testGroup, summary } = await import('./harness.js');
const assert = (await import('assert')).default;
const { redeemInvite, mintInviteCode, inviteDigest, INVITES_FROZEN, MEMBER_ACCESS_FROZEN, DOORS_FROZEN_REASON } = await import('../src/invites.js');
const { MongoOAuthProvider, INVITE_GRANT, MEMBER_GRANT } = await import('../src/oauth-provider.js');

import { memDb as sharedMemDb } from './memstore.js';
function memDb() {
  const counter = { lookups: 0 };
  const db = sharedMemDb({ counter });
  db.collection('persons').insertOne({ person_id: 'alex', display_name: 'Alex', role: 'owner' });
  return db;
}
const client = { client_id: 'c1' };
// Real flags: no invitesFrozen / memberAccessFrozen pins, so the provider reads invites.js as deployed.
const providerFor = (db) => new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example', fetch: async () => ({ ok: false, status: 404 }) });
const oauthCode = async (p) => {
  try { await p; } catch (e) { return { code: typeof e.toResponseObject === 'function' ? e.toResponseObject().error : null, message: e.message }; }
  return { code: 'ok' };
};

console.log('\n=== doors: both off ===');
await testGroup('flags', () => {
  test('guest access and member access are both off', () => { assert.strictEqual(INVITES_FROZEN, true); assert.strictEqual(MEMBER_ACCESS_FROZEN, true); });
});
await testGroup('redeem: refused before any lookup', async () => {
  await test('a live guest code and a live member code are both refused as frozen with zero lookups, and no person is created', async () => {
    for (const door of ['guest', 'member']) {
      const db = memDb();
      const code = mintInviteCode();
      await db.collection('invites').insertOne({ digest: inviteDigest(code), display_name: 'X', scopes: ['emet.read'], created_at: new Date(), expires_at: new Date(Date.now() + 86400000), used_at: null, person_id: null, door });
      db.counter.lookups = 0;
      const r = await redeemInvite(db, code);
      assert.strictEqual(r.ok, false, door); assert.strictEqual(r.reason, 'frozen', door);
      assert.strictEqual(db.counter.lookups, 0, `${door}: no lookup while both doors are shut`);
      assert.strictEqual(db.collection('persons').rows.length, 1, `${door}: no person created`);
    }
  });
  await test('a made-up code gets the same answer as a real one (the install never says whether a code exists)', async () => {
    const db = memDb();
    assert.deepStrictEqual(await redeemInvite(db, 'made-up'), { ok: false, reason: 'frozen', message: DOORS_FROZEN_REASON });
    assert.strictEqual(db.counter.lookups, 0);
  });
  await test('the refusal names both doors and the flag for each', () => {
    for (const s of ['EMET Guest Access', 'EMET_INVITES=1', 'EMET Member Access', 'EMET_MEMBER_ACCESS=1']) assert.ok(DOORS_FROZEN_REASON.includes(s), s);
  });
});
await testGroup('refresh with both doors off', async () => {
  await test('the owner (passphrase) token refreshes', async () => {
    const db = memDb(); const provider = providerFor(db);
    const t = await provider._issueTokens('c1', [], null, 'alex', null, null, 'laptop');
    assert.ok((await provider.exchangeRefreshToken(client, t.refresh_token, undefined, null)).access_token);
  });
  await test('a guest token and a member token are refused at refresh (invalid_grant)', async () => {
    for (const [door, grant, id, scopes] of [['guest', INVITE_GRANT, 'guest-1', ['emet.read']], ['member', MEMBER_GRANT, 'mem-1', ['emet.read', 'emet.write']]]) {
      const db = memDb(); const provider = providerFor(db);
      await db.collection('persons').insertOne({ person_id: id, role: 'member', ...(door === 'member' ? { door: 'member' } : {}) });
      const authCode = await provider.createAuthorizationCode({ client_id: 'c1', redirect_uri: 'https://h/cb', code_challenge: 'x', scopes, subject: id, issued_via: grant, source_tag: 'laptop' });
      const t = await provider.exchangeAuthorizationCode(client, authCode, undefined, 'https://h/cb');
      assert.strictEqual((await oauthCode(provider.exchangeRefreshToken(client, t.refresh_token, undefined, null))).code, 'invalid_grant', door);
    }
  });
});
summary('DOORS (BOTH OFF) TEST SUMMARY');
