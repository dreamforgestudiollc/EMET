/**
 * EMET - records are superseded, never amended (2026-09-26).
 *
 * The owner: "enforce supersession ISO practices". The handoff is a record (ISO 9001
 * 7.5.3 / 13485 4.2.5): patch_doc is refused on it (append_doc was retired 2026-09-27), and a new
 * revision must be written whole naming the revision it supersedes. The
 * refusals happen before any database call, so they are testable without one.
 */

import { test, summary } from './harness.js';
import assert from 'assert';
import { isRecordDoc, recordDocIds, patchDoc } from '../src/tools.js';
import { CLOSE_PROTOCOL } from '../src/session.js';


async function run() {
  console.log('\n=== which documents are records ===');
  await test('the handoff is a record', () => assert.strictEqual(isRecordDoc('HANDOFF.md'), true));
  await test('the board is a controlled document, not a record', () => assert.strictEqual(isRecordDoc('STATE.md'), false));
  await test('thread documents are not records', () => assert.strictEqual(isRecordDoc('threads/emet-publication.md'), false));
  await test('recordDocIds leads with the handoff', () => assert.strictEqual(recordDocIds()[0], 'HANDOFF.md'));

  console.log('\n=== a record is not amended in place ===');
  await test('patch_doc on the handoff is refused and says nothing changed', async () => {
    await assert.rejects(() => patchDoc('HANDOFF.md', 'a', 'b'),
      (e) => /is a record/.test(e.message) && /superseded, not amended/.test(e.message) && /Nothing was changed/.test(e.message));
  });
  await test('the refusal names the way forward: write_doc with supersedes', async () => {
    await assert.rejects(() => patchDoc('HANDOFF.md', 'a', 'b'), (e) => /write_doc/.test(e.message) && /supersedes/.test(e.message));
  });

  console.log('\n=== the served close protocol says so ===');
  await test('handoff step names write_doc with supersedes and forbids patching', () => {
    const step = CLOSE_PROTOCOL.find((s) => s.step === 5);
    assert.ok(/supersedes/.test(step.what) && /never patched or appended/.test(step.what));
  });

  await summary('Record Supersession Test Summary');
}
run();
