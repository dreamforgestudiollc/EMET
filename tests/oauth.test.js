/**
 * EMET - OAuth provider tests: Client ID Metadata Documents (CIMD), refresh
 * rotation, and the metadata advertisement that lets a client choose CIMD.
 *
 * Why this exists (2026-09-07): the MCP 2026-07-28 specification deprecates
 * Dynamic Client Registration with a twelve-month window in favour of CIMD,
 * and EMET's provider implemented only DCR. This is the auth path of EMET's
 * ONLY transport; a defect here locks every interface out. So the pure parts
 * are tested without a network or a database, and the fetch-and-cache path is
 * tested against an in-memory collection and an injected fetch - the failure
 * cases first, because a provider that accepts a bad document is worse than
 * one that rejects a good one.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import {
  MongoOAuthProvider,
  isCimdClientId,
  validateCimdDocument,
  withCimdMetadata,
  CIMD_TTL_MS,
  tokenDigest
} from '../src/oauth-provider.js';





// ---------------------------------------------------------------------------
// In-memory stand-ins. Only the Mongo surface the provider actually uses.
// ---------------------------------------------------------------------------
import { memDb } from './memstore.js';
function fakeFetch(map) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const entry = map[String(url)];
    if (!entry) return { ok: false, status: 404, headers: new Map(), text: async () => 'not found' };
    if (entry instanceof Error) throw entry;
    const body = typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body);
    return {
      ok: (entry.status || 200) < 400,
      status: entry.status || 200,
      headers: new Map(Object.entries(entry.headers || { 'content-type': 'application/json' })),
      text: async () => body
    };
  };
  fn.calls = calls;
  return fn;
}

const CIMD_URL = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const GOOD_DOC = {
  client_id: CIMD_URL,
  client_name: 'Claude',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none'
};

(async () => {

await testGroup('isCimdClientId - a client id is a CIMD reference only when it is an https URL', () => {
  test('accepts an https URL', () => assert.strictEqual(isCimdClientId(CIMD_URL), true));
  test('rejects an opaque DCR id', () => assert.strictEqual(isCimdClientId('a3F9kQ2mZ8xL1pW4'), false));
  test('rejects http (metadata must be fetched over TLS)', () => assert.strictEqual(isCimdClientId('http://example.com/client'), false));
  test('rejects a URL with a fragment', () => assert.strictEqual(isCimdClientId('https://example.com/client#x'), false));
  test('rejects a URL with userinfo', () => assert.strictEqual(isCimdClientId('https://user:pw@example.com/client'), false));
  test('rejects a bare host with no path (a document needs a location)', () => assert.strictEqual(isCimdClientId('https://example.com'), false));
  test('rejects null / undefined / non-strings', () => {
    assert.strictEqual(isCimdClientId(null), false);
    assert.strictEqual(isCimdClientId(undefined), false);
    assert.strictEqual(isCimdClientId(42), false);
  });
});

await testGroup('validateCimdDocument - the document must describe the URL it was fetched from', () => {
  test('accepts a well-formed document', () => {
    const v = validateCimdDocument(GOOD_DOC, CIMD_URL);
    assert.strictEqual(v.client_id, CIMD_URL);
    assert.deepStrictEqual(v.redirect_uris, GOOD_DOC.redirect_uris);
  });
  test('rejects a document whose client_id differs from the URL (the binding that makes CIMD safe)', () => {
    assert.throws(() => validateCimdDocument({ ...GOOD_DOC, client_id: 'https://attacker.example/x' }, CIMD_URL), /client_id/);
  });
  test('rejects a document with no redirect_uris', () => {
    assert.throws(() => validateCimdDocument({ ...GOOD_DOC, redirect_uris: undefined }, CIMD_URL), /redirect_uris/);
  });
  test('rejects a document whose redirect_uris are not all strings', () => {
    assert.throws(() => validateCimdDocument({ ...GOOD_DOC, redirect_uris: ['https://a', 5] }, CIMD_URL), /redirect_uris/);
  });
  test('rejects a document that asks for a client secret (CIMD clients are public)', () => {
    assert.throws(() => validateCimdDocument({ ...GOOD_DOC, token_endpoint_auth_method: 'client_secret_post' }, CIMD_URL), /token_endpoint_auth_method/);
  });
  test('tolerates an absent token_endpoint_auth_method (defaults to none)', () => {
    const { token_endpoint_auth_method, ...d } = GOOD_DOC;
    assert.strictEqual(validateCimdDocument(d, CIMD_URL).token_endpoint_auth_method, 'none');
  });
  test('never carries a client_secret through, even if the document had one', () => {
    const v = validateCimdDocument({ ...GOOD_DOC, client_secret: 'leak' }, CIMD_URL);
    assert.strictEqual(v.client_secret, undefined);
  });
  test('rejects non-object input', () => {
    assert.throws(() => validateCimdDocument('nope', CIMD_URL));
    assert.throws(() => validateCimdDocument(null, CIMD_URL));
    assert.throws(() => validateCimdDocument([GOOD_DOC], CIMD_URL));
  });
});

await testGroup('withCimdMetadata - advertising is what makes the client choose CIMD', () => {
  const base = { issuer: 'https://x', token_endpoint_auth_methods_supported: ['client_secret_post', 'none'], registration_endpoint: 'https://x/register' };
  test('adds client_id_metadata_document_supported: true when enabled', () => {
    const m = withCimdMetadata(base, true);
    assert.strictEqual(m.client_id_metadata_document_supported, true);
  });
  test('keeps "none" in token_endpoint_auth_methods_supported (Claude requires BOTH signals)', () => {
    const m = withCimdMetadata(base, true);
    assert(m.token_endpoint_auth_methods_supported.includes('none'));
  });
  test('adds "none" if the base metadata lacked it', () => {
    const m = withCimdMetadata({ ...base, token_endpoint_auth_methods_supported: ['client_secret_post'] }, true);
    assert(m.token_endpoint_auth_methods_supported.includes('none'));
  });
  test('leaves DCR advertised alongside (deprecated, not removed - twelve-month window)', () => {
    const m = withCimdMetadata(base, true);
    assert.strictEqual(m.registration_endpoint, 'https://x/register');
  });
  test('when disabled, sets the flag to false explicitly rather than omitting it', () => {
    const m = withCimdMetadata(base, false);
    assert.strictEqual(m.client_id_metadata_document_supported, false);
  });
  test('does not mutate its input', () => {
    const copy = JSON.parse(JSON.stringify(base));
    withCimdMetadata(base, true);
    assert.deepStrictEqual(base, copy);
  });
});

await testGroup('getClient - opaque ids still resolve from the clients collection (DCR path unchanged)', async () => {
  const db = memDb();
  const provider = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example', fetch: fakeFetch({}) });
  const reg = await provider.clientsStore.registerClient({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'dcr' });
  await test('registerClient mints an opaque id', () => assert.match(reg.client_id, /^[A-Za-z0-9_-]{16,}$/));
  await test('getClient returns the registered client', async () => {
    const c = await provider.clientsStore.getClient(reg.client_id);
    assert.strictEqual(c.client_name, 'dcr');
  });
  await test('getClient returns undefined for an unknown opaque id (never fetches)', async () => {
    const c = await provider.clientsStore.getClient('nope');
    assert.strictEqual(c, undefined);
    assert.strictEqual(provider._fetch.calls.length, 0);
  });
});

await testGroup('getClient - CIMD: fetch, validate, cache', async () => {
  const db = memDb();
  const fetch = fakeFetch({ [CIMD_URL]: { body: GOOD_DOC } });
  const provider = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example', fetch });

  await test('fetches the document for a URL client_id and returns it as the client', async () => {
    const c = await provider.clientsStore.getClient(CIMD_URL);
    assert.strictEqual(c.client_id, CIMD_URL);
    assert.deepStrictEqual(c.redirect_uris, GOOD_DOC.redirect_uris);
    assert.strictEqual(fetch.calls.length, 1);
  });
  await test('sends Accept: application/json and a timeout signal', () => {
    const { opts } = fetch.calls[0];
    assert.strictEqual(opts.headers.Accept, 'application/json');
    assert(opts.signal, 'expected an AbortSignal');
  });
  await test('caches the document; a second call within the TTL does not fetch', async () => {
    await provider.clientsStore.getClient(CIMD_URL);
    assert.strictEqual(fetch.calls.length, 1);
  });
  await test('the cache row is marked as a CIMD client with a fetched_at', async () => {
    const row = await db.collection(`${provider.prefix}oauth_clients`).findOne({ client_id: CIMD_URL });
    assert.strictEqual(row.cimd, true);
    assert.strictEqual(typeof row.fetched_at, 'number');
  });
  await test('refetches once the TTL has passed', async () => {
    const col = db.collection(`${provider.prefix}oauth_clients`);
    const row = await col.findOne({ client_id: CIMD_URL });
    row.fetched_at = Date.now() - CIMD_TTL_MS - 1;
    await provider.clientsStore.getClient(CIMD_URL);
    assert.strictEqual(fetch.calls.length, 2);
  });
});

await testGroup('getClient - CIMD failure modes', async () => {
  await test('a 404 yields undefined (unknown client), not a throw', async () => {
    const provider = new MongoOAuthProvider(() => memDb(), { fetch: fakeFetch({}) });
    assert.strictEqual(await provider.clientsStore.getClient(CIMD_URL), undefined);
  });
  await test('a document whose client_id does not match the URL is rejected (yields undefined)', async () => {
    const provider = new MongoOAuthProvider(() => memDb(), { fetch: fakeFetch({ [CIMD_URL]: { body: { ...GOOD_DOC, client_id: 'https://evil.example/c' } } }) });
    assert.strictEqual(await provider.clientsStore.getClient(CIMD_URL), undefined);
  });
  await test('non-JSON is rejected', async () => {
    const provider = new MongoOAuthProvider(() => memDb(), { fetch: fakeFetch({ [CIMD_URL]: { body: '<html>' } }) });
    assert.strictEqual(await provider.clientsStore.getClient(CIMD_URL), undefined);
  });
  await test('a rejected document is NOT cached', async () => {
    const db = memDb();
    const provider = new MongoOAuthProvider(() => db, { fetch: fakeFetch({ [CIMD_URL]: { body: '<html>' } }) });
    await provider.clientsStore.getClient(CIMD_URL);
    assert.strictEqual(await db.collection(`${provider.prefix}oauth_clients`).findOne({ client_id: CIMD_URL }), null);
  });
  await test('an oversized body is rejected', async () => {
    const big = { ...GOOD_DOC, pad: 'x'.repeat(70 * 1024) };
    const provider = new MongoOAuthProvider(() => memDb(), { fetch: fakeFetch({ [CIMD_URL]: { body: big } }) });
    assert.strictEqual(await provider.clientsStore.getClient(CIMD_URL), undefined);
  });
  await test('a network error after a good cache serves the stale copy (the client is still who it was)', async () => {
    const db = memDb();
    const good = fakeFetch({ [CIMD_URL]: { body: GOOD_DOC } });
    const p1 = new MongoOAuthProvider(() => db, { fetch: good });
    await p1.clientsStore.getClient(CIMD_URL);
    const row = await db.collection(`${p1.prefix}oauth_clients`).findOne({ client_id: CIMD_URL });
    row.fetched_at = Date.now() - CIMD_TTL_MS - 1;
    const p2 = new MongoOAuthProvider(() => db, { fetch: fakeFetch({ [CIMD_URL]: new Error('ECONNRESET') }) });
    const c = await p2.clientsStore.getClient(CIMD_URL);
    assert.strictEqual(c.client_id, CIMD_URL);
  });
  await test('a network error with no cache yields undefined', async () => {
    const provider = new MongoOAuthProvider(() => memDb(), { fetch: fakeFetch({ [CIMD_URL]: new Error('ECONNRESET') }) });
    assert.strictEqual(await provider.clientsStore.getClient(CIMD_URL), undefined);
  });
  await test('with CIMD disabled, a URL client_id is treated as unknown and never fetched', async () => {
    const fetch = fakeFetch({ [CIMD_URL]: { body: GOOD_DOC } });
    const provider = new MongoOAuthProvider(() => memDb(), { fetch, cimd: false });
    assert.strictEqual(await provider.clientsStore.getClient(CIMD_URL), undefined);
    assert.strictEqual(fetch.calls.length, 0);
  });
});

await testGroup('refresh-token rotation (OAuth 2.1 for public clients)', async () => {
  const db = memDb();
  const provider = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example', fetch: fakeFetch({}) });
  const client = { client_id: 'c1' };
  const first = await provider._issueTokens('c1', ['emet.read'], null, null, null, null, 'laptop');
  let second;
  await test('a refresh issues a NEW refresh token', async () => {
    second = await provider.exchangeRefreshToken(client, first.refresh_token, [], null);
    assert.notStrictEqual(second.refresh_token, first.refresh_token);
    assert(second.access_token && second.access_token !== first.access_token);
  });
  await test('the old refresh token is marked rotated in the store', async () => {
    const row = await db.collection(`${provider.prefix}oauth_tokens`).findOne({ token: tokenDigest(first.refresh_token), kind: 'refresh' });
    assert.strictEqual(typeof row.rotated_at, 'number');
    assert.strictEqual(row.replaced_by, tokenDigest(second.refresh_token));
  });
  await test('the old refresh token is still honoured inside the grace window (a lost response must not lock the client out)', async () => {
    const third = await provider.exchangeRefreshToken(client, first.refresh_token, [], null);
    assert.strictEqual(third.refresh_token, second.refresh_token);
    assert.strictEqual(third.access_token, second.access_token);
  });
  await test('the new refresh token works', async () => {
    const r = await provider.exchangeRefreshToken(client, second.refresh_token, [], null);
    assert(r.access_token);
  });
  await test('the old refresh token is refused after the grace window with invalid_grant', async () => {
    const row = await db.collection(`${provider.prefix}oauth_tokens`).findOne({ token: tokenDigest(first.refresh_token), kind: 'refresh' });
    row.rotated_at = Math.floor(Date.now() / 1000) - 3600;
    await assert.rejects(() => provider.exchangeRefreshToken(client, first.refresh_token, [], null), (e) => e.errorCode === 'invalid_grant');
  });
  await test('a reuse outside the grace window revokes the replacement too', async () => {
    await assert.rejects(() => provider.exchangeRefreshToken(client, second.refresh_token, [], null), (e) => e.errorCode === 'invalid_grant');
  });
});

await testGroup('tokens are stored as digests, never in clear (security audit H2, 2026-09-19)', async () => {
  const db = memDb();
  const provider = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example', fetch: fakeFetch({}) });
  const tokens = db.collection(`${provider.prefix}oauth_tokens`);
  const issued = await provider._issueTokens('c1', ['emet.read'], null);
  await test('no issued token appears in clear anywhere in the tokens collection', async () => {
    const dump = JSON.stringify(tokens.rows);
    assert.ok(!dump.includes(issued.access_token), 'access token stored in clear');
    assert.ok(!dump.includes(issued.refresh_token), 'refresh token stored in clear');
    assert.ok(dump.includes(tokenDigest(issued.access_token)), 'access digest missing');
    assert.ok(tokens.rows.every((r) => r.hashed === true));
  });
  await test('the issued access token still verifies', async () => {
    const v = await provider.verifyAccessToken(issued.access_token);
    assert.strictEqual(v.clientId, 'c1');
  });
  await test('a digest presented AS a token does not verify (the stored value is not a bearer)', async () => {
    await assert.rejects(() => provider.verifyAccessToken(tokenDigest(issued.access_token)), (e) => e.errorCode === 'invalid_token');
  });
  await test('a pre-H2 clear row verifies once and is rewritten as its digest (no device re-authorizes)', async () => {
    const legacy = 'legacy-clear-token';
    await tokens.insertOne({ token: legacy, kind: 'access', client_id: 'c1', scopes: [], subject: 'owner', expiresAt: Math.floor(Date.now() / 1000) + 600, createdAt: new Date() });
    const v = await provider.verifyAccessToken(legacy);
    assert.strictEqual(v.clientId, 'c1');
    assert.strictEqual(await tokens.findOne({ token: legacy }), null, 'clear row still present after migration');
    const row = await tokens.findOne({ token: tokenDigest(legacy) });
    assert.ok(row && row.hashed === true, 'digest row missing after migration');
    const again = await provider.verifyAccessToken(legacy);
    assert.strictEqual(again.clientId, 'c1', 'the migrated token must keep working');
  });
  await test('revoke with the digest presented as the token removes nothing (same rule as verify)', async () => {
    const before = tokens.rows.length;
    await provider.revokeToken({ client_id: 'c1' }, { token: tokenDigest(issued.access_token) });
    assert.strictEqual(tokens.rows.length, before);
  });
  await test('revoke removes the digest row for the clear token presented', async () => {
    await provider.revokeToken({ client_id: 'c1' }, { token: issued.access_token });
    await assert.rejects(() => provider.verifyAccessToken(issued.access_token), (e) => e.errorCode === 'invalid_token');
  });
});

summary('OAUTH (CIMD + ROTATION + DIGESTS) TEST SUMMARY');
})();
