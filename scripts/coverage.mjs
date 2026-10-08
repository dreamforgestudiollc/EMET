#!/usr/bin/env node
/**
 * EMET - code coverage, as an input to review (2026-09-29, a decision record).
 *
 * Owner's ruling: "if it's a metric that an auditor is expected to see, then
 * we need to do something about that" - published as an INPUT TO REVIEW, not a
 * pass/fail gate. This script never fails on the number; its exit code is the
 * test run's exit code and nothing else.
 *
 * Method, no dependency: Node's built-in V8 coverage (NODE_V8_COVERAGE). Every
 * suite runs in its own child process and inherits the variable, so each
 * process writes its own raw coverage file. For every file under src/:
 *   - executable lines = lines that are not blank and not wholly comment;
 *   - a line is covered when any process ran the code at its first
 *     non-blank character (V8 block ranges, innermost range wins);
 *   - a function is covered when any process called it at least once;
 *   - a file no suite loaded counts with every executable line uncovered.
 * Output: a summary on stdout and docs/COVERAGE.md (date, commit, suite
 * result, totals, per-file table lowest first).
 *
 * Usage: node scripts/coverage.mjs      (or: npm run coverage)
 */

import { spawnSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT_MD = path.join(ROOT, 'docs', 'COVERAGE.md');

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listJs(path.join(dir, e.name)) : (e.name.endsWith('.js') || e.name.endsWith('.mjs') ? [path.join(dir, e.name)] : []));
}

/** For each line: the offset of its first code character, or -1 if the line
 *  is blank or wholly comment. A light scanner: strings and template text are
 *  code, // and block comments are not. Quote state resets at a newline so a
 *  quote inside a regex literal cannot swallow more than its own line. */
function codeStarts(text) {
  const starts = [];
  let i = 0, line = 0, first = -1, inBlock = false, quote = null;
  const endLine = () => { starts[line] = first; line++; first = -1; };
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '\n') { endLine(); if (quote !== '`') quote = null; i++; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; } else i++; continue; }
    if (quote) {
      if (first < 0 && !/\s/.test(c)) first = i;
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; if (first < 0) first = i; i++; continue; }
    if (first < 0 && !/\s/.test(c)) first = i;
    i++;
  }
  starts[line] = first;
  return starts;
}

/** Count at each character offset of one script, innermost V8 range winning.
 *  V8 ranges nest and never partly overlap, so filling from the widest to the
 *  narrowest leaves the innermost count on every character, whatever order
 *  the functions were reported in. */
function countsFor(len, functions) {
  const counts = new Int32Array(len).fill(-1);
  const ranges = functions.flatMap((fn) => fn.ranges)
    .sort((x, y) => (y.endOffset - y.startOffset) - (x.endOffset - x.startOffset));
  for (const r of ranges) counts.fill(r.count, Math.max(0, r.startOffset), Math.min(len, r.endOffset));
  return counts;
}

// --- 1. run the suite with coverage on ------------------------------------
const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-v8cov-'));
const run = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'run-all-tests.js')], {
  cwd: ROOT, env: { ...process.env, NODE_V8_COVERAGE: rawDir }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
});
const runOut = (run.stdout || '') + (run.stderr || '');
const suitesRun = (runOut.match(/suites run:\s+(\d+)/) || [])[1] || '?';
const suitesPassed = (runOut.match(/suites passed:\s+(\d+)/) || [])[1] || '?';
const checksPassed = (runOut.match(/^\s*PASS: /gm) || []).length;
const checksFailed = (runOut.match(/^\s*FAIL: /gm) || []).length;

// --- 2. merge every process's raw coverage for files under src/ -----------
const norm = (p) => path.resolve(p).toLowerCase();
const srcFiles = listJs(SRC);
const byFile = new Map(srcFiles.map((f) => [norm(f), { file: f, text: fs.readFileSync(f, 'utf8'), coveredLines: new Set(), fns: new Map(), loaded: false }]));

