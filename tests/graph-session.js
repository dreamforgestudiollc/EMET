/**
 * Test helpers for the session graph, which runs in enforce only: every
 * governed write needs an open session, and every open needs a load_id whose
 * startup pages were all fetched. Tests of the guards that sit behind the
 * graph (bot tags, record docs, setup) use a seeded session so the graph
 * passes and the guard under test is what answers.
 */
import { GRAPH_WRITE_TOOLS, sessionOf } from '../src/session-graph.js';

export const TEST_SESSION_BASE = '2026-10-03_guard-test';
export const TEST_SESSION_ID = `${TEST_SESSION_BASE}_verbatim_part1`;

/** A startup load with every page served, so emet_session_open passes the startup_pages gate. */
export async function fullStartup(prefix = 'test-load') {
  const pg = await import('../src/startup-pages.js');
  const id = `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
  pg.notePageServed(id, 'all');
  return id;
}

/**
 * Seed an open session whose board, episodic record and first exchange exist,
 * straight into the collections (no recorded write). `col(name)` returns a
 * test collection with a `docs` array. Returns the session id to pass.
 */
export function seedOpenSession(col, base = TEST_SESSION_BASE, { transcript = true } = {}) {
  const sessions = col('emet_sessions').docs;
  if (!sessions.some((d) => d._id === base)) sessions.push({ _id: base, opened: true, board: true, episodic: true, drops_seen: [] });
  const sid = `${base}_verbatim_part1`;
  if (transcript) {
    const t = col('transcripts').docs;
    if (!t.some((d) => d.session_id === sid)) t.push({ _id: `seed-${base}`, session_id: sid, exchanges: [{ exchange_index: 1, user_message: 'u', assistant_message: 'a' }] });
  }
  return sid;
}

/** The args with session_id added when the tool is governed and names no session. */
export function inSession(tool, args = {}, sid = TEST_SESSION_ID) {
  if (!GRAPH_WRITE_TOOLS.has(tool) || sessionOf(args)) return args;
  return { ...args, session_id: sid };
}
