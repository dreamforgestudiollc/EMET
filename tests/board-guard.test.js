process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://test';
/**
 * Board-guard checks. Sixteen cases, table and direct.
 */
import assert from 'node:assert/strict';
import { test, testGroup, summary } from './harness.js';
import { makeStore, withStore } from './memstore.js';

console.log('\n=== board guard ===');

process.env.EMET_DROP_LIST_TIMEOUT_MS = process.env.EMET_DROP_LIST_TIMEOUT_MS || '50';
const REASON = 'fixture reason for the edit';
function toolData(res) {
  if (res && res.data && typeof res.data === 'object') return res.data;
  const text = res && res.content && res.content[0] && res.content[0].text;
  if (typeof text === 'string') {
    try { const parsed = JSON.parse(text); return parsed.data || parsed; } catch { return {}; }
  }
  return res || {};
}

function allowBoard(db, id = 'board-ok') {
  const base = String(id).replace(/_verbatim_part\d+$/, '');
  const docs = db.col('emet_sessions').docs;
  if (!docs.some((d) => d._id === base)) docs.push({ _id: base, opened: true, drops_seen: [] });
  return id;
}
async function write(id, content, options = {}) {
  const { writeDoc } = await import('../src/tools.js');
  return writeDoc(id, content, 'project-host', null, null, options);
}

testGroup('sixteen board-guard checks', () => {
  const cases = [
    ['the board is never written', () => write('STATE.md', '# Board\n'), /never written|provisioned/],
    ['a working document is edited, not rewritten', async () => { await write('threads/x.md', '# X\nx\n'); return write('threads/x.md', '# X\ny\n'); }, /edited, not rewritten/],
    ['a record revision needs a reason', async () => { await write('HANDOFF.md', '# Handoff\nfirst\n', { reason: REASON }); return write('HANDOFF.md', '# Handoff\nnext\n', { supersedes: 1 }); }, /needs reason/],
    ['retire of a working document is refused', async () => { const { retireDoc } = await import('../src/tools.js'); await write('threads/x.md', '# X\nx\n'); return retireDoc('threads/x.md', REASON, 'project-host'); }, /not a drop/],
    ['the board is never renamed', async () => { const { renameDoc } = await import('../src/tools.js'); await write('STATE.md', '# Board\n', { provision: true }); return renameDoc('STATE.md', 'archive/STATE.md', 'project-host', null, REASON); }, /never renamed/],
    ['a drop is never renamed', async () => { const { renameDoc } = await import('../src/tools.js'); await write('drops/a.md', 'note\n'); return renameDoc('drops/a.md', 'drops/b.md', 'project-host', null, REASON); }, /write-once/],
    ['restore needs a reason', async () => { const { restoreDoc } = await import('../src/tools.js'); return restoreDoc('threads/x.md', 1, 'project-host', null, 'short'); }, /needs reason/]
  ];
  for (const [name, fn, pattern] of cases) {
    test(name, async () => {
      const db = makeStore();
      await withStore(db, async () => {
        await assert.rejects(fn, pattern);
      });
    });
  }
  test('a later edit is measured from the size at session start', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      await write('HANDOFF.md', 'x'.repeat(100), { reason: REASON, session_id: 's1' });
      await write('HANDOFF.md', 'x'.repeat(80), { reason: REASON, supersedes: 1, session_id: 's1' });
      await assert.rejects(() => write('HANDOFF.md', 'x'.repeat(40), { reason: REASON, supersedes: 2, session_id: 's1' }), /first touched/);
    });
  });
  test('a change that stays over half of the session-start size is kept', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      await write('HANDOFF.md', 'x'.repeat(100), { reason: REASON });
      const mid = await write('HANDOFF.md', 'x'.repeat(60), { reason: REASON, supersedes: 1 });
      assert.strictEqual(mid.version, 2);
    });
  });
  test('a second write of a drop is refused', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      await write('drops/e.md', 'a note for later\n');
      await assert.rejects(() => write('drops/e.md', 'again\n'), /already exists/);
    });
  });
  test('a drop may name a tool in its text', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      const r = await write('drops/c.md', 'tool: write_doc\n');
      assert.strictEqual(r.version, 1);
    });
  });
  test('a new drop with no tool call is kept', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      const r = await write('drops/f.md', 'a note for later\n');
      assert.strictEqual(r.version, 1);
    });
  });
  test('setup provisions a missing board', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      const r = await write('STATE.md', '# Board\n\n', { provision: true });
      assert.strictEqual(r.doc_id, 'STATE.md');
    });
  });
  test('client_id is stored next to the write', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      await write('threads/y.md', '# Y\ny\n', { client_id: 'client-1' });
      assert.strictEqual(db.doc('threads/y.md').client_id, 'stdio');
    });
  });
  test('an open drop blocks a board edit', async () => {
    const { patchDoc } = await import('../src/tools.js');
    const db = makeStore();
    await withStore(db, async () => {
      await write('STATE.md', '# Board\n- open\n', { provision: true });
      await write('drops/open.md', 'still open\n');
      db.col('emet_sessions').docs.push({ _id: 's-boot', drops_seen: ['drops/open.md'] });
      await assert.rejects(() => patchDoc('STATE.md', '- open', '- handled', 'project-host', null, null, { reason: REASON, session_id: 's-boot', drops_seen: [] }), /listed at this session boot/);
    });
  });
  test('patch of the board needs a reason', async () => {
    const { patchDoc } = await import('../src/tools.js');
    const db = makeStore();
    await withStore(db, async () => {
      await write('STATE.md', '# Board\nactive\n', { provision: true });
      await assert.rejects(() => patchDoc('STATE.md', 'active', 'idle', 'project-host'), /needs reason/);
    });
  });
});

