/**
 * EMET - the one way to open a MongoDB connection (2026-09-29).
 *
 * Some local resolvers (home routers, VPN DNS) refuse
 * the SRV queries a mongodb+srv:// URI needs, and the driver fails with
 * "querySrv ECONNREFUSED". Until today the public-DNS fallback lived only in
 * EmetDatabase.ensureClient; nine other connections in src/ and
 * scripts/chain-verify.mjs opened their own client without it, so every tool
 * behind them failed on a machine with such a resolver while the layer tools
 * worked. One helper, used everywhere, so the fallback cannot be forgotten in
 * a tenth place.
 *
 * On a querySrv failure: switch this process to public DNS (8.8.8.8, 1.1.1.1)
 * and retry once. dns.setServers is process-wide, so every later connection
 * in the same process resolves first time. Any other failure is rethrown as
 * it came.
 */

import dns from 'dns';
import { MongoClient } from 'mongodb';

export const PUBLIC_DNS = Object.freeze(['8.8.8.8', '1.1.1.1']);

export function isSrvRefusal(error) {
  return /querySrv/i.test(String(error && error.message));
}

/**
 * Test seam (2026-10-01): the suites install an in-memory client so a tool
 * that connects for itself (emet_transcript_append) can be run end to end
 * with no database. Never set outside tests; null means the real driver.
 */
let testClient = null;
export function useTestClient(Client) { testClient = Client || null; }
export function testClientActive() { return testClient != null; }

/** Connect and return the client. `onFallback(message)` is told when the retry happens. */
export async function connectMongo(uri, options = {}, { onFallback = null, _Client = testClient || MongoClient, _dns = dns } = {}) {
  const attempt = async () => { const c = new _Client(uri, options); await c.connect(); return c; };
  try {
    return await attempt();
  } catch (error) {
    if (!isSrvRefusal(error)) throw error;
    if (onFallback) onFallback(`SRV DNS lookup refused by the local resolver - retrying with public DNS (${PUBLIC_DNS.join(', ')})`);
    _dns.setServers([...PUBLIC_DNS]);
    return await attempt();
  }
}
