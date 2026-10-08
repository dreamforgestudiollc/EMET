/**
 * EMET - undefined-constant guard.
 *
 * Exists because an earlier commit (2026-09-15) deleted the definitions of
 * SEMANTIC_RECALL_LAYERS and SEMANTIC_RECALL_INDEX while semanticRecall kept
 * using them. `node --check` does not catch a reference to a name that was
 * never declared, and no suite exercises the vector path without Atlas, so
 * every semantic_recall call threw a ReferenceError for four days and 20/20
 * suites passed the whole time.
 *
 * The check is static and deliberately narrow: every SCREAMING_CASE identifier
 * used in a src file (not as a property, not inside a string or comment) must
 * be declared in that file or brought in by an import.
 */

import { test, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');


function stripStringsAndComments(src) {
  // Replace the contents of comments and string/template literals with spaces so
  // identifiers inside them are ignored and line numbers survive.
  let out = '', i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += c + blank(src.slice(i + 1, j)) + c; i = j + 1; continue;
    }
    if (c === '/' && /[=(,:\[!&|?{};]\s*$/.test(out)) {
      // A regex literal: `/` where an operand is expected. Skip to its close.
      let j = i + 1, inClass = false;
      while (j < src.length && (inClass || src[j] !== '/') && src[j] !== '\n') {
        if (src[j] === '\\') j++; else if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
        j++;
      }
      out += c + blank(src.slice(i + 1, j)) + '/'; i = j + 1; continue;
    }
    out += c; i++;
  }
  // Re-export lists name bindings that live in another module, not here.
  return out.replace(/\bexport\s*\{[^}]*\}\s*from/g, (m) => blank(m));
}

function declaredNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) for (const p of m[1].split(',')) { const n = p.split(':').pop().split('=')[0].trim(); if (n) names.add(n); }
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) for (const p of m[1].split(',')) { const n = p.split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  for (const m of code.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
  return names;
}

function undefinedConstants(file) {
  const code = stripStringsAndComments(fs.readFileSync(file, 'utf8'));
  const declared = declaredNames(code);
  const found = new Map();
  for (const m of code.matchAll(/(^|[^\w$.])([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b(\s*:(?!:))?/g)) {
    const name = m[2];
    if (declared.has(name)) continue;
    if (m[3]) continue; // an object-literal key, not a reference
    const line = code.slice(0, m.index).split('\n').length;
    if (!found.has(name)) found.set(name, line);
  }
  return found;
}

console.log('\n=== Every SCREAMING_CASE name used in src/ is declared or imported ===');
for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.js')).sort()) {
  test(f, () => {
    const bad = undefinedConstants(path.join(SRC, f));
    assert.strictEqual(bad.size, 0, [...bad].map(([n, l]) => `${n} (line ${l})`).join(', '));
  });
}

summary('Undefined Constants Test Summary');