test('floor applies to a patch', async () => {
  const { patchDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await write('threads/floor.md', 'x'.repeat(100));
    await assert.rejects(() => patchDoc('threads/floor.md', 'x'.repeat(100), 'x'.repeat(40), 'project-host', null, null, { reason: REASON, session_id: 's1' }), /first touched/);
  });
});
test('a board wipe via patch is refused', async () => {
  const { patchDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await write('STATE.md', '# Board\n\n## \u00a71 HALF-STATE\n| Id | What |\n|---|---|\n| B-001 | keep |\n', { provision: true });
    const sid = allowBoard(db);
    await assert.rejects(() => patchDoc('STATE.md', 'B-001', 'gone', 'project-host', null, null, { reason: REASON, session_id: sid }), /nonconforming|no disposition/);
  });
});
test('a drop cannot be patched or restored', async () => {
  const { patchDoc, restoreDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await write('drops/once.md', 'original note\n');
    await assert.rejects(() => patchDoc('drops/once.md', 'original', 'rewritten', 'project-host', null, null, { reason: REASON }), /write-once/);
    await assert.rejects(() => restoreDoc('drops/once.md', 1, 'project-host', null, REASON), /never restored/);
  });
});
test('restore with no source is refused', async () => {
  const { restoreDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await assert.rejects(() => restoreDoc('threads/x.md', 1, null, null, REASON), /needs a source/);
  });
});
test('a tampered hash is not restored', async () => {
  const { restoreDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await write('threads/tamper.md', '# Tamper\n');
    const row = db.doc('threads/tamper.md');
    db.collection('documents_history').docs.push({ ...row, version: 1, content: 'tampered\n', sha256: 'deadbeef', conformance: { verdict: 'conforms' } });
    process.env.EMET_SOURCE_TAG = 'project-host';
    await assert.rejects(() => restoreDoc('threads/tamper.md', 1, 'project-host', null, REASON), /digest/);
  });
});
test('the 21st drop from one source in a day is refused', async () => {
  const db = makeStore();
  await withStore(db, async () => {
    for (let i = 0; i < 20; i++) await write(`drops/cap-${i}.md`, `note ${i}\n`);
    await assert.rejects(() => write('drops/cap-20.md', 'over\n'), /20 drops/);
  });
});
test('edits are atomic against the current text', async () => {
  const { patchDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await write('threads/edits.md', 'alpha beta\n');
    await assert.rejects(() => patchDoc('threads/edits.md', null, null, 'project-host', null, null, { reason: REASON, edits: [{ old_str: 'alpha', new_str: 'ALPHA' }, { old_str: 'ALPHA', new_str: 'nope' }] }), /not found|exactly once/);
    assert.strictEqual(db.doc('threads/edits.md').content, 'alpha beta\n');
  });
});
test('a drop listed at boot blocks a board patch; a later drop does not', async () => {
  const { patchDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await write('STATE.md', '# Board\nactive\n', { provision: true });
    db.col('emet_sessions').docs.push({ _id: 's-boot', drops_seen: ['drops/boot.md'] });
    db.col('documents').docs.push({ doc_id: 'drops/boot.md', content: 'boot\n', retired: false, version: 1 });
    await assert.rejects(() => patchDoc('STATE.md', 'active', 'idle', 'project-host', null, null, { reason: REASON, session_id: 's-boot', drops_seen: [] }), /listed at this session boot/);
    await assert.rejects(() => patchDoc('STATE.md', 'active', 'idle', 'project-host', null, null, { reason: REASON, drops_seen: ['drops/boot.md'] }), (e) => !/listed at this session boot/.test(e.message));
  });
});

