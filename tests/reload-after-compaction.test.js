/**
 * Reload after compaction.
 * The rule is on every initialize. The checks warn when EMET_CONTINUITY_CURRENCY
 * is 1. They do not block, rewrite HANDOFF or STATE, or delete a transcript.
 * The session-graph startup gate, the machine-line gate, and the unregistered
 * source cutoff still refuse before any of that.
 * In-memory store. No database.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';
import { makeStore, withStore, withEnv } from './memstore.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
for (const key of [
  'EMET_CONTINUITY_CURRENCY', 'CASCADE_CONTINUITY_CURRENCY',
  'EMET_CONTINUITY_CURRENCY_BLOCK', 'CASCADE_CONTINUITY_CURRENCY_BLOCK',
  'EMET_RELOAD_GAP_HOURS', 'EMET_RELOAD_FRESH_MINUTES',
  'EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_TIMEZONE'
]) delete process.env[key];

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { initialize, setupComplete } = await import('../src/setup.js');
const { clearPageCache, noteReloadBaseline } = await import('../src/startup-pages.js');
const { dispatchTool } = await import('../src/dispatch.js');
const { guardUnregisteredSourceSave } = await import('../src/source-registration.js');
const {
  RELOAD_RULE, COMPACTION_NOTICE, NO_TRANSCRIPT_NOTICE, RELOADED_NOTICE, OFF_NOTICE, LOADED_NOTICE,
  CURRENT_NOTICE, UNREADABLE_NOTICE,
  gapNotice, staleNotice, assessReload, compactedFlag, priorActivityMs, reloadCheckEnabled,
  loadReloadReport
} = await import('../src/reload-after-compaction.js');
const {
  RELOAD_AFTER_COMPACTION_MERMAID, reloadAfterCompactionStep, reloadAfterCompactionInvariant
} = await import('../src/reload-after-compaction-statechart.js');
const { statechartBody } = await import('../src/access-statechart.js');

const ANSWERS = {
  assistant_name: 'Ada',
  assistant_character: 'Plain and careful.',
  user_name: 'Sam Example',
  user_context: 'Testing reload after compaction.',
  more_than_one_bot: 'no',
  source_tag: 'example-host'
};

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function toolData(result) {
  const text = result && result.content && result.content[0] && result.content[0].text;
  const body = JSON.parse(text);
  return body.data !== undefined ? body.data : body;
}

function docOf(store, id) {
  return store.collection('documents').docs.find((row) => row.doc_id === id);
}

async function readyStore() {
  const store = makeStore();
  await withStore(store, () => setupComplete(ANSWERS));
  const handoff = '# HANDOFF\n\n## §1\nthe owner plays Drosselmeyer.\n';
  const state = '# BOARD\n\n## §3 OPEN BOARD\n| Item | Id |\n|---|---|\n| reload | B-001 |\n';
  const plant = (id, version, content) => {
    const row = store.collection('documents').docs.find((doc) => doc.doc_id === id);
    const next = { doc_id: id, version, sha256: sha(content), updated_at: '2026-11-22T15:00:00.000Z', content };
    if (row) Object.assign(row, next);
    else store.collection('documents').docs.push(next);
  };
  plant('HANDOFF.md', 3, handoff);
  plant('STATE.md', 8, state);
  return store;
}

const on = { EMET_CONTINUITY_CURRENCY: '1', EMET_SOURCE_TAG: 'example-host' };

function blank() {
  return {
    phase: 'CheckOff', flag: 'off', warning: false,
    handoffMutated: false, stateMutated: false, deleted: false, blocked: false
  };
}

console.log('\n=== reload after compaction ===');

testGroup('statechart', () => {
  test('the served diagram matches the document', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'reload-after-compaction-statechart.md'), 'utf8');
    const fenced = /```mermaid\n([\s\S]*?)\n```/.exec(doc);
    assert.ok(fenced);
    assert.strictEqual(fenced[1], RELOAD_AFTER_COMPACTION_MERMAID);
    const html = statechartBody();
    assert.match(html, /Reload after compaction/);
    assert.match(html, /ReloadDue/);
    assert.match(html, /does not block/);
    assert.match(html, /EMET-MEM-035/);
  });

  test('compaction, gap, stale, and an empty close warn and never rewrite or block', () => {
    const path = [
      'flag_off', 'enable', 'append', 'declare_compaction', 'no_fresh', 'continue',
      'declare_compaction', 'fresh_initialize', 'continue',
      'gap', 'fresh_initialize', 'continue',
      'stale', 'continue', 'close_empty', 'continue', 'unreadable', 'continue'
    ];
    let state = blank();
    for (const type of path) {
      const next = reloadAfterCompactionStep(state, { type });
      assert.ok(next, type);
      assert.strictEqual(reloadAfterCompactionInvariant(next), true, type);
      state = next;
    }
    assert.strictEqual(state.phase, 'Working');
    assert.strictEqual(state.handoffMutated, false);
    assert.strictEqual(state.blocked, false);
    assert.strictEqual(reloadAfterCompactionStep(blank(), { type: 'declare_compaction' }), null);
    const warned = reloadAfterCompactionStep(
      reloadAfterCompactionStep({ ...blank(), phase: 'Working', flag: 'warn' }, { type: 'declare_compaction' }),
      { type: 'no_fresh' }
    );
    assert.strictEqual(warned.phase, 'ReloadDue');
    assert.strictEqual(warned.warning, true);
    assert.strictEqual(warned.blocked, false);
  });
});

testGroup('pure check', () => {
  const live = {
    handoff: { doc_id: 'HANDOFF.md', seen_version: 4, seen_sha256: 'abc' },
    state: { doc_id: 'STATE.md', seen_version: 9, seen_sha256: 'def' }
  };
  const seen = {
    handoff: { doc_id: 'HANDOFF.md', seen_version: 4, seen_sha256: 'abc' },
    state: { doc_id: 'STATE.md', seen_version: 9, seen_sha256: 'def' }
  };
  const now = new Date('2026-11-22T16:00:00.000Z');

  test('a compaction with a fresh complete initialize is reloaded', () => {
    const report = assessReload({
      tool: 'emet_session_open',
      compacted: true,
      loadId: 'abc',
      baseline: { at: now.getTime() - 60 * 1000, complete: true, continuity: seen },
      seen,
      live,
      now,
      freshMs: 15 * 60 * 1000,
      gapMs: 6 * 60 * 60 * 1000
    });
    assert.strictEqual(report.status, 'reloaded');
    assert.strictEqual(report.notice, RELOADED_NOTICE);
    assert.strictEqual(report.does_not_block, true);
    assert.strictEqual(report.block_enabled, false);
    assert.deepStrictEqual(report.reasons, []);
  });

  test('a compaction without a fresh initialize warns and names the rule', () => {
    const report = assessReload({
      tool: 'emet_transcript_append',
      compacted: true,
      baseline: { at: now.getTime() - 40 * 60 * 1000, complete: true, continuity: seen },
      seen,
      live,
      now,
      freshMs: 15 * 60 * 1000,
      gapMs: 6 * 60 * 60 * 1000
    });
    assert.strictEqual(report.status, 'warn');
    assert.deepStrictEqual(report.reasons, ['compaction_without_reload']);
    assert.strictEqual(report.notice, COMPACTION_NOTICE);
    assert.strictEqual(report.does_not_block, true);
    assert.strictEqual(report.rule, RELOAD_RULE);
  });

  test('a long gap warns in New York and in UTC, and a fresh load covers it', () => {
    const session = { id: '2026-11-22_gap', exchange_count: 2, last_activity_ms: now.getTime() - 7 * 60 * 60 * 1000 };
    const zones = {};
    for (const zone of ['America/New_York', 'UTC']) {
      zones[zone] = withEnv({ EMET_TIMEZONE: zone }, () => assessReload({
        tool: 'emet_transcript_append',
        session,
        seen,
        live,
        now,
        freshMs: 15 * 60 * 1000,
        gapMs: 6 * 60 * 60 * 1000
      }));
      assert.strictEqual(zones[zone].status, 'warn');
      assert.deepStrictEqual(zones[zone].reasons, ['gap_without_reload']);
      assert.strictEqual(zones[zone].notice, gapNotice(7));
      assert.strictEqual(zones[zone].observed_at.zone, zone);
      assert.strictEqual(zones[zone].does_not_block, true);
    }
    assert.notStrictEqual(zones['America/New_York'].observed_at.local, zones.UTC.observed_at.local);
    assert.match(zones['America/New_York'].observed_at.offset, /^-05:00$/);
    assert.strictEqual(zones.UTC.observed_at.offset, '+00:00');
    const covered = assessReload({
      tool: 'emet_transcript_append',
      session,
      baseline: { at: now.getTime(), complete: true, continuity: seen },
      seen,
      live,
      now,
      freshMs: 15 * 60 * 1000,
      gapMs: 6 * 60 * 60 * 1000
    });
    assert.strictEqual(covered.status, 'reloaded');
    assert.strictEqual(covered.reasons.length, 0);
  });

  test('a stale HANDOFF or STATE version warns and does not describe a rewrite', () => {
    const report = assessReload({
      tool: 'write_doc',
      seen,
      live: {
        handoff: { doc_id: 'HANDOFF.md', seen_version: 5, seen_sha256: 'fff' },
        state: { doc_id: 'STATE.md', seen_version: 9, seen_sha256: 'def' }
      },
      now,
      freshMs: 15 * 60 * 1000,
      gapMs: 6 * 60 * 60 * 1000
    });
    assert.strictEqual(report.status, 'warn');
    assert.deepStrictEqual(report.reasons, ['stale_continuity']);
    assert.strictEqual(report.notice, staleNotice(4, 5, 9, 9));
    assert.match(report.notice, /were not rewritten/);
    assert.strictEqual(report.block_enabled, false);
  });

  test('fresh is true at 15:00 and false at 15:01; a gap starts at 6:00 and not at 5:59', () => {
    const now = new Date('2026-11-22T18:00:00.000Z');
    const freshMs = 15 * 60 * 1000;
    const gapMs = 6 * 60 * 60 * 1000;
    const pins = {
      handoff: { doc_id: 'HANDOFF.md', seen_version: 4, seen_sha256: 'abc' },
      state: { doc_id: 'STATE.md', seen_version: 9, seen_sha256: 'def' }
    };
    const at = (ms) => assessReload({
      tool: 'emet_transcript_append',
      compacted: true,
      baseline: { at: now.getTime() - ms, complete: true, continuity: pins },
      seen: pins,
      live: pins,
      now,
      freshMs,
      gapMs
    });
    assert.strictEqual(at(15 * 60 * 1000).status, 'reloaded');
    assert.strictEqual(at(15 * 60 * 1000).fresh_initialize, true);
    assert.strictEqual(at(15 * 60 * 1000 + 1000).status, 'warn');
    assert.deepStrictEqual(at(15 * 60 * 1000 + 1000).reasons, ['compaction_without_reload']);
    const gapAt = (ms) => assessReload({
      tool: 'emet_transcript_append',
      session: { id: 's', exchange_count: 2, last_activity_ms: now.getTime() - ms },
      seen: pins,
      live: pins,
      now,
      freshMs,
      gapMs
    });
    assert.strictEqual(gapAt(5 * 60 * 60 * 1000 + 59 * 60 * 1000).status, 'current');
    assert.deepStrictEqual(gapAt(5 * 60 * 60 * 1000 + 59 * 60 * 1000).reasons, []);
    assert.strictEqual(gapAt(6 * 60 * 60 * 1000).status, 'warn');
    assert.deepStrictEqual(gapAt(6 * 60 * 60 * 1000).reasons, ['gap_without_reload']);
    assert.strictEqual(gapAt(6 * 60 * 60 * 1000).notice, gapNotice(6));
  });

  test('a close with no transcript warns, and the exchange just written is not a gap', () => {
    const empty = assessReload({
      tool: 'emet_session_close',
      session: { id: 's', exchange_count: 0, last_activity_ms: null },
      seen,
      live,
      now,
      freshMs: 15 * 60 * 1000,
      gapMs: 6 * 60 * 60 * 1000
    });
    assert.deepStrictEqual(empty.reasons, ['no_transcript']);
    assert.strictEqual(empty.notice, NO_TRANSCRIPT_NOTICE);
    const just = priorActivityMs([
      { timestamp: (now.getTime() - 8 * 60 * 60 * 1000) / 1000 },
      { timestamp: now.getTime() / 1000 }
    ], now.getTime());
    assert.strictEqual(just, now.getTime() - 8 * 60 * 60 * 1000);
    assert.strictEqual(priorActivityMs([{ timestamp: now.getTime() / 1000 }], now.getTime()), null);
    assert.strictEqual(compactedFlag({ after_compaction: 'true' }), true);
    assert.strictEqual(compactedFlag({ compacted: 'false' }), false);
    assert.strictEqual(reloadCheckEnabled(), false);
  });
});

testGroup('initialize carries the rule', () => {
  test('the flag off still states the rule and writes neither HANDOFF nor STATE', async () => {
    clearPageCache();
    const store = await readyStore();
    const handoff = docOf(store, 'HANDOFF.md').content;
    const state = docOf(store, 'STATE.md').content;
    const before = store.writes.length;
    const whole = await withEnv({ EMET_SOURCE_TAG: 'example-host' }, () => withStore(store, () => initialize({ page: 'all' })));
    assert.strictEqual(whole.reload_after_compaction.status, 'off');
    assert.strictEqual(whole.reload_after_compaction.rule, RELOAD_RULE);
    assert.strictEqual(whole.reload_after_compaction.notice, OFF_NOTICE);
    assert.strictEqual(whole.reload_after_compaction.does_not_block, true);
    assert.ok(!whole.reload_after_compaction.continuity);
    assert.match(whole.page_notice, /work from HANDOFF and STATE, not from that summary/);
    assert.match(whole.instructions, /Do not continue from the chat summary/);
    assert.strictEqual(docOf(store, 'HANDOFF.md').content, handoff);
    assert.strictEqual(docOf(store, 'STATE.md').content, state);
    assert.deepStrictEqual(store.writes.slice(before), []);
  });

  test('the flag on records the served versions and writes nothing', async () => {
    clearPageCache();
    const store = await readyStore();
    const before = store.writes.length;
    const whole = await withEnv(on, () => withStore(store, () => initialize({ page: 'all' })));
    const report = whole.reload_after_compaction;
    assert.strictEqual(report.status, 'loaded');
    assert.strictEqual(report.notice, LOADED_NOTICE);
    assert.strictEqual(report.continuity.handoff.seen_version, 3);
    assert.strictEqual(report.continuity.state.seen_version, 8);
    assert.strictEqual(report.continuity.handoff.seen_sha256, docOf(store, 'HANDOFF.md').sha256);
    assert.strictEqual(report.does_not_block, true);
    assert.strictEqual(report.block_enabled, false);
    assert.deepStrictEqual(store.writes.slice(before), []);
  });
});

testGroup('warnings on the session, without blocking', () => {
  test('a declared compaction without a fresh initialize warns and the session still opens', async () => {
    clearPageCache();
    const store = await readyStore();
    const handoff = docOf(store, 'HANDOFF.md').content;
    const whole = await withEnv(on, () => withStore(store, () => initialize({ page: 'all' })));
    const loadId = whole.startup_page.load_id;
    noteReloadBaseline(loadId, whole.reload_after_compaction.continuity, {
      complete: true,
      fresh: true,
      now: Date.now() - 40 * 60 * 1000
    });
    const opened = await withEnv({ ...on, EMET_CONTINUITY_CURRENCY_BLOCK: '1' }, () => withStore(store, () => dispatchTool(
      'emet_session_open',
      { slug: 'compacted', load_id: loadId, compacted: true },
      { dbManager: store, logger: null }
    )));
    const data = toolData(opened);
    assert.ok(data.session_id, JSON.stringify(opened).slice(0, 400));
    assert.strictEqual(data.reload_after_compaction.status, 'warn');
    assert.deepStrictEqual(data.reload_after_compaction.reasons, ['compaction_without_reload']);
    assert.strictEqual(data.reload_after_compaction.notice, COMPACTION_NOTICE);
    assert.strictEqual(data.reload_after_compaction.does_not_block, true);
    assert.strictEqual(data.reload_after_compaction.block_enabled, false);
    assert.strictEqual(data.reload_after_compaction.block_requested, true);
    assert.strictEqual(docOf(store, 'HANDOFF.md').content, handoff);
  });

  test('a fresh initialize after compaction is reloaded', async () => {
    clearPageCache();
    const store = await readyStore();
    const whole = await withEnv(on, () => withStore(store, () => initialize({ page: 'all' })));
    const opened = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_session_open',
      { slug: 'reloaded', load_id: whole.startup_page.load_id, after_compaction: true },
      { dbManager: store, logger: null }
    )));
    const data = toolData(opened);
    assert.strictEqual(data.reload_after_compaction.status, 'reloaded');
    assert.strictEqual(data.reload_after_compaction.notice, RELOADED_NOTICE);
    assert.ok(data.session_id);
  });

  test('a long gap warns, a fresh load_id covers it, and the append is kept', async () => {
    clearPageCache();
    const store = await readyStore();
    const gapEnv = { ...on, EMET_RELOAD_GAP_HOURS: '0.05' };
    const whole = await withEnv(gapEnv, () => withStore(store, () => initialize({ page: 'all' })));
    const loadId = whole.startup_page.load_id;
    const opened = await withEnv(gapEnv, () => withStore(store, () => dispatchTool(
      'emet_session_open',
      { slug: 'gap', load_id: loadId },
      { dbManager: store, logger: null }
    )));
    const sessionId = toolData(opened).session_id;
    const first = await withEnv(gapEnv, () => withStore(store, () => dispatchTool(
      'emet_transcript_append',
      {
        session_id: sessionId,
        user_message: 'Who plays Drosselmeyer?',
        assistant_message: 'no local shell MCP. Checking EMET.',
        exchange_index: 1,
        source: 'example-host'
      },
      { dbManager: store, logger: null }
    )));
    assert.strictEqual(toolData(first).exchange_index, 1, JSON.stringify(first).slice(0, 500));
    const row = store.collection('transcripts').docs.find((doc) => doc.session_id === sessionId);
    row.exchanges[0].timestamp = (Date.now() / 1000) - 30 * 60;
    noteReloadBaseline(loadId, whole.reload_after_compaction.continuity, {
      complete: true,
      fresh: true,
      now: Date.now() - 30 * 60 * 1000
    });
    const second = await withEnv(gapEnv, () => withStore(store, () => dispatchTool(
      'emet_transcript_append',
      {
        session_id: sessionId,
        user_message: 'Still there?',
        assistant_message: 'Continuing.',
        exchange_index: 2,
        source: 'example-host'
      },
      { dbManager: store, logger: null }
    )));
    const warned = toolData(second);
    assert.strictEqual(warned.exchange_count, 2);
    assert.strictEqual(warned.reload_after_compaction.status, 'warn');
    assert.deepStrictEqual(warned.reload_after_compaction.reasons, ['gap_without_reload']);
    assert.strictEqual(warned.reload_after_compaction.notice, gapNotice(1));
    const secondRow = store.collection('transcripts').docs.find((doc) => doc.session_id === sessionId);
    const latest = secondRow.exchanges[secondRow.exchanges.length - 1];
    latest.timestamp = (Date.now() / 1000) - 30 * 60;
    noteReloadBaseline(loadId, whole.reload_after_compaction.continuity, {
      complete: true,
      fresh: true,
      now: Date.now()
    });
    const covered = await withEnv(gapEnv, () => withStore(store, () => dispatchTool(
      'emet_transcript_append',
      {
        session_id: sessionId,
        user_message: 'Reloaded.',
        assistant_message: 'Working from HANDOFF and STATE.',
        exchange_index: 3,
        load_id: loadId,
        source: 'example-host'
      },
      { dbManager: store, logger: null }
    )));
    assert.strictEqual(toolData(covered).exchange_count, 3);
    assert.strictEqual(toolData(covered).reload_after_compaction.status, 'reloaded');
    assert.strictEqual(store.collection('transcripts').docs.filter((doc) => doc.session_id === sessionId).length, 1);
  });

  test('a write against a newer HANDOFF warns and leaves the document as it was', async () => {
    clearPageCache();
    const store = await readyStore();
    const whole = await withEnv(on, () => withStore(store, () => initialize({ page: 'all' })));
    const handoff = docOf(store, 'HANDOFF.md');
    const before = handoff.content;
    handoff.version = 4;
    handoff.sha256 = sha(before + 'v4');
    const opened = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_session_open',
      { slug: 'stale', load_id: whole.startup_page.load_id },
      { dbManager: store, logger: null }
    )));
    const data = toolData(opened);
    assert.strictEqual(data.reload_after_compaction.status, 'warn');
    assert.ok(data.reload_after_compaction.reasons.includes('stale_continuity'));
    assert.strictEqual(data.reload_after_compaction.notice, staleNotice(3, 4, 8, 8));
    assert.strictEqual(docOf(store, 'HANDOFF.md').content, before);
    assert.strictEqual(docOf(store, 'HANDOFF.md').version, 4);
    assert.strictEqual(docOf(store, 'STATE.md').version, 8);
  });

  test('a close with no transcript append warns and does not change the close state or delete', async () => {
    clearPageCache();
    const store = await readyStore();
    const whole = await withEnv(on, () => withStore(store, () => initialize({ page: 'all' })));
    const opened = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_session_open',
      { slug: 'silent', load_id: whole.startup_page.load_id },
      { dbManager: store, logger: null }
    )));
    const sessionId = toolData(opened).session_id;
    const docsBefore = store.collection('documents').docs.length;
    const closed = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_session_close',
      { session_id: sessionId },
      { dbManager: store, logger: null }
    )));
    const data = toolData(closed);
    assert.notStrictEqual(data.state, 'complete');
    assert.strictEqual(data.reload_after_compaction.status, 'warn');
    assert.deepStrictEqual(data.reload_after_compaction.reasons, ['no_transcript']);
    assert.ok(data.warnings.includes(NO_TRANSCRIPT_NOTICE));
    assert.strictEqual(store.collection('documents').docs.length, docsBefore);
    assert.strictEqual(store.collection('transcripts').docs.length, 0);
  });

  test('an append inside the gap window with matching pins is current and is kept', async () => {
    clearPageCache();
    const store = await readyStore();
    const whole = await withEnv(on, () => withStore(store, () => initialize({ page: 'all' })));
    const opened = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_session_open',
      { slug: 'current', load_id: whole.startup_page.load_id },
      { dbManager: store, logger: null }
    )));
    const sessionId = toolData(opened).session_id;
    const appended = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_transcript_append',
      {
        session_id: sessionId,
        user_message: 'Who plays Drosselmeyer?',
        assistant_message: 'no local shell MCP. the owner does.',
        exchange_index: 1,
        source: 'example-host'
      },
      { dbManager: store, logger: null }
    )));
    const first = toolData(appended);
    assert.strictEqual(first.exchange_index, 1, JSON.stringify(appended).slice(0, 400));
    const again = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_transcript_append',
      {
        session_id: sessionId,
        user_message: 'And the next line?',
        assistant_message: 'Still inside the window.',
        exchange_index: 2,
        source: 'example-host'
      },
      { dbManager: store, logger: null }
    )));
    const data = toolData(again);
    assert.strictEqual(data.exchange_count, 2);
    assert.strictEqual(data.reload_after_compaction.status, 'current');
    assert.strictEqual(data.reload_after_compaction.notice, CURRENT_NOTICE);
    assert.strictEqual(data.reload_after_compaction.does_not_block, true);
    assert.deepStrictEqual(data.reload_after_compaction.reasons, []);
    assert.strictEqual(store.collection('transcripts').docs.filter((doc) => doc.session_id === sessionId).length, 1);
    assert.strictEqual(docOf(store, 'HANDOFF.md').version, 3);
    assert.strictEqual(docOf(store, 'STATE.md').version, 8);
  });

  test('a continuity read that throws leaves the call successful, unreadable, and writes nothing more', async () => {
    clearPageCache();
    const store = await readyStore();
    const whole = await withEnv(on, () => withStore(store, () => initialize({ page: 'all' })));
    const opened = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_session_open',
      { slug: 'unread', load_id: whole.startup_page.load_id },
      { dbManager: store, logger: null }
    )));
    const sessionId = toolData(opened).session_id;
    const saved = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_transcript_append',
      {
        session_id: sessionId,
        user_message: 'First line.',
        assistant_message: 'no local shell MCP.',
        exchange_index: 1,
        source: 'example-host'
      },
      { dbManager: store, logger: null }
    )));
    assert.strictEqual(toolData(saved).exchange_index, 1, JSON.stringify(saved).slice(0, 400));
    const docsCol = store.collection('documents');
    const originalFind = docsCol.findOne.bind(docsCol);
    docsCol.findOne = async (query) => {
      if (query && (query.doc_id === 'HANDOFF.md' || query.doc_id === 'STATE.md')) throw new Error('continuity read down');
      return originalFind(query);
    };
    const handoff = docOf(store, 'HANDOFF.md').content;
    const state = docOf(store, 'STATE.md').content;
    const readWrites = store.writes.length;
    const db = await store.ensureClient();
    const direct = await withEnv(on, () => loadReloadReport(db, {
      tool: 'emet_transcript_append',
      args: { session_id: sessionId },
      data: {},
      now: new Date()
    }));
    assert.strictEqual(direct.status, 'unreadable');
    assert.strictEqual(direct.does_not_block, true);
    assert.strictEqual(store.writes.length, readWrites);
    const before = store.writes.length;
    let replay;
    try {
      replay = await withEnv(on, () => withStore(store, () => dispatchTool(
        'emet_transcript_append',
        {
          session_id: sessionId,
          user_message: 'First line.',
          assistant_message: 'no local shell MCP.',
          exchange_index: 1,
          source: 'example-host'
        },
        { dbManager: store, logger: null }
      )));
    } finally {
      docsCol.findOne = originalFind;
    }
    const data = toolData(replay);
    assert.strictEqual(data.already_present, true);
    assert.strictEqual(data.reload_after_compaction.status, 'unreadable');
    assert.strictEqual(data.reload_after_compaction.notice, UNREADABLE_NOTICE);
    assert.strictEqual(data.reload_after_compaction.does_not_block, true);
    const deadline = Date.now() + 1000;
    while (store.writes.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepStrictEqual(store.writes.slice(before), ['insert emet_graph_lab']);
    assert.strictEqual(docOf(store, 'HANDOFF.md').content, handoff);
    assert.strictEqual(docOf(store, 'STATE.md').content, state);
    assert.strictEqual(store.collection('transcripts').docs.filter((doc) => doc.session_id === sessionId)[0].exchange_count, 1);
  });

  test('the flag off adds no report on open', async () => {
    clearPageCache();
    const store = await readyStore();
    const whole = await withEnv({ EMET_SOURCE_TAG: 'example-host' }, () => withStore(store, () => initialize({ page: 'all' })));
    const opened = await withEnv({ EMET_SOURCE_TAG: 'example-host' }, () => withStore(store, () => dispatchTool(
      'emet_session_open',
      { slug: 'quiet', load_id: whole.startup_page.load_id, compacted: true },
      { dbManager: store, logger: null }
    )));
    const data = toolData(opened);
    assert.ok(data.session_id);
    assert.ok(!('reload_after_compaction' in data));
    assert.match(data.instructions, /work from HANDOFF and STATE, not from the summary/);
  });
});

testGroup('existing gates still refuse', () => {
  test('an open with no load_id is refused before a session exists', async () => {
    clearPageCache();
    const store = await readyStore();
    const before = store.writes.length;
    const refused = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_session_open',
      { slug: 'no-load', compacted: true },
      { dbManager: store, logger: null }
    )));
    const body = JSON.parse(refused.content[0].text);
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.emet_code, 'EMET-INT-001');
    assert.match(body.error.message, /emet_session_open needs load_id/);
    assert.match(body.error.message, /no session was opened and nothing was written/);
    assert.ok(!store.collection('emet_sessions').docs.some((row) => String(row._id || '').includes('no-load')));
    assert.ok(!store.writes.slice(before).includes('insert transcripts'));
  });

  test('the machine line still refuses the append that opens a transcript', async () => {
    clearPageCache();
    const store = await readyStore();
    store.collection('documents').docs.push({
      doc_id: 'bootstrap/INSTALL.md',
      version: 1,
      sha256: 'install',
      content: '# Install\n\n| Name |\n| --- |\n| Example Host |\n'
    });
    const whole = await withEnv(on, () => withStore(store, () => initialize({ page: 'all' })));
    const opened = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_session_open',
      { slug: 'machine', load_id: whole.startup_page.load_id },
      { dbManager: store, logger: null }
    )));
    const sessionId = toolData(opened).session_id;
    const before = store.collection('transcripts').docs.length;
    const refused = await withEnv(on, () => withStore(store, () => dispatchTool(
      'emet_transcript_append',
      {
        session_id: sessionId,
        user_message: 'hi',
        assistant_message: 'hello from memory',
        exchange_index: 1,
        source: 'example-host'
      },
      { dbManager: store, logger: null }
    )));
    assert.match(JSON.stringify(refused), /EMET-MEM-018/);
    assert.strictEqual(store.collection('transcripts').docs.length, before);
  });

  test('an unregistered source is still refused on the cutoff date', () => {
    const now = new Date('2026-12-16T15:00:00.000Z');
    withEnv({ EMET_CONTINUITY_CURRENCY: '1', EMET_SOURCE_TAGS: 'example-host' }, () => {
      assert.throws(
        () => guardUnregisteredSourceSave({ tag: 'stranger', tool: 'save_to_layer', now }),
        (error) => error && error.emetCode === 'EMET-MEM-035'
      );
      const kept = guardUnregisteredSourceSave({ tag: 'example-host', tool: 'save_to_layer', now });
      assert.strictEqual(kept.membership, 'registered');
    });
  });
});

summary();
