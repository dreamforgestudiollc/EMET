/**
 * EMET - the session graph (2026-09-29). The monorail under the
 * guardrails (docs/GUARDRAILS-AND-MONORAILS.md): the next step of a session is decided by its state, read before every
 * governed write. Pure decision tested directly; the store layer tested with
 * a fake dbManager; the door (dispatchTool) tested end to end. Enforce only.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import {
  graphMode, GRAPH_WRITE_TOOLS, baseOf, sessionOf, declaredExchange, nextStep, evaluate, recordStep,
  graphBefore, graphBlock, graphAfter, labRow, labRecord, labSummary
} from '../src/session-graph.js';
import { makeStore } from './memstore.js';

const SID = '2026-09-30_x_verbatim_part2';
// Sets EMET_SESSION_GRAPH for one call, to show the value is no longer read.
async function withMode(mode, fn) {
  const saved = process.env.EMET_SESSION_GRAPH;
  if (mode === undefined) delete process.env.EMET_SESSION_GRAPH; else process.env.EMET_SESSION_GRAPH = mode;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.EMET_SESSION_GRAPH; else process.env.EMET_SESSION_GRAPH = saved; }
}
const open = { opened: true };

testGroup('mode and basics', () => {
  test('enforce only: EMET_SESSION_GRAPH is not read, so report and off are not modes', async () => {
    for (const v of [undefined, 'report', 'off', 'enforce', 'nonsense']) {
      await withMode(v, () => assert.strictEqual(graphMode(), 'enforce', String(v)));
    }
  });
  test('the base id drops the part suffix', () => assert.strictEqual(baseOf(SID), '2026-09-30_x'));
  test('reads are not governed', () => {
    for (const t of ['recall', 'read_doc', 'query_layer', 'emet_initialize', 'emet_status']) {
      assert.strictEqual(GRAPH_WRITE_TOOLS.has(t), false, t);
      assert.strictEqual(evaluate(t, {}, {}, 0), null);
    }
  });
  test('an append declares exchange_index; other writes declare exchange', () => {
    assert.strictEqual(declaredExchange('emet_transcript_append', { exchange_index: 4 }), 4);
    assert.strictEqual(declaredExchange('save_to_layer', { exchange: 4 }), 4);
    assert.strictEqual(declaredExchange('save_to_layer', { exchange: 'x' }), null);
  });
  test('the session is named by session_id, else by derived_from (revise_memory)', () => {
    assert.strictEqual(sessionOf({ session_id: SID }), SID);
    assert.strictEqual(sessionOf({ metadata: { derived_from: { session_id: SID, exchange_start: 1, exchange_end: 2 } } }), SID);
    assert.strictEqual(sessionOf({ metadata: { derived_from: { entries: [3] } } }), null);
    assert.strictEqual(sessionOf({}), null);
  });
  test('a whole number sent as text is the same declaration (live-caught: a host with a stale tool list)', () => {
    assert.strictEqual(declaredExchange('save_to_layer', { exchange: '18' }), 18);
    assert.strictEqual(declaredExchange('emet_transcript_append', { exchange_index: ' 4 ' }), 4);
    assert.strictEqual(declaredExchange('save_to_layer', { exchange: '1.5' }), null);
    assert.strictEqual(declaredExchange('save_to_layer', { exchange: '-3' }), null);
  });
});

testGroup('next step comes from state', () => {
  test('not open', () => assert.ok(/emet_session_open/.test(nextStep({}, 0))));
  test('open: append the exchange after the highest', () => assert.ok(/exchange 8 after this reply/.test(nextStep(open, 7))));
  test('a transcript alone counts as open', () => assert.ok(/exchange 3/.test(nextStep({}, 2))));
  test('handoff written: close', () => assert.ok(/emet_session_close/.test(nextStep({ ...open, handoff: true }, 9))));
  test('closed: the stop condition', () => assert.ok(/closed/.test(nextStep({ ...open, closed: true }, 9))));
  test('an allowed append points past itself (live-caught: it named the exchange just appended)', () => {
    const d = evaluate('emet_transcript_append', { session_id: SID, exchange_index: 8 }, open, 7);
    assert.strictEqual(d.verdict, 'ok');
    assert.ok(/exchange 9/.test(d.next), d.next);
  });
  test('a refused append keeps the step still owed', () => {
    const d = evaluate('emet_transcript_append', { session_id: SID, exchange_index: 10 }, open, 7);
    assert.strictEqual(d.verdict, 'refuse');
    assert.ok(/exchange 8/.test(d.next), d.next);
  });
});

testGroup('the gates', () => {
  test('not_open: a write to a session never opened', () => {
    const d = evaluate('save_to_layer', { session_id: SID, layer: 'semantic' }, {}, 0);
    assert.strictEqual(d.verdict, 'refuse'); assert.strictEqual(d.gate, 'not_open');
  });
  test('the first append of a session opens it (exchange 1 or none)', () => {
    assert.strictEqual(evaluate('emet_transcript_append', { session_id: SID, exchange_index: 1 }, {}, 0).verdict, 'ok');
    assert.strictEqual(evaluate('emet_transcript_append', { session_id: SID }, {}, 0).verdict, 'ok');
  });
  test('turn_skipped: exchange 9 declared while 8 was never appended', () => {
    const d = evaluate('save_to_layer', { session_id: SID, exchange: 9 }, open, 7);
    assert.strictEqual(d.gate, 'turn_skipped'); assert.ok(/exchange 8/.test(d.reason));
  });
  test('turn_skipped catches a skipped append on the append itself', () =>
    assert.strictEqual(evaluate('emet_transcript_append', { session_id: SID, exchange_index: 9 }, open, 7).gate, 'turn_skipped'));
  test('the current exchange and earlier ones pass', () => {
    assert.strictEqual(evaluate('save_to_layer', { session_id: SID, exchange: 8 }, open, 7).verdict, 'ok');
    assert.strictEqual(evaluate('save_to_layer', { session_id: SID, exchange: 3 }, open, 7).verdict, 'ok');
    assert.strictEqual(evaluate('save_to_layer', { session_id: SID }, open, 7).verdict, 'ok');
  });
  test('handoff_early names every missing close step', () => {
    const d = evaluate('write_doc', { session_id: SID, doc_id: 'HANDOFF.md' }, open, 0);
    assert.strictEqual(d.gate, 'handoff_early');
    assert.ok(/STATE\.md/.test(d.reason) && /episodic/.test(d.reason) && /transcript/.test(d.reason));
  });
  test('handoff passes once the board, the episodic record and the transcript exist', () =>
    assert.strictEqual(evaluate('write_doc', { session_id: SID, doc_id: 'HANDOFF.md' }, { ...open, board: true, episodic: true }, 12).verdict, 'ok'));
  test('other documents are not held to the close order', () =>
    assert.strictEqual(evaluate('write_doc', { session_id: SID, doc_id: 'staging/x.md' }, open, 0).verdict, 'ok'));
  test('closed: writes after a complete close are refused, a late append included (2026-10-01)', () => {
    const closed = { ...open, closed: true };
    assert.strictEqual(evaluate('patch_doc', { session_id: SID, doc_id: 'STATE.md' }, closed, 9).gate, 'closed');
    assert.strictEqual(evaluate('emet_transcript_append', { session_id: SID, exchange_index: 10 }, closed, 9).gate, 'closed');
  });
  test('every refusal carries the next step', () =>
    assert.ok(evaluate('save_to_layer', { session_id: SID }, {}, 0).next));
});

testGroup('what a successful call records', () => {
  test('open, episodic, board, handoff, close', () => {
    assert.strictEqual(recordStep('emet_session_open', {}, { base: 'b' }).opened, true);
    assert.strictEqual(recordStep('save_to_layer', { layer: 'episodic' }, { id: 7 }).episodic_id, 7);
    assert.strictEqual(recordStep('save_to_layer', { layer: 'semantic' }, {}), null);
    assert.strictEqual(recordStep('patch_doc', { doc_id: 'STATE.md' }, { version: 3 }).board_version, 3);
    assert.strictEqual(recordStep('restore_doc', { doc_id: 'STATE.md' }, { version: 4 }).board, true);
    assert.strictEqual(recordStep('restore_doc', { doc_id: 'threads/x.md' }, { version: 4 }), null);
    assert.strictEqual(recordStep('write_doc', { doc_id: 'HANDOFF.md' }, { version: 9 }).handoff, true);
    assert.strictEqual(recordStep('emet_session_close', {}, { state: 'blocked' }), null);
    assert.strictEqual(recordStep('emet_session_close', {}, { state: 'complete' }).closed, true);
  });
});

// A fake dbManager: a sessions collection in memory and a fixed transcript position.
function fakeDb({ state = null, highest = 0, failRead = false } = {}) {
  return makeStore({ failRead, highest, state, sessionId: baseOf(SID) });
}
testGroup('the store layer', () => {
  test('a refusal throws, saying nothing was written and what to do; EMET_SESSION_GRAPH=report or off changes nothing', async () => {
    for (const v of [undefined, 'report', 'off']) {
      await withMode(v, () => assert.rejects(() => graphBefore('save_to_layer', { session_id: SID, exchange: 9 }, fakeDb({ state: open, highest: 7 })),
        (e) => /exchange 8/.test(e.message) && /Nothing was written/.test(e.message) && /emet_transcript_append/.test(e.message) && e.graph.decision.gate === 'turn_skipped'));
    }
  });
  test('a write naming no session is refused (no_session) on every governed tool, before any write', async () => {
    for (const tool of GRAPH_WRITE_TOOLS) {
      await assert.rejects(() => graphBefore(tool, { doc_id: 'x.md', source: 'example-host' }, fakeDb()),
        (e) => e.graph.decision.gate === 'no_session' && /Nothing was written/.test(e.message), tool);
    }
  });
  test('no_session words: open a session with load_id or pass session_id, resubmit this same write; nothing was written', async () => {
    await assert.rejects(() => graphBefore('write_doc', { doc_id: 'notes.md', source: 'example-host' }, fakeDb()),
      (e) => /names no session/.test(e.message) && /emet_session_open \(with the load_id from your startup pages\)/.test(e.message) &&
        /resubmit this same write with that session_id/.test(e.message) &&
        /Nothing was written/.test(e.message) && !/WAS saved/.test(e.message) && e.graph.decision.gate === 'no_session');
  });
  test('a session named only through derived_from or close receipts is not a no_session write', async () => {
    const g1 = await graphBefore('revise_memory', { metadata: { derived_from: { session_id: SID, exchange_start: 1, exchange_end: 1 } } }, fakeDb({ state: open, highest: 3 }));
    assert.notStrictEqual(g1.decision.gate, 'no_session');
  });
  test('graphAfter records the step under the base id', async () => {
    const db = fakeDb({ state: open, highest: 3 });
    await graphAfter('patch_doc', { session_id: SID, doc_id: 'STATE.md' }, { version: 5 }, db);
    assert.strictEqual(db.rows.get(baseOf(SID)).board_version, 5);
  });
  test('graphAfter on session_open keys by the returned base id', async () => {
    const db = fakeDb();
    await graphAfter('emet_session_open', { slug: 'x' }, { base: '2026-09-30_new' }, db);
    assert.strictEqual(db.rows.get('2026-09-30_new').opened, true);
  });
  test('graphAfter never throws when the store fails', async () => {
    const db = fakeDb(); db.ensureClient = async () => { throw new Error('down'); };
    await graphAfter('patch_doc', { session_id: SID, doc_id: 'STATE.md' }, {}, db);
  });
});

testGroup('lab results: every check, timestamped', () => {
  const skipped = { mode: 'enforce', base: '2026-09-30_x', highest: 7, decision: { verdict: 'refuse', gate: 'turn_skipped', reason: 'exchange 8 was never appended', next: 'x' } };
  const fine = { mode: 'enforce', base: '2026-09-30_x', highest: 7, decision: { verdict: 'ok', gate: null, reason: null, next: 'x' } };
  test('a row carries time, session, host, tool, the claim, the position and the verdict', () => {
    const t = new Date('2026-09-30T03:00:00Z');
    const r = labRow('save_to_layer', { session_id: SID, exchange: 9, source: 'project-host' }, skipped, t);
    assert.strictEqual(r.ts, t);
    assert.strictEqual(r.session, '2026-09-30_x');
    assert.strictEqual(r.source, 'project-host');
    assert.strictEqual(r.exchange_declared, 9);
    assert.strictEqual(r.highest_appended, 7);
    assert.strictEqual(r.mode, 'enforce');
    assert.strictEqual(r.verdict, 'refuse');
    assert.strictEqual(r.gate, 'turn_skipped');
  });
  test('no graph, no row', () => assert.strictEqual(labRow('recall', {}, null), null));
  test('the row takes the source from metadata.source (save_to_layer, revise_memory) and from the aliases (2026-10-03 lab fix)', () => {
    assert.strictEqual(labRow('save_to_layer', { metadata: { source: 'project-host' } }, skipped).source, 'project-host');
    assert.strictEqual(labRow('revise_memory', { metadata: { source: ' host-a ' } }, skipped).source, 'host-a');
    assert.strictEqual(labRow('patch_doc', { doc_id: 'x.md', updated_by: 'host-b' }, skipped).source, 'host-b');
    assert.strictEqual(labRow('write_doc', { doc_id: 'x.md', source: 'host-c', metadata: { source: 'other' } }, skipped).source, 'host-c');
    assert.strictEqual(labRow('save_to_layer', {}, skipped).source, null);
  });
  test('flagged rows name the document for write_doc and patch_doc (2026-10-03 lab fix)', () => {
    const s = labSummary([
      labRow('write_doc', { session_id: SID, doc_id: 'HANDOFF.md', source: 'b' }, { ...skipped, decision: { ...skipped.decision, gate: 'handoff_early' } }, new Date('2026-09-30T03:02:00Z')),
      labRow('save_to_layer', { session_id: SID, exchange: 9, source: 'a' }, skipped, new Date('2026-09-30T03:00:00Z'))
    ]);
    assert.strictEqual(s.flagged_rows[0].doc_id, 'HANDOFF.md');
    assert.ok(!('doc_id' in s.flagged_rows[1]), 'non-document writes carry no doc_id');
  });
  test('the summary counts everything and lists the flagged rows newest first', () => {
    const rows = [
      labRow('save_to_layer', { session_id: SID, exchange: 9, source: 'a' }, skipped, new Date('2026-09-30T03:00:00Z')),
      labRow('emet_transcript_append', { session_id: SID, exchange_index: 8, source: 'a' }, fine, new Date('2026-09-30T03:01:00Z')),
      labRow('write_doc', { session_id: SID, doc_id: 'HANDOFF.md', source: 'b' }, { ...skipped, decision: { ...skipped.decision, gate: 'handoff_early' } }, new Date('2026-09-30T03:02:00Z'))
    ];
    const s = labSummary(rows);
    assert.strictEqual(s.checks, 3);
    assert.strictEqual(s.flagged, 2);
    assert.strictEqual(s.by_verdict.ok, 1);
    assert.strictEqual(s.by_verdict.refuse, 2);
    assert.strictEqual(s.by_gate.handoff_early, 1);
    assert.strictEqual(s.by_source.b, 1);
    assert.strictEqual(s.flagged_rows[0].gate, 'handoff_early');
    assert.strictEqual(s.first_at, '2026-09-30T03:00:00.000Z');
    assert.strictEqual(s.last_at, '2026-09-30T03:02:00.000Z');
  });
  test('recording never throws when the store fails', async () => {
    const db = fakeDb(); db.ensureClient = async () => { throw new Error('down'); };
    await labRecord('patch_doc', { session_id: SID }, fine, db);
  });
});

testGroup('the door: dispatchTool', () => {
  test('a graph that cannot read its state refuses a governed write that names a session', async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    for (const mode of [undefined, 'off']) {
      const r = await withMode(mode, () => dispatchTool('patch_doc', { session_id: SID, doc_id: 'x.md', source: 'test' }, { dbManager: fakeDb({ failRead: true }), logger: null }));
      const text = JSON.stringify(r);
      assert.ok(r.isError && /session graph unavailable/.test(text) && /Nothing was written/.test(text), `${mode}: ${text.slice(0, 300)}`);
    }
  });
  test('a real refusal comes from the graph, before the tool runs', async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    const r = await dispatchTool('patch_doc', { session_id: SID, doc_id: 'x.md', source: 'test', exchange: 9 }, { dbManager: fakeDb({ state: open, highest: 7 }), logger: null });
    const text = JSON.stringify(r);
    assert.ok(r.isError && /session_graph/.test(text) && /exchange 8/.test(text), text.slice(0, 300));
  });
  test('the governed-tool list is the one the schemas use', async () => {
    const { TOOLS } = await import('../src/tools.js');
    for (const t of TOOLS) {
      if (!GRAPH_WRITE_TOOLS.has(t.name) || t.name === 'emet_transcript_append') continue;
      assert.ok(t.inputSchema.properties.session_id && t.inputSchema.properties.exchange, t.name);
    }
  });
});

summary('Session Graph Test Summary');