test('a session baseline is not reset by another session in between', async () => {
  const { patchDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await write('threads/aba.md', 'x'.repeat(100), { session_id: 'A' });
    await patchDoc('threads/aba.md', 'x'.repeat(100), 'x'.repeat(80), 'project-host', null, null, { reason: REASON, session_id: 'B' });
    await assert.rejects(() => patchDoc('threads/aba.md', 'x'.repeat(80), 'x'.repeat(45), 'project-host', null, null, { reason: REASON, session_id: 'A_verbatim_part1' }), /first touched/);
  });
});
test('restore succeeds for a board and a working doc, and a record is refused', async () => {
  const { restoreDoc, patchDoc } = await import('../src/tools.js');
  const { provisionBoardText } = await import('../src/setup.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.EMET_SOURCE_TAG = 'project-host';
    const board = provisionBoardText();
    await write('STATE.md', board, { provision: true });
    const sid = allowBoard(db);
    await patchDoc('STATE.md', 'Provisioned by the server. Verified at setup.', 'Provisioned by the server. Verified at setup. touched', 'project-host', null, null, { reason: REASON, session_id: sid });
    const restoredBoard = await restoreDoc('STATE.md', 1, 'project-host', null, REASON, { session_id: sid });
    assert.strictEqual(restoredBoard.restored_from_version, 1);
    await write('notes/plain.md', 'alpha note\n');
    await patchDoc('notes/plain.md', 'alpha', 'beta', 'project-host', null, null, { reason: REASON });
    const restoredThread = await restoreDoc('notes/plain.md', 1, 'project-host', null, REASON);
    assert.strictEqual(restoredThread.restored_from_version, 1);
    await write('HANDOFF.md', 'x'.repeat(40), { reason: REASON });
    await assert.rejects(() => restoreDoc('HANDOFF.md', 1, 'project-host', null, REASON), /revise_memory/);
  });
});
test('a nonconforming retained revision is not restored', async () => {
  const { restoreDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.EMET_SOURCE_TAG = 'project-host';
    const { patchDoc } = await import('../src/tools.js');
    await write('threads/bad.md', 'keep\n');
    await patchDoc('threads/bad.md', 'keep', 'changed', 'project-host', null, null, { reason: REASON });
    const row = db.col('documents_history').docs.find((d) => d.doc_id === 'threads/bad.md');
    row.conformance = { verdict: 'nonconforming' };
    await assert.rejects(() => restoreDoc('threads/bad.md', 1, 'project-host', null, REASON), /not conforming/);
  });
});
test('restore with no open session is refused by the session graph', async () => {
  const { graphBefore, GRAPH_WRITE_TOOLS } = await import('../src/session-graph.js');
  assert.strictEqual(GRAPH_WRITE_TOOLS.has('restore_doc'), true);
  await assert.rejects(() => graphBefore('restore_doc', { doc_id: 'notes/plain.md', version: 1, reason: REASON, source: 'project-host' }, null), /no session/);
});
test('a shipped copy is not restored', async () => {
  const { restoreDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await assert.rejects(() => restoreDoc('CHARTER.md', 1, 'project-host', null, REASON), /shipped copy/);
  });
});
test('overlapping edits are refused', async () => {
  const { patchDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    const body = 'LEFTMIDRIGHT' + 'z'.repeat(400);
    await write('threads/span.md', body);
    await assert.rejects(() => patchDoc('threads/span.md', null, null, 'project-host', null, null, { reason: REASON, edits: [{ old_str: 'LEFTMID', new_str: 'A' }, { old_str: 'MIDRIGHT', new_str: 'B' }] }), /overlap/);
    assert.strictEqual(db.doc('threads/span.md').content, body);
  });
});
test('an added board row needs an origin', async () => {
  const { patchDoc } = await import('../src/tools.js');
  const { provisionBoardText } = await import('../src/setup.js');
  const db = makeStore();
  await withStore(db, async () => {
    await write('STATE.md', provisionBoardText(), { provision: true });
    const sid = allowBoard(db);
    await assert.rejects(() => patchDoc('STATE.md', 'Provisioned by the server. Verified at setup.', 'Provisioned by the server. Verified at setup. B-010', 'project-host', null, null, { reason: REASON, session_id: sid }), /origin/);
  });
});
test('a provisioned board conforms, and initialize provisions only a missing board', async () => {
  const { validateDocument } = await import('../src/conformance.js');
  const { provisionBoardIfMissing, provisionBoardText } = await import('../src/setup.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.EMET_SOURCE_TAG = 'project-host';
    const made = await provisionBoardIfMissing();
    assert.strictEqual(made.version, 1);
    assert.strictEqual(validateDocument('STATE.md', provisionBoardText(), null).verdict, 'conforms');
    assert.strictEqual(await provisionBoardIfMissing(), null);
    await assert.rejects(() => write('STATE.md', provisionBoardText(), { provision: true }), /already exists/);
  });
});
test('a drop with no source is stored as visitor', async () => {
  const { writeDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await writeDoc('drops/anon.md', 'a note for later\n', null);
    assert.strictEqual(db.doc('drops/anon.md').updated_by, 'visitor');
  });
});
test('a rotated source tag does not reset the drop cap', async () => {
  const { writeDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    for (let i = 0; i < 20; i++) await writeDoc(`drops/flood-${i}.md`, `note ${i}\n`, null);
    await assert.rejects(() => writeDoc('drops/tagged.md', 'still allowed\n', 'project-host'), /20 drops/);
    assert.strictEqual(db.doc('drops/flood-0.md').drop_bucket, 'stdio');
  });
});
test('a template is not restored', async () => {
  const { restoreDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await assert.rejects(() => restoreDoc('templates/BOARD.md', 1, 'project-host', null, REASON), /shipped copy/);
  });
});
test('initialize on an existing store does not replace the board', async () => {
  const { initialize, setStartupBuildForTests } = await import('../src/setup.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.EMET_SOURCE_TAG = 'project-host';
    await write('STATE.md', 'KEEP THIS BOARD\n', { provision: true });
    setStartupBuildForTests(async () => ({ state: 'ready' }));
    try { await initialize({ page: 'all' }); } catch { /* paging may refuse a stub payload; the board must still stand */ }
    finally { setStartupBuildForTests(null); }
    assert.strictEqual(db.doc('STATE.md').content, 'KEEP THIS BOARD\n');
    assert.strictEqual(db.doc('STATE.md').version, 1);
  });
});

