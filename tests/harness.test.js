/**
 * EMET - the shared test harness is itself under test (2026-09-29).
 *
 * A harness that cannot fail converts every defect into a green run. Each case
 * below writes a tiny suite to a temp file, runs it in a child process, and
 * checks the exit code and the PASS/FAIL lines - so failure reporting, async
 * ordering and the no-overlap rule are proven, not assumed.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const HARNESS = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'harness.js')).href;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-harness-'));
let n = 0;
function runSuite(body) {
  const file = path.join(DIR, `s${++n}.mjs`);
  fs.writeFileSync(file, `import { test, testGroup, summary } from '${HARNESS}';\n${body}\n`);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
const lines = (out, kind) => out.split('\n').filter((l) => l.startsWith(`  ${kind}: `)).map((l) => l.slice(kind.length + 4).trim());

testGroup('failures are reported and fail the run', () => {
  test('a throwing sync test exits 1 and is named FAIL', () => {
    const r = runSuite(`test('ok', () => {}); test('bad', () => { throw new Error('boom'); }); summary('x');`);
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual(lines(r.out, 'PASS'), ['ok']);
    assert.deepStrictEqual(lines(r.out, 'FAIL'), ['bad']);
    assert.ok(/boom/.test(r.out));
  });
  test('a rejecting async test exits 1', () => {
    const r = runSuite(`test('late', async () => { await new Promise((s) => setTimeout(s, 20)); throw new Error('late boom'); }); summary('x');`);
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual(lines(r.out, 'FAIL'), ['late']);
  });
  test('a thrown non-Error value still fails, with its text', () => {
    const r = runSuite(`test('str', () => { throw 'plain string'; }); summary('x');`);
    assert.strictEqual(r.code, 1);
    assert.ok(/plain string/.test(r.out));
  });
  test('an all-passing suite exits 0 and counts every test', () => {
    const r = runSuite(`test('a', () => {}); test('b', async () => {}); test('c', () => {}); summary('x');`);
    assert.strictEqual(r.code, 0);
    assert.ok(/Passed: 3/.test(r.out) && /Failed: 0/.test(r.out));
  });
});

testGroup('async tests run one at a time, in declaration order', () => {
  test('a later test waits for an earlier async one (no overlap)', () => {
    const r = runSuite(`
      let busy = false; const order = [];
      const slow = (name) => async () => { if (busy) throw new Error('overlap'); busy = true; await new Promise((s) => setTimeout(s, 15)); order.push(name); busy = false; };
      test('one', slow('one')); test('two', slow('two')); test('three', () => { order.push('three'); });
      test('order', () => { if (order.join() !== 'one,two,three') throw new Error(order.join()); });
      summary('x');`);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(lines(r.out, 'PASS'), ['one', 'two', 'three', 'order']);
  });
  test('a sync test before any async one runs at declaration, reading current values', () => {
    const r = runSuite(`let v = 1; test('reads 1', () => { if (v !== 1) throw new Error(String(v)); }); v = 2; summary('x');`);
    assert.strictEqual(r.code, 0, r.out);
  });
  test('await test(...) resolves after the test has finished', () => {
    const r = runSuite(`let done = false; await test('a', async () => { await new Promise((s) => setTimeout(s, 10)); done = true; }); if (!done) process.exit(3); summary('x');`);
    assert.strictEqual(r.code, 0, r.out);
  });
  test('group headings keep their place behind a busy chain', () => {
    const r = runSuite(`test('a', async () => { await new Promise((s) => setTimeout(s, 10)); }); testGroup('G', () => { test('b', () => {}); }); summary('x');`);
    const iA = r.out.indexOf('PASS: a'), iG = r.out.indexOf('=== G ==='), iB = r.out.indexOf('PASS: b');
    assert.ok(iA < iG && iG < iB, r.out);
  });
});

try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* temporary */ }
summary('Harness Test Summary');
