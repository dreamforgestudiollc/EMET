/**
 * The admin password opens settings. The connect passphrase
 * does not. Either secret can change while the other still checks out.
 * Login and settings use the full-size scene as a fixed background.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, summary } from './harness.js';

process.env.EMET_HTTP_LISTEN = '0';
process.env.EMET_OAUTH_PASSPHRASE = 'owner-secret-value';
process.env.EMET_REQUEST_LOG = '0';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const SECRET = 'owner-secret-value';
const ADMIN = 'admin-password-value';
const ADMIN_NEXT = 'admin-password-rotated';
const RECOVERED = 'admin-password-recovered';
const REDIRECT = 'https://example.com/cb';

console.log('\n=== Admin password ===');

const { makeStore, withEnv } = await import('./memstore.js');
const { MongoOAuthProvider, tokenDigest } = await import('../src/oauth-provider.js');
const {
  createAdminPassword, verifyAdminPassword, adminPasswordPublicStatus,
  recoverAdminPassword, transportIsAdminSession, ADMIN_CREDENTIALS_COLLECTION
} = await import('../src/admin-password.js');
const { OWNER_GRAPHIC_PATH } = await import('../src/owner-session.js');
const remote = await import('../src/http-remote.js');

const server = await new Promise((resolve) => {
  const listening = remote.app.listen(0, '127.0.0.1', () => resolve(listening));
});
// Argon2id under V8 coverage outlasts Node's 5s keep-alive. The next request
// on that idle socket is ECONNRESET ("fetch failed") even though the server
// is still up. Leave the test socket open for the whole suite.
server.keepAliveTimeout = 120000;
server.headersTimeout = 121000;
const base = `http://127.0.0.1:${server.address().port}`;
const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'assets');

function fresh() {
  const db = makeStore();
  remote.dbManager.db = db;
  return db;
}

function codesFrom(html) {
  return [...html.matchAll(/<code>([A-Za-z0-9_-]+)<\/code>/g)].map((row) => row[1]);
}

async function call(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    const code = err && err.cause && err.cause.code;
    if (code !== 'ECONNRESET' && code !== 'EPIPE') throw err;
    return fetch(url, options);
  }
}

async function postForm(urlPath, fields, extraHeaders = {}) {
  const res = await call(`${base}${urlPath}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams(fields).toString()
  });
  return { status: res.status, text: await res.text(), location: res.headers.get('location'), headers: res.headers };
}

async function approve(db, passphrase) {
  remote.dbManager.db = db;
  await db.collection('emet_oauth_clients').insertOne({
    client_id: `client-${passphrase.length}-${Date.now()}`,
    client_name: 'Host',
    redirect_uris: [REDIRECT]
  });
  const clientId = (await db.collection('emet_oauth_clients').find({}).toArray()).at(-1).client_id;
  return postForm('/oauth/approve', {
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: 'challenge',
    scopes: 'emet.read emet.write',
    passphrase
  });
}

try {
  await test('login and settings use the full-size scene as a fixed background', async () => {
    const db = fresh();
    const provider = new MongoOAuthProvider(() => db, { passphrase: SECRET });
    let body = '';
    await provider.authorize(
      { client_id: 'app', client_name: 'Host' },
      { redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: 'challenge', scopes: ['emet.read'] },
      { setHeader() {}, end(html) { body = html; }, req: { query: {}, originalUrl: '/authorize' } }
    );
    const settings = await call(`${base}/owner/admin-password`);
    const settingsHtml = await settings.text();
    for (const html of [body, settingsHtml]) {
      assert.match(html, new RegExp(`url\\("${OWNER_GRAPHIC_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`));
      assert.match(html, /background-attachment:\s*fixed/);
      assert.match(html, /background-size:\s*cover/);
      assert.equal(/background-size:\s*100%\s+100%/.test(html), false);
      assert.equal(/position:\s*fixed/.test(html), false);
      assert.equal(html.includes('portrait'), false);
      assert.match(html, /rgba\(18,\s*20,\s*26,\s*0\.86\)/);
    }
    assert.match(body, /connect passphrase/);
    assert.match(body, /name="passphrase"/);
    assert.equal(/name="password"/.test(body), false);
    const asset = await call(`${base}${OWNER_GRAPHIC_PATH}`);
    const bytes = Buffer.from(await asset.arrayBuffer());
    const full = fs.readFileSync(path.join(assets, 'scene.webp'));
    const crop = fs.readFileSync(path.join(assets, 'portrait.webp'));
    const small = fs.readFileSync(path.join(assets, 'portrait-560.webp'));
    assert.equal(asset.status, 200);
    assert.equal(bytes.equals(full), true);
    assert.equal(bytes.equals(crop), false);
    assert.ok(full.length > crop.length && full.length > small.length);
  });

  await test('a running process with the connect passphrase set is not settings admin', async () => {
    const db = makeStore();
    const status = await adminPasswordPublicStatus(db);
    assert.deepEqual(status, { admin_password_set: false, admin_password_url: '/owner/admin-password' });
    assert.equal(await verifyAdminPassword(db, SECRET), false);
    assert.equal(transportIsAdminSession(), false);
    const provider = new MongoOAuthProvider(() => db, { passphrase: SECRET });
    const created = await createAdminPassword(db, ADMIN, ADMIN);
    assert.equal(created.ok, true, JSON.stringify({ status: created.status, reason: created.reason }));
    const row = await db.collection(ADMIN_CREDENTIALS_COLLECTION).findOne({ _id: 'admin' });
    assert.equal(row.algorithm, 'argon2id');
    assert.equal(JSON.stringify(row).includes(ADMIN), false);
    assert.equal(JSON.stringify(await db.collection('documents').find({}).toArray()).includes(ADMIN), false);
    assert.equal((await db.collection('owner_credential').find({}).toArray()).length, 0);
    assert.equal(await verifyAdminPassword(db, ADMIN), true);
    assert.equal(await verifyAdminPassword(db, SECRET), false);
    provider.passphrase = 'rotated-connect-secret';
    assert.equal(provider.checkPassphrase('rotated-connect-secret'), true);
    assert.equal(provider.checkPassphrase(SECRET), false);
    assert.equal(provider.checkPassphrase(ADMIN), false);
    assert.equal(await verifyAdminPassword(db, ADMIN), true);
    assert.equal(await verifyAdminPassword(db, 'rotated-connect-secret'), false);
  });

  await test('a pepper that matches the connect passphrase is not applied', async () => {
    const db = makeStore();
    await withEnv({ EMET_ADMIN_PEPPER: SECRET, EMET_OAUTH_PASSPHRASE: SECRET }, async () => {
      const created = await createAdminPassword(db, ADMIN, ADMIN);
      assert.equal(created.ok, true, created.reason);
      const row = await db.collection(ADMIN_CREDENTIALS_COLLECTION).findOne({ _id: 'admin' });
      assert.equal(row.peppered, false);
      assert.equal(await verifyAdminPassword(db, ADMIN), true);
    });
  });

  await test('the README names /owner/admin-password and does not send settings to the connect passphrase', () => {
    const readme = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
    assert.match(readme, /\/owner\/admin-password/);
    assert.match(readme, /admin password/i);
    assert.equal(/use the connect passphrase.{0,80}settings/i.test(readme), false);
    assert.equal(/settings.{0,80}use the connect passphrase/i.test(readme), false);
    assert.equal(/EMET_OAUTH_PASSPHRASE.{0,120}(opens settings|opens the chooser|admin password)/i.test(readme), false);
  });

  await test('an owner Authorize token can create the admin password and a member token cannot', async () => {
    const db = fresh();
    const now = Math.floor(Date.now() / 1000) + 3600;
    async function plant(plain, issued) {
      await db.collection('emet_oauth_tokens').insertOne({
        token: tokenDigest(plain), hashed: true, kind: 'access', client_id: 'host',
        scopes: ['emet'], subject: issued === 'owner' ? 'owner' : 'ada', issued_via: issued,
        family: `fam-${issued}-admin`, source_tag: issued === 'owner' ? 'owner' : 'laptop',
        expiresAt: now, createdAt: new Date(), rotation_generation: 0
      });
    }
    await plant('member-access-token-value', 'member');
    await plant('owner-access-token-value', 'owner');
    const member = await postForm('/owner/admin-password', { password: ADMIN, confirm: ADMIN }, { authorization: 'Bearer member-access-token-value' });
    assert.equal(member.status, 401, member.text.slice(0, 300));
    assert.equal(await db.collection(ADMIN_CREDENTIALS_COLLECTION).findOne({ _id: 'admin' }), null);
    const owner = await postForm('/owner/admin-password', { password: ADMIN, confirm: ADMIN }, { authorization: 'Bearer owner-access-token-value' });
    assert.equal(owner.status, 200, owner.text.slice(0, 400));
    assert.equal(await verifyAdminPassword(db, ADMIN), true);
    assert.equal(await verifyAdminPassword(db, SECRET), false);
    const row = await db.collection(ADMIN_CREDENTIALS_COLLECTION).findOne({ _id: 'admin' });
    assert.equal(JSON.stringify(row).includes(SECRET), false);
  });

  await test('settings require the admin password and refuse the connect passphrase', async () => {
    const db = fresh();
    for (const door of ['/owner/chooser', '/owner/break-glass', '/owner/approvals', '/owner/approvals/decide', '/owner/chooser/decide']) {
      const closed = await call(`${base}${door}`, { redirect: 'manual' });
      assert.equal(closed.status, 303, `${door} ${await closed.text()}`);
      assert.match(closed.headers.get('location') || '', /\/owner\/admin-password$/, door);
    }
    const grant = await postForm('/owner/chooser/decide', { decision: 'guest', tag: 'laptop' });
    assert.equal(grant.status, 303, grant.text.slice(0, 200));
    assert.match(grant.location || '', /\/owner\/admin-password$/);
    const missingProof = await postForm('/owner/admin-password', { password: ADMIN, confirm: ADMIN });
    assert.equal(missingProof.status, 401, missingProof.text.slice(0, 300));
    const passwordIsNotProof = await postForm('/owner/admin-password', { password: SECRET, confirm: SECRET });
    assert.equal(passwordIsNotProof.status, 401, passwordIsNotProof.text.slice(0, 300));
    assert.equal(await db.collection(ADMIN_CREDENTIALS_COLLECTION).findOne({ _id: 'admin' }), null);
    const created = await postForm('/owner/admin-password', { connect_passphrase: SECRET, password: ADMIN, confirm: ADMIN });
    assert.equal(created.status, 200, created.text.slice(0, 400));
    const codes = codesFrom(created.text);
    assert.equal(codes.length, 8);
    const firstRow = await db.collection(ADMIN_CREDENTIALS_COLLECTION).findOne({ _id: 'admin' });
    const again = await postForm('/owner/admin-password', { password: 'second-admin-password', confirm: 'second-admin-password' });
    assert.equal(again.status, 409, again.text.slice(0, 300));
    const kept = await db.collection(ADMIN_CREDENTIALS_COLLECTION).findOne({ _id: 'admin' });
    assert.equal(kept.hash, firstRow.hash);
    assert.equal(kept.salt, firstRow.salt);
    assert.equal(await verifyAdminPassword(db, ADMIN), true);
    assert.equal(await verifyAdminPassword(db, 'second-admin-password'), false);
    const row = await db.collection(ADMIN_CREDENTIALS_COLLECTION).findOne({ _id: 'admin' });
    assert.equal(JSON.stringify(row).includes(codes[0]), false);
    const asPassphrase = await postForm('/owner/login', { passphrase: ADMIN, next: '/owner/chooser' });
    assert.equal(asPassphrase.status, 401);
    const asConnect = await postForm('/owner/login', { password: SECRET, next: '/owner/chooser' });
    assert.equal(asConnect.status, 401, asConnect.text);
    assert.match(asConnect.text, /admin password/);
    const signed = await postForm('/owner/login', { password: ADMIN, next: '/owner/chooser' });
    assert.equal(signed.status, 303, signed.text);
    const cookie = signed.headers.get('set-cookie').split(';')[0];
    const page = await call(`${base}/owner/chooser`, { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /Grant this door/);
    assert.match(html, /background-attachment:\s*fixed/);
    const anonymous = await postForm('/owner/chooser/decide', { decision: 'guest', tag: 'laptop' });
    assert.equal(anonymous.status, 401);
    const connectOnAuthorize = await approve(db, SECRET);
    assert.equal(connectOnAuthorize.status, 302, connectOnAuthorize.text.slice(0, 300));
    const adminOnAuthorize = await approve(db, ADMIN);
    assert.equal(adminOnAuthorize.status, 401, adminOnAuthorize.text.slice(0, 300));
    const before = await db.collection('emet_oauth_codes').countDocuments({});
    assert.equal(before, 1);

    const rotatePage = await call(`${base}/owner/admin-password/rotate`, { headers: { cookie } });
    const rotateHtml = await rotatePage.text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(rotateHtml)[1];
    const rotated = await call(`${base}/owner/admin-password/rotate`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, current: ADMIN, password: ADMIN_NEXT, confirm: ADMIN_NEXT }).toString()
    });
    const rotatedHtml = await rotated.text();
    assert.equal(rotated.status, 200, rotatedHtml.slice(0, 400));
    const nextCodes = codesFrom(rotatedHtml);
    assert.equal(nextCodes.length, 8);
    const stale = await call(`${base}/owner/chooser`, { headers: { cookie } });
    assert.match(await stale.text(), /name="password"/);
    assert.equal(await verifyAdminPassword(db, ADMIN), false);
    assert.equal(await verifyAdminPassword(db, ADMIN_NEXT), true);
    const stillConnect = await approve(db, SECRET);
    assert.equal(stillConnect.status, 302, stillConnect.text.slice(0, 200));
    const oldAdmin = await postForm('/owner/login', { password: ADMIN, next: '/owner/chooser' });
    assert.equal(oldAdmin.status, 401);
    const newAdmin = await postForm('/owner/login', { password: ADMIN_NEXT, next: '/owner/chooser' });
    assert.equal(newAdmin.status, 303, newAdmin.text);

    const rejected = await postForm('/owner/admin-password/recover', {
      proof: SECRET, password: RECOVERED, confirm: RECOVERED
    });
    assert.equal(rejected.status, 401, rejected.text.slice(0, 300));
    assert.match(rejected.text, /connect passphrase/);
    assert.equal(await verifyAdminPassword(db, ADMIN_NEXT), true);
    const recovered = await postForm('/owner/admin-password/recover', {
      proof: nextCodes[0], password: RECOVERED, confirm: RECOVERED
    });
    assert.equal(recovered.status, 200, recovered.text.slice(0, 400));
    assert.equal(await verifyAdminPassword(db, ADMIN_NEXT), false);
    assert.equal(await verifyAdminPassword(db, RECOVERED), true);
    const connectAfterRecover = await approve(db, SECRET);
    assert.equal(connectAfterRecover.status, 302, connectAfterRecover.text.slice(0, 200));
  });

  await test('the host recovery token is single-use and is not the connect passphrase', async () => {
    const db = fresh();
    await withEnv({ EMET_ADMIN_RECOVERY: SECRET }, async () => {
      const refused = await recoverAdminPassword(db, {
        proof: SECRET,
        password: RECOVERED,
        confirm: RECOVERED,
        connectPassphrase: (input) => input === SECRET
      });
      assert.equal(refused.reason, 'connect_passphrase_rejected');
      assert.equal(await adminPasswordPublicStatus(db).then((row) => row.admin_password_set), false);
    });
    await withEnv({ EMET_ADMIN_RECOVERY: 'host-recovery-token' }, async () => {
      const first = await postForm('/owner/admin-password/recover', {
        proof: 'host-recovery-token', password: ADMIN, confirm: ADMIN
      });
      assert.equal(first.status, 200, first.text.slice(0, 300));
      const second = await postForm('/owner/admin-password/recover', {
        proof: 'host-recovery-token', password: ADMIN_NEXT, confirm: ADMIN_NEXT
      });
      assert.equal(second.status, 401, second.text.slice(0, 300));
      assert.equal(await verifyAdminPassword(db, ADMIN), true);
      assert.equal(await verifyAdminPassword(db, ADMIN_NEXT), false);
      const connect = await approve(db, SECRET);
      assert.equal(connect.status, 302, connect.text.slice(0, 200));
    });
  });
} finally {
  server.close();
}

await summary('Admin password');