test('a read-scoped initialize writes nothing', async () => {
  const { initialize, setStartupBuildForTests } = await import('../src/setup.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    setStartupBuildForTests(async () => ({ state: 'ready' }));
    try { await actorStore.run({ scopes: ['emet.read'] }, () => initialize({ page: 'all' })); }
    catch { /* a stub payload may not page; the write is the check */ }
    finally { setStartupBuildForTests(null); }
    assert.strictEqual(db.doc('STATE.md'), undefined);
    assert.strictEqual(db.writes.some((w) => w.includes('documents')), false);
  });
});
test('initialize with a write scope provisions a missing board', async () => {
  const { initialize, setStartupBuildForTests } = await import('../src/setup.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.EMET_SOURCE_TAG = 'project-host';
    setStartupBuildForTests(async () => ({ state: 'ready' }));
    try { await actorStore.run({ scopes: ['emet.write'] }, () => initialize({ page: 'all' })); }
    catch { /* stub payload; provision runs first */ }
    finally { setStartupBuildForTests(null); }
    assert.ok(db.doc('STATE.md'));
    assert.strictEqual(db.doc('STATE.md').version, 1);
  });
});
test('a reopen keeps earlier drops_seen, and a cache miss loads the store', async () => {
  const { sessionOpen, dropsSeenForOpen } = await import('../src/tools.js');
  const { graphAfter } = await import('../src/session-graph.js');
  const { cacheLoad, clearPageCache } = await import('../src/startup-pages.js');
  const db = makeStore();
  await withStore(db, async () => {
    db.col('documents').docs.push({ doc_id: 'drops/a.md', content: 'a\n', retired: false, updated_at: new Date() });
    const firstId = cacheLoad({ state: 'ready', unhandled_drops: ['drops/a.md'] });
    const first = await sessionOpen({ slug: 'reopen', load_id: firstId }, null, db, new Date('2026-10-04T12:00:00Z'));
    assert.ok(first.drops_seen.includes('drops/a.md'));
    await graphAfter('emet_session_open', { drops_seen: ['drops/caller.md'] }, first, db);
    db.col('documents').docs.push({ doc_id: 'drops/b.md', content: 'b\n', retired: false, updated_at: new Date() });
    const secondId = cacheLoad({ state: 'ready', unhandled_drops: ['drops/b.md'] });
    const second = await sessionOpen({ slug: 'reopen', load_id: secondId }, null, db, new Date('2026-10-04T12:00:00Z'));
    await graphAfter('emet_session_open', { drops_seen: ['drops/caller.md'] }, second, db);
    const stamped = db.row(first.base).drops_seen.slice().sort();
    assert.deepStrictEqual(stamped, ['drops/a.md', 'drops/b.md']);
    clearPageCache();
    db.col('documents').docs.push({ doc_id: 'drops/miss.md', content: 'later\n', retired: false, updated_at: new Date() });
    const loaded = await dropsSeenForOpen('not-a-cached-load');
    assert.ok(loaded.includes('drops/miss.md'));
    const down = makeStore({ failRead: true });
    await withStore(down, async () => {
      await assert.rejects(() => dropsSeenForOpen('also-missing'), /could not load unhandled drops/);
    });
  });
});
test('session close prunes baselines for sessions closed more than 7 days ago', async () => {
  const { sessionClose } = await import('../src/session.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://test';
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    db.col('emet_sessions').docs.push({ _id: 'old-session', closed: true, closed_at: old });
    db.col('emet_sessions').docs.push({ _id: 'fresh-session', closed: true, closed_at: new Date() });
    db.col('emet_sessions').docs.push({ _id: 'idle-open', closed: false, updated_at: old });
    db.col('emet_sessions').docs.push({ _id: 'open-session', closed: false, updated_at: new Date() });
    db.col('documents').docs.push({ doc_id: 'threads/base.md', content: 'x', size_baselines: { 'old-session': 10, 'fresh-session': 20, 'open-session': 30, 'idle-open': 40 } });
    await sessionClose({});
    const baselines = db.doc('threads/base.md').size_baselines;
    assert.strictEqual(baselines['old-session'], undefined);
    assert.strictEqual(baselines['idle-open'], undefined);
    assert.strictEqual(baselines['fresh-session'], 20);
    assert.strictEqual(baselines['open-session'], 30);
  });
});

