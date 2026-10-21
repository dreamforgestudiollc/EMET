/**
 * The operational error log: allow-list, redaction, rotation, and a failed write.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert';
import fs from 'node:fs';
import { ValidationError } from '../src/validation.js';
import { handleError } from '../src/tools.js';
import { actorStore } from '../src/persons.js';
import {
  useMemoryErrorLog, setErrorLogBackend, recordError, flushErrorLog, rotateErrorLog, insertErrorLog,
  ERROR_LOG_MAX, ERROR_LOG_DAYS
} from '../src/error-log.js';

const ENTRY_KEYS = ['_id', 't', 'emet_code', 'class_code', 'tool', 'version', 'transport', 'caller', 'role', 'correlation_id', 'count'];
const store = useMemoryErrorLog();

function silence(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.error = orig; })
    .then((value) => ({ value, lines }));
}

testGroup('error log', () => {
  test('a forced error stores no sentinel, no message, and only the allow-list', async () => {
    store.entries.length = 0;
    const err = new ValidationError('query', 'SENTINEL_CONTENT emet_tok_abcdefghijklmnopqrstuvwxyz ada@example.com Ada Lovelace Finances');
    err.emetCode = 'EMET-VAL-005';
    err.extra = 'SENTINEL_CONTENT';
    await actorStore.run({ transport: 'http', personId: 'guest-1', sourceTag: 'SENTINEL_TAG', scopes: ['emet.read'] }, () => {
      handleError(err, 'recall_SENTINEL', null);
    });
    await flushErrorLog();
    assert.strictEqual(store.entries.length, 1);
    const row = store.entries[0];
    assert.deepStrictEqual(Object.keys(row).sort(), ENTRY_KEYS.slice().sort());
    const raw = JSON.stringify(row);
    assert.ok(!raw.includes('SENTINEL'));
    assert.ok(!raw.includes('emet_tok_'));
    assert.ok(!raw.includes('example.com'));
    assert.ok(!raw.includes('Ada'));
    assert.ok(!raw.includes('Finances'));
    assert.ok(!raw.includes('Query'));
    assert.strictEqual(row.caller, 'unregistered');
    assert.strictEqual(row.tool, 'unknown');
    assert.strictEqual(row.role, 'guest');
    assert.strictEqual(row.transport, 'http');
    assert.strictEqual(row.emet_code, 'EMET-VAL-005');
    assert.strictEqual(row.count, 1);
  });

  test('a registered source tag is kept and an unregistered one is not', async () => {
    store.entries.length = 0;
    process.env.EMET_SOURCE_TAGS = 'laptop';
    await actorStore.run({ transport: 'stdio', sourceTag: 'laptop' }, () => recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '0123456789abcdef'
    }));
    await actorStore.run({ transport: 'stdio', sourceTag: 'not-registered' }, () => recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: 'abcdef0123456789'
    }));
    await flushErrorLog();
    delete process.env.EMET_SOURCE_TAGS;
    assert.deepStrictEqual(store.entries.map((row) => row.caller).sort(), ['laptop', 'unregistered']);
  });

  test('a log write failure still returns the original envelope', async () => {
    store.fail = true;
    const { value, lines } = await silence(async () => {
      const res = handleError(new ValidationError('query', 'Query is required', { code: 'EMET-VAL-005' }), 'recall');
      await flushErrorLog();
      return res;
    });
    store.fail = false;
    const body = JSON.parse(value.content[0].text);
    assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
    assert.strictEqual(body.error.emet_code, 'EMET-VAL-005');
    assert.match(body.error.message, /Query is required/);
    assert.ok(lines.some((line) => line === 'error log write failed'));
    assert.ok(!lines.join('\n').includes('Query is required'));
  });

  test('rotation writes matching summary counts and the process-log line', async () => {
    store.entries.length = 0;
    store.summaries.length = 0;
    const old = '2020-01-02T03:04:05.000Z';
    await insertErrorLog({ _id: 'old-a', t: old, emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: 'aaaaaaaaaaaaaaaa' });
    await insertErrorLog({ _id: 'old-b', t: old, emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: 'bbbbbbbbbbbbbbbb' });
    await insertErrorLog({ _id: 'new-c', t: '2026-10-20T00:00:00.000Z', emet_code: 'EMET-VAL-005', class_code: 'VALIDATION_ERROR', tool: 'recall', correlation_id: 'cccccccccccccccc' });
    const { lines } = await silence(() => rotateErrorLog({ now: new Date('2026-10-20T00:00:00.000Z'), maxAgeDays: 90, maxEntries: 100 }));
    assert.deepStrictEqual(store.entries.map((row) => row._id), ['new-c']);
    const summary = store.summaries.find((row) => row.emet_code === 'EMET-INT-001');
    assert.ok(summary);
    assert.strictEqual(summary.count, 2);
    assert.strictEqual(summary.day, '2020-01-02');
    assert.strictEqual(summary.tool, 'recall');
    assert.deepStrictEqual(Object.keys(summary).sort(), ['count', 'day', 'emet_code', 'tool', 'version']);
    assert.ok(lines.some((line) => /^rotated 2 entries older than \d{4}-\d{2}-\d{2}$/.test(line)));
  });

  test('the cap is 10000 entries and retention is 90 days', () => {
    assert.strictEqual(ERROR_LOG_MAX, 10000);
    assert.strictEqual(ERROR_LOG_DAYS, 90);
    const src = fs.readFileSync(new URL('../src/error-log.js', import.meta.url), 'utf8');
    assert.match(src, /ERROR_LOG_MAX = 10000/);
    assert.match(src, /ERROR_LOG_DAYS = 90/);
  });

  test('the cap removes the oldest entries and summarizes them', async () => {
    store.entries.length = 0;
    store.summaries.length = 0;
    await insertErrorLog({ _id: '1', t: '2026-10-18T00:00:00.000Z', emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '1111111111111111' });
    await insertErrorLog({ _id: '2', t: '2026-10-19T00:00:00.000Z', emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '2222222222222222' });
    await insertErrorLog({ _id: '3', t: '2026-10-20T00:00:00.000Z', emet_code: 'EMET-VAL-005', class_code: 'VALIDATION_ERROR', tool: 'recall', correlation_id: '3333333333333333' });
    await silence(() => rotateErrorLog({ now: new Date('2026-10-20T00:00:00.000Z'), maxAgeDays: 90, maxEntries: 2 }));
    assert.deepStrictEqual(store.entries.map((row) => row._id).sort(), ['2', '3']);
    assert.strictEqual(store.summaries.reduce((sum, row) => sum + row.count, 0), 1);
  });
});

testGroup('cleanup', () => {
  test('the memory backend does not leak into other suites in this process', () => {
    setErrorLogBackend(null);
    assert.ok(true);
  });
});

summary('Error log');
