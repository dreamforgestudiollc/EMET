#!/usr/bin/env node
/**
 * EMET test runner.
 *
 * No framework, no dependency: each suite is a plain node script using assert,
 * exiting non-zero on failure. Ported from upstream along with the suites.
 *
 * Suites are DISCOVERED: every *.test.js in this directory runs, in name order.
 * Until 2026-09-27 the list was hand-kept here (code audit, finding 4.3) - a
 * new suite ran only if someone remembered to add it, and the header named
 * three SQLite-era files that no longer existed. A file that must not run as a
 * suite does not end in .test.js.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUITES = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();

const failed = [];

function run(file) {
  return new Promise((resolve) => {
    console.log(`\n${'='.repeat(70)}\nRunning: ${file}\n${'='.repeat(70)}`);
    const proc = spawn(process.execPath, [path.join(__dirname, file)], { cwd: __dirname, stdio: 'inherit', env: { ...process.env, EMET_DROP_LIST_TIMEOUT_MS: process.env.EMET_DROP_LIST_TIMEOUT_MS || '50' } });
    proc.on('close', (code) => { if (code !== 0) failed.push(file); resolve(code); });
    proc.on('error', (err) => { console.error(`Failed to run ${file}:`, err.message); failed.push(file); resolve(1); });
  });
}

const started = Date.now();
for (const suite of SUITES) await run(suite);

console.log(`\n${'='.repeat(70)}\nRESULTS\n${'='.repeat(70)}`);
console.log(`suites run:    ${SUITES.length}`);
console.log(`suites passed: ${SUITES.length - failed.length}`);
console.log(`suites failed: ${failed.length}`);
console.log(`time:          ${((Date.now() - started) / 1000).toFixed(2)}s`);
if (failed.length) { console.log('\nfailed:'); failed.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
console.log('\nAll suites passed.');