test('after the startup cache is evicted, a boot-listed drop still refuses a board patch', async () => {
  const { initialize, setStartupBuildForTests, provisionBoardText } = await import('../src/setup.js');
  const { dispatchTool } = await import('../src/dispatch.js');
  const { cacheLoad, clearPageCache } = await import('../src/startup-pages.js');
  const { actorStore } = await import('../src/persons.js');
  const { patchDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.EMET_SOURCE_TAG = 'project-host';
    await write('drops/boot.md', 'still open\n');
    await write('STATE.md', provisionBoardText(), { provision: true });
    setStartupBuildForTests(async () => ({ state: 'ready', unhandled_drops: ['drops/boot.md'] }));
    let started;
    try { started = await actorStore.run({ scopes: ['emet.read'], clientId: 'stdio' }, () => initialize({ page: 'all' })); }
    finally { setStartupBuildForTests(null); }
    const load = started && started.startup_page && started.startup_page.load_id;
    for (let i = 0; i < 40; i++) cacheLoad({ n: i, pad: 'x'.repeat(20) });
    const opened = await actorStore.run({ scopes: ['emet.write'], clientId: 'stdio' }, () => dispatchTool('emet_session_open', { slug: 'late', load_id: load }, { dbManager: db }));
    const data = toolData(opened);
    assert.ok((data.drops_seen || []).includes('drops/boot.md'), JSON.stringify(opened).slice(0, 400));
    await assert.rejects(() => patchDoc('STATE.md', 'Verified at setup.', 'Verified at setup. later', 'project-host', null, null, { reason: REASON, session_id: data.session_id }), /retired with retire_doc/);
    clearPageCache();
  });
});
test('a read-only token initializes and cannot open a session, and writes nothing', async () => {
  const { initialize, setStartupBuildForTests } = await import('../src/setup.js');
  const { dispatchTool } = await import('../src/dispatch.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    setStartupBuildForTests(async () => ({ state: 'ready' }));
    const before = db.writes.length;
    let started;
    try { started = await actorStore.run({ scopes: ['emet.read'], clientId: 'guest' }, () => initialize({ page: 'all' })); }
    finally { setStartupBuildForTests(null); }
    const load = started && started.startup_page && started.startup_page.load_id;
    const opened = await actorStore.run({ scopes: ['emet.read'], clientId: 'guest' }, () => dispatchTool('emet_session_open', { slug: 'guest', load_id: load }, { dbManager: db }));
    assert.ok(opened.isError && /emet.write/.test(JSON.stringify(opened)));
    assert.strictEqual(db.doc('STATE.md'), undefined);
    assert.strictEqual(db.writes.slice(before).some((w) => w.includes('documents')), false);
  });
});
test('initialize with no source tag warns, and a write scope provisions as emet-server', async () => {
  const { initialize, setStartupBuildForTests } = await import('../src/setup.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    const prior = process.env.EMET_SOURCE_TAG;
    delete process.env.EMET_SOURCE_TAG;
    process.env.EMET_SOURCE_TAGS = 'project-host';
    setStartupBuildForTests(async () => ({ state: 'ready' }));
    try {
      const warned = await actorStore.run({ scopes: ['emet.read'] }, () => initialize({ page: 'all' }));
      assert.match(JSON.stringify(warned), /not provisioned/);
      assert.strictEqual(db.doc('STATE.md'), undefined);
      const made = await actorStore.run({ scopes: ['emet.write'] }, () => initialize({ page: 'all' }));
      assert.ok(db.doc('STATE.md'), JSON.stringify(made).slice(0, 500));
      assert.strictEqual(db.doc('STATE.md').updated_by, 'emet-server');
    } finally {
      setStartupBuildForTests(null);
      if (prior === undefined) delete process.env.EMET_SOURCE_TAG; else process.env.EMET_SOURCE_TAG = prior;
    }
  });
});
test('the drop cap is 20 in a New York day, and yesterday does not count', async () => {
  const { writeDoc } = await import('../src/tools.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    await actorStore.run({ clientId: 'app-1' }, async () => {
      for (let i = 0; i < 20; i++) {
        await writeDoc(`drops/old-${i}.md`, `old ${i}\n`, 'project-host');
        db.doc(`drops/old-${i}.md`).updated_at = yesterday;
      }
      for (let i = 0; i < 20; i++) await writeDoc(`drops/day-${i}.md`, `day ${i}\n`, 'project-host');
      await assert.rejects(() => writeDoc('drops/over.md', 'over\n', 'project-host'), /20 drops/);
    });
  });
});
test('stdio with no source does not fill a tagged stdio bucket, and http with no client is not stdio', async () => {
  const { writeDoc } = await import('../src/tools.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    await actorStore.run({ clientId: 'stdio' }, async () => {
      for (let i = 0; i < 20; i++) await writeDoc(`drops/vis-${i}.md`, `v ${i}\n`, null);
      await assert.rejects(() => writeDoc('drops/tagged-ok.md', 'ok\n', 'project-host'), /20 drops/);
    });
    assert.strictEqual(db.doc('drops/vis-0.md').drop_bucket, 'stdio');
    await actorStore.run({ clientId: 'http:visitor' }, async () => {
      await writeDoc('drops/http.md', 'http\n', null);
    });
    assert.strictEqual(db.doc('drops/http.md').drop_bucket, 'http:visitor');
  });
});
test('restore goes through dispatch, and a templated row with no verdict is refused', async () => {
  const { dispatchTool } = await import('../src/dispatch.js');
  const { writeDoc, patchDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.EMET_SOURCE_TAG = 'project-host';
    process.env.EMET_RESTORE_TAGS = 'project-host';
    await writeDoc('notes/plain.md', 'alpha note that is long enough to restore\n', 'project-host');
    await patchDoc('notes/plain.md', 'alpha', 'beta', 'project-host', null, null, { reason: REASON });
    const { initialize, setStartupBuildForTests } = await import('../src/setup.js');
    setStartupBuildForTests(async () => ({ state: 'ready' }));
    let started;
    try { started = await initialize({ page: 'all' }); } finally { setStartupBuildForTests(null); }
    const opened = await dispatchTool('emet_session_open', { slug: 'restore', load_id: started.startup_page.load_id }, { dbManager: db });
    const session_id = toolData(opened).session_id;
    assert.ok(session_id, JSON.stringify(opened).slice(0, 300));
    const restored = await dispatchTool('restore_doc', { doc_id: 'notes/plain.md', version: 1, reason: REASON, source: 'project-host', session_id }, { dbManager: db });
    assert.strictEqual(toolData(restored).restored_from_version, 1, JSON.stringify(restored).slice(0, 400));
    await writeDoc('threads/nov.md', 'thread text long enough to restore', 'project-host');
    await patchDoc('threads/nov.md', 'thread', 'THREAD', 'project-host', null, null, { reason: REASON });
    const row = db.col('documents_history').docs.find((d) => d.doc_id === 'threads/nov.md');
    assert.ok(row, 'history row');
    delete row.conformance;
    const refused = await dispatchTool('restore_doc', { doc_id: 'threads/nov.md', version: 1, reason: REASON, source: 'project-host', session_id }, { dbManager: db });
    assert.match(JSON.stringify(refused), /no conformance verdict/);
  });
});


