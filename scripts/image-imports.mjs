/**
 * Import every runtime module in the image except the two entry points,
 * which boot a server. host-reach.js must load the vendored load gate.
 * Run from /app inside the deploy image: node scripts/image-imports.mjs
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = path.join(root, 'src');
const skip = new Set(['index.js', 'http-remote.js']);
const names = (await readdir(dir)).filter((name) => name.endsWith('.js') && !skip.has(name)).sort();
for (const name of names) {
  await import(pathToFileURL(path.join(dir, name)).href);
}
const host = await import(pathToFileURL(path.join(dir, 'host-reach.js')).href);
let reason = null;
try {
  host.refuseHostAccess("import * as fs from 'node:fs';\nexport const y = 1;\n");
} catch (e) {
  reason = e && e.reason;
}
if (reason !== 'specifier not allowed') {
  console.error('image load gate did not refuse node:fs:', reason);
  process.exit(1);
}
console.log('imported ' + names.length + ' runtime modules');
