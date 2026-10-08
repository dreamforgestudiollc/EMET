/**
 * EMET - the two doors, with only EMET_MEMBER_ACCESS=1 (public snapshot 1.0.0).
 * EMET Guest Access (EMET_INVITES) and EMET Member Access (EMET_MEMBER_ACCESS) are separate doors with
 * separate flags. invites.js reads its flags at module load, so this file sets the environment BEFORE
 * importing anything that reads them (the way invites.test.js runs with both unset), and each env
 * combination has its own file.
 */
for (const k of ['EMET_INVITES', 'CASCADE_INVITES', 'EMET_MEMBER_ACCESS', 'CASCADE_MEMBER_ACCESS']) delete process.env[k];
process.env.EMET_MEMBER_ACCESS = '1';
const { test, testGroup, summary } = await import('./harness.js');
const assert = (await import('assert')).default;
const { createInvite, createMemberAccess, redeemInvite, mintInviteCode, inviteDigest, INVITES_FROZEN, MEMBER_ACCESS_FROZEN, MEMBER_SCOPES } = await import('../src/invites.js');
const { MongoOAuthProvider, INVITE_GRANT, MEMBER_GRANT, tokenDigest } = await import('../src/oauth-provider.js');
const { memberAccessCreate } = await import('../src/tools.js');
const { actorStore } = await import('../src/persons.js');

import { memDb as sharedMemDb } from './memstore.js';
function memDb() {
  const db = sharedMemDb();
  db.collection('persons').insertOne({ person_id: 'alex', display_name: 'Alex', role: 'owner' });
  return db;
}
const dbManagerFor = (db) => ({ db, async getConnection() { return {}; } });
const client = { client_id: 'c1' };
const oauthCode = async (p) => {
  try { await p; } catch (e) { return { code: typeof e.toResponseObject === 'function' ? e.toResponseObject().error : null, message: e.message }; }
  return { code: 'ok' };
};
// Real flags: no invitesFrozen / memberAccessFrozen pins, so the provider reads invites.js as deployed.
const providerFor = (db) => new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example', fetch: async () => ({ ok: false, status: 404 }) });
async function plantCode(db, door, scopes) {
  const code = mintInviteCode();
  await db.collection('invites').insertOne({ digest: inviteDigest(code), display_name: door === 'member' ? 'Alex' : 'Guest', scopes, created_at: new Date(), expires_at: new Date(Date.now() + 86400000), used_at: null, person_id: null, door });
  return code;
}
async function tokenFor(provider, db, door, { legacy = false } = {}) {
  const id = door === 'member' ? 'mem-1' : 'guest-1';
  await db.collection('persons').insertOne({ person_id: id, role: 'member', ...(door === 'member' ? { door: 'member' } : {}) });
  const scopes = door === 'member' ? ['emet.read', 'emet.write'] : ['emet.read'];
  if (legacy) return provider._issueTokens('c1', scopes, null, id, null, null, 'laptop');
  const authCode = await provider.createAuthorizationCode({ client_id: 'c1', redirect_uri: 'https://h/cb', code_challenge: 'x', scopes, subject: id, issued_via: door === 'member' ? MEMBER_GRANT : INVITE_GRANT, source_tag: 'laptop' });
  return provider.exchangeAuthorizationCode(client, authCode, undefined, 'https://h/cb');
}