test('an external caller claiming emet-server cannot accept a nonconformance on the handoff', async () => {
  const { acceptNonconformance } = await import('../src/tools.js');
  const { initialize, setStartupBuildForTests } = await import('../src/setup.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.EMET_SOURCE_TAGS = 'project-host';
    const prior = process.env.EMET_SOURCE_TAG;
    delete process.env.EMET_SOURCE_TAG;
    await assert.rejects(() => acceptNonconformance('HANDOFF.md', REASON, 'emet-server'), /not a registered/);
    setStartupBuildForTests(async () => ({ state: 'ready' }));
    try {
      await actorStore.run({ scopes: ['emet.write'] }, () => initialize({ page: 'all' }));
      assert.strictEqual(db.doc('STATE.md').updated_by, 'emet-server');
    } finally {
      setStartupBuildForTests(null);
      if (prior === undefined) delete process.env.EMET_SOURCE_TAG; else process.env.EMET_SOURCE_TAG = prior;
    }
  });
});
test('a new session resets the first-touch baseline; the same session does not', async () => {
  const { patchDoc } = await import('../src/tools.js');
  const db = makeStore();
  await withStore(db, async () => {
    await write('threads/fresh.md', 'x'.repeat(100), { session_id: 'same' });
    await patchDoc('threads/fresh.md', 'x'.repeat(100), 'x'.repeat(80), 'project-host', null, null, { reason: REASON, session_id: 'same' });
    await assert.rejects(() => patchDoc('threads/fresh.md', 'x'.repeat(80), 'x'.repeat(45), 'project-host', null, null, { reason: REASON, session_id: 'same' }), /first touched/);
    await assert.rejects(() => patchDoc('threads/fresh.md', 'x'.repeat(80), 'x'.repeat(45), 'project-host', null, null, { reason: REASON, session_id: 'other' }), /24 hours/);
    await patchDoc('threads/fresh.md', 'x'.repeat(80), 'x'.repeat(60), 'project-host', null, null, { reason: REASON, session_id: 'other' });
    assert.strictEqual(db.doc('threads/fresh.md').content.length, 60);
  });
});
test('restore of the board is refused while an unretired boot drop is open', async () => {
  const { restoreDoc, patchDoc } = await import('../src/tools.js');
  const { provisionBoardText } = await import('../src/setup.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.EMET_SOURCE_TAG = 'project-host';
    process.env.EMET_RESTORE_TAGS = 'project-host';
    await write('STATE.md', provisionBoardText(), { provision: true });
    db.col('emet_sessions').docs.push({ _id: 'plain', opened: true, drops_seen: [] });
    await patchDoc('STATE.md', 'Verified at setup.', 'Verified at setup. later', 'project-host', null, null, { reason: REASON, session_id: 'plain' });
    db.col('documents').docs.push({ doc_id: 'drops/open.md', content: 'open', retired: false, updated_at: new Date() });
    db.col('emet_sessions').docs.push({ _id: 'gated', drops_seen: ['drops/open.md'] });
    await assert.rejects(() => restoreDoc('STATE.md', 1, 'project-host', null, REASON, { session_id: 'gated' }), /retired with retire_doc/);
  });
});

