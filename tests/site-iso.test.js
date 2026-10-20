/**
 * The public site's hero lede and its four descriptions carry the repository
 * description's phrase, "built for ISO 9001 / ISO 13485 document control".
 * The lede, the meta description, og:description, twitter:description, and
 * the JSON-LD description each fail here if either standard is dropped.
 * Version 0.2.6 stays in the four descriptions.
 * The What it is disclaimer stays: no certification or conformity is claimed.
 * Noun and verb families of certify, comply, conform, and accredit fail
 * anywhere in site/index.html, including visible text, meta, and JSON-LD.
 * Exact allowlisted phrases pass. The patterns are not narrowed to spare them.
 * Matching uses the same normalization as the RUNE guard in site-tabs.test.js:
 * decode numeric and named entities, drop soft hyphens and zero-width characters,
 * and remove inline tags so a split word is one word.
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
const FAMILY = /certif\w*|compl(?:ies|ied|ying|iance|iant|y)|conform\w*|accredit\w*/gi;
const ALLOWED = [
  'holds no certification and claims no conformity',
  'accept_nonconformance',
  'conformance list',
  'CONFORMANCE.md',
  'conforming revision',
  'gem-library/CONFORMANCE.md">Conformance</a>',
  'authoring, and conformance',
];
const DISCLAIMER_SENTENCES = [
  DISCLAIMER,
  'It holds no certification and claims no conformity.',
  'EMET holds no certification and claims no conformity.',
];
const FORBIDDEN = [
  'EMET holds ISO 13485 certification.',
  'EMET conforms to ISO 9001.',
  'EMET complies with ISO 13485.',
  'Full ISO 13485 compliance.',
  'in conformity with ISO 9001',
  'We certify',
  'ISO-accredited',
];
const DISGUISED = [
  ['cer&#116;ified', 'cer&#116;ified'],
  ['cer&#x74;ified', 'cer&#x74;ified'],
  ['certi&shy;fied', 'certi&shy;fied'],
  ['certi + U+00AD + fied', 'certi\u00ADfied'],
  ['cert + U+200B + ified', 'cert\u200Bified'],
  ['<b>cert</b>ified', '<b>cert</b>ified'],
  ['&#99;ompliant', '&#99;ompliant'],
];
const PHRASING = /^(?:a|abbr|b|bdi|bdo|cite|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var)$/i;
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

function decodeEntities(text) {
  const char = (code) => (code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '');
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => char(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => char(Number(dec)))
    .replace(/&shy;/gi, '\u00AD')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function stripInvisibles(text) {
  return text.replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF\u180E]/g, '');
}

function tagEnd(text, start) {
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') return i;
  }
  return -1;
}

function nextTag(text, from) {
  let i = text.indexOf('<', from);
  while (i !== -1) {
    const end = tagEnd(text, i);
    if (end !== -1) return [i, end];
    i = text.indexOf('<', i + 1);
  }
  return null;
}

function tagName(interior) {
  const name = /^\/?\s*([^\s/>]+)/.exec(interior);
  return name ? name[1] : '';
}

function attributesOf(interior) {
  return interior.replace(/^\/?\s*[^\s/>]+/, ' ');
}

function selfClosing(interior) {
  return /\/\s*$/.test(interior.replace(/"[^"]*"|'[^']*'/g, ''));
}

function proseOutsideCode(text) {
  const exposed = [];
  let markup = text.replace(/<!--([\s\S]*?)-->/g, (_, body) => {
    exposed.push(body);
    return ' ';
  });
  let i = 0;
  while (i < markup.length) {
    const found = nextTag(markup, i);
    if (!found) break;
    const [start, end] = found;
    const interior = markup.slice(start + 1, end);
    const name = tagName(interior);
    const after = markup.slice(end + 1);
    const plain = /^code$/i.test(name) && interior[0] !== '/' && !selfClosing(interior)
      ? /^([^<]*)<\/code>/i.exec(after)
      : null;
    if (plain) {
      exposed.push(attributesOf(interior));
      markup = `${markup.slice(0, start)} ${after.slice(plain[0].length)}`;
      i = start;
      continue;
    }
    i = end + 1;
  }
  let out = '';
  i = 0;
  while (i < markup.length) {
    const found = nextTag(markup, i);
    if (!found) {
      out += markup.slice(i);
      break;
    }
    const [start, end] = found;
    const interior = markup.slice(start + 1, end);
    exposed.push(attributesOf(interior));
    out += markup.slice(i, start);
    out += PHRASING.test(tagName(interior)) ? '' : ' ';
    i = end + 1;
  }
  return stripInvisibles(decodeEntities(`${exposed.join('\n')}\n${out}`));
}

function normalize(text) {
  return proseOutsideCode(text);
}

function familyHits(text) {
  return [...normalize(text).matchAll(new RegExp(FAMILY.source, 'gi'))].map((match) => match[0]);
}

function maskFamily(phrase) {
  return phrase.replace(new RegExp(FAMILY.source, 'gi'), (hit) => ' '.repeat(hit.length));
}

function maskAllowed(text) {
  const phrases = [...ALLOWED].sort((a, b) => b.length - a.length);
  let out = text;
  for (const phrase of phrases) {
    let from = 0;
    let built = '';
    while (from < out.length) {
      const at = out.indexOf(phrase, from);
      if (at < 0) {
        built += out.slice(from);
        break;
      }
      built += out.slice(from, at) + maskFamily(phrase);
      from = at + phrase.length;
    }
    out = built;
  }
  return out;
}

function uncovered(text) {
  return familyHits(maskAllowed(text));
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

  test('the What it is disclaimer stays', () => {
    const what = whatPanel(html);
    assert.ok(what.includes('<dt>Document control (ISO 9001 7.5.3 / ISO 13485 4.2.5)</dt>'));
    assert.ok(what.includes(DISCLAIMER), 'disclaimer');
  });

  test('the whole of site/index.html has no unallowlisted certify, comply, conform, or accredit hit', () => {
    assert.deepStrictEqual(uncovered(html), []);
  });

  for (const claim of FORBIDDEN) {
    test(`fails: ${claim}`, () => {
      assert.ok(uncovered(claim).length > 0, claim);
    });
  }

  for (const [name, claim] of DISGUISED) {
    test(`fails: ${name}`, () => {
      assert.ok(uncovered(claim).length > 0, name);
    });
  }

  for (const sentence of DISCLAIMER_SENTENCES) {
    test(`passes: ${sentence}`, () => {
      assert.ok(html.includes(sentence), sentence);
      assert.ok(familyHits(sentence).length > 0, sentence);
      assert.deepStrictEqual(uncovered(sentence), []);
    });
  }

  for (const phrase of ALLOWED) {
    test(`passes: ${phrase}`, () => {
      assert.ok(html.includes(phrase), phrase);
      assert.ok(familyHits(phrase).length > 0, phrase);
      assert.deepStrictEqual(uncovered(phrase), []);
    });
  }
});

summary('site ISO descriptions');
