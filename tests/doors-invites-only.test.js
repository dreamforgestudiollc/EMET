/**
 * EMET - the two doors, with only EMET_INVITES=1 (public snapshot 1.0.0).
 * EMET Guest Access (EMET_INVITES) and EMET Member Access (EMET_MEMBER_ACCESS) are separate doors with
 * separate flags. invites.js reads its flags at module load, so this file sets the environment BEFORE
 * importing anything that reads them (the way invites.test.js runs with both unset), and each env
 * combination has its own file.
 */
for (const k of ['EMET_INVITES', 'CASCADE_INVITES', 'EMET_MEMBER_ACCESS', 'CASCADE_MEMBER_ACCESS']) delete process.env[k];
process.env.EMET_INVITES = '1';
const { test, testGroup, summary } = await import('./harness.js');
const assert = (await import('assert')).default;
const { createInvite, createMemberAccess, redeemInvite, mintInviteCode, inviteDigest, INVITES_FROZEN, MEMBER_ACCESS_FROZEN, MEMBER_SCOPES } = await import('../src/invites.js');
const { MongoOAuthProvider, INVITE_GRANT, MEMBER_GRANT, tokenDigest } = await import('../src/oauth-provider.js');
const { memberAccessCreate } = await import('../src/tools.js');
const { actorStore } = await import('../src/persons.js');
const { ValidationError } = await import('../src/validation.js');

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

console.log('\n=== doors: only EMET_INVITES=1 ===');
await testGroup('flags', () => {
  test('guest access on, member access off', () => { assert.strictEqual(INVITES_FROZEN, false); assert.strictEqual(MEMBER_ACCESS_FROZEN, true); });
});
await testGroup('EMET Member Access stays shut when only guest access is on', async () => {
  await test('creation is refused (invites.js and the emet_member_access_create tool), nothing stored', async () => {
    const db = memDb();
    await assert.rejects(() => createMemberAccess(db, { display_name: 'M' }), (e) => e.code === 'MEMBER_ACCESS_FROZEN');
    // The tool refuses on its own, as a ValidationError, before reaching invites.js.
    await assert.rejects(() => memberAccessCreate(dbManagerFor(db), { display_name: 'M' }), (e) => e instanceof ValidationError && /EMET Member Access is off/.test(e.message) && e.code !== 'MEMBER_ACCESS_FROZEN');
    assert.strictEqual(db.collection('invites').rows.length, 0);
  });
  await test('a member code is refused at redeem (reason frozen, member wording), no person created, code not used', async () => {
    const db = memDb();
    const code = await plantCode(db, 'member', ['emet.read', 'emet.write']);
    const r = await redeemInvite(db, code);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'frozen'); assert.match(r.message, /EMET Member Access is off/);
    assert.strictEqual(db.collection('persons').rows.length, 1);
    assert.strictEqual(db.collection('invites').rows[0].used_at, null);
  });
  await test('a guest code still redeems as a guest (read only, door guest on the person row)', async () => {
    const db = memDb();
    const made = await createInvite(db, { display_name: 'Guest' });
    const r = await redeemInvite(db, made.code);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.door, 'guest'); assert.deepStrictEqual(r.scopes, ['emet.read']);
    assert.strictEqual((await db.collection('persons').findOne({ person_id: r.person_id })).door, 'guest');
  });
});
await testGroup('refresh: each token against its own flag', async () => {
  await test('a member token is refused at refresh when member access is off, even with guest access on', async () => {
    const db = memDb(); const provider = providerFor(db);
    const t = await tokenFor(provider, db, 'member');
    const row = await db.collection(`${provider.prefix}oauth_tokens`).findOne({ token: tokenDigest(t.refresh_token), kind: 'refresh' });
    assert.strictEqual(row.issued_via, MEMBER_GRANT, 'the member marker is stored on the token');
    const r = await oauthCode(provider.exchangeRefreshToken(client, t.refresh_token, undefined, null));
    assert.strictEqual(r.code, 'invalid_grant', JSON.stringify(r)); assert.match(r.message, /EMET Member Access/);
  });
  await test('a legacy member token (no marker, person door member) is refused too', async () => {
    const db = memDb(); const provider = providerFor(db);
    const t = await tokenFor(provider, db, 'member', { legacy: true });
    assert.strictEqual((await oauthCode(provider.exchangeRefreshToken(client, t.refresh_token, undefined, null))).code, 'invalid_grant');
  });
  await test('a guest token refreshes while guest access is on, and keeps its guest marker', async () => {
    const db = memDb(); const provider = providerFor(db);
    const t = await tokenFor(provider, db, 'guest');
    const out = await provider.exchangeRefreshToken(client, t.refresh_token, undefined, null);
    assert.ok(out.access_token);
    const row = await db.collection(`${provider.prefix}oauth_tokens`).findOne({ token: tokenDigest(out.refresh_token), kind: 'refresh' });
    assert.strictEqual(row.issued_via, INVITE_GRANT);
  });
  await test('a legacy guest token (no marker, role member, no door) still works as a guest', async () => {
    const db = memDb(); const provider = providerFor(db);
    const t = await tokenFor(provider, db, 'guest', { legacy: true });
    assert.strictEqual(await provider._tokenDoor({ subject: 'guest-1' }), 'guest');
    assert.ok((await provider.exchangeRefreshToken(client, t.refresh_token, undefined, null)).access_token);
  });
});
summary('DOORS (ONLY EMET_INVITES=1) TEST SUMMARY');