console.log('\n=== doors: only EMET_MEMBER_ACCESS=1 ===');
await testGroup('flags', () => {
  test('member access on, guest access off', () => { assert.strictEqual(MEMBER_ACCESS_FROZEN, false); assert.strictEqual(INVITES_FROZEN, true); });
});
await testGroup('EMET Member Access', async () => {
  await test('redeem gives a NEW person_id (never the owner, even named like the owner), role member, door member, exactly [emet.read, emet.write]', async () => {
    const db = memDb();
    const made = await createMemberAccess(db, { display_name: 'Alex' });
    assert.deepStrictEqual(made.scopes, ['emet.read', 'emet.write']);
    const r = await redeemInvite(db, made.code);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.door, 'member');
    assert.notStrictEqual(r.person_id, 'alex'); assert.notStrictEqual(r.person_id, 'owner'); assert.strictEqual(r.person_id, 'alex-2');
    assert.deepStrictEqual(r.scopes, ['emet.read', 'emet.write']);
    const p = await db.collection('persons').findOne({ person_id: r.person_id });
    assert.strictEqual(p.role, 'member'); assert.strictEqual(p.door, 'member');
    assert.strictEqual((await db.collection('persons').findOne({ person_id: 'alex' })).role, 'owner', 'the owner row is untouched');
  });
  await test('the member scopes are fixed at redeem: a stored code with empty, wider or narrower scopes still gives exactly [emet.read, emet.write]', async () => {
    for (const stored of [[], ['emet'], ['*'], ['emet.read'], ['emet.read', 'emet.write', 'admin'], undefined]) {
      const db = memDb();
      const r = await redeemInvite(db, await plantCode(db, 'member', stored));
      assert.strictEqual(r.ok, true, JSON.stringify(stored));
      assert.deepStrictEqual(r.scopes, [...MEMBER_SCOPES], JSON.stringify(stored));
      assert.ok(r.scopes.length > 0);
    }
  });
  await test('a member caller is refused at emet_member_access_create; the owner is allowed', async () => {
    const db = memDb();
    await db.collection('persons').insertOne({ person_id: 'mem-9', role: 'member', door: 'member' });
    await assert.rejects(() => actorStore.run({ personId: 'mem-9', scopes: ['emet.read', 'emet.write'] }, () => memberAccessCreate(dbManagerFor(db), { display_name: 'X' })), /Only the owner can create EMET Member Access/);
    assert.strictEqual(db.collection('invites').rows.length, 0);
    const ok = await actorStore.run({ personId: 'alex', scopes: [] }, () => memberAccessCreate(dbManagerFor(db), { display_name: 'X' }));
    assert.strictEqual(ok.door, 'member'); assert.strictEqual(ok.label, 'EMET Member Access');
  });
});
await testGroup('EMET Guest Access stays shut when only member access is on', async () => {
  await test('a guest code is refused at redeem (reason frozen, guest wording), no person created', async () => {
    const db = memDb();
    const r = await redeemInvite(db, await plantCode(db, 'guest', ['emet.read']));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'frozen'); assert.match(r.message, /EMET Guest Access is off/);
    assert.strictEqual(db.collection('persons').rows.length, 1);
  });
  await test('a legacy code with no door field is a guest code and is refused too', async () => {
    const db = memDb();
    const code = mintInviteCode();
    await db.collection('invites').insertOne({ digest: inviteDigest(code), display_name: 'Old', scopes: ['emet.read'], created_at: new Date(), expires_at: new Date(Date.now() + 86400000), used_at: null, person_id: null });
    assert.strictEqual((await redeemInvite(db, code)).reason, 'frozen');
  });
  await test('guest creation is refused', async () => {
    await assert.rejects(() => createInvite(memDb(), { display_name: 'G' }), /off on this install/i);
  });
});
await testGroup('refresh: each token against its own flag', async () => {
  await test('a member token refreshes with only EMET_MEMBER_ACCESS=1, scopes kept, marker kept', async () => {
    const db = memDb(); const provider = providerFor(db);
    const t = await tokenFor(provider, db, 'member');
    const out = await provider.exchangeRefreshToken(client, t.refresh_token, undefined, null);
    assert.ok(out.access_token);
    const row = await db.collection(`${provider.prefix}oauth_tokens`).findOne({ token: tokenDigest(out.refresh_token), kind: 'refresh' });
    assert.strictEqual(row.issued_via, MEMBER_GRANT); assert.deepStrictEqual(row.scopes, ['emet.read', 'emet.write']);
  });
  await test('a guest token is refused at refresh when guest access is off, even with member access on', async () => {
    const db = memDb(); const provider = providerFor(db);
    const t = await tokenFor(provider, db, 'guest');
    const r = await oauthCode(provider.exchangeRefreshToken(client, t.refresh_token, undefined, null));
    assert.strictEqual(r.code, 'invalid_grant', JSON.stringify(r)); assert.match(r.message, /invites are off/);
  });
  await test('a legacy guest token (no marker) is refused as a guest', async () => {
    const db = memDb(); const provider = providerFor(db);
    const t = await tokenFor(provider, db, 'guest', { legacy: true });
    assert.strictEqual((await oauthCode(provider.exchangeRefreshToken(client, t.refresh_token, undefined, null))).code, 'invalid_grant');
  });
  await test('a passphrase (owner) token is untouched by either flag', async () => {
    const db = memDb(); const provider = providerFor(db);
    const t = await provider._issueTokens('c1', [], null, 'alex', null, null, 'laptop');
    assert.ok((await provider.exchangeRefreshToken(client, t.refresh_token, undefined, null)).access_token);
  });
});
summary('DOORS (ONLY EMET_MEMBER_ACCESS=1) TEST SUMMARY');
