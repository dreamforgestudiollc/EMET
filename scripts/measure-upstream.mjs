/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Regenerate the upstream attribution table in README.md.
 *
 * EMET is a derivative of CASCADE Enterprise RAM, and the README states how
 * much of each shared file is still upstream's work. That claim decays every
 * time this tree changes, and it decayed badly once already: the figures
 * published before 2026-09-09 could not be reproduced against the very commit
 * the README cites, and they understated the upstream contribution.
 *
 * The cause was not the numbers. It was that re-measuring them was a manual
 * step nobody was going to take. This script is that step, automated, so the
 * table can be regenerated in one command whenever src/ changes.
 *
 * METHOD, which is also stated in the README so a reader can check it:
 * exact, case-sensitive comparison of non-blank lines. An upstream line counts
 * as retained if the same line is present in our file. Multiset - a line
 * appearing twice upstream needs two occurrences here to count twice.
 *
 * Two ratios are reported because they answer different questions and diverge
 * sharply: how much of the upstream file survives here, and how much of our
 * file is upstream's. For tools.js those are 79% and 33%.
 *
 * USAGE:
 *   git clone https://github.com/For-Sunny/cascade-memory-enterprise /tmp/cascade
 *   node scripts/measure-upstream.mjs /tmp/cascade
 *
 * Pin the clone to the commit named in the README's Attribution section before
 * trusting the output; upstream moving would silently change what is measured.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// our file in src/  <->  upstream file in server/
const PAIRS = [
  'content_analyzer.js',
  'validation.js',
  'index.js',
  'tools.js',
  'database.js'
];

/**
 * Split into lines. A file ending in a newline yields a trailing empty element
 * from split(), which would report every file as one line longer than it is -
 * the table and this script have to agree, so it is dropped here.
 */
function lines(path) {
  const all = readFileSync(path, 'utf8').split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  return all;
}

const codeLines = (path) => lines(path).filter((line) => line.trim().length > 0);

/** Count upstream lines present in ours, treating duplicates as distinct. */
function retained(upstream, ours) {
  const bag = new Map();
  for (const line of ours) bag.set(line, (bag.get(line) ?? 0) + 1);
  let hits = 0;
  for (const line of upstream) {
    const left = bag.get(line) ?? 0;
    if (left > 0) { bag.set(line, left - 1); hits += 1; }
  }
  return hits;
}

const upstreamRoot = process.argv[2];
if (!upstreamRoot) {
  console.error('usage: node scripts/measure-upstream.mjs <path-to-upstream-clone>');
  process.exit(2);
}
if (!existsSync(join(upstreamRoot, 'server'))) {
  console.error(`no server/ directory under ${upstreamRoot} - is that an upstream clone?`);
  process.exit(2);
}

console.log('| File | Lines here | Upstream lines retained | of upstream | of this file |');
console.log('|---|---:|---|---:|---:|');

for (const file of PAIRS) {
  const up = codeLines(join(upstreamRoot, 'server', file));
  const ours = codeLines(join(REPO, 'src', file));
  const total = lines(join(REPO, 'src', file)).length;
  const hits = retained(up, ours);
  const ofUpstream = ((hits / up.length) * 100).toFixed(1);
  const ofOurs = ((hits / ours.length) * 100).toFixed(1);
  console.log(
    `| \`src/${file}\` | ${total} | ${hits} of ${up.length} | ${ofUpstream}% | ${ofOurs}% |`
  );
}

console.log('');
console.log('Non-blank lines compared; "Lines here" is the total including blanks.');
