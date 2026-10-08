/**
 * EMET - an expired, revoked, rotated or unknown login is refused clearly,
 * never with a 500.
 *
 * The provider used to throw plain Error objects for these cases. The SDK's
 * bearer middleware and token endpoint only recognise its own OAuth error
 * classes; anything else is answered as 500 server_error. So an expired
 * access token on /mcp looked like a broken server, and a client had no
 * signal to refresh or sign in again.
 *
 * These tests run the SDK's real token handler and bearer middleware over
 * HTTP, as http-remote.js mounts them, against an in-memory store:
 *   /mcp with a bad access token  -> 401 invalid_token + WWW-Authenticate
 *   /token with a bad refresh token or code -> 400 invalid_grant
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import express from 'express';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { MongoOAuthProvider, tokenDigest } from '../src/oauth-provider.js';

import { memDb } from './memstore.js';

const db = memDb();
const provider = new MongoOAuthProvider(() => db, {
  passphrase: 'p', issuerUrl: 'http://127.0.0.1', fetch: async () => ({ ok: false, status: 404 }),
  resolveSubject: async () => 'owner', invitesFrozen: async () => false, memberAccessFrozen: async () => false
});
const CLIENT = { client_id: 'c1', redirect_uris: ['http://127.0.0.1/cb'], token_endpoint_auth_method: 'none' };
await db.collection(`${provider.prefix}oauth_clients`).insertOne({ ...CLIENT });
const tokens = db.collection(`${provider.prefix}oauth_tokens`);

const app = express();
app.use('/token', tokenHandler({ provider, rateLimit: false }));
app.post('/mcp', requireBearerAuth({ verifier: provider }), (req, res) => res.json({ ok: true, subject: req.auth.extra.subject }));
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const mcp = (token) => fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
const tokenReq = (fields) => fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: 'c1', ...fields }).toString() });
const refresh = (rt) => tokenReq({ grant_type: 'refresh_token', refresh_token: rt });
const rowFor = (tok) => tokens.rows.find((r) => r.token === tokenDigest(tok));

async function expect401(res, pattern) {
  const body = await res.json();
  assert.strictEqual(res.status, 401, `status ${res.status} ${JSON.stringify(body)}`);
  assert.strictEqual(body.error, 'invalid_token');
  assert.match(body.error_description, pattern);
  assert.match(res.headers.get('www-authenticate') || '', /^Bearer error="invalid_token"/);
}
async function expect400grant(res, pattern) {
  const body = await res.json();
  assert.strictEqual(res.status, 400, `status ${res.status} ${JSON.stringify(body)}`);
  assert.strictEqual(body.error, 'invalid_grant');
  assert.match(body.error_description, pattern);
}

try {
  await testGroup('/mcp: a bad access token is 401 invalid_token, never 500', async () => {
    const good = await provider._issueTokens('c1', ['emet.read'], null);
    await test('a live access token still gets through', async () => {
      const res = await mcp(good.access_token);
      assert.strictEqual(res.status, 200);
    });
    await test('an expired access token: 401 with "expired"', async () => {
      const t = await provider._issueTokens('c1', [], null);
      rowFor(t.access_token).expiresAt = Math.floor(Date.now() / 1000) - 5;
      await expect401(await mcp(t.access_token), /expired/);
    });
    await test('a revoked access token: 401 with "not recognised"', async () => {
      const t = await provider._issueTokens('c1', [], null);
      await provider.revokeToken({ client_id: 'c1' }, { token: t.access_token });
      await expect401(await mcp(t.access_token), /not recognised/);
    });
    await test('an unknown (made-up) access token: 401', async () => {
      await expect401(await mcp('no-such-token'), /not recognised/);
    });
    await test('a refresh token presented as an access token: 401', async () => {
      await expect401(await mcp(good.refresh_token), /not recognised/);
    });
    await test('the stored digest presented as a token: 401', async () => {
      await expect401(await mcp(tokenDigest(good.access_token)), /not recognised/);
    });
  });

  await testGroup('/token refresh: a bad refresh token is 400 invalid_grant, never 500', async () => {
    await test('a live refresh token still refreshes', async () => {
      const t = await provider._issueTokens('c1', [], null, null, null, null, 'laptop');
      const res = await refresh(t.refresh_token);
      assert.strictEqual(res.status, 200);
      assert.ok((await res.json()).access_token);
    });
    await test('an expired refresh token: 400 invalid_grant, "expired"', async () => {
      const t = await provider._issueTokens('c1', [], null);
      rowFor(t.refresh_token).expiresAt = Math.floor(Date.now() / 1000) - 5;
      await expect400grant(await refresh(t.refresh_token), /expired/);
    });
    await test('a rotated refresh token past the grace window: 400 invalid_grant, "replaced"', async () => {
      const t = await provider._issueTokens('c1', [], null, null, null, null, 'laptop');
      assert.strictEqual((await refresh(t.refresh_token)).status, 200);
      rowFor(t.refresh_token).rotated_at -= 3600;
      await expect400grant(await refresh(t.refresh_token), /replaced/);
    });
    await test('a revoked refresh token: 400 invalid_grant, "not recognised"', async () => {
      const t = await provider._issueTokens('c1', [], null);
      await provider.revokeToken({ client_id: 'c1' }, { token: t.refresh_token });
      await expect400grant(await refresh(t.refresh_token), /not recognised/);
    });
    await test('an unknown refresh token: 400 invalid_grant', async () => {
      await expect400grant(await refresh('no-such-refresh-token'), /not recognised/);
    });
    await test('a refresh token issued to another client: 400 invalid_grant', async () => {
      const t = await provider._issueTokens('c2', [], null);
      await expect400grant(await refresh(t.refresh_token), /not recognised/);
    });
  });

  await testGroup('/token code exchange: a bad authorization code is 400 invalid_grant, never 500', async () => {
    await test('an unknown code: 400 invalid_grant', async () => {
      await expect400grant(await tokenReq({ grant_type: 'authorization_code', code: 'no-such-code', code_verifier: 'x'.repeat(43) }), /not recognised/);
    });
    await test('a used code and an expired code are invalid_grant from the provider', async () => {
      const used = await provider.createAuthorizationCode({ client_id: 'c1', redirect_uri: 'http://127.0.0.1/cb', code_challenge: 'c' });
      await provider.exchangeAuthorizationCode(CLIENT, used);
      await assert.rejects(() => provider.exchangeAuthorizationCode(CLIENT, used), (e) => e.errorCode === 'invalid_grant' && /already been used/.test(e.message));
      const old = await provider.createAuthorizationCode({ client_id: 'c1', redirect_uri: 'http://127.0.0.1/cb', code_challenge: 'c' });
      const row = await db.collection(`${provider.prefix}oauth_codes`).findOne({ code: tokenDigest(old) });
      row.expiresAtMs = Date.now() - 1;
      await assert.rejects(() => provider.exchangeAuthorizationCode(CLIENT, old), (e) => e.errorCode === 'invalid_grant' && /expired/.test(e.message));
    });
  });

  // The other direction (2026-10-03): a store that cannot be read is the
  // server's fault, so it is a 500, never a refusal that tells a client its
  // login is bad and sends it off to sign in again.
  await testGroup('a store failure is 500, never invalid_token / invalid_grant', async () => {
    const down = async (fn) => {
      const real = tokens.findOne;
      tokens.findOne = async () => { throw new Error('store unreachable'); };
      try { return await fn(); } finally { tokens.findOne = real; }
    };
    await test('/mcp with a live access token while the token store is down: 500, not 401', async () => {
      const t = await provider._issueTokens('c1', [], null);
      const res = await down(() => mcp(t.access_token));
      const body = await res.json();
      assert.strictEqual(res.status, 500, `status ${res.status} ${JSON.stringify(body)}`);
      assert.notStrictEqual(body.error, 'invalid_token');
    });
    await test('/token refresh with a live refresh token while the token store is down: 500, not 400 invalid_grant', async () => {
      const t = await provider._issueTokens('c1', [], null);
      const res = await down(() => refresh(t.refresh_token));
      const body = await res.json();
      assert.strictEqual(res.status, 500, `status ${res.status} ${JSON.stringify(body)}`);
      assert.notStrictEqual(body.error, 'invalid_grant');
      assert.ok(rowFor(t.refresh_token), 'the refresh token was not consumed');
    });
  });
} finally {
  server.close();
}

summary('TOKEN REFUSALS (401 / invalid_grant, NEVER 500) TEST SUMMARY');