test('the boot list shows exactly 20 of 25 open drops', async () => {
  const { initialize } = await import('../src/setup.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://test';
    db.col('documents').docs.push({ doc_id: 'bootstrap/IDENTITY.md', content: 'id' });
    db.col('documents').docs.push({ doc_id: 'bootstrap/USER.md', content: 'user' });
    for (let n = 0; n < 25; n++) db.col('documents').docs.push({ doc_id: 'drops/cap-' + n + '.md', content: 'd', retired: false, updated_at: new Date(Date.now() - n * 1000) });
    const started = await initialize({ page: 'all' });
    const text = JSON.stringify(started);
    const drops = started.unhandled_drops || (started.startup && started.startup.unhandled_drops) || [];
    assert.strictEqual(drops.length, 20, text.slice(0, 500));
    assert.strictEqual(started.unhandled_drops_more, 5);
  });
});
test('a drop at 02:00Z does not count toward the New York day, and one at 05:00Z on that UTC date does', async () => {
  const { writeDoc } = await import('../src/tools.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    const ny = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const previousNy = new Date(ny + 'T02:00:00Z');
    const thisNy = new Date(ny + 'T05:00:00Z');
    await actorStore.run({ clientId: 'app-boundary' }, async () => {
      for (let n = 0; n < 20; n++) {
        await writeDoc('drops/zedge-' + n + '.md', 'edge', 'project-host');
        db.doc('drops/zedge-' + n + '.md').updated_at = previousNy;
      }
      await writeDoc('drops/after-zedge.md', 'allowed', 'project-host');
      for (let n = 0; n < 19; n++) {
        await writeDoc('drops/zny-' + n + '.md', 'ny', 'project-host');
        db.doc('drops/zny-' + n + '.md').updated_at = thisNy;
      }
      await assert.rejects(() => writeDoc('drops/zny-over.md', 'over', 'project-host'), /20 drops/);
    });
  });
});
test('a refused provision returns a warning and does not throw', async () => {
  const { initialize, setStartupBuildForTests } = await import('../src/setup.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore({ failRead: true });
  await withStore(db, async () => {
    setStartupBuildForTests(async () => ({ state: 'ready' }));
    try {
      const warned = await actorStore.run({ scopes: ['emet.write'] }, () => initialize({ page: 'all' }));
      assert.match(JSON.stringify(warned), /not provisioned/);
    } finally { setStartupBuildForTests(null); }
  });
});
test('a failed drop read refuses a board patch and a board restore', async () => {
  const { patchDoc, restoreDoc } = await import('../src/tools.js');
  const { provisionBoardText } = await import('../src/setup.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.EMET_SOURCE_TAG = 'project-host';
    process.env.EMET_RESTORE_TAGS = 'project-host';
    await write('STATE.md', provisionBoardText(), { provision: true });
    db.col('emet_sessions').docs.push({ _id: 'plain', opened: true, drops_seen: [] });
    await patchDoc('STATE.md', 'Verified at setup.', 'Verified at setup. later', 'project-host', null, null, { reason: REASON, session_id: 'plain' });
    db.col('emet_sessions').docs.push({ _id: 'unknown-list', drops_unverified: true });
    await assert.rejects(() => patchDoc('STATE.md', 'Verified at setup. later', 'Verified at setup. later still', 'project-host', null, null, { reason: REASON, session_id: 'unknown-list' }), /could not be loaded/);
    await assert.rejects(() => restoreDoc('STATE.md', 1, 'project-host', null, REASON, { session_id: 'unknown-list' }), /could not be loaded/);
  });
});
test('a verified reopen that finds no unretired drops clears drops_unverified', async () => {
  const { sessionOpen } = await import('../src/tools.js');
  const { graphAfter } = await import('../src/session-graph.js');
  const { cacheLoad } = await import('../src/startup-pages.js');
  const db = makeStore();
  await withStore(db, async () => {
    db.col('emet_sessions').docs.push({ _id: '2026-10-04_clear-me', drops_unverified: true, drops_seen: ['drops/gone.md'] });
    const load = cacheLoad({ state: 'ready', unhandled_drops: [] });
    const opened = await sessionOpen({ slug: 'clear-me', load_id: load }, null, db, new Date('2026-10-04T12:00:00Z'));
    assert.deepStrictEqual(opened.drops_seen, []);
    await graphAfter('emet_session_open', {}, opened, db);
    assert.strictEqual(db.row(opened.base).drops_unverified, undefined, JSON.stringify(db.row(opened.base)));
  });
});
test('session close does not prune a live session baseline, including the session being closed', async () => {
  const { sessionClose } = await import('../src/session.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://test';
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    db.col('emet_sessions').docs.push({ _id: 'old-session', closed: true, closed_at: old });
    db.col('emet_sessions').docs.push({ _id: 'closing', closed: false, updated_at: old });
    db.col('documents').docs.push({ doc_id: 'threads/live.md', content: 'x', size_baselines: { 'old-session': 10, 'closing': 50 } });
    db.col('documents').docs.push({ doc_id: 'threads/only-live.md', content: 'y', size_baselines: { 'closing': 50 } });
    await sessionClose({ session_id: 'closing_verbatim_part1' });
    assert.strictEqual(db.doc('threads/live.md').size_baselines['old-session'], undefined);
    assert.strictEqual(db.doc('threads/live.md').size_baselines['closing'], 50);
    assert.strictEqual(db.doc('threads/only-live.md').size_baselines['closing'], 50);
  });
});
test('session close does not modify a document that has only live or fresh baselines', async () => {
  const { sessionClose } = await import('../src/session.js');
  const db = makeStore();
  await withStore(db, async () => {
    process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://test';
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stamp = new Date('2026-10-02T15:04:00.000Z');
    db.col('emet_sessions').docs.push({ _id: 'old-session', closed: true, closed_at: old });
    db.col('emet_sessions').docs.push({ _id: 'live-open', closed: false, updated_at: recent });
    db.col('emet_sessions').docs.push({ _id: 'fresh-closed', closed: true, closed_at: recent });
    db.col('documents').docs.push({
      doc_id: 'threads/kept.md', content: 'kept', version: 4, updated_at: stamp,
      size_baselines: { 'live-open': 40, 'fresh-closed': 20 }
    });
    const docWrites = () => db.writes.filter((w) => w.includes('documents'));
    const before = docWrites();
    await sessionClose();
    const kept = db.doc('threads/kept.md');
    assert.strictEqual(kept.version, 4);
    assert.strictEqual(kept.updated_at, stamp);
    assert.deepStrictEqual(kept.size_baselines, { 'live-open': 40, 'fresh-closed': 20 });
    assert.deepStrictEqual(docWrites(), before);
  });
});
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
// The /mcp route requires a bearer token before it ever builds a server. This
// request has no OAuth login, so that check is stepped past and authInfo stays
// absent — the case where the old stdio fallback would stamp stdio.
function skipBearer(app) {
  for (const layer of app.router.stack) {
    const route = layer.route;
    if (!route || route.path !== '/mcp' || !route.methods.post) continue;
    for (const step of route.stack) {
      if (Function.prototype.toString.call(step.handle).includes('verifyAccessToken')) {
        step.handle = (_req, _res, next) => next();
        return;
      }
    }
  }
  throw new Error('the /mcp bearer check was not found on the HTTP app');
}
test('an HTTP caller with no OAuth client id is http:visitor, never a stdio bucket', async () => {
  const express = (await import('express')).default;
  const port = await freePort();
  const saved = { PORT: process.env.PORT, HOST: process.env.HOST };
  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  let httpServer = null;
  const origListen = express.application.listen;
  const listening = new Promise((resolve, reject) => {
    express.application.listen = function (...args) {
      httpServer = origListen.apply(this, args);
      httpServer.once('listening', () => resolve(this));
      httpServer.once('error', reject);
      return httpServer;
    };
  });
  const db = makeStore();
  try {
    await withStore(db, async () => {
      await import('../src/http-remote.js');
      const app = await listening;
      skipBearer(app);
      const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'write_doc', arguments: { doc_id: 'drops/http-noclient.md', content: 'visitor', source: 'project-host' } }
        })
      });
      const body = await res.text();
      assert.strictEqual(res.status, 200, body.slice(0, 500));
      const row = db.doc('drops/http-noclient.md');
      assert.ok(row, body.slice(0, 800));
      assert.strictEqual(row.client_id, 'http:visitor');
      assert.strictEqual(row.drop_bucket, 'http:visitor');
    });
  } finally {
    express.application.listen = origListen;
    if (saved.PORT === undefined) delete process.env.PORT; else process.env.PORT = saved.PORT;
    if (saved.HOST === undefined) delete process.env.HOST; else process.env.HOST = saved.HOST;
    if (httpServer) {
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    }
  }
});
summary('BOARD GUARD TEST SUMMARY');
