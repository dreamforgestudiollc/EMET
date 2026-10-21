/**
 * Stable error codes: registry, lock file, throw coverage, message snapshot,
 * and the error envelope.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, RETIRED_CODES, renderErrorCodesDoc, EMET_CODE_RE } from '../src/error-codes.js';
import { ValidationError } from '../src/validation.js';
import { DatabaseError, ErrorCodes } from '../src/database.js';
import { handleError } from '../src/tools.js';
import { useMemoryErrorLog, flushErrorLog } from '../src/error-log.js';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { scanSource, throwStatements, codedThrowSites } from './error-scan.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const SCAN_REASONS = new Set([
  'too large', 'bad escape', 'unterminated string', 'bad template', 'unterminated template',
  'vm', 'non-literal', 'computed import', 'eval', 'Function', 'process binding'
]);

useMemoryErrorLog();

function srcFiles() {
  return fs.readdirSync(SRC).filter((name) => name.endsWith('.js')).sort();
}

function stripExport(src, name) {
  const marker = `export const ${name} = Object.freeze({`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        const end = src.indexOf(';', i);
        assert.ok(end > i, name);
        return src.slice(0, start) + src.slice(end + 1);
      }
    }
  }
  assert.fail(name);
}

testGroup('registry', () => {
  test('every code matches the format and the lock file', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/error-codes.lock.json'), 'utf8'));
    const codes = Object.keys(ERROR_CODES);
    assert.deepStrictEqual(codes.slice().sort(), Object.keys(lock).sort());
    for (const code of codes) {
      assert.match(code, EMET_CODE_RE);
      assert.strictEqual(ERROR_CODES[code].summary, lock[code].summary, code);
      assert.strictEqual(ERROR_CODES[code].status, lock[code].status, code);
      assert.strictEqual(ERROR_CODES[code].internal, lock[code].internal, code);
      if (lock[code].status === 'retired') assert.strictEqual(ERROR_CODES[code].status, 'retired');
    }
  });

  test('the registry source has no duplicate keys', () => {
    const src = fs.readFileSync(path.join(SRC, 'error-codes.js'), 'utf8');
    const keys = [...src.matchAll(/'(EMET-[A-Z]{2,5}-\d{3})':/g)].map((match) => match[1]);
    const expected = [...Object.keys(ERROR_CODES), ...Object.keys(RETIRED_CODES)];
    assert.strictEqual(keys.length, new Set(keys).size);
    assert.deepStrictEqual(keys.slice().sort(), expected.slice().sort());
  });

  test('docs/ERROR-CODES.md is the generated registry', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/ERROR-CODES.md'), 'utf8');
    assert.strictEqual(doc, renderErrorCodesDoc());
  });

  test('every registry summary is unique', () => {
    const seen = new Map();
    for (const [code, row] of Object.entries(ERROR_CODES)) {
      const previous = seen.get(row.summary);
      assert.ok(!previous, `${code} and ${previous} share "${row.summary}"`);
      seen.set(row.summary, code);
    }
  });

  test('a frozen code keeps its meaning; a removal retires the number', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/error-codes.baseline.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/error-codes.lock.json'), 'utf8'));
    for (const [code, row] of Object.entries(baseline)) {
      const live = ERROR_CODES[code];
      const retired = RETIRED_CODES[code];
      if (!live) {
        assert.ok(retired, `${code} was removed without retiring it`);
        assert.strictEqual(retired.summary, row.summary, code);
        assert.strictEqual(retired.status, 'retired', code);
        assert.ok(!Object.prototype.hasOwnProperty.call(lock, code), code);
        continue;
      }
      assert.ok(!retired, `${code} is active and retired`);
      assert.strictEqual(live.summary, row.summary, code);
      assert.strictEqual(live.status, row.status, code);
      assert.strictEqual(live.internal, row.internal, code);
    }
  });

  test('the frozen baseline hash is pinned', () => {
    const bytes = fs.readFileSync(path.join(ROOT, 'tests/fixtures/error-codes.baseline.json'));
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.strictEqual(hash, '62bd9a57ccc28b3e020c76c636505773d61ceadd8b8f0fab4dc4ad2f6d7d9187');
  });

  test('a retired number does not reappear in the registry or the lock', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/error-codes.lock.json'), 'utf8'));
    const reserved = {
      'EMET-CFG-003': 'MONGODB_URI is not set for setup',
      'EMET-DB-009': 'MONGODB_URI is not set; cannot assess gaps',
      'EMET-DB-011': 'MONGODB_URI is not set; cannot read topic pages',
      'EMET-DB-012': 'MONGODB_URI is not set; cannot verify session artifacts',
      'EMET-MEM-031': 'Query exceeds the maximum length',
      'EMET-MEM-033': 'Startup pages could not fit the budget',
      'EMET-VAL-009': 'Query exceeds the maximum length'
    };
    for (const [code, summary] of Object.entries(reserved)) {
      assert.ok(RETIRED_CODES[code], `${code} left the retired list`);
      assert.strictEqual(RETIRED_CODES[code].summary, summary, code);
      assert.strictEqual(RETIRED_CODES[code].status, 'retired', code);
    }
    for (const [code, row] of Object.entries(RETIRED_CODES)) {
      assert.match(code, EMET_CODE_RE);
      assert.strictEqual(row.status, 'retired', code);
      assert.ok(!Object.prototype.hasOwnProperty.call(ERROR_CODES, code), `${code} reappeared in the registry`);
      assert.ok(!Object.prototype.hasOwnProperty.call(lock, code), `${code} reappeared in the lock`);
    }
  });

  test('every code literal is registered, and every active code is used or internal', () => {
    const registrySrc = stripExport(stripExport(fs.readFileSync(path.join(SRC, 'error-codes.js'), 'utf8'), 'RETIRED_CODES'), 'ERROR_CODES');
    const body = registrySrc;
    const used = new Set();
    const consider = (text) => {
      for (const match of text.matchAll(/EMET-[A-Z]{2,5}-\d{3}/g)) {
        assert.ok(ERROR_CODES[match[0]], `unregistered ${match[0]}`);
        used.add(match[0]);
      }
    };
    consider(body);
    for (const file of srcFiles()) {
      if (file === 'error-codes.js') continue;
      consider(fs.readFileSync(path.join(SRC, file), 'utf8'));
    }
    for (const [code, row] of Object.entries(ERROR_CODES)) {
      if (row.status !== 'active' || row.internal) continue;
      assert.ok(used.has(code), `${code} is active and unused`);
    }
  });
});

testGroup('throw sites', () => {
  test('every throw new Error carries a registered code, and ScanRefuse stays on its allow-list', () => {
    const reasons = [];
    for (const file of srcFiles()) {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8');
      for (const row of throwStatements(src)) {
        if (row.className === 'ScanRefuse') {
          const quoted = (row.text.match(/ScanRefuse\(\s*'([^']*)'/) || [])[1] || '';
          const reason = quoted.startsWith('non-literal') ? 'non-literal' : quoted;
          reasons.push(reason);
          assert.ok(SCAN_REASONS.has(reason), `${file}:${row.line} ${row.text}`);
          continue;
        }
        assert.match(row.text, /EMET-[A-Z]{2,5}-\d{3}/, `${file}:${row.line} has no code`);
      }
    }
    assert.strictEqual(reasons.length, 13);
    assert.deepStrictEqual([...new Set(reasons)].sort(), [...SCAN_REASONS].sort());
  });

  test('every coded throw site keeps its message mapped to its code', () => {
    const script = path.join(ROOT, 'scripts/error-throw-codes.mjs');
    const check = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    assert.strictEqual(check.status, 0, check.stderr || check.stdout);
    const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/error-throw-codes.json'), 'utf8'));
    const live = codedThrowSites(ROOT);
    assert.deepStrictEqual(live, snap);
    const queryLength = snap.filter((row) => /query exceeds maximum length/i.test(row.message));
    assert.ok(queryLength.length >= 1);
    for (const row of queryLength) assert.strictEqual(row.code, 'EMET-VAL-008', `${row.file} ${row.message}`);
  });

  test('the throw-site snapshot hash is pinned', () => {
    const bytes = fs.readFileSync(path.join(ROOT, 'tests/fixtures/error-throw-codes.json'));
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.strictEqual(hash, '2114f297fe7763f2c1ce5c996e43a814efc9dd130463967012192d3787cdfcbb');
  });

  test('today\'s message texts are still present', () => {
    const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/error-messages.snapshot.json'), 'utf8'));
    const { throws, returned } = scanSource(ROOT);
    const current = new Map();
    for (const item of [...throws, ...returned]) current.set(item, (current.get(item) || 0) + 1);
    for (const [item, count] of Object.entries(snap)) {
      assert.ok((current.get(item) || 0) >= count, `disappeared: ${item}`);
    }
  });
});

testGroup('envelope', () => {
  test('a coded validation error keeps error.code and adds emet_code', async () => {
    const bare = new ValidationError('query', 'Query is required');
    const coded = new ValidationError('query', 'Query is required', { code: 'EMET-VAL-005' });
    assert.strictEqual(coded.message, bare.message);
    assert.strictEqual(coded.emetCode, 'EMET-VAL-005');
    const stored = new DatabaseError('Failed to save memory', 'save_memory', { layer: 'auto' }, { code: 'EMET-DB-013' });
    assert.strictEqual(stored.message, 'Failed to save memory');
    assert.strictEqual(stored.code, ErrorCodes.DATABASE_ERROR);
    assert.deepStrictEqual(stored.details, { layer: 'auto' });
    assert.strictEqual(stored.emetCode, 'EMET-DB-013');
    const res = handleError(coded, 'recall');
    const body = JSON.parse(res.content[0].text);
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.error.code, ErrorCodes.VALIDATION_ERROR);
    assert.strictEqual(body.error.emet_code, 'EMET-VAL-005');
    assert.match(body.error.correlation_id, /^[0-9a-f]{16}$/);
    assert.strictEqual(body.error.message, bare.message);
    await flushErrorLog();
  });

  test('an uncoded error is EMET-INT-001 and the message is unchanged', () => {
    const res = handleError(new Error('boom'), 'recall');
    const body = JSON.parse(res.content[0].text);
    assert.strictEqual(body.error.code, ErrorCodes.INTERNAL_ERROR);
    assert.strictEqual(body.error.emet_code, 'EMET-INT-001');
    assert.strictEqual(body.error.message, 'boom');
    assert.match(body.error.correlation_id, /^[0-9a-f]{16}$/);
  });
});

summary('Error codes');
