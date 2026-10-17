/**
 * The socket must not execute RUNE code. This fails if src/ or gems/ contains
 * child_process, spawn, worker_threads, vm, new Function, a computed import()
 * path, or an import of a RUNE runner, including a dynamic import() of a RUNE
 * file. The exceptions in src/gem-check.js are its node --check and the
 * text walker's named vm comparisons. The banned-import list lives in
 * verification/load-gate/load-gate.mjs, which this walk does not scan.
 * Matches are by the code, not by line number. A comment is not a site.
 * A dynamic import of one string literal that is not a RUNE file is not a site.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW_FILE = 'src/gem-check.js';
const ALLOW = [
  /import\s*\{\s*spawnSync\s*\}\s*from\s*['"]node:child_process['"]/,
  /['"]child_process['"]/,
  /['"]vm['"]\s*,\s*['"]module['"]/,
  /value === ['"]vm['"]/,
  /value === ['"]node:vm['"]/,
  /ScanRefuse\(['"]vm['"]\)/,
  /spawnSync\(\s*process\.execPath\s*,\s*\[\s*['"]--check['"]/
];

function stripComments(source) {
  const s = String(source);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') {
      i += 2;
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i = Math.min(s.length, i + 2);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
        out += s[i];
        if (s[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** null when the text is allowed. Otherwise the kind of hit. */
export function offense(source, rel) {
  let text = stripComments(source);
  const file = String(rel).replaceAll('\\', '/');
  if (file === ALLOW_FILE) {
    for (const re of ALLOW) text = text.replace(re, '');
  }
  if (text.includes('child_process')) return 'child_process';
  if (/\bspawn(?:Sync)?\b/.test(text)) return 'spawn';
  if (/\bworker_threads\b/.test(text)) return 'worker_threads';
  if (/(['"`])(?:node:)?vm\1/.test(text)) return 'vm';
  if (/\bnew\s+Function\b/.test(text) || /\bFunction\s*\(/.test(text)) return 'Function';
  if (/import\s*\(\s*['"`][^'"`]*(?:\/runes\/|rune-sandbox|rune-child|rune-loader|rune-hooks|rune-bridge)/.test(text)) return 'runner';
  if (/rune-sandbox|rune-child|rune-loader|rune-hooks|rune-bridge|\brunIsolated\b/.test(text)) return 'runner';
  const dynamicImports = text.match(/\bimport\s*\(/g) || [];
  const literalImports = text.match(/\bimport\s*\(\s*(['"])[^'"`+]*\1\s*\)/g) || [];
  if (dynamicImports.length !== literalImports.length) return 'import';
  return null;
}

function walk(dir, hits) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) { walk(abs, hits); continue; }
    const rel = path.relative(ROOT, abs).replaceAll('\\', '/');
    const hit = offense(fs.readFileSync(abs, 'utf8'), rel);
    if (hit) hits.push(`${rel}: ${hit}`);
  }
}

testGroup('no runner in src or gems', () => {
  test('the tree is clean, and gem-check node --check is the only exception', () => {
    const hits = [];
    walk(path.join(ROOT, 'src'), hits);
    walk(path.join(ROOT, 'gems'), hits);
    assert.deepStrictEqual(hits, []);
  });

  test('a comment that names spawn is not a hit', () => {
    const text = '// spawn("child_process")\n/* import rune-sandbox */\n// import("./runes/fieldnote.js")\n/* worker_threads */\n// new Function("return 1")\n/* import(name) */\n// import vm from \'vm\'\nexport const x = 1;\n';
    assert.strictEqual(offense(text, 'src/note.js'), null);
    assert.strictEqual(offense(text, ALLOW_FILE), null);
  });

  test('a new spawn is caught', () => {
    const planted = "import { spawn } from 'node:child_process';\nspawn('node');\n";
    assert.strictEqual(offense(planted, 'src/planted.js'), 'child_process');
    assert.strictEqual(offense("spawnSync('node');\n", 'gems/fieldnote/runes/fieldnote.js'), 'spawn');
    const checker = fs.readFileSync(path.join(ROOT, ALLOW_FILE), 'utf8') + "\nspawn('extra');\n";
    assert.strictEqual(offense(checker, ALLOW_FILE), 'spawn');
    assert.strictEqual(offense("import { runIsolated } from './rune-sandbox.js';\n", 'src/planted.js'), 'runner');
  });

  test('a dynamic import of a RUNE file, and worker_threads, are caught', () => {
    assert.strictEqual(offense("await import('./tools.js');\n", 'src/dispatch.js'), null);
    assert.strictEqual(offense("await import('./rune-dispatch.js');\n", 'src/dispatch.js'), null);
    assert.strictEqual(offense("return import('./runes/fieldnote.js');\n", 'src/planted.js'), 'runner');
    assert.strictEqual(offense("import('./rune-child.js');\n", 'gems/fieldnote/runes/fieldnote.js'), 'runner');
    assert.strictEqual(offense("import { Worker } from 'worker_threads';\n", 'src/planted.js'), 'worker_threads');
    const checker = fs.readFileSync(path.join(ROOT, ALLOW_FILE), 'utf8');
    assert.strictEqual(offense(checker, ALLOW_FILE), null);
    assert.strictEqual(offense(checker + "\nimport { Worker } from 'worker_threads';\n", ALLOW_FILE), 'worker_threads');
  });

  test('vm, new Function, and a computed import path are caught', () => {
    assert.strictEqual(offense("import vm from 'node:vm';\n", 'src/planted.js'), 'vm');
    assert.strictEqual(offense("import { createContext } from 'vm';\n", 'gems/fieldnote/runes/fieldnote.js'), 'vm');
    assert.strictEqual(offense('const f = new Function("return 1");\n', 'src/planted.js'), 'Function');
    assert.strictEqual(offense('const f = Function\n("return 1");\n', 'src/planted.js'), 'Function');
    assert.strictEqual(offense('return import(name);\n', 'src/planted.js'), 'import');
    assert.strictEqual(offense('return import("./" + "look.js");\n', 'src/planted.js'), 'import');
    assert.strictEqual(offense('return import(`./${name}.js`);\n', 'src/planted.js'), 'import');
    assert.strictEqual(offense("await import('./tools.js');\n", 'src/dispatch.js'), null);
    const checker = fs.readFileSync(path.join(ROOT, ALLOW_FILE), 'utf8');
    assert.strictEqual(offense(checker, ALLOW_FILE), null);
    assert.strictEqual(offense(checker + "\nimport vm from 'vm';\n", ALLOW_FILE), 'vm');
    assert.strictEqual(offense(checker + '\nconst f = new Function("x");\n', ALLOW_FILE), 'Function');
    const vmAllow = ALLOW.filter((re) => re.source.includes('vm'));
    assert.strictEqual(vmAllow.length, 4);
    const plants = ["import vm from 'vm';\n", "import { createContext } from 'node:vm';\n"];
    for (const re of vmAllow) {
      for (const planted of plants) assert.strictEqual(re.test(planted), false, re.source);
    }
  });
});

await summary('RUNE GUARD');
