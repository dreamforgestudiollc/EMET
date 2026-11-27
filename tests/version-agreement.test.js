/**
 * The declared version is the same string in the package, the server
 * manifest, the plugin, the roadmap, and the site.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, summary } from './harness.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('\n=== Version agreement ===');

await test('package, server, plugin, roadmap, site, deploy, and setup name one version', () => {
  const version = JSON.parse(read('package.json')).version;
  const server = JSON.parse(read('server.json'));
  const plugin = JSON.parse(read('.cursor-plugin/plugin.json'));
  assert.equal(server.version, version);
  assert.equal(plugin.version, version);
  assert.match(plugin.description, new RegExp(`EMET ${version} is an MCP`));
  assert.match(read('docs/ROADMAP.md'), new RegExp(`Version ${version} is this repository`));
  assert.match(read('site/index.html'), new RegExp(`What ${version} changed`));
  assert.match(read('docs/DEPLOY.md'), new RegExp(`## Upgrading to ${version}`));
  assert.match(read('docs/SETUP.md'), new RegExp(`## Upgrading to ${version}`));
});

await summary('Version agreement');
