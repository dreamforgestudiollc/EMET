/**
 * Security audit (2026-09-29): what may the server's own database login do?
 * Prints the authenticated user's roles and the distinct actions it holds per
 * resource - never the URI, the user name's password, or any document.
 * Run from the repo root:
 *   railway run --service <service> node scripts/db-privileges.mjs
 */
import '../src/env.js';
import { connectMongo } from '../src/mongo-connect.js';

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI is not set'); process.exit(1); }
const client = await connectMongo(URI, { serverSelectionTimeoutMS: 15000 }, { onFallback: (m) => console.error(`(${m})`) });
try {
  const r = await client.db('admin').command({ connectionStatus: 1, showPrivileges: true });
  const info = r.authInfo || {};
  console.log('roles:', JSON.stringify((info.authenticatedUserRoles || []).map((x) => `${x.role}@${x.db}`)));
  const byRes = {};
  for (const p of info.authenticatedUserPrivileges || []) {
    const res = p.resource || {};
    const key = res.cluster ? 'cluster' : res.anyResource ? 'anyResource' : `${res.db === '' ? '*' : res.db}.${res.collection === '' ? '*' : res.collection}`;
    (byRes[key] ||= new Set());
    for (const a of p.actions || []) byRes[key].add(a);
  }
  const risky = ['dropDatabase', 'dropCollection', 'createUser', 'dropUser', 'grantRole', 'shutdown', 'remove', 'delete'];
  for (const [k, set] of Object.entries(byRes).sort()) {
    const acts = [...set].sort();
    console.log(`${k}: ${acts.length} actions${acts.some((a) => risky.includes(a)) ? ' [includes: ' + acts.filter((a) => risky.includes(a)).join(', ') + ']' : ''}`);
  }
} finally { await client.close(); }
