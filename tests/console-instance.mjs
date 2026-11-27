/**
 * One EMET HTTP server for the cross-server console test.
 * The parent sets the env before spawn. This process uses its own store.
 */
process.env.EMET_HTTP_LISTEN = '0';
process.env.EMET_REQUEST_LOG = '0';
process.env.LOG_LEVEL = 'error';

const remote = await import('../src/http-remote.js');
const { makeStore } = await import('./memstore.js');
const { createAdminPassword } = await import('../src/admin-password.js');

const db = makeStore();
remote.dbManager.db = db;
const password = process.env.EMET_TEST_ADMIN_PASSWORD || '';
const created = await createAdminPassword(db, password, password);
if (!created.ok) {
  console.error('admin password was not created');
  process.exit(1);
}
const prefix = process.env.EMET_COLLECTION_PREFIX || 'emet_';
await db.collection(`${prefix}oauth_clients`).insertOne({
  client_id: 'console-test',
  client_name: 'Console',
  redirect_uris: ['https://console.example/callback']
});
const server = await new Promise((resolve) => {
  const listening = remote.app.listen(0, '127.0.0.1', () => resolve(listening));
});
process.stdout.write(`${server.address().port}\n`);
