/**
 * The feature map names every registered tool. A tool added to the host list
 * and left out of docs/features fails here.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEATURES_DIR = path.join(ROOT, 'docs', 'features');
const SECTIONS = [
  '## Sub-features',
  '## How to get to it (user POV)',
  '## Driving it with verify-emet',
  '## Gotchas'
];

delete process.env.EMET_SUBKEYS;
delete process.env.CASCADE_SUBKEYS;
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
const { hostTools } = await import('../src/tools.js');
const { FEATURES } = await import('../scripts/verify-emet.mjs');

function registeredNames() {
  delete process.env.EMET_SUBKEYS;
  delete process.env.CASCADE_SUBKEYS;
  const off = hostTools().map((tool) => tool.name);
  process.env.EMET_SUBKEYS = '1';
  const on = hostTools().map((tool) => tool.name);
  delete process.env.EMET_SUBKEYS;
  delete process.env.CASCADE_SUBKEYS;
  return [...new Set([...off, ...on])].sort();
}

function mentions(text, name) {
  return new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(text);
}

const featureFiles = fs.readdirSync(FEATURES_DIR).filter((name) => name.endsWith('.md') && name !== 'README.md').sort();

testGroup('feature map covers every registered tool', () => {
  test('each feature file has the four sections', () => {
    assert.ok(featureFiles.length >= 10, featureFiles.join(','));
    for (const name of featureFiles) {
      const text = fs.readFileSync(path.join(FEATURES_DIR, name), 'utf8');
      for (const heading of SECTIONS) {
        assert.ok(text.includes(heading), `${name} is missing ${heading}`);
      }
    }
  });

  test('the overview links to every feature file', () => {
    const overview = fs.readFileSync(path.join(FEATURES_DIR, 'README.md'), 'utf8');
    for (const name of featureFiles) {
      assert.ok(overview.includes(`(${name})`) || overview.includes(`(${name} `), `${name} is not linked from the overview`);
    }
  });

  test('every registered tool is named in a feature file', () => {
    const blob = featureFiles.map((name) => fs.readFileSync(path.join(FEATURES_DIR, name), 'utf8')).join('\n');
    const missing = registeredNames().filter((name) => !mentions(blob, name));
    assert.deepStrictEqual(missing, [], `missing from docs/features: ${missing.join(', ')}`);
  });

  test('each feature file names the tools verify-emet assigns to it', () => {
    for (const feature of FEATURES) {
      const text = fs.readFileSync(path.join(FEATURES_DIR, feature.file), 'utf8');
      for (const tool of feature.tools) {
        assert.ok(mentions(text, tool), `${feature.file} does not name ${tool}`);
      }
    }
  });

  test('development practices credit the guide and keep the two review rule', () => {
    const text = fs.readFileSync(path.join(ROOT, 'docs', 'DEVELOPMENT-PRACTICES.md'), 'utf8');
    assert.ok(text.includes('The Complete Guide to pstack'));
    assert.ok(text.includes('https://x.com/poteto/status/2094457600259842065'));
    assert.ok(text.includes('https://x.com/poteto/status/2097732320606507506'));
    assert.ok(/two independent reviewers/i.test(text));
    assert.ok(/cross-check/i.test(text));
    assert.ok(text.includes('verify-emet'));
    assert.ok(text.includes('docs/features'));
  });
});

summary('FEATURE MAP TEST SUMMARY');
