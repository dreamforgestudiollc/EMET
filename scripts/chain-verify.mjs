/**
 * Walk each layer's forward hash chain - the OUTSIDE copy (2026-09-29).
 *
 * The same walk runs inside the server as part of emet_gaps (its `chain` block
 * and the broken_chain / chain_discontinuities classes), so every host can ask
 * for it. This script is kept on purpose as the independent check: an auditor
 * can verify the record without trusting the server's own answer. Both call
 * the one function, walkChain in src/aleph.js, so the two cannot drift.
 *
 * Run from the repo root with Railway env:
 *   railway run --service <service> node scripts/chain-verify.mjs
 */
import '../src/env.js';
import { connectMongo } from '../src/mongo-connect.js';
import { walkChain } from '../src/aleph.js';

const URI = process.env.MONGODB_URI;
const DB = process.env.MONGODB_DB || 'emet';
const PREFIX = process.env.EMET_COLLECTION_PREFIX || 'emet_';
const LAYERS = ['identity', 'semantic', 'episodic', 'procedural', 'meta', 'working'];

if (!URI) {
  console.error('MONGODB_URI is not set');
  process.exit(1);
}

// Through the shared helper, so a resolver that refuses SRV queries
// falls back to public DNS instead of failing.
const client = await connectMongo(URI, { serverSelectionTimeoutMS: 15000 }, {
  onFallback: (msg) => console.error(`(${msg})`)
});
const db = client.db(DB);

const report = { database: DB, prefix: PREFIX, layers: {}, checked_at: new Date().toISOString() };
try {
  for (const layer of LAYERS) {
    const rows = await db.collection(PREFIX + layer).find(
      {},
      { projection: { id: 1, timestamp: 1, sha256: 1, prev_sha256: 1, chain_sha256: 1 } }
    ).toArray();
    const w = walkChain(rows);
    report.layers[layer] = {
      total: w.total, linked: w.linked, unlinked: w.unlinked,
      broken: w.broken, broken_ids_sample: w.broken_ids,
      discontinuities: w.discontinuities, discontinuity_ids_sample: w.discontinuity_ids,
      head: w.head
    };
  }
} finally {
  await client.close();
}
console.log(JSON.stringify(report, null, 2));
