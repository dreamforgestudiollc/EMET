/**
 * Prove the npm package contains the RUNE load gate and that importing the
 * packed host-reach module loads it. acorn comes from this repo's install.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-pack-'));
try {
  const out = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], {
    cwd: root,
    encoding: 'utf8'
  });
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start));
  const tgz = path.join(dir, parsed[0].filename);
  execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  const packed = path.join(dir, 'package');
  const gate = path.join(packed, 'verification/load-gate/load-gate.mjs');
  const corpus = path.join(packed, 'verification/load-gate/corpus.json');
  if (!fs.existsSync(gate) || !fs.existsSync(corpus)) {
    console.error('packed tree is missing the load gate');
    process.exit(1);
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(packed, 'node_modules'));
  const host = await import(pathToFileURL(path.join(packed, 'src/host-reach.js')).href);
  let reason = null;
  try {
    host.refuseHostAccess("import * as cp from 'node:child_process';\nexport const y = 1;\n");
  } catch (e) {
    reason = e && e.reason;
  }
  if (reason !== 'specifier not allowed') {
    console.error('packed gate did not refuse node:child_process:', reason);
    process.exit(1);
  }
  console.log('packed host-reach loaded the load gate');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
