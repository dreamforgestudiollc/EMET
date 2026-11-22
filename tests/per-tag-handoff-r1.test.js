/**
 * Review R1 on the per-tag handoff. Each must-fix is a store test:
 * patchDoc, writeDoc, restoreDoc, session close, or the session graph.
 * A pure helper call is not the check.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';
import { makeStore, withStore, withEnv } from './memstore.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
process.env.EMET_DROP_LIST_TIMEOUT_MS = process.env.EMET_DROP_LIST_TIMEOUT_MS || '50';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = 'hub';
const WRITER = 'writer';
const FIELD = 'field';
const REASON = 'fixture reason for the edit';
const DAY = 86400000;
const HOUR = 3600000;

console.log('\n=== per-tag handoff R1 ===');

function env(extra = {}) {
  return {
    EMET_TAG_HANDOFFS: 'enforce',
    EMET_HUB_TAG: HUB,
    EMET_SOURCE_TAGS: `${HUB},${WRITER},${FIELD},notebook`,
    EMET_SOURCE_TAG: HUB,
    EMET_RECORD_DOCS: `bots/${WRITER}/HANDOFF.md`,
    EMET_HANDOFF_AGING_DAYS: '7',
    EMET_STALE_OPEN_HOURS: '24',
    ...extra
  };
}

function allowBoard(db, id = 'board-ok') {
  const base = String(id).replace(/_verbatim_part\d+$/, '');
  const docs = db.col('emet_sessions').docs;
  if (!docs.some((d) => d._id === base)) docs.push({ _id: base, opened: true, drops_seen: [] });
  return id;
}

async function boardWith(nextAction) {
  const { provisionBoardText } = await import('../src/setup.js');
  let text = provisionBoardText();
  text = text.replace('| 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |', '| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
  const none = 'None \u2014 checked against: none yet.';
  const table = [
    '| What | State it was left in | Next action | Contingency | How to undo | Id |',
    '|---|---|---|---|---|---|',
    `| shared row | left open | ${nextAction} | if blocked, stop | revert the line | B-010 |`
  ].join('\n');
  const at = text.indexOf(none);
  if (at < 0) throw new Error('provisioned board has no empty half-state line');
  return text.slice(0, at) + table + text.slice(at + none.length);
}

function handoffText(state, next) {
  return [
    '# Handoff',
    '',
    '## §1 Picture',
    '| id | state | next |',
    '| --- | --- | --- |',
    `| B-010 | ${state} | ${next} |`,
    ''
  ].join('\n');
}

function fingerprint(stamp) {
  const copy = { ...stamp };
  delete copy.view_sha256;
  return JSON.stringify(copy);
}

async function tools() {
  return import('../src/tools.js');
}

testGroup('MF-1 and N10: hub settlement uses the stamp as_of and clears the mark', () => {
  test('a hub patchDoc of a marked row with the initialize stamp is kept, a bad sha is refused, and the next view drops the conflict', async () => {
    const db = makeStore();
    await withEnv(env(), () => withStore(db, async () => {
      const { writeDoc, patchDoc, loadHandoffView } = { ...(await tools()), loadHandoffView: (await import('../src/per-tag-handoff.js')).loadHandoffView };
      const sid = allowBoard(db);
      await writeDoc('STATE.md', await boardWith('do a'), HUB, null, null, { provision: true, reason: REASON });
      await writeDoc('HANDOFF.md', handoffText('left open', 'do b'), HUB, null, null, { reason: REASON });
      await writeDoc(`HANDOFF/${WRITER}.md`, handoffText('left open', 'do a'), WRITER, null, null, { reason: REASON });
      db.doc('STATE.md').row_openers = {
        'B-010': { opener_tag: WRITER, opened_at: '2026-11-01T00:00:00.000Z', opened_in_version: 1 }
      };
      const asOf = new Date().toISOString();
      const view = await loadHandoffView(db, { asOf, person: 'owner', tag: HUB });
      const stamp = view.handoff_view;
      assert.ok(view.handoff_view_conflicts.includes('B-010'), view.handoff_view_text);
      const bad = { ...stamp, view_sha256: '0'.repeat(64) };
      await assert.rejects(
        () => patchDoc('STATE.md', 'do a', 'do c', HUB, null, null, {
          reason: REASON, session_id: sid, resolve_conflict: { row_id: 'B-010', handoff_view: bad }
        }),
        (err) => err.emetCode === 'EMET-DOC-085'
      );
      assert.strictEqual(db.doc('STATE.md').version, 1);
      const settled = await patchDoc('STATE.md', 'do a', 'do c', HUB, null, null, {
        reason: REASON, session_id: sid, resolve_conflict: { row_id: 'B-010', handoff_view: stamp }
      });
      assert.strictEqual(settled.version, 2);
      assert.deepStrictEqual(db.doc('STATE.md').conflict_settled['B-010'].inputs, stamp.inputs);
      const after = await loadHandoffView(db, { asOf: new Date().toISOString(), person: 'owner', tag: HUB });
      assert.ok(!after.handoff_view_text.includes('\n- conflict\n'), after.handoff_view_text);
      assert.deepStrictEqual(after.handoff_view_conflicts, []);
      await writeDoc(`HANDOFF/${WRITER}.md`, handoffText('left open', 'do d'), WRITER, null, null, { reason: REASON, supersedes: 1 });
      const again = await loadHandoffView(db, { asOf: new Date().toISOString(), person: 'owner', tag: HUB });
      assert.ok(again.handoff_view_conflicts.includes('B-010'));
    }));
  });
});

testGroup('MF-2: close and the session graph accept HANDOFF/<tag>.md', () => {
  test('a bot close and a host close on HANDOFF/<tag>.md return complete, and the graph records the write', async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    const { graphAfter } = await import('../src/session-graph.js');
    const { fullStartup } = await import('./graph-session.js');
    const go = (db, tool, args, now) => withStore(db, () => dispatchTool(tool, args, { dbManager: db, logger: null, now }));
    const dataOf = (r) => JSON.parse(r.content[0].text).data;
    const text = (r) => JSON.stringify(r);
    async function ready(db, slug, tag) {
      const T = new Date();
      const opened = await go(db, 'emet_session_open', { slug, load_id: await fullStartup(slug) }, T);
      assert.ok(!opened.isError, text(opened).slice(0, 400));
      const { session_id: sid, base } = dataOf(opened);
      const reply = 'no local shell MCP. hello';
      const a1 = await go(db, 'emet_transcript_append', { session_id: sid, source: tag, user_message: 'hi', assistant_message: reply }, T);
      assert.ok(!a1.isError, text(a1).slice(0, 400));
      const a2 = await go(db, 'emet_transcript_append', { session_id: sid, source: tag, user_message: 'wrap up please', assistant_message: 'wrapping up' }, T);
      assert.ok(!a2.isError, text(a2).slice(0, 400));
      const wall = Date.now();
      db.col('documents').docs.push(
        { doc_id: `HANDOFF/${tag}.md`, version: 3, updated_at: new Date(wall - 1000), updated_by: tag, size: 12, content: 'handoff\n' },
        { doc_id: 'STATE.md', version: 1, updated_at: new Date(wall - 2 * HOUR), updated_by: HUB, size: 8, content: '# Board\nold\n' }
      );
      db.col('emet_episodic').docs.push({
        id: 42, timestamp: (wall - 60000) / 1000, importance: 0.5, metadata: { source: tag },
        source_session_id: base, source_exchange_start: 1, source_exchange_end: 2
      });
      const receipts = {
        working_docs: [], episodic_id: 42,
        transcript_session_id: base, transcript_parts: [sid], transcript_exchanges: 2,
        handoff_doc: `HANDOFF/${tag}.md`, handoff_version: 3,
        handoff_view: {
          as_of: new Date(wall).toISOString(), person: 'owner', inputs: [], board: 'STATE.md@v0',
          open_sessions: [], aging_days: 7, stale_open_hours: 24, registry: [tag],
          view_sha256: 'ab'.repeat(32)
        }
      };
      return { T, base, receipts, session_start: Math.floor((wall - HOUR) / 1000) };
    }
    const botDb = makeStore();
    await withEnv(env(), async () => {
      const bot = await ready(botDb, 'bot-close', WRITER);
      const closed = await go(botDb, 'emet_session_close', { receipts: bot.receipts, session_start: bot.session_start }, bot.T);
      assert.ok(!closed.isError, text(closed).slice(0, 800));
      assert.strictEqual(dataOf(closed).state, 'complete', JSON.stringify(dataOf(closed).missing));
    });
    const hostDb = makeStore();
    await withEnv(env({ EMET_RECORD_DOCS: '' }), async () => {
      const host = await ready(hostDb, 'host-close', FIELD);
      const closed = await go(hostDb, 'emet_session_close', { receipts: host.receipts, session_start: host.session_start }, host.T);
      assert.ok(!closed.isError, text(closed).slice(0, 800));
      assert.strictEqual(dataOf(closed).state, 'complete', JSON.stringify(dataOf(closed).missing));
    });
    const graphDb = makeStore();
    await withEnv(env(), () => withStore(graphDb, async () => {
      const recorded = await graphAfter('write_doc', {
        doc_id: `HANDOFF/${WRITER}.md`, source: WRITER, session_id: '2026-11-10_graph'
      }, { version: 2 }, graphDb);
      assert.deepStrictEqual(recorded, { recorded: true, base: '2026-11-10_graph' });
      assert.strictEqual(graphDb.row('2026-11-10_graph').handoff, true);
      assert.strictEqual(graphDb.row('2026-11-10_graph').tag, WRITER);
    }));
  });
});

testGroup('MF-3: open sessions take the tag from the schema fields', () => {
  test('dispatch open and save_to_layer metadata.source name the in-progress line, and the query stays age-bounded', async () => {
    const db = makeStore();
    const { dispatchTool } = await import('../src/dispatch.js');
    const { fullStartup } = await import('./graph-session.js');
    const { TOOLS } = await import('../src/tools.js');
    const openTool = [...TOOLS].find((tool) => tool.name === 'emet_session_open');
    assert.ok(openTool.inputSchema.properties.source, 'emet_session_open schema has no source');
    assert.ok(!([...TOOLS].find((tool) => tool.name === 'save_to_layer').inputSchema.properties.source), 'save_to_layer has no top-level source');
    const memory = {
      ...db,
      async getConnection() { return {}; },
      collectionFor(layer) { return db.collection(`emet_${layer}`); },
      async insertMemory(layer, doc) {
        const col = db.collection(`emet_${layer}`);
        const id = col.docs.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
        col.docs.push({ ...doc, id });
        return id;
      },
      async readMemory(layer, id) {
        return db.collection(`emet_${layer}`).docs.find((row) => row.id === id) || null;
      }
    };
    const go = (tool, args, now) => withStore(db, () => dispatchTool(tool, args, { dbManager: memory, logger: null, now }));
    const dataOf = (r) => JSON.parse(r.content[0].text).data;
    const text = (r) => JSON.stringify(r);
    async function until(pred, label) {
      const deadline = Date.now() + 2000;
      for (;;) {
        if (pred()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((res) => setImmediate(res));
      }
    }
    await withEnv(env(), async () => {
      const now = new Date();
      const opened = await go('emet_session_open', { slug: 'live-tag', load_id: await fullStartup('live-tag') }, now);
      assert.ok(!opened.isError, text(opened).slice(0, 400));
      const { session_id: sid, base } = dataOf(opened);
      await until(() => db.row(base)?.opened === true, 'session opened');
      const saved = await go('save_to_layer', {
        layer: 'episodic', content: 'The session recorded what changed and what is next.',
        session_id: sid, metadata: { source: WRITER }
      }, now);
      assert.ok(!saved.isError, text(saved).slice(0, 500));
      await until(() => db.row(base)?.episodic === true && db.row(base)?.tag === WRITER, 'episodic tag');
      const staleAt = new Date(now.getTime() - 25 * HOUR);
      const staleOpen = await go('emet_session_open', { slug: 'stale-tag', load_id: await fullStartup('stale-tag') }, staleAt);
      assert.ok(!staleOpen.isError, text(staleOpen).slice(0, 400));
      const stale = dataOf(staleOpen);
      await until(() => db.row(stale.base)?.opened === true, 'stale opened');
      const staleSave = await go('save_to_layer', {
        layer: 'episodic', content: 'An older open session still has material work.',
        session_id: stale.session_id, metadata: { source: FIELD }
      }, staleAt);
      assert.ok(!staleSave.isError, text(staleSave).slice(0, 500));
      await until(() => db.row(stale.base)?.tag === FIELD, 'stale tag');
      const oldAt = new Date(now.getTime() - 40 * DAY);
      const oldOpen = await go('emet_session_open', { slug: 'old-tag', load_id: await fullStartup('old-tag') }, oldAt);
      assert.ok(!oldOpen.isError, text(oldOpen).slice(0, 400));
      const old = dataOf(oldOpen);
      await until(() => db.row(old.base)?.opened === true, 'old opened');
      const oldSave = await go('save_to_layer', {
        layer: 'episodic', content: 'This open session is older than the lookback.',
        session_id: old.session_id, metadata: { source: 'notebook' }
      }, oldAt);
      assert.ok(!oldSave.isError, text(oldSave).slice(0, 500));
      await until(() => db.row(old.base)?.tag === 'notebook', 'old tag');
      const { loadHandoffView } = await import('../src/per-tag-handoff.js');
      const view = await withStore(db, () => loadHandoffView(db, { asOf: now.toISOString(), person: 'owner', tag: WRITER }));
      assert.match(view.handoff_view_text, new RegExp(`in progress by ${WRITER}`));
      assert.match(view.handoff_view_text, /stale-open/);
      assert.ok(!view.handoff_view_text.includes('in progress by notebook'), view.handoff_view_text);
    });
  });
});

testGroup('MF-4: the stamp records the inputs that change the bytes', () => {
  test('aging days and an open session change the stamp, and a rebuild from the stored stamp still matches', async () => {
    const db = makeStore();
    const asOf = new Date().toISOString();
    const updated = new Date(Date.parse(asOf) - 8 * DAY).toISOString();
    await withEnv(env(), () => withStore(db, async () => {
      const { writeDoc } = await tools();
      const { loadHandoffView, buildView } = await import('../src/per-tag-handoff.js');
      const { graphAfter } = await import('../src/session-graph.js');
      await writeDoc('STATE.md', await boardWith('do a'), HUB, null, null, { provision: true, reason: REASON });
      await writeDoc(`HANDOFF/${WRITER}.md`, handoffText('left open', 'do a'), WRITER, null, null, { reason: REASON });
      db.doc(`HANDOFF/${WRITER}.md`).updated_at = new Date(updated);
      const first = await loadHandoffView(db, { asOf, person: 'owner', tag: WRITER });
      const stamp = first.handoff_view;
      assert.strictEqual(stamp.aging_days, 7);
      assert.strictEqual(stamp.stale_open_hours, 24);
      assert.ok(Array.isArray(stamp.open_sessions));
      assert.deepStrictEqual(stamp.registry, [HUB, WRITER, FIELD, 'notebook']);
      assert.match(first.handoff_view_text, /class: aging/);
      const captured = {
        inputs: [{
          doc_id: `HANDOFF/${WRITER}.md`, tag: WRITER, version: stamp.inputs.find((id) => id.startsWith('HANDOFF/')).split('@v')[1] | 0,
          updated_at: updated, content: db.doc(`HANDOFF/${WRITER}.md`).content
        }],
        board: { doc_id: 'STATE.md', version: db.doc('STATE.md').version, content: db.doc('STATE.md').content }
      };
      captured.inputs[0].version = db.doc(`HANDOFF/${WRITER}.md`).version;
      await withEnv(env({ EMET_HANDOFF_AGING_DAYS: '30' }), async () => {
        const wider = await loadHandoffView(db, { asOf, person: 'owner', tag: WRITER });
        assert.notStrictEqual(fingerprint(wider.handoff_view), fingerprint(stamp));
        assert.strictEqual(wider.handoff_view.aging_days, 30);
        assert.match(wider.handoff_view_text, /class: current/);
      });
      const rebuilt = buildView({
        inputs: captured.inputs, board: captured.board, as_of: stamp.as_of, person: stamp.person,
        open_sessions: stamp.open_sessions, registry: stamp.registry,
        aging_days: stamp.aging_days, stale_open_hours: stamp.stale_open_hours
      });
      assert.strictEqual(rebuilt.stamp.view_sha256, stamp.view_sha256);
      await graphAfter('emet_session_open', { source: WRITER }, { base: '2026-11-10_stamp', drops_seen: [] }, db, null, new Date());
      await graphAfter('save_to_layer', { layer: 'episodic', source: WRITER, session_id: '2026-11-10_stamp' }, { id: 3 }, db, null, new Date());
      const withSession = await loadHandoffView(db, { asOf, person: 'owner', tag: WRITER });
      assert.notStrictEqual(fingerprint(withSession.handoff_view), fingerprint(stamp));
      assert.notStrictEqual(withSession.handoff_view.view_sha256, stamp.view_sha256);
      const still = buildView({
        inputs: captured.inputs, board: captured.board, as_of: stamp.as_of, person: stamp.person,
        open_sessions: stamp.open_sessions, registry: stamp.registry,
        aging_days: stamp.aging_days, stale_open_hours: stamp.stale_open_hours
      });
      assert.strictEqual(still.stamp.view_sha256, stamp.view_sha256);
    }));
  });
});

testGroup('MF-5: another tag folder is refused, including the hub on a bot handoff', () => {
  test('the hub write of bots/<tag>/HANDOFF.md and a registered non-bot write of bots/<other>/NOTES.md are EMET-DOC-084', async () => {
    const db = makeStore();
    await withEnv(env(), () => withStore(db, async () => {
      const { writeDoc } = await tools();
      await assert.rejects(
        () => writeDoc(`bots/${WRITER}/HANDOFF.md`, '# Handoff\n\nnot the hub\n', HUB, null, null, { reason: REASON }),
        (err) => err.emetCode === 'EMET-DOC-084'
      );
      await assert.rejects(
        () => writeDoc(`bots/${WRITER}/NOTES.md`, 'a note in another folder\n', 'notebook'),
        (err) => err.emetCode === 'EMET-DOC-084'
      );
      assert.strictEqual(db.doc(`bots/${WRITER}/HANDOFF.md`), undefined);
      assert.strictEqual(db.doc(`bots/${WRITER}/NOTES.md`), undefined);
    }));
  });
});

testGroup('MF-6: delete, restore, and an unmapped row stay with the opener', () => {
  test('dropping a foreign row, restoring the board, and patching a row missing from the map are EMET-DOC-085', async () => {
    const db = makeStore();
    await withEnv(env({ EMET_BOARD_GUARD: 'enforce', EMET_RESTORE_TAGS: `${HUB},${WRITER},notebook` }), () => withStore(db, async () => {
      const { writeDoc, patchDoc, restoreDoc } = await tools();
      const sid = allowBoard(db);
      const board = await boardWith('do a');
      await writeDoc('STATE.md', board, HUB, null, null, { provision: true, reason: REASON });
      const row = '| shared row | left open | do a | if blocked, stop | revert the line | B-010 |';
      await assert.rejects(
        () => patchDoc('STATE.md', null, null, 'notebook', null, null, {
          reason: REASON, session_id: sid, acknowledge_dropped_rows: ['B-010'],
          edits: [
            { old_str: '| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |', new_str: '| 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |' },
            { old_str: row, new_str: 'None \u2014 checked against: none yet.' }
          ]
        }),
        (err) => err.emetCode === 'EMET-MEM-029'
      );
      assert.strictEqual(db.doc('STATE.md').version, 1);
      assert.ok(db.doc('STATE.md').content.includes(row));
      db.doc('STATE.md').row_openers = {
        'B-999': { opener_tag: WRITER, opened_at: '2026-11-01T00:00:00.000Z', opened_in_version: 1 }
      };
      await assert.rejects(
        () => patchDoc('STATE.md', 'do a', 'do z', 'notebook', null, null, { reason: REASON, session_id: sid }),
        (err) => err.emetCode === 'EMET-DOC-085'
      );
      assert.ok(db.doc('STATE.md').content.includes('do a'));
      db.doc('STATE.md').row_openers = {
        'B-010': { opener_tag: HUB, opened_at: '2026-11-01T00:00:00.000Z', opened_in_version: 1 }
      };
      await patchDoc('STATE.md', 'do a', 'do b', HUB, null, null, { reason: REASON, session_id: sid });
      await assert.rejects(
        () => restoreDoc('STATE.md', 1, 'notebook', null, REASON, { session_id: sid }),
        (err) => err.emetCode === 'EMET-DOC-085'
      );
      assert.ok(db.doc('STATE.md').content.includes('do b'));
    }));
  });
});

testGroup('a nonconforming board patch is refused with the flag on', () => {
  test('warn and enforce refuse a nonconforming patch_doc with EMET-MEM-029 and write nothing', async () => {
    for (const flag of ['warn', 'enforce']) {
      const db = makeStore();
      await withEnv(env({ EMET_TAG_HANDOFFS: flag }), () => withStore(db, async () => {
        const { writeDoc, patchDoc } = await tools();
        const sid = allowBoard(db);
        const board = await boardWith('do a');
        await writeDoc('STATE.md', board, HUB, null, null, { provision: true, reason: REASON });
        const before = db.doc('STATE.md').content;
        const row = '| shared row | left open | do a | if blocked, stop | revert the line | B-010 |';
        await assert.rejects(
          () => patchDoc('STATE.md', null, null, 'notebook', null, null, {
            reason: REASON, session_id: sid,
            edits: [
              { old_str: '| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |', new_str: '| 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |' },
              { old_str: row, new_str: 'None \u2014 checked against: none yet.' }
            ]
          }),
          (err) => err.emetCode === 'EMET-MEM-029' && /Nothing was written/.test(err.message)
        );
        assert.strictEqual(db.doc('STATE.md').content, before);
        assert.strictEqual(db.doc('STATE.md').version, 1);
      }));
    }
  });
});

testGroup('MF-7: warn mode puts the gap warning on the receipt', () => {
  test('a kept hub-handoff write in warn returns the warning and stores the document', async () => {
    const db = makeStore();
    await withEnv(env({ EMET_TAG_HANDOFFS: 'warn' }), () => withStore(db, async () => {
      const { writeDoc } = await tools();
      const res = await writeDoc('HANDOFF.md', '# Handoff\n\nkept in warn\n', 'notebook', null, null, { reason: REASON });
      assert.ok(Array.isArray(res.warnings), 'the receipt has no warnings');
      assert.ok(res.warnings.some((line) => /hub handoff/i.test(line) && /Warn only/.test(line)), JSON.stringify(res.warnings));
      assert.match(db.doc('HANDOFF.md').content, /kept in warn/);
    }));
  });
});

testGroup('MF-8: the docs name the fields and the codes', () => {
  test('the continuity section, session open, the statechart sentence, and codes 084 and 086 are current', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const continuity = readme.split('**Continuity currency**')[1].split('**During the session**')[0];
    assert.match(continuity, /handoff_view/);
    assert.match(continuity, /own_handoff/);
    assert.match(continuity, /stale_open/);
    assert.match(continuity, /in-progress line/);
    const toolsSrc = fs.readFileSync(path.join(ROOT, 'src/tools.js'), 'utf8');
    const openAt = toolsSrc.indexOf('name: "emet_session_open"');
    const open = toolsSrc.slice(openAt, openAt + 1800);
    assert.match(open, /handoff_view/);
    assert.match(open, /own_handoff/);
    assert.match(open, /stale_open/);
    const chart = fs.readFileSync(path.join(ROOT, 'docs/continuity-currency-statechart.md'), 'utf8');
    const chartAt = chart.indexOf('The generated chart draws 10 states and 17 arrows.');
    const perTagAt = chart.indexOf('When `EMET_TAG_HANDOFFS`');
    assert.ok(chartAt > 0 && perTagAt > chartAt, 'the 10-states sentence sits under the per-tag paragraph');
    const spec = fs.readFileSync(path.join(ROOT, 'docs/ERROR-CODES-SPEC.md'), 'utf8');
    assert.match(spec, /EMET-DOC-084` is another tag's handoff[\s\S]*unregistered credential/);
    assert.match(spec, /EMET-DOC-086` is a reserved two-segment handoff id[\s\S]*malformed id/);
    assert.match(spec, /not the view in force/);
    assert.match(spec, /re-read the handoff view/);
    assert.match(readme, /re-read the handoff view/);
    assert.match(readme, /EMET-CFG-015/);
    const deploy = fs.readFileSync(path.join(ROOT, 'docs/DEPLOY.md'), 'utf8');
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    assert.match(deploy, /EMET_HUB_TAG[\s\S]{0,500}EMET-CFG-015/);
    assert.match(example, /EMET_HUB_TAG unset refuses every write \(EMET-CFG-015\)/);
    const bots = fs.readFileSync(path.join(ROOT, 'docs/BOTS.md'), 'utf8');
    assert.match(bots, /nobody writes inside another tag's `bots\/<tag>\/` folder, the hub included/);
    assert.ok(!/still write anywhere under bots/.test(toolsSrc));
  });
});

testGroup('N6 and N7: no hub tag, and a tag handoff is not restored', () => {
  test('the flag on with no EMET_HUB_TAG is EMET-CFG-015', async () => {
    const db = makeStore();
    await withEnv(env({ EMET_HUB_TAG: undefined }), () => withStore(db, async () => {
      const { writeDoc } = await tools();
      await assert.rejects(
        () => writeDoc('notes/plain.md', 'a note without a hub\n', HUB),
        (err) => err.emetCode === 'EMET-CFG-015'
      );
    }));
  });
  test('restore_doc on HANDOFF/<tag>.md is EMET-DOC-040', async () => {
    const db = makeStore();
    await withEnv(env(), () => withStore(db, async () => {
      const { restoreDoc } = await tools();
      await assert.rejects(
        () => restoreDoc(`HANDOFF/notebook.md`, 1, 'notebook', null, REASON),
        (err) => err.emetCode === 'EMET-DOC-040'
      );
    }));
  });
});

testGroup('N1 and N5: exact boundaries, and load_id ignores the view', () => {
  test('aging at exactly 7 days is current and stale at exactly 24 hours is not stale', async () => {
    const db = makeStore();
    const asOfMs = Date.now();
    const asOf = new Date(asOfMs).toISOString();
    await withEnv(env(), () => withStore(db, async () => {
      const { writeDoc } = await tools();
      const { loadHandoffView } = await import('../src/per-tag-handoff.js');
      await writeDoc('STATE.md', await boardWith('do a'), HUB, null, null, { provision: true, reason: REASON });
      await writeDoc(`HANDOFF/${WRITER}.md`, handoffText('left open', 'do a'), WRITER, null, null, { reason: REASON });
      db.doc(`HANDOFF/${WRITER}.md`).updated_at = new Date(asOfMs - 7 * DAY);
      db.col('emet_sessions').docs.push({
        _id: 'edge-open', tag: WRITER, closed: false, episodic: true,
        opened_at: new Date(asOfMs - 24 * HOUR), updated_at: new Date(asOfMs)
      });
      const edge = await loadHandoffView(db, { asOf, person: 'owner', tag: WRITER });
      assert.match(edge.handoff_view_text, /class: current/);
      assert.ok(!/class: aging/.test(edge.handoff_view_text));
      assert.ok(!edge.handoff_view_text.includes('stale-open'), edge.handoff_view_text);
      db.doc(`HANDOFF/${WRITER}.md`).updated_at = new Date(asOfMs - 7 * DAY - 1);
      db.row('edge-open').opened_at = new Date(asOfMs - 24 * HOUR - 1);
      const over = await loadHandoffView(db, { asOf, person: 'owner', tag: WRITER });
      assert.match(over.handoff_view_text, /class: aging/);
      assert.match(over.handoff_view_text, /stale-open/);
    }));
  });
  test('two startups that differ only in handoff_view.as_of have one load_id', async () => {
    const { loadIdOf } = await import('../src/startup-pages.js');
    const base = { state: 'ready', instructions_short: 'read the board' };
    const early = loadIdOf({ ...base, handoff_view: { as_of: '2026-11-10T15:00:00.000Z' }, own_handoff: { doc_id: 'HANDOFF/writer.md' }, stale_open: [] });
    const later = loadIdOf({ ...base, handoff_view: { as_of: '2026-11-10T15:00:01.000Z' }, own_handoff: { doc_id: 'HANDOFF/writer.md' }, stale_open: [{ tag: 'writer' }] });
    assert.strictEqual(early, later);
    assert.strictEqual(early, loadIdOf(base));
  });
});

testGroup('MF-7: warn receipts on accept, rename, and retire', () => {
  test('accept_nonconformance, rename of another bot folder, and retire keep the gap warning', async () => {
    const db = makeStore();
    const heard = [];
    const logger = { warn: (line) => heard.push(String(line)) };
    await withEnv(env({ EMET_TAG_HANDOFFS: 'warn' }), () => withStore(db, async () => {
      const { writeDoc, acceptNonconformance, renameDoc, retireDoc } = await tools();
      await writeDoc('HANDOFF.md', '# Handoff\n\nshort enough to mark\n', HUB, null, null, { reason: REASON });
      const accepted = await acceptNonconformance('HANDOFF.md', REASON, 'notebook', logger);
      assert.ok(accepted.warnings.some((line) => /hub handoff/i.test(line) && /Warn only/.test(line)), JSON.stringify(accepted.warnings));
      await writeDoc(`bots/${WRITER}/NOTES.md`, 'a note in the bot folder\n', WRITER);
      const renamed = await renameDoc(`bots/${WRITER}/NOTES.md`, 'notes/from-writer.md', 'notebook', logger, REASON);
      assert.ok(renamed.warnings.some((line) => /folder/i.test(line) && /Warn only/.test(line)), JSON.stringify(renamed.warnings));
      assert.strictEqual(db.doc('notes/from-writer.md').version, 1);
      const retired = await retireDoc('HANDOFF.md', REASON, 'notebook', logger, { fromRename: true });
      assert.ok(retired.warnings.some((line) => /hub handoff/i.test(line)), JSON.stringify(retired.warnings));
      assert.strictEqual(db.doc('HANDOFF.md').retired, true);
      assert.ok(heard.some((line) => /Warn only/.test(line)));
    }));
  });
});

testGroup('MF-9: a host close always reads the board', () => {
  test('a host who patched STATE.md does not close complete without a board receipt', async () => {
    const db = makeStore();
    const { dispatchTool } = await import('../src/dispatch.js');
    const { fullStartup } = await import('./graph-session.js');
    const dataOf = (r) => JSON.parse(r.content[0].text).data;
    const text = (r) => JSON.stringify(r);
    await withEnv(env({ EMET_RECORD_DOCS: '' }), () => withStore(db, async () => {
      const go = (tool, args, now) => dispatchTool(tool, args, { dbManager: db, logger: null, now });
      const { writeDoc, patchDoc } = await tools();
      const T = new Date();
      const opened = await go('emet_session_open', { slug: 'board-close', load_id: await fullStartup('board-close'), source: FIELD }, T);
      assert.ok(!opened.isError, text(opened).slice(0, 400));
      const { session_id: sid, base } = dataOf(opened);
      const reply = 'no local shell MCP. hello';
      assert.ok(!(await go('emet_transcript_append', { session_id: sid, source: FIELD, user_message: 'hi', assistant_message: reply }, T)).isError);
      assert.ok(!(await go('emet_transcript_append', { session_id: sid, source: FIELD, user_message: 'wrap up', assistant_message: 'wrapping up' }, T)).isError);
      allowBoard(db, base);
      await writeDoc('STATE.md', await boardWith('do a'), FIELD, null, null, { provision: true, reason: REASON });
      await patchDoc('STATE.md', 'do a', 'do b', FIELD, null, null, { reason: REASON, session_id: sid });
      const handoff = await writeDoc(`HANDOFF/${FIELD}.md`, handoffText('left open', 'do b'), FIELD, null, null, { reason: REASON });
      const wall = Date.now();
      db.col('emet_episodic').docs.push({
        id: 42, timestamp: (wall - 30000) / 1000, importance: 0.5, metadata: { source: FIELD },
        source_session_id: base, source_exchange_start: 1, source_exchange_end: 2
      });
      const receipts = {
        working_docs: [], episodic_id: 42,
        transcript_session_id: base, transcript_parts: [sid], transcript_exchanges: 2,
        handoff_doc: `HANDOFF/${FIELD}.md`, handoff_version: handoff.version,
        handoff_view: {
          as_of: new Date(wall).toISOString(), person: 'owner', inputs: [], board: 'STATE.md@v2',
          open_sessions: [], aging_days: 7, stale_open_hours: 24, registry: [FIELD],
          view_sha256: 'ab'.repeat(32)
        }
      };
      const closed = await go('emet_session_close', { session_id: sid, receipts, session_start: Math.floor((wall - HOUR) / 1000) }, T);
      assert.ok(!closed.isError, text(closed).slice(0, 500));
      const body = dataOf(closed);
      assert.notStrictEqual(body.state, 'complete', JSON.stringify(body.missing));
      assert.match(JSON.stringify(body.missing), /board/i);
    }));
  });
});

testGroup('MF-10: a bot close allows a patch of rows it opened', () => {
  test('a bot that patched its own STATE.md row closes complete', async () => {
    const db = makeStore();
    const { dispatchTool } = await import('../src/dispatch.js');
    const { fullStartup } = await import('./graph-session.js');
    const dataOf = (r) => JSON.parse(r.content[0].text).data;
    const text = (r) => JSON.stringify(r);
    await withEnv(env(), () => withStore(db, async () => {
      const go = (tool, args, now) => dispatchTool(tool, args, { dbManager: db, logger: null, now });
      const { writeDoc, patchDoc } = await tools();
      const T = new Date();
      const opened = await go('emet_session_open', { slug: 'bot-row', load_id: await fullStartup('bot-row'), source: WRITER }, T);
      assert.ok(!opened.isError, text(opened).slice(0, 400));
      const { session_id: sid, base } = dataOf(opened);
      const reply = 'no local shell MCP. hello';
      assert.ok(!(await go('emet_transcript_append', { session_id: sid, source: WRITER, user_message: 'hi', assistant_message: reply }, T)).isError);
      assert.ok(!(await go('emet_transcript_append', { session_id: sid, source: WRITER, user_message: 'wrap up', assistant_message: 'wrapping up' }, T)).isError);
      allowBoard(db, base);
      await writeDoc('STATE.md', await boardWith('do a'), WRITER, null, null, { provision: true, reason: REASON });
      await patchDoc('STATE.md', 'do a', 'do b', WRITER, null, null, { reason: REASON, session_id: sid });
      const handoff = await writeDoc(`HANDOFF/${WRITER}.md`, handoffText('left open', 'do b'), WRITER, null, null, { reason: REASON });
      const wall = Date.now();
      db.col('emet_episodic').docs.push({
        id: 43, timestamp: (wall - 30000) / 1000, importance: 0.5, metadata: { source: WRITER },
        source_session_id: base, source_exchange_start: 1, source_exchange_end: 2
      });
      const receipts = {
        working_docs: [], episodic_id: 43,
        transcript_session_id: base, transcript_parts: [sid], transcript_exchanges: 2,
        handoff_doc: `HANDOFF/${WRITER}.md`, handoff_version: handoff.version,
        handoff_view: {
          as_of: new Date(wall).toISOString(), person: 'owner', inputs: [], board: 'STATE.md@v2',
          open_sessions: [], aging_days: 7, stale_open_hours: 24, registry: [WRITER],
          view_sha256: 'cd'.repeat(32)
        }
      };
      const closed = await go('emet_session_close', { session_id: sid, receipts, session_start: Math.floor((wall - HOUR) / 1000) }, T);
      assert.ok(!closed.isError, text(closed).slice(0, 500));
      assert.strictEqual(dataOf(closed).state, 'complete', JSON.stringify(dataOf(closed).missing));
    }));
  });
});

testGroup('MF-11: the hub handoff is HANDOFF.md only', () => {
  test('HANDOFF/<hub>.md is refused, a close that names it is not complete, and a stored copy does not win by read order', async () => {
    const db = makeStore();
    await withEnv(env({ EMET_RECORD_DOCS: '' }), () => withStore(db, async () => {
      const { writeDoc } = await tools();
      const { loadHandoffView } = await import('../src/per-tag-handoff.js');
      await assert.rejects(
        () => writeDoc(`HANDOFF/${HUB}.md`, handoffText('left open', 'short file'), HUB, null, null, { reason: REASON }),
        (err) => err.emetCode === 'EMET-DOC-084'
      );
      await writeDoc('STATE.md', await boardWith('do a'), HUB, null, null, { provision: true, reason: REASON });
      await writeDoc('HANDOFF.md', handoffText('left open', 'hub file'), HUB, null, null, { reason: REASON });
      db.col('documents').docs.push({
        doc_id: `HANDOFF/${HUB}.md`, version: 9, content: handoffText('left open', 'short file'),
        updated_at: new Date(), updated_by: HUB
      });
      const view = await loadHandoffView(db, { asOf: new Date().toISOString(), person: 'owner', tag: HUB });
      assert.match(view.handoff_view_text, /HANDOFF\.md@v/);
      assert.ok(!view.handoff_view_text.includes(`HANDOFF/${HUB}.md`), view.handoff_view_text);
    }));
    const closeDb = makeStore();
    const { dispatchTool } = await import('../src/dispatch.js');
    const { fullStartup } = await import('./graph-session.js');
    const go = (tool, args, now) => withStore(closeDb, () => dispatchTool(tool, args, { dbManager: closeDb, logger: null, now }));
    const dataOf = (r) => JSON.parse(r.content[0].text).data;
    const text = (r) => JSON.stringify(r);
    await withEnv(env({ EMET_RECORD_DOCS: '' }), async () => {
      const T = new Date();
      const opened = await go('emet_session_open', { slug: 'hub-close', load_id: await fullStartup('hub-close'), source: HUB }, T);
      assert.ok(!opened.isError, text(opened).slice(0, 400));
      const { session_id: sid, base } = dataOf(opened);
      const reply = 'no local shell MCP. hello';
      assert.ok(!(await go('emet_transcript_append', { session_id: sid, source: HUB, user_message: 'hi', assistant_message: reply }, T)).isError);
      assert.ok(!(await go('emet_transcript_append', { session_id: sid, source: HUB, user_message: 'wrap up', assistant_message: 'wrapping up' }, T)).isError);
      const wall = Date.now();
      closeDb.col('documents').docs.push(
        { doc_id: 'HANDOFF.md', version: 3, updated_at: new Date(wall - 1000), updated_by: HUB, size: 12, content: 'handoff\n' },
        { doc_id: 'STATE.md', version: 1, updated_at: new Date(wall - 2 * HOUR), updated_by: HUB, size: 8, content: '# Board\nold\n' }
      );
      closeDb.col('emet_episodic').docs.push({
        id: 42, timestamp: (wall - 60000) / 1000, importance: 0.5, metadata: { source: HUB },
        source_session_id: base, source_exchange_start: 1, source_exchange_end: 2
      });
      const receipts = {
        working_docs: [], episodic_id: 42,
        transcript_session_id: base, transcript_parts: [sid], transcript_exchanges: 2,
        handoff_doc: `HANDOFF/${HUB}.md`, handoff_version: 3,
        handoff_view: {
          as_of: new Date(wall).toISOString(), person: 'owner', inputs: [], board: 'STATE.md@v1',
          open_sessions: [], aging_days: 7, stale_open_hours: 24, registry: [HUB],
          view_sha256: 'ab'.repeat(32)
        }
      };
      const closed = await go('emet_session_close', { receipts, session_start: Math.floor((wall - HOUR) / 1000) }, T);
      assert.ok(!closed.isError, text(closed).slice(0, 500));
      const body = dataOf(closed);
      assert.notStrictEqual(body.state, 'complete', JSON.stringify(body.missing));
      assert.match(JSON.stringify(body.missing), /HANDOFF\.md/);
    });
  });
});

testGroup('MF-11 currency and cleanup: the hub currency read is HANDOFF.md, and the hub can retire a stored short id', () => {
  test('per-tag currency cites HANDOFF.md when HANDOFF/<hub>.md is also stored', async () => {
    const db = makeStore();
    await withEnv(env(), () => withStore(db, async () => {
      db.col('documents').docs.push(
        { doc_id: 'HANDOFF.md', version: 2, updated_at: new Date(), updated_by: HUB, content: 'Close verification episodic 11\n', sha256: 'aa' },
        { doc_id: `HANDOFF/${HUB}.md`, version: 4, updated_at: new Date(), updated_by: HUB, content: 'Close verification episodic 99\n', sha256: 'bb' }
      );
      const { loadContinuityCurrency } = await import('../src/continuity-currency.js');
      const result = await loadContinuityCurrency(db);
      const hub = (result.per_tag || []).find((row) => row.tag === HUB);
      assert.ok(hub, JSON.stringify(result.per_tag));
      assert.strictEqual(hub.handoff_doc, 'HANDOFF.md');
      assert.strictEqual(hub.cited_episodic_id, 11);
    }));
  });
  test('the hub retires a stored HANDOFF/<hub>.md, and a write of that id is still refused', async () => {
    const db = makeStore();
    await withEnv(env(), () => withStore(db, async () => {
      const { writeDoc, retireDoc } = await tools();
      db.col('documents').docs.push({
        doc_id: `HANDOFF/${HUB}.md`, version: 1, updated_at: new Date(), updated_by: HUB,
        content: 'Close verification episodic 3\n', sha256: 'cc'
      });
      await assert.rejects(
        () => writeDoc(`HANDOFF/${HUB}.md`, handoffText('left open', 'no'), HUB, null, null, { reason: REASON, supersedes: 1 }),
        (err) => err.emetCode === 'EMET-DOC-084'
      );
      await assert.rejects(
        () => retireDoc(`HANDOFF/${HUB}.md`, REASON, 'notebook'),
        (err) => err.emetCode === 'EMET-DOC-084'
      );
      const retired = await retireDoc(`HANDOFF/${HUB}.md`, REASON, HUB);
      assert.strictEqual(retired.retired, true);
      assert.strictEqual(db.doc(`HANDOFF/${HUB}.md`).retired, true);
    }));
  });
});

testGroup('MF-7: write, patch, and restore log the warn gap', () => {
  test('write_doc, patch_doc, and restore_doc pass the warn-mode gap warning to the logger', async () => {
    const db = makeStore();
    const heard = [];
    const logger = { warn: (line) => heard.push(String(line)) };
    await withEnv(env({ EMET_TAG_HANDOFFS: 'warn', EMET_RESTORE_TAGS: `${HUB},${WRITER},notebook` }), () => withStore(db, async () => {
      const { writeDoc, patchDoc, restoreDoc } = await tools();
      const sid = allowBoard(db);
      await writeDoc('HANDOFF.md', '# Handoff\n\nkept and logged\n', 'notebook', null, logger, { reason: REASON });
      await writeDoc('STATE.md', await boardWith('do a'), HUB, null, null, { provision: true, reason: REASON });
      await patchDoc('STATE.md', 'do a', 'do b', 'notebook', null, logger, { reason: REASON, session_id: sid });
      await writeDoc(`bots/${WRITER}/NOTES.md`, 'a note in the bot folder\n', WRITER, null, null, { reason: REASON });
      await patchDoc(`bots/${WRITER}/NOTES.md`, 'a note', 'a longer note', WRITER, null, null, { reason: REASON });
      await restoreDoc(`bots/${WRITER}/NOTES.md`, 1, 'notebook', logger, REASON);
      assert.ok(heard.some((line) => /hub handoff/i.test(line)), heard.join('\n'));
      assert.ok(heard.some((line) => /B-010/.test(line)), heard.join('\n'));
      assert.ok(heard.some((line) => /folder/i.test(line)), heard.join('\n'));
    }));
  });
});

testGroup('session tag: HTTP uses the credential', () => {
  test('an HTTP caller cannot put another tag on the in-progress line', async () => {
    const db = makeStore();
    const { dispatchTool } = await import('../src/dispatch.js');
    const { fullStartup } = await import('./graph-session.js');
    const { actorStore } = await import('../src/persons.js');
    const { loadHandoffView } = await import('../src/per-tag-handoff.js');
    const memory = {
      ...db,
      async getConnection() { return {}; },
      collectionFor(layer) { return db.collection(`emet_${layer}`); },
      async insertMemory(layer, doc) {
        const col = db.collection(`emet_${layer}`);
        const id = col.docs.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
        col.docs.push({ ...doc, id });
        return id;
      },
      async readMemory(layer, id) {
        return db.collection(`emet_${layer}`).docs.find((row) => row.id === id) || null;
      }
    };
    const go = (tool, args, now) => withStore(db, () => dispatchTool(tool, args, { dbManager: memory, logger: null, now }));
    const dataOf = (r) => JSON.parse(r.content[0].text).data;
    const text = (r) => JSON.stringify(r);
    async function until(pred, label) {
      const deadline = Date.now() + 2000;
      for (;;) {
        if (pred()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((res) => setImmediate(res));
      }
    }
    await withEnv(env(), async () => {
      const now = new Date();
      const opened = await go('emet_session_open', { slug: 'cred-tag', load_id: await fullStartup('cred-tag'), source: WRITER }, now);
      assert.ok(!opened.isError, text(opened).slice(0, 400));
      const { session_id: sid, base } = dataOf(opened);
      await until(() => db.row(base)?.opened === true, 'opened');
      const saved = await go('save_to_layer', {
        layer: 'episodic', content: 'The session recorded what changed and what is next.',
        session_id: sid, metadata: { source: WRITER }
      }, now);
      assert.ok(!saved.isError, text(saved).slice(0, 500));
      await until(() => db.row(base)?.tag === WRITER && db.row(base)?.episodic === true, 'own tag');
      const foreign = await actorStore.run({
        transport: 'http', sourceTag: WRITER, sourceBasis: 'subkey', effectiveTag: WRITER,
        declaredTag: 'notebook', clientId: 'test-client', grantId: 'grant-1', door: 'member',
        authenticated: true, scopes: ['emet.write']
      }, () => go('save_to_layer', {
        layer: 'episodic', content: 'A claimed other tag must not become the session line.',
        session_id: sid, metadata: { source: 'notebook' }
      }, now));
      assert.ok(foreign.isError, text(foreign).slice(0, 400));
      assert.match(text(foreign), /EMET-DOC-088/);
      assert.strictEqual(db.row(base).tag, WRITER);
      const view = await withStore(db, () => loadHandoffView(db, { asOf: now.toISOString(), person: 'owner', tag: WRITER }));
      assert.match(view.handoff_view_text, new RegExp(`in progress by ${WRITER}`));
      assert.ok(!view.handoff_view_text.includes('in progress by notebook'), view.handoff_view_text);
    });
  });
});

testGroup('MF-12: the credential-tag check is off with the flag', () => {
  test('a flag-off HTTP owner-login save with metadata.source=writer succeeds, and the same save is EMET-DOC-088 with the flag on', async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    const { fullStartup } = await import('./graph-session.js');
    const { actorStore } = await import('../src/persons.js');
    const owner = {
      transport: 'http', authenticated: true, scopes: ['emet.write'], door: 'owner',
      sourceTag: 'owner', sourceBasis: 'declared', declaredTag: WRITER, effectiveTag: WRITER,
      clientId: 'owner-login', grantId: 'grant-owner'
    };
    async function save(flag) {
      const db = makeStore();
      const memory = {
        ...db,
        async getConnection() { return {}; },
        collectionFor(layer) { return db.collection(`emet_${layer}`); },
        async insertMemory(layer, doc) {
          const col = db.collection(`emet_${layer}`);
          const id = col.docs.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
          col.docs.push({ ...doc, id });
          return id;
        },
        async readMemory(layer, id) {
          return db.collection(`emet_${layer}`).docs.find((row) => row.id === id) || null;
        }
      };
      const go = (tool, args) => withStore(db, () => dispatchTool(tool, args, { dbManager: memory, logger: null }));
      return withEnv(env({ EMET_TAG_HANDOFFS: flag }), async () => {
        const opened = await go('emet_session_open', { slug: `owner-${flag}`, load_id: await fullStartup(`owner-${flag}`), source: WRITER });
        if (opened.isError) return opened;
        const { session_id: sid } = JSON.parse(opened.content[0].text).data;
        return actorStore.run(owner, () => go('save_to_layer', {
          layer: 'episodic', content: 'The owner login saved this under the declared tag.',
          session_id: sid, metadata: { source: WRITER }
        }));
      });
    }
    const off = await save('off');
    assert.ok(!off.isError, JSON.stringify(off).slice(0, 500));
    const on = await save('enforce');
    assert.ok(on.isError, JSON.stringify(on).slice(0, 400));
    assert.match(JSON.stringify(on), /EMET-DOC-088/);
  });
});

testGroup('MF-13: the credential-tag rule is in the docs', () => {
  test('README, BOTS, the tool descriptions, the changelog, and the spec name EMET-DOC-088 and the flag-off skip', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const bots = fs.readFileSync(path.join(ROOT, 'docs/BOTS.md'), 'utf8');
    const spec = fs.readFileSync(path.join(ROOT, 'docs/ERROR-CODES-SPEC.md'), 'utf8');
    const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const toolsSrc = fs.readFileSync(path.join(ROOT, 'src/tools.js'), 'utf8');
    for (const text of [readme, bots]) {
      assert.match(text, /EMET-DOC-088/);
      assert.match(text, /own sub-key before/);
    }
    assert.match(spec, /EMET-DOC-088[\s\S]*flag off the check does not run/);
    assert.match(log, /EMET-DOC-088` runs only while `EMET_TAG_HANDOFFS` is `warn` or `enforce`/);
    const saveAt = toolsSrc.indexOf('name: "save_to_layer"');
    const save = toolsSrc.slice(saveAt, saveAt + 4500);
    assert.match(save, /EMET-DOC-088/);
    assert.match(save, /flag at warn or enforce/);
    const openAt = toolsSrc.indexOf('name: "emet_session_open"');
    const open = toolsSrc.slice(openAt, openAt + 2800);
    assert.match(open, /EMET-DOC-088/);
    for (const name of ['write_doc', 'patch_doc', 'write_doc_commit']) {
      const at = toolsSrc.indexOf(`name: "${name}"`);
      const next = toolsSrc.indexOf('\n    name: "', at + 10);
      assert.match(toolsSrc.slice(at, next), /EMET-DOC-088/, name);
    }
    const deploy = fs.readFileSync(path.join(ROOT, 'docs/DEPLOY.md'), 'utf8');
    const upgrade = deploy.slice(deploy.indexOf('## Upgrading to 0.3.7'), deploy.indexOf('## Upgrading to 0.3.6'));
    const flagRow = deploy.slice(deploy.indexOf('| `EMET_TAG_HANDOFFS`'), deploy.indexOf('| `EMET_HUB_TAG`'));
    for (const text of [upgrade, flagRow]) {
      assert.match(text, /EMET-DOC-088/);
      assert.match(text, /own sub-key before/);
    }
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    assert.match(example, /EMET-DOC-088/);
    assert.match(example, /own sub-key before/);
  });

  test('README and BOTS say a call that declares no tag is kept', () => {
    const kept = /refused \(`EMET-DOC-088`\)\. A call that declares no tag is kept\./;
    for (const file of ['README.md', 'docs/BOTS.md']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.match(text, kept, file);
    }
  });
});

testGroup('credential tag on write_doc, patch_doc, and write_doc_commit', () => {
  test('sub-key, claimed, and bound-login callers are refused on each write, and stdio keeps the declared tag', async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    const { fullStartup } = await import('./graph-session.js');
    const { actorStore } = await import('../src/persons.js');
    const bases = {
      subkey: {
        actor: { transport: 'http', authenticated: true, scopes: ['emet.write'], sourceBasis: 'subkey', effectiveTag: WRITER, sourceTag: WRITER, declaredTag: 'notebook', clientId: 'c', grantId: 'g', door: 'member' },
        source: 'notebook'
      },
      claimed: {
        actor: { transport: 'http', authenticated: true, scopes: ['emet.write'], sourceBasis: 'declared', declaredTag: WRITER, effectiveTag: WRITER, sourceTag: 'owner', clientId: 'c', grantId: 'g', door: 'owner' },
        source: WRITER
      },
      bound: {
        actor: { transport: 'http', authenticated: true, scopes: ['emet.write'], sourceTag: WRITER, clientId: 'bound-client', grantId: 'g', door: 'member', personId: 'owner' },
        source: 'notebook',
        preflight: true
      }
    };
    const calls = {
      write_doc: (source) => ({ doc_id: 'notes/plain.md', content: 'a note for the session\n', source, session_id: 'sess-write' }),
      patch_doc: (source) => ({ doc_id: 'notes/plain.md', old_str: 'a note', new_str: 'the note', reason: REASON, source, session_id: 'sess-write' }),
      write_doc_commit: (source) => ({ doc_id: 'notes/plain.md', sha256: 'ab', source, session_id: 'sess-write' })
    };
    const db = makeStore();
    const go = (tool, args) => withStore(db, () => dispatchTool(tool, args, { dbManager: db, logger: null }));
    const { preflight } = await import('../src/attribution.js');
    await withEnv(env(), async () => {
      for (const [tool, build] of Object.entries(calls)) {
        for (const [name, row] of Object.entries(bases)) {
          const actor = { ...row.actor };
          const args = build(row.source);
          if (row.preflight) {
            await preflight({ db, registry: [HUB, WRITER, FIELD, 'notebook'] }, actor, args, tool);
            assert.strictEqual(actor.sourceBasis, 'declared', `${tool} ${name} did not go through login preflight`);
          }
          const result = await actorStore.run(actor, () => go(tool, args));
          assert.ok(result.isError, `${tool} ${name} was kept`);
          assert.match(JSON.stringify(result), /EMET-DOC-088/, `${tool} ${name}`);
        }
      }
      const opened = await go('emet_session_open', { slug: 'stdio-tag', load_id: await fullStartup('stdio-tag'), source: WRITER });
      assert.ok(!opened.isError, JSON.stringify(opened).slice(0, 400));
      const { session_id: sid, base } = JSON.parse(opened.content[0].text).data;
      const wrote = await go('write_doc', { doc_id: 'notes/stdio.md', content: 'stdio keeps the declared tag\n', source: WRITER, session_id: sid });
      assert.ok(!wrote.isError, JSON.stringify(wrote).slice(0, 500));
      assert.strictEqual(db.row(base).tag, WRITER);
    });
  });
});

function memoryDb(db) {
  return {
    ...db,
    async getConnection() { return {}; },
    collectionFor(layer) { return db.collection(`emet_${layer}`); },
    async insertMemory(layer, doc) {
      const col = db.collection(`emet_${layer}`);
      const id = col.docs.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
      col.docs.push({ ...doc, id });
      return id;
    },
    async readMemory(layer, id) {
      return db.collection(`emet_${layer}`).docs.find((row) => row.id === id) || null;
    }
  };
}

testGroup('MF-14: a claimed caller that declares no tag is kept', () => {
  test('an auto-tag claimed semantic save with no session is not EMET-DOC-088 with the flag on', async () => {
    const db = makeStore();
    const { dispatchTool } = await import('../src/dispatch.js');
    const { fullStartup } = await import('./graph-session.js');
    const { actorStore } = await import('../src/persons.js');
    const auto = {
      transport: 'http', authenticated: true, scopes: ['emet.write'], door: 'member',
      sourceBasis: 'auto', clientId: 'auto-client', grantId: 'grant-auto'
    };
    const memory = memoryDb(db);
    const go = (tool, args) => withStore(db, () => dispatchTool(tool, args, { dbManager: memory, logger: null }));
    await withEnv(env(), async () => {
      const outside = await actorStore.run(auto, () => go('save_to_layer', {
        layer: 'semantic',
        content: 'A fact consolidated with no session and no declared tag.',
        metadata: { derived_from: { entries: [1] } }
      }));
      const outsideText = JSON.stringify(outside);
      assert.doesNotMatch(outsideText, /EMET-DOC-088/);
      assert.match(outsideText, /names no session/);
      const opened = await actorStore.run(auto, async () => go('emet_session_open', {
        slug: 'auto-semantic', load_id: await fullStartup('auto-semantic')
      }));
      assert.ok(!opened.isError, outsideText.slice(0, 400));
      const { session_id: sid } = JSON.parse(opened.content[0].text).data;
      const saved = await actorStore.run(auto, () => go('save_to_layer', {
        layer: 'semantic',
        content: 'A fact saved by a claimed caller that declared no tag.',
        session_id: sid
      }));
      assert.ok(!saved.isError, JSON.stringify(saved).slice(0, 500));
      assert.ok(db.collection('emet_semantic').docs.some((row) => /declared no tag/.test(row.content)));
    });
  });
});

testGroup('session tag is stored only while the flag is on', () => {
  test('a flag-off HTTP open is kept and the session row stores no tag', async () => {
    const db = makeStore();
    const { dispatchTool } = await import('../src/dispatch.js');
    const { fullStartup } = await import('./graph-session.js');
    const { actorStore } = await import('../src/persons.js');
    const owner = {
      transport: 'http', authenticated: true, scopes: ['emet.write'], door: 'owner',
      sourceTag: 'owner', sourceBasis: 'declared', declaredTag: WRITER, effectiveTag: WRITER,
      clientId: 'owner-login', grantId: 'grant-owner'
    };
    const go = (tool, args) => withStore(db, () => dispatchTool(tool, args, { dbManager: db, logger: null }));
    await withEnv(env({ EMET_TAG_HANDOFFS: 'off' }), async () => {
      const opened = await actorStore.run(owner, async () => go('emet_session_open', {
        slug: 'flag-off-open', load_id: await fullStartup('flag-off-open'), source: WRITER
      }));
      assert.ok(!opened.isError, JSON.stringify(opened).slice(0, 400));
      const { base } = JSON.parse(opened.content[0].text).data;
      const deadline = Date.now() + 2000;
      for (;;) {
        if (db.row(base)?.opened === true) break;
        if (Date.now() > deadline) throw new Error('timed out waiting for the flag-off open');
        await new Promise((res) => setImmediate(res));
      }
      assert.ok(db.row(base).tag == null);
    });
  });

  test('a matching tag is kept, and a claimed caller that declares nothing opens and saves', async () => {
    const db = makeStore();
    const { dispatchTool } = await import('../src/dispatch.js');
    const { fullStartup } = await import('./graph-session.js');
    const { actorStore } = await import('../src/persons.js');
    const { preflight } = await import('../src/attribution.js');
    const memory = memoryDb(db);
    const go = (tool, args) => withStore(db, () => dispatchTool(tool, args, { dbManager: memory, logger: null }));
    const subkey = {
      transport: 'http', authenticated: true, scopes: ['emet.write'], sourceBasis: 'subkey',
      effectiveTag: WRITER, sourceTag: WRITER, clientId: 'c', grantId: 'g', door: 'member'
    };
    const auto = {
      transport: 'http', authenticated: true, scopes: ['emet.write'], door: 'member',
      sourceBasis: 'auto', clientId: 'auto-client', grantId: 'grant-auto'
    };
    const bound = {
      transport: 'http', authenticated: true, scopes: ['emet.write'], sourceTag: WRITER,
      clientId: 'bound-client', grantId: 'g', door: 'member', personId: 'owner'
    };
    await withEnv(env(), async () => {
      const opened = await go('emet_session_open', { slug: 'match-tag', load_id: await fullStartup('match-tag'), source: WRITER });
      assert.ok(!opened.isError, JSON.stringify(opened).slice(0, 400));
      const { session_id: sid, base } = JSON.parse(opened.content[0].text).data;
      const matched = await actorStore.run(subkey, () => go('write_doc', {
        doc_id: 'notes/match.md', content: 'the credential tag matches\n', source: WRITER, session_id: sid
      }));
      assert.ok(!matched.isError, JSON.stringify(matched).slice(0, 500));
      const bare = { doc_id: 'notes/bare.md', content: 'no declared tag\n', session_id: sid };
      await preflight({ db, registry: [HUB, WRITER, FIELD, 'notebook'] }, bound, bare, 'write_doc');
      assert.strictEqual(bound.sourceBasis, 'login');
      const boundWrite = await actorStore.run(bound, () => go('write_doc', bare));
      assert.ok(!boundWrite.isError, JSON.stringify(boundWrite).slice(0, 500));
      assert.doesNotMatch(JSON.stringify(boundWrite), /EMET-DOC-088/);
      const autoOpen = await actorStore.run(auto, async () => go('emet_session_open', {
        slug: 'auto-open', load_id: await fullStartup('auto-open')
      }));
      assert.ok(!autoOpen.isError, JSON.stringify(autoOpen).slice(0, 400));
      const autoSid = JSON.parse(autoOpen.content[0].text).data.session_id;
      const autoSave = await actorStore.run(auto, () => go('save_to_layer', {
        layer: 'episodic', content: 'The claimed caller declared no tag.', session_id: autoSid
      }));
      assert.ok(!autoSave.isError, JSON.stringify(autoSave).slice(0, 500));
      assert.ok(db.row(base).tag === WRITER);
    });
  });
});

summary();
