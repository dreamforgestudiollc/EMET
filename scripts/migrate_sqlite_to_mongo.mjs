// Migration: upstream CASCADE SQLite layer files -> MongoDB (EMET collections)
//
// Only needed if you are coming from an upstream SQLite CASCADE install.
// A new EMET install has nothing to migrate.
//
//   SQLITE_DIR   directory holding <layer>_memory.db files   (required)
//   MONGODB_URI  target connection string                    (required)
//   MONGODB_DB   target database                             (default: emet)
// - Preserves every field including id exactly
// - Seeds <prefix>counters with each layer's max id
// - Verifies: count equality + sha256 set equality over (id|timestamp|content)
// - Safety: aborts if any target collection is non-empty
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { MongoClient } from 'mongodb';

const LAYERS = ['episodic', 'semantic', 'procedural', 'meta', 'identity', 'working'];
const PREFIX = process.env.EMET_COLLECTION_PREFIX || 'emet_';
const DATA_DIR = process.env.SQLITE_DIR;
if (!DATA_DIR) { console.error('SQLITE_DIR is not set. See the header of this file.'); process.exit(1); }
const uri = process.env.MONGODB_URI;
if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(1); }

function rowHash(r) {
  return crypto.createHash('sha256').update(`${r.id}|${r.timestamp}|${r.content ?? ''}`).digest('hex');
}

async function readSqliteLayer(layer) {
  const file = path.join(DATA_DIR, `${layer}_memory.db`);
  if (!fs.existsSync(file)) return [];
  const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
  const allAsync = promisify(db.all.bind(db));
  const rows = await allAsync('SELECT id, timestamp, content, event, context, emotional_intensity, importance, metadata FROM memories ORDER BY id');
  await promisify(db.close.bind(db))();
  return rows;
}

let client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
try {
  await client.connect();
} catch (e) {
  if (/querySrv/i.test(String(e.message))) {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    console.log('(connected via public-DNS fallback)');
  } else { throw e; }
}
const db = client.db(process.env.MONGODB_DB || 'emet');

let allOk = true;
const summary = [];

// Safety pre-check
for (const layer of LAYERS) {
  const n = await db.collection(PREFIX + layer).countDocuments({});
  if (n > 0) {
    console.log(`ABORT: ${PREFIX}${layer} already contains ${n} documents. No changes made.`);
    await client.close();
    process.exit(2);
  }
}

for (const layer of LAYERS) {
  const rows = await readSqliteLayer(layer);
  const col = db.collection(PREFIX + layer);

  if (rows.length > 0) {
    await col.insertMany(rows.map(r => ({ ...r })), { ordered: true });
  }
  await col.createIndex({ id: 1 }, { unique: true });
  await col.createIndex({ timestamp: -1 });
  await col.createIndex({ importance: -1 });

  const maxId = rows.length ? Math.max(...rows.map(r => r.id)) : 0;
  await db.collection(PREFIX + 'counters').updateOne(
    { _id: layer }, { $set: { seq: maxId } }, { upsert: true }
  );

  // Verification
  const mongoRows = await col.find({}).project({ _id: 0, id: 1, timestamp: 1, content: 1 }).toArray();
  const srcHashes = new Set(rows.map(rowHash));
  const dstHashes = new Set(mongoRows.map(rowHash));
  const countOk = mongoRows.length === rows.length;
  const hashOk = srcHashes.size === dstHashes.size && [...srcHashes].every(h => dstHashes.has(h));
  const ok = countOk && hashOk;
  if (!ok) allOk = false;
  summary.push(`${ok ? 'OK  ' : 'FAIL'} ${layer.padEnd(10)} sqlite=${rows.length} mongo=${mongoRows.length} hashes=${hashOk ? 'match' : 'MISMATCH'} counter=${maxId}`);
}

console.log(summary.join('\n'));
console.log(allOk ? 'MIGRATION: VERIFIED COMPLETE' : 'MIGRATION: VERIFICATION FAILED');
await client.close();
process.exit(allOk ? 0 : 1);
