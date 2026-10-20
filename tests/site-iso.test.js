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
 * Before matching, comments are removed entirely, inline and non-breaking tags
 * (including wbr and code) leave no space, and only block-level tags and br
 * become a space. Numeric entities and the named entities for Unicode format
 * characters are decoded, then every format character is removed.
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
const BREAK = new Set([
  'address', 'article', 'aside', 'audio', 'blockquote', 'body', 'br', 'canvas', 'caption',
  'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head',
  'header', 'hgroup', 'hr', 'html', 'iframe', 'img', 'image', 'input', 'legend', 'li',
  'main', 'math', 'menu', 'nav', 'object', 'ol', 'optgroup', 'option', 'p', 'picture',
  'pre', 'search', 'section', 'select', 'summary', 'svg', 'table', 'tbody', 'td',
  'textarea', 'tfoot', 'th', 'thead', 'title', 'tr', 'ul', 'video',
]);
const LIFTED = new Set(['script', 'style', 'template']);
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
  ApplyFunction: '\u2061', InvisibleComma: '\u2063', InvisibleTimes: '\u2062',
  NegativeMediumSpace: '\u200B', NegativeThickSpace: '\u200B', NegativeThinSpace: '\u200B',
  NegativeVeryThinSpace: '\u200B', NoBreak: '\u2060', ZeroWidthSpace: '\u200B',
  af: '\u2061', ic: '\u2063', it: '\u2062', lrm: '\u200E', rlm: '\u200F', shy: '\u00AD',
  zwj: '\u200D', zwnj: '\u200C',
};
const PAGE_JOINS = [
  ['cert<!-- -->ified', 'cert<!-- -->ified'],
  ['cert<wbr>ified', 'cert<wbr>ified'],
  ['cert&ZeroWidthSpace;ified', 'cert&ZeroWidthSpace;ified'],
  ['<code>certified</code>', '<code>certified</code>'],
];
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
    .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (all, name) => (Object.hasOwn(NAMED, name) ? NAMED[name] : all))
    .replace(/&shy(?![A-Za-z0-9;])/g, '\u00AD');
}

function stripFormat(text) {
  return text.replace(/\p{Cf}/gu, '');
}

function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
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

function splitTags(text) {
  const side = [];
  let out = '';
  let i = 0;
  while (i < text.length) {
    const found = nextTag(text, i);
    if (!found) {
      out += text.slice(i);
      break;
    }
    const [start, end] = found;
    out += text.slice(i, start);
    const interior = text.slice(start + 1, end);
    const name = tagName(interior).toLowerCase();
    const closing = /^\s*\//.test(interior);
    if (!closing && LIFTED.has(name)) {
      side.push(attributesOf(interior));
      const rest = text.slice(end + 1);
      const close = new RegExp(`^([\\s\\S]*?)</${name}\\b[^>]*>`, 'i').exec(rest);
      if (close) {
        side.push(close[1]);
        i = end + 1 + close[0].length;
        continue;
      }
    }
    side.push(attributesOf(interior));
    out += BREAK.has(name) ? ' ' : '';
    i = end + 1;
  }
  return { flow: out, side };
}

function normalize(text) {
  const parts = [];
  const visit = (src) => {
    const { flow, side } = splitTags(stripComments(src));
    parts.push(flow);
    for (const piece of side) visit(piece);
  };
  visit(text);
  return stripFormat(decodeEntities(parts.join('\n')));
}

function pageWith(claim) {
  const at = html.lastIndexOf('</body>');
  return at < 0 ? html + claim : `${html.slice(0, at)}${claim}${html.slice(at)}`;
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

  for (const [name, claim] of PAGE_JOINS) {
    test(`fails on the page: ${name}`, () => {
      const hits = uncovered(pageWith(claim));
      assert.ok(hits.some((hit) => /certified/i.test(hit)), `${name}: ${hits.join(', ')}`);
    });
  }

  for (const name of ['NegativeThinSpace', 'zwj', 'zwnj', 'NoBreak', 'shy', 'lrm', 'ApplyFunction']) {
    test(`fails on the page: cert&${name};ified`, () => {
      const hits = uncovered(pageWith(`cert&${name};ified`));
      assert.ok(hits.some((hit) => /certified/i.test(hit)), name);
    });
  }

  test('fails on the page: <pre>certified</pre>', () => {
    const hits = uncovered(pageWith('<pre>certified</pre>'));
    assert.ok(hits.some((hit) => /certified/i.test(hit)), hits.join(', '));
  });

  test('nit: a br split does not join cert and ified', () => {
    assert.deepStrictEqual(uncovered('cert<br>ified'), []);
    assert.deepStrictEqual(uncovered(pageWith('cert<br>ified')), []);
    assert.ok(uncovered(pageWith('<br>certified')).some((hit) => /certified/i.test(hit)));
  });

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
