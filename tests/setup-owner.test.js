/**
 * Stage 1 of the host-aware startup amendment (2026-10-02; admitted by
 * the reviewer's design review, conditions S1-S2; the owner's decisions 1 and 2 as
 * relayed 2026-10-01, the owner's decision record, and answer 5).
 *
 *   S2a  a new store: initialize says setup_required and writes nothing;
 *        setupComplete writes the three documents AND the owner person;
 *        initialize is then ready, as that person
 *   S2b  initialize writes nothing on a store that has an owner (and nothing
 *        on a set-up store without one: the owner write moved out)
 *   R    setupComplete on a set-up store is refused unless reissue: true;
 *        nothing is written when refused; a reissue keeps the one owner
 *   B    setupComplete under a configured bot tag is refused (S1: inert until a
 *        caller declares a bot tag the owner has configured); nothing is written
 *   D1   retire_doc and rename_doc are refused under any bot tag for any doc_id,
 *        and stay allowed for a host tag
 * Everything runs against an in-memory store through the real code (initialize,
 * setupComplete, dispatchTool); no database, no live server.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { makeStore, withStore, withEnv } from './memstore.js';
import { seedOpenSession, inSession } from './graph-session.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const k of ['EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_TEMPLATE_MAP', 'EMET_GAP_BASELINE', 'EMET_RECORD_DOCS', 'CASCADE_RECORD_DOCS'])
  delete process.env[k];
const BOT = 'example-bot';
const HOST = 'example-host';

console.log('\n=== setup-owner (stage 1 of the host-aware startup amendment) ===');

const { initialize, setupComplete } = await import('../src/setup.js');
const { dispatchTool } = await import('../src/dispatch.js');
// The session graph runs in enforce only. Its state and lab rows live in a
// store of their own with one seeded open session, so the store under test
// sees only the tool's writes and the guard under test is what answers.
const graphStore = makeStore();
const GRAPH_SID = seedOpenSession((n) => graphStore.collection(n), undefined, { transcript: false });
const GRAPH_DB = { async ensureClient() { return new graphStore.Client().db(); }, async transcriptPosition() { return { highest: 1 }; } };
const CTX = { dbManager: GRAPH_DB, logger: null };
const go = (s, tool, args) => withStore(s, () => dispatchTool(tool, inSession(tool, (tool === 'patch_doc' || tool === 'write_doc' || tool === 'rename_doc' || tool === 'retire_doc') && !args.reason ? { ...args, reason: 'fixture reason for the edit' } : args, GRAPH_SID), CTX));
const ANSWERS = { assistant_name: 'Ada', assistant_character: 'Plain and careful.', user_name: 'Sam Example', user_context: 'Testing a new store.' };
const persons = (s) => (s.cols.get('persons') ? s.cols.get('persons').docs : []);
const docOf = (s, id) => (s.cols.get('documents') ? s.cols.get('documents').docs.find((d) => d.doc_id === id) : null);
async function setUpStore() {
  const s = makeStore();
  await withStore(s, () => setupComplete({ ...ANSWERS, source_tag: HOST }));
  return s;
}

testGroup('S2a: a new store gets its owner from setupComplete, not from initialize', () => {
  test('new store -> initialize (setup_required, no writes) -> setupComplete (docs + owner) -> initialize ready as that person', async () => {
    const s = makeStore();
    const first = await withStore(s, () => initialize({}));
    assert.strictEqual(first.state, 'setup_required');
    assert.deepStrictEqual(s.writes, [], 'initialize on a new store wrote: ' + s.writes.join(', '));
    const done = await withStore(s, () => setupComplete({ ...ANSWERS, source_tag: HOST }));
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.person_id, 'sam-example');
    assert.strictEqual(done.person_role, 'owner');
    assert.strictEqual(persons(s).length, 1);
    assert.strictEqual(persons(s)[0].role, 'owner');
    assert.ok(docOf(s, 'bootstrap/IDENTITY.md') && docOf(s, 'bootstrap/USER.md'));
    const before = s.writes.length;
    const ready = await withStore(s, () => initialize({}));
    assert.strictEqual(ready.state, 'ready', JSON.stringify(ready).slice(0, 300));
    assert.strictEqual(ready.person_id, 'sam-example');
    assert.deepStrictEqual(s.writes.slice(before), [], 'initialize (ready) wrote: ' + s.writes.slice(before).join(', '));
  });
});

testGroup('S2b: initialize writes nothing once an owner exists', () => {
  test('a set-up store with an owner: three initialize calls write nothing and the owner row is unchanged', async () => {
    const s = await setUpStore();
    const owner = JSON.stringify(persons(s));
    const before = s.writes.length;
    for (let i = 0; i < 3; i++) assert.strictEqual((await withStore(s, () => initialize({}))).state, 'ready');
    assert.deepStrictEqual(s.writes.slice(before), []);
    assert.strictEqual(JSON.stringify(persons(s)), owner);
  });
  test('a set-up store with NO owner row (older stores): initialize still writes nothing and resolves to "owner"', async () => {
    const s = await setUpStore();
    s.cols.get('persons').docs.length = 0;
    const before = s.writes.length;
    const r = await withStore(s, () => initialize({}));
    assert.strictEqual(r.state, 'ready');
    assert.strictEqual(r.person_id, 'owner');
    assert.deepStrictEqual(s.writes.slice(before), [], 'the owner write moved out of initialize');
    assert.strictEqual(persons(s).length, 0);
  });
});

testGroup('R: re-running setup needs reissue: true (answer 5)', () => {
  test('without reissue: refused, nothing written, documents and owner unchanged', async () => {
    const s = await setUpStore();
    const before = s.writes.length; const v = docOf(s, 'bootstrap/USER.md').version;
    await assert.rejects(() => withStore(s, () => setupComplete({ ...ANSWERS, user_name: 'Someone Else' })),
      (e) => e.field === 'reissue' && /already set up/.test(e.message) && /Nothing was written/.test(e.message));
    assert.deepStrictEqual(s.writes.slice(before), []);
    assert.strictEqual(docOf(s, 'bootstrap/USER.md').version, v);
  });
  test('reissue: false, or reissue inside answers, is not the explicit word', async () => {
    const s = await setUpStore();
    await assert.rejects(() => withStore(s, () => setupComplete({ ...ANSWERS }, null, { reissue: false })), (e) => e.field === 'reissue');
    await assert.rejects(() => withStore(s, () => setupComplete({ ...ANSWERS, reissue: true })), (e) => e.field === 'reissue');
  });
  test('with reissue: true: new document versions, still exactly one owner (the first)', async () => {
    const s = await setUpStore();
    const v = docOf(s, 'bootstrap/USER.md').version;
    const r = await withStore(s, () => setupComplete({ ...ANSWERS, user_name: 'Sam Example', user_context: 'Updated.' }, null, { reissue: true }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(docOf(s, 'bootstrap/USER.md').version, v + 1);
    assert.strictEqual(persons(s).length, 1);
    assert.strictEqual(persons(s)[0].person_id, 'sam-example');
  });
  test('through dispatchTool: reissue and source reach setupComplete', async () => {
    const s = await setUpStore();
    const refused = await go(s, 'emet_setup_complete', { answers: { ...ANSWERS } });
    assert.ok(refused.isError && /already set up/.test(refused.content[0].text), refused.content[0].text.slice(0, 200));
    const ok = await go(s, 'emet_setup_complete', { answers: { ...ANSWERS }, reissue: true });
    assert.ok(!ok.isError, ok.content[0].text.slice(0, 300));
  });
  test('through dispatchTool: only a top-level boolean true reissues ("true", 1, answers.reissue are refused; nothing written)', async () => {
    const s = await setUpStore();
    const before = s.writes.length;
    for (const args of [
      { answers: { ...ANSWERS }, reissue: 'true' },
      { answers: { ...ANSWERS }, reissue: 1 },
      { answers: { ...ANSWERS, reissue: true } },
      { answers: { ...ANSWERS }, reissue: false }
    ]) {
      const r = await go(s, 'emet_setup_complete', args);
      assert.ok(r.isError && /already set up/.test(r.content[0].text), JSON.stringify(args).slice(0, 80) + ' -> ' + r.content[0].text.slice(0, 200));
    }
    assert.strictEqual(s.writes.length, before);
  });
  test('S-c: the guard needs BOTH identity documents - a half-set-up store (only IDENTITY, or only USER) completes setup without reissue', async () => {
    for (const keep of ['bootstrap/IDENTITY.md', 'bootstrap/USER.md']) {
      const s = await setUpStore();
      const docs = s.collection('documents').docs;
      for (let i = docs.length - 1; i >= 0; i--) {
        if ((docs[i].doc_id === 'bootstrap/IDENTITY.md' || docs[i].doc_id === 'bootstrap/USER.md') && docs[i].doc_id !== keep) docs.splice(i, 1);
      }
      const r = await withStore(s, () => setupComplete({ ...ANSWERS, source_tag: HOST }));
      assert.strictEqual(r.ok, true, keep);
      // Now both exist again: the guard holds.
      await assert.rejects(() => withStore(s, () => setupComplete({ ...ANSWERS, source_tag: HOST })), (e) => e.field === 'reissue', keep);
    }
  });
});

testGroup('B: setup under a configured bot tag is refused (S1: inert until a bot tag is declared and configured)', () => {
  test('source or answers.source_tag naming a configured bot tag: refused before any write, even on a new store', () => withEnv({ EMET_RECORD_DOCS: `bots/${BOT}/HANDOFF.md` }, async () => {
    for (const call of [(s) => setupComplete({ ...ANSWERS }, null, { source: BOT }), (s) => setupComplete({ ...ANSWERS, source_tag: BOT })]) {
      const s = makeStore();
      await assert.rejects(() => withStore(s, () => call(s)), (e) => ['source', 'answers.source_tag'].includes(e.field) && /owner's/.test(e.message) && /Nothing was written/.test(e.message));
      assert.deepStrictEqual(s.writes, []);
    }
  }));
  test('S1-1: each value is checked - a host source with a bot answers.source_tag (and the reverse) is refused; nothing written', () => withEnv({ EMET_RECORD_DOCS: `bots/${BOT}/HANDOFF.md` }, async () => {
    for (const [answers, options, field] of [
      [{ ...ANSWERS, source_tag: BOT }, { source: 'project-host' }, 'answers.source_tag'],
      [{ ...ANSWERS, source_tag: 'project-host' }, { source: BOT }, 'source']
    ]) {
      const s = makeStore();
      await assert.rejects(() => withStore(s, () => setupComplete(answers, null, options)),
        (e) => e.field === field && new RegExp(`${BOT} is a bot tag`).test(e.message) && /Nothing was written/.test(e.message));
      assert.deepStrictEqual(s.writes, []);
    }
  }));
  test('S1-1: the tag that would be written is checked too - a bot EMET_SOURCE_TAG with nothing declared is refused', () => withEnv({ EMET_RECORD_DOCS: `bots/${BOT}/HANDOFF.md`, EMET_SOURCE_TAG: BOT }, async () => {
    const s = makeStore();
    await assert.rejects(() => withStore(s, () => setupComplete({ ...ANSWERS }, null, {})), (e) => /is a bot tag/.test(e.message));
    assert.deepStrictEqual(s.writes, []);
  }));
  test('S1-1: dispatch passes sourceOf(args), so the legacy alias updated_by naming a bot tag is refused too', () => withEnv({ EMET_RECORD_DOCS: `bots/${BOT}/HANDOFF.md` }, async () => {
    const s = makeStore();
    const r = await go(s, 'emet_setup_complete', { answers: { ...ANSWERS }, updated_by: BOT });
    assert.ok(r.isError && /is a bot tag/.test(r.content[0].text), r.content[0].text.slice(0, 200));
    assert.deepStrictEqual(s.writes, []);
  }));
  test('the same tag before the owner configures it is not a bot tag: setup proceeds (the gating is inert until stage 3)', async () => {
    const s = makeStore();
    const r = await withStore(s, () => setupComplete({ ...ANSWERS }, null, { source: BOT }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source_tag, BOT);
  });
});

testGroup('D1: retire_doc and rename_doc are refused under any bot tag (decision 1)', () => {
  const env = { EMET_RECORD_DOCS: `bots/${BOT}/HANDOFF.md` };
  test('a bot tag cannot retire or rename an ordinary document, or its own folder; nothing changes', () => withEnv(env, async () => {
    const s = await setUpStore();
    await go(s, 'write_doc', { doc_id: 'threads/x.md', content: '# X\nx\n', source: HOST });
    await go(s, 'write_doc', { doc_id: `bots/${BOT}/notes.md`, content: '# N\nn\n', source: BOT });
    const before = s.writes.length;
    for (const [tool, args] of [
      ['retire_doc', { doc_id: 'threads/x.md', reason: 'test', source: BOT }],
      ['retire_doc', { doc_id: `bots/${BOT}/notes.md`, reason: 'test', source: BOT }],
      ['rename_doc', { old_id: 'threads/x.md', new_id: 'threads/y.md', source: BOT }],
      ['rename_doc', { old_id: `bots/${BOT}/notes.md`, new_id: `bots/${BOT}/notes2.md`, source: BOT }]
    ]) {
      const r = await go(s, tool, args);
      assert.ok(r.isError && /is not a bot tool/.test(r.content[0].text) && /Nothing was changed/.test(r.content[0].text), `${tool}: ${r.content[0].text.slice(0, 300)}`);
    }
    assert.deepStrictEqual(s.writes.slice(before), []);
    assert.ok(!docOf(s, 'threads/x.md').retired && !docOf(s, 'threads/y.md'));
  }));
  test('a host tag still retires and renames', () => withEnv(env, async () => {
    const s = await setUpStore();
    await go(s, 'write_doc', { doc_id: 'threads/x.md', content: '# X\nx\n', source: HOST });
    const r1 = await go(s, 'rename_doc', { old_id: 'threads/x.md', new_id: 'threads/y.md', source: HOST });
    assert.ok(!r1.isError, r1.content[0].text.slice(0, 300));
    const r2 = await go(s, 'retire_doc', { doc_id: 'threads/y.md', reason: 'handled in the thread', source: HOST });
    assert.ok(r2.isError && /not a drop/.test(r2.content[0].text), r2.content[0].text.slice(0, 300));
  }));
  test('with no bot tags configured, nothing changes for any tag', async () => {
    const { refuseBotRetireRename } = await import('../src/tools.js');
    assert.doesNotThrow(() => refuseBotRetireRename(BOT, 'retire_doc'));
    withEnv(env, () => assert.throws(() => refuseBotRetireRename(BOT, 'retire_doc'), /retire_doc is not a bot tool/));
    withEnv({ ...env, EMET_SOURCE_TAG: BOT }, () => assert.throws(() => refuseBotRetireRename(null, 'rename_doc'), /rename_doc is not a bot tool/));
    // Citations: The first decision record covers retire only; rename stays owner-only under a later one.
    withEnv(env, () => assert.throws(() => refuseBotRetireRename(BOT, 'retire_doc'), (e) => /the owner's decision record item 1/.test(e.message) && !/#\d{3}/.test(e.message)));
    withEnv(env, () => assert.throws(() => refuseBotRetireRename(BOT, 'rename_doc'), (e) => /owner-only \(the owner's decision record\)/.test(e.message) && !/#\d{3}/.test(e.message)));
  });
});

summary('SETUP OWNER (STAGE 1) TEST SUMMARY');
