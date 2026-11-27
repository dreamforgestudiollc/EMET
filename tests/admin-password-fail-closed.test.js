/**
 * An unset connect passphrase is not owner proof. An anonymous create
 * is refused, and no recovery codes are minted.
 */

delete process.env.EMET_OAUTH_PASSPHRASE;
delete process.env.CASCADE_OAUTH_PASSPHRASE;
process.env.EMET_HTTP_LISTEN = '0';
process.env.EMET_REQUEST_LOG = '0';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

import assert from 'node:assert/strict';
import { test, summary } from './harness.js';

const ADMIN = 'admin-password-value';

console.log('\n=== Admin password fails closed ===');

const { makeStore } = await import('./memstore.js');
const { adminPasswordIsSet } = await import('../src/admin-password.js');
const remote = await import('../src/http-remote.js');

const server = await new Promise((resolve) => {
  const listening = remote.app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;

try {
  await test('an anonymous create with no connect passphrase is refused and mints nothing', async () => {
    const db = makeStore();
    remote.dbManager.db = db;
    const res = await fetch(`${base}/owner/admin-password`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: ADMIN, confirm: ADMIN }).toString()
    });
    const text = await res.text();
    assert.ok(res.status === 401 || res.status === 403, `${res.status} ${text.slice(0, 300)}`);
    assert.equal((text.match(/<code>/g) || []).length, 0);
    assert.equal(await adminPasswordIsSet(db), false);
    assert.equal(text.includes(ADMIN), false);
  });
} finally {
  server.close();
}

await summary('Admin password fails closed');