for (const name of fs.readdirSync(rawDir)) {
  if (!name.endsWith('.json')) continue;
  let data; try { data = JSON.parse(fs.readFileSync(path.join(rawDir, name), 'utf8')); } catch { continue; }
  for (const script of data.result || []) {
    if (!script.url || !script.url.startsWith('file:')) continue;
    let p; try { p = norm(fileURLToPath(script.url)); } catch { continue; }
    const rec = byFile.get(p);
    if (!rec) continue;
    rec.loaded = true;
    const counts = countsFor(rec.text.length, script.functions);
    const starts = codeStarts(rec.text);
    starts.forEach((off, line) => { if (off >= 0 && counts[off] > 0) rec.coveredLines.add(line); });
    for (const fn of script.functions) {
      const r0 = fn.ranges[0];
      if (!r0 || (r0.startOffset === 0 && !fn.functionName)) continue; // the module body itself
      const key = `${r0.startOffset}:${r0.endOffset}`;
      const prev = rec.fns.get(key) || { name: fn.functionName || '(anonymous)', called: false };
      if (r0.count > 0) prev.called = true;
      rec.fns.set(key, prev);
    }
  }
}
try { fs.rmSync(rawDir, { recursive: true, force: true }); } catch { /* temporary */ }

// --- 3. per file and totals ------------------------------------------------
const pct = (a, b) => (b ? (100 * a / b) : 100);
const rows = [];
let tExec = 0, tCov = 0, tFn = 0, tFnCov = 0;
for (const rec of byFile.values()) {
  const execLines = codeStarts(rec.text).filter((o) => o >= 0).length;
  const cov = rec.loaded ? rec.coveredLines.size : 0;
  const fns = [...rec.fns.values()];
  const fnCov = fns.filter((f) => f.called).length;
  tExec += execLines; tCov += cov; tFn += fns.length; tFnCov += fnCov;
  rows.push({ file: path.relative(ROOT, rec.file).split(path.sep).join('/'), execLines, cov, linePct: pct(cov, execLines), fns: fns.length, fnCov, loaded: rec.loaded });
}
rows.sort((a, b) => a.linePct - b.linePct || a.file.localeCompare(b.file));

let commit = 'unknown', dirty = false;
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); dirty = !!execSync('git status --porcelain -- src tests', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* not a git tree */ }
const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const f1 = (x) => x.toFixed(1) + '%';

const summaryLines = [
  `Lines:     ${f1(pct(tCov, tExec))}  (${tCov} of ${tExec} executable lines in src/)`,
  `Functions: ${f1(pct(tFnCov, tFn))}  (${tFnCov} of ${tFn} functions in loaded files)`,
  `Files:     ${rows.filter((r) => r.loaded).length} of ${rows.length} loaded by at least one suite`,
  `Suites:    ${suitesPassed} of ${suitesRun} passed; ${checksPassed} checks passed, ${checksFailed} failed`
];
console.log('\n' + '='.repeat(60) + '\nCOVERAGE (input to review, not a gate)\n' + '='.repeat(60));
summaryLines.forEach((l) => console.log(l));

const md = [
  '# Code coverage',
  '',
  `Measured ${when} at commit \`${commit}\`${dirty ? ' (with uncommitted changes under src/ or tests/)' : ''}, Node ${process.version}. Regenerate with \`npm run coverage\`.`,
  '',
  '**An input to review, not a gate** (owner\'s ruling 2026-09-29, a decision record). No threshold fails the build; the number is here so a reviewer or auditor can see what the suite exercises and what it does not.',
  '',
  '## Totals',
  '',
  ...summaryLines.map((l) => `- ${l}`),
  '',
  '## Method',
  '',
  '- Node\'s built-in V8 coverage (`NODE_V8_COVERAGE`), no dependency. Every suite runs in its own process; coverage from all of them is merged.',
  '- A line counts when it is not blank and not wholly comment. It is covered when any suite ran the code at its first character.',
  '- A function is covered when any suite called it. Functions are counted only in files a suite loaded.',
  '- V8 does not report a function nested inside a function that never ran, so the function figure undercounts uncalled code and reads high. **The line figure is the one to trust.**',
  '- A file no suite loads counts with every executable line uncovered - it is not left out.',
  '- The comment scanner is simple: a quote or `//` inside a regular-expression literal can misjudge that one line.',
  '',
  '## Per file, lowest line coverage first',
  '',
  '| File | Lines covered | Lines | Functions called | Loaded by a suite |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| \`${r.file}\` | ${f1(r.linePct)} | ${r.cov} / ${r.execLines} | ${r.loaded ? `${r.fnCov} / ${r.fns}` : '-'} | ${r.loaded ? 'yes' : '**no**'} |`),
  ''
].join('\n');
fs.writeFileSync(OUT_MD, md);
console.log(`\nwrote ${path.relative(ROOT, OUT_MD)}`);
process.exit(run.status ?? 1);
