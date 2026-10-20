/**
 * The tool names published in the README, glama.json and server.json are the
 * names src/tools.js registers, including the four that appear only when
 * EMET_SUBKEYS=1.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.EMET_SUBKEYS;
const { hostTools } = await import('../src/tools.js');

function registeredNames() {
  delete process.env.EMET_SUBKEYS;
  const off = hostTools().map((tool) => tool.name);
  process.env.EMET_SUBKEYS = '1';
  const on = hostTools().map((tool) => tool.name);
  delete process.env.EMET_SUBKEYS;
  return [...new Set([...off, ...on])].sort();
}

function readmeNames() {
  const text = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const start = text.indexOf('<!-- emet-tools -->');
  const end = text.indexOf('<!-- /emet-tools -->');
  assert.ok(start >= 0 && end > start, 'README tools block');
  return text.slice(start, end).split('\n').map((line) => line.trim()).filter((line) => /^[a-z0-9_]+$/.test(line)).sort();
}

testGroup('declared tool names match the registry', () => {
  test('README, glama.json and server.json list the registered names', () => {
    const names = registeredNames();
    assert.ok(names.length > 30, names.length);
    assert.deepStrictEqual(readmeNames(), names);
    const glama = JSON.parse(fs.readFileSync(path.join(ROOT, 'glama.json'), 'utf8'));
    assert.deepStrictEqual([...glama.tools].sort(), names);
    const server = JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8'));
    const listed = server._meta['io.modelcontextprotocol.registry/publisher-provided'].tools;
    assert.deepStrictEqual([...listed].sort(), names);
    assert.ok(server.description.length <= 100);
    assert.match(glama.description, /no account, key or payment required to run it/);
    assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /## License and access\n\nEMET is free and open source under the MIT License \(see LICENSE\)\. No account, key or payment is required to run it\./);
  });
});

summary('DECLARED TOOLS TEST SUMMARY');
