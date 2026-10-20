/**
 * The public site's hero lede and its four descriptions carry the repository
 * description's phrase, "built for ISO 9001 / ISO 13485 document control".
 * The lede, the meta description, og:description, twitter:description, and
 * the JSON-LD description each fail here if either standard is dropped.
 * Version 0.2.6 stays in the four descriptions.
 * The What it is disclaimer stays: no certification or conformity is claimed.
 * certified, compliant, and conformant fail anywhere in site/index.html,
 * including visible text, meta, and JSON-LD. The disclaimer sentence is allowed.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'site/index.html'), 'utf8');

const PHRASE = 'built for ISO 9001 / ISO 13485 document control';
const DISCLAIMER = 'EMET supports that work; it holds no certification and claims no conformity.';
const CLAIM = /\b(?:certified|compliant|conformant)\b/i;
const LEDE = 'An MCP memory server built for ISO 9001 / ISO 13485 document control: persistent, shared memory.';
const SHARED = 'EMET 0.2.6 is an MCP memory server built for ISO 9001 / ISO 13485 document control: persistent shared memory, verified writes, per-client approvals, and client-side GEM execution. EMET verifies the record, not the computation.';
const JSONLD = 'EMET 0.2.6 is an MCP memory server built for ISO 9001 / ISO 13485 document control: persistent shared memory, verified writes, per-client attribution and approvals, and client-side GEM execution. EMET verifies the record, not the computation.';

function content(attr, name) {
  const found = html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`));
  assert.ok(found, name);
  return found[1];
}

function lede() {
  const found = html.match(/<p class="lede">([^<]*)<\/p>/);
  assert.ok(found, 'lede');
  return found[1];
}

function whatPanel(page) {
  const start = page.indexOf('id="what"');
  const end = page.indexOf('data-demo-mount="what"', start);
  assert.ok(start >= 0 && end > start, 'what panel');
  return page.slice(start, end);
}

function jsonLdDescription() {
  const found = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(found, 'json-ld');
  return JSON.parse(found[1]).description;
}

const surfaces = {
  lede: lede(),
  'meta description': content('name', 'description'),
  'og:description': content('property', 'og:description'),
  'twitter:description': content('name', 'twitter:description'),
  'JSON-LD description': jsonLdDescription(),
};

testGroup('the public site keeps ISO 9001 and ISO 13485', () => {
  test('the hero lede uses the repository phrase', () => {
    assert.strictEqual(surfaces.lede, LEDE);
  });

  test('the four descriptions keep 0.2.6 and the rest of each sentence', () => {
    assert.strictEqual(surfaces['meta description'], SHARED);
    assert.strictEqual(surfaces['og:description'], SHARED);
    assert.strictEqual(surfaces['twitter:description'], SHARED);
    assert.strictEqual(surfaces['JSON-LD description'], JSONLD);
  });

  for (const [name, text] of Object.entries(surfaces)) {
    test(`${name} keeps ISO 9001 and ISO 13485`, () => {
      assert.ok(text.includes('ISO 9001'), `${name} lost ISO 9001`);
      assert.ok(text.includes('ISO 13485'), `${name} lost ISO 13485`);
      assert.ok(text.includes(PHRASE), name);
    });
  }

  test('the What it is disclaimer stays and the whole page claims no ISO certification', () => {
    const what = whatPanel(html);
    assert.ok(what.includes('<dt>Document control (ISO 9001 7.5.3 / ISO 13485 4.2.5)</dt>'));
    assert.ok(what.includes(DISCLAIMER), 'disclaimer');
    assert.equal(CLAIM.test(DISCLAIMER), false, 'the disclaimer is allowed');
    assert.equal(CLAIM.test(html), false, 'site/index.html');
    for (const claim of ['ISO 13485 certified', 'EMET is ISO certified', 'ISO 9001 compliant', 'conformant to ISO 13485']) {
      assert.equal(CLAIM.test(claim), true, claim);
    }
  });
});

summary('site ISO descriptions');
