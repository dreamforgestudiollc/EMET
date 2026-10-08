/**
 * EMET - one way to open a MongoDB connection (2026-09-29).
 *
 * The public-DNS fallback for resolvers that refuse SRV queries lived in one
 * connection; nine others and scripts/chain-verify.mjs opened their own client
 * without it. The helper is tested with a fake client and fake dns, and a
 * guard fails if any file but the helper constructs a MongoClient again.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectMongo, isSrvRefusal, PUBLIC_DNS } from '../src/mongo-connect.js';

function fakes(failures) {
  const calls = { made: 0, servers: null };
  class FakeClient {
    constructor(uri, opts) { this.uri = uri; this.opts = opts; calls.made++; }
    async connect() { const f = failures.shift(); if (f) throw new Error(f); }
  }
  const fakeDns = { setServers(s) { calls.servers = s; } };
  return { calls, FakeClient, fakeDns };
}

testGroup('connectMongo', () => {
  test('connects first time with no fallback', async () => {
    const { calls, FakeClient, fakeDns } = fakes([]);
    let told = false;
    const c = await connectMongo('mongodb+srv://x', { a: 1 }, { _Client: FakeClient, _dns: fakeDns, onFallback: () => { told = true; } });
    assert.strictEqual(calls.made, 1); assert.strictEqual(calls.servers, null); assert.strictEqual(told, false);
    assert.deepStrictEqual(c.opts, { a: 1 });
  });
  test('a querySrv refusal switches to public DNS and retries once', async () => {
    const { calls, FakeClient, fakeDns } = fakes(['querySrv ECONNREFUSED _mongodb._tcp.x']);
    let msg = null;
    await connectMongo('mongodb+srv://x', {}, { _Client: FakeClient, _dns: fakeDns, onFallback: (m) => { msg = m; } });
    assert.strictEqual(calls.made, 2);
    assert.deepStrictEqual(calls.servers, [...PUBLIC_DNS]);
    assert.ok(/public DNS/.test(msg));
  });
  test('a second failure after the fallback is thrown, not swallowed', async () => {
    const { FakeClient, fakeDns } = fakes(['querySrv ECONNREFUSED', 'still down']);
    await assert.rejects(() => connectMongo('u', {}, { _Client: FakeClient, _dns: fakeDns }), /still down/);
  });
  test('any other failure is thrown as it came, with no DNS change', async () => {
    const { calls, FakeClient, fakeDns } = fakes(['bad auth']);
    await assert.rejects(() => connectMongo('u', {}, { _Client: FakeClient, _dns: fakeDns }), /bad auth/);
    assert.strictEqual(calls.made, 1); assert.strictEqual(calls.servers, null);
  });
  test('isSrvRefusal reads the message', () => {
    assert.strictEqual(isSrvRefusal(new Error('querySrv ECONNREFUSED')), true);
    assert.strictEqual(isSrvRefusal(new Error('timeout')), false);
    assert.strictEqual(isSrvRefusal(null), false);
  });
});

testGroup('no second way to connect', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const allowed = new Set(['src/mongo-connect.js', 'scripts/migrate_sqlite_to_mongo.mjs']);
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${d}/${e.name}`) : (/\.(m?js)$/.test(e.name) ? [`${d}/${e.name}`] : []));
  const files = [...walk('src'), ...walk('scripts')];
  test('only the helper constructs a MongoClient (the retired SQLite migration script is exempt)', () => {
    const offenders = files.filter((f) => !allowed.has(f) && /new\s+MongoClient\s*\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    assert.deepStrictEqual(offenders, []);
  });
  test('only the helper changes DNS servers', () => {
    const offenders = files.filter((f) => !allowed.has(f) && /\.setServers\s*\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    assert.deepStrictEqual(offenders, []);
  });
});

summary('Mongo Connect Test Summary');
