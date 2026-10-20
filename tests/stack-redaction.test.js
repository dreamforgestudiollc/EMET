/**
 * A stack frame in an error is replaced with [stack-frame]. A regex literal
 * in src must not contain a scrub-substitution word after a backslash
 * (the corruption that turned \bat into \reviewer).
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as acorn from 'acorn';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { sanitizeErrorMessage } = await import('../src/database.js');

const SCRUB_WORDS = new Set(['reviewer', 'tester', 'intake', 'research', 'memory', 'hub']);

export function regexScrubFaults(source) {
  const text = String(source).replace(/^#!.*\n/, '');
  const ast = acorn.parse(text, { ecmaVersion: 2022, sourceType: 'module' });
  const faults = [];
  const seen = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (node.type === 'Literal' && node.regex && typeof node.regex.pattern === 'string') {
      for (const match of node.regex.pattern.matchAll(/\\([A-Za-z]+)/g)) {
        if (SCRUB_WORDS.has(match[1])) faults.push(match[0]);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast);
  return faults;
}

function jsFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) jsFiles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

testGroup('stack frames stay redacted', () => {
  test('a path inside a stack frame becomes [stack-frame]', () => {
    const framed = sanitizeErrorMessage('Error: x\n    at handler (/opt/emet/src/internal/secret-module.js:12:5)');
    assert.ok(framed.includes('[stack-frame]'), framed);
    assert.ok(!framed.includes('secret-module'), framed);
    const host = sanitizeErrorMessage('at run (internal-host.svc:5:9)');
    assert.ok(host.includes('[stack-frame]'), host);
    assert.ok(!host.includes('internal-host'), host);
  });

  test('a scrub word inside a regex literal fails, and the restored stack rule does not', () => {
    assert.deepStrictEqual(regexScrubFaults('const re = /\\bat\\s+\\S+\\s+\\([^)]*\\)/gi;\n'), []);
    const planted = regexScrubFaults('const re = /\\reviewer/;\n');
    assert.ok(planted.some((fault) => fault.includes('reviewer')), planted.join(','));
    const bad = [];
    for (const file of jsFiles(path.join(ROOT, 'src'))) {
      const faults = regexScrubFaults(fs.readFileSync(file, 'utf8'));
      if (faults.length) bad.push(`${path.relative(ROOT, file)}: ${faults.join(',')}`);
    }
    assert.deepStrictEqual(bad, []);
  });
});

summary('STACK REDACTION TEST SUMMARY');
