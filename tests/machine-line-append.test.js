/**
 * EMET-MEM-018. The first successful transcript append must carry the machine
 * line. Observed 2026-11-03: exchange 1 was refused, then exchange 2 was
 * stored, because the door ran only when the index was 1.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { makeStore, withStore } from './memstore.js';
import { machineLineRequired } from '../src/lessons-to-checks.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
delete process.env.EMET_INSTALL_DOC;
delete process.env.EMET_SOURCE_TAGS;
delete process.env.EMET_SOURCE_TAG;

console.log('\n=== machine line on the first successful append ===');

const INSTALL = `# Install

| Name | Model |
|---|---|
| STUDIO | desk |
`;
const LINE = 'STUDIO 2026-11-03 15:09';
const BARE = 'Truth stands. Memory connected.';

function seedInstall(store) {
  store.collection('documents').docs.push({
    doc_id: 'bootstrap/INSTALL.md',
    content: INSTALL,
    retired: false
  });
}

function transcriptCount(store, sessionId) {
  return store.collection('transcripts').docs.filter((d) => d.session_id === sessionId).length;
}

async function append(store, args) {
  const { transcriptAppend } = await import('../src/tools.js');
  return withStore(store, () => transcriptAppend({
    channel: 'example-host',
    user_message: 'hello',
    ...args
  }));
}

async function refused(store, args) {
  try {
    await append(store, args);
    assert.fail('the append was stored');
  } catch (e) {
    assert.strictEqual(e.emetCode, 'EMET-MEM-018', e && e.message);
    assert.match(e.message, /no local shell MCP/);
  }
}

testGroup('the pure rule', () => {
  test('an empty session requires the line at any index', () => {
    assert.strictEqual(machineLineRequired([], 1), true);
    assert.strictEqual(machineLineRequired([], 2), true);
  });
  test('a lower index than every stored one still requires the line', () => {
    assert.strictEqual(machineLineRequired([2], 1), true);
  });
  test('a later index does not require the line once a lower one is stored', () => {
    assert.strictEqual(machineLineRequired([1], 2), false);
    assert.strictEqual(machineLineRequired([1, 2, 3, 4, 5, 6, 7, 8], 9), false);
  });
});

testGroup('the append door', () => {
  test('refusing exchange 1 does not let exchange 2 open the transcript', async () => {
    const store = makeStore();
    seedInstall(store);
    const sid = '2026-11-03_sec-ladder-adherence_verbatim_part1';
    await refused(store, { session_id: sid, exchange_index: 1, assistant_message: BARE });
    assert.strictEqual(transcriptCount(store, sid), 0);
    await refused(store, { session_id: sid, exchange_index: 2, assistant_message: BARE });
    assert.strictEqual(transcriptCount(store, sid), 0);
    const opened = await append(store, { session_id: sid, exchange_index: 1, assistant_message: `no local shell MCP. ${BARE}` });
    assert.strictEqual(opened.exchange_index, 1);
    assert.strictEqual(opened.machine_line, 'checked: no local shell MCP');
    const next = await append(store, { session_id: sid, exchange_index: 2, assistant_message: BARE });
    assert.strictEqual(next.exchange_index, 2);
    assert.strictEqual(next.machine_line, undefined);
  });

  test('exchange 2 with the line can open, and a later exchange 1 must carry the line too', async () => {
    const store = makeStore();
    seedInstall(store);
    const sid = '2026-11-03_open-at-two_verbatim_part1';
    await refused(store, { session_id: sid, exchange_index: 2, assistant_message: BARE });
    const opened = await append(store, { session_id: sid, exchange_index: 2, assistant_message: LINE });
    assert.strictEqual(opened.exchange_index, 2);
    assert.strictEqual(opened.machine_line, 'checked: STUDIO');
    await refused(store, { session_id: sid, exchange_index: 1, assistant_message: BARE });
    const first = await append(store, { session_id: sid, exchange_index: 1, assistant_message: LINE });
    assert.strictEqual(first.exchange_index, 1);
    const third = await append(store, { session_id: sid, exchange_index: 3, assistant_message: BARE });
    assert.strictEqual(third.exchange_index, 3);
  });

  test('a rolled part does not ask for the line again, and an empty later part cannot skip it', async () => {
    const store = makeStore();
    seedInstall(store);
    const base = '2026-11-03_roll';
    const part1 = `${base}_verbatim_part1`;
    store.collection('transcripts').docs.push({
      session_id: part1,
      exchange_count: 8,
      exchanges: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
        exchange_index: n,
        user_message: 'u',
        assistant_message: n === 1 ? LINE : 'later',
        timestamp: 1
      }))
    });
    const ninth = await append(store, {
      session_id: `${base}_verbatim_part2`,
      exchange_index: 9,
      assistant_message: BARE
    });
    assert.strictEqual(ninth.exchange_index, 9);
    assert.strictEqual(ninth.machine_line, undefined);

    const bare = makeStore();
    seedInstall(bare);
    const jumped = '2026-11-03_jump_verbatim_part2';
    await refused(bare, { session_id: jumped, exchange_index: 9, assistant_message: BARE });
    assert.strictEqual(transcriptCount(bare, jumped), 0);
  });

  test('with no machine table the check is not enforced, including at index 2', async () => {
    const store = makeStore();
    const sid = '2026-11-03_no-table_verbatim_part1';
    const opened = await append(store, { session_id: sid, exchange_index: 2, assistant_message: BARE });
    assert.strictEqual(opened.exchange_index, 2);
    assert.match(opened.machine_line, /not enforced/);
  });
});

summary();
