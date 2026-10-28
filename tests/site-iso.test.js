/**
 * The public site's hero lede and its four descriptions carry the repository
 * description's phrase, "built for ISO 9001 / ISO 13485 document control".
 * The lede, the meta description, og:description, twitter:description, and
 * the JSON-LD description each fail here if either standard is dropped.
 * Version 0.3.2 stays in the four descriptions.
 * The What it is disclaimer stays: no certification or conformity is claimed.
 * Noun and verb families of certify, comply, conform, and accredit fail
 * anywhere in site/index.html, including visible text, meta, and JSON-LD.
 * A hit is allowed only as one of the pinned sentences below, and only inside
 * that sentence's pinned block, so a new sentence built around an allowed
 * phrase fails, text after an allowed sentence fails, and an extra copy fails.
 * Meta, JSON-LD, and the Conformance link are not sentence fragments: each is
 * the whole normalized text node or attribute value, pinned to its count.
 * Before matching, comments are removed entirely, inline and non-breaking tags
 * (including wbr and code) leave no space, and br becomes a space. Content
 * blocks stay separate so one paragraph cannot run into the next. Numeric
 * entities and the named entities for Unicode format characters are decoded,
 * then every format character is removed.
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
const SPACE = new Set(['br', 'hr', 'img', 'image', 'input', 'embed']);
const BOUNDARY = new Set([...BREAK].filter((tag) => !SPACE.has(tag)));
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
const SHARED = 'EMET 0.3.2 is an MCP memory server built for ISO 9001 / ISO 13485 document control: persistent shared memory, verified writes, per-client approvals, and client-side GEM execution. EMET verifies the record, not the computation.';
const JSONLD = 'EMET 0.3.2 is an MCP memory server built for ISO 9001 / ISO 13485 document control: persistent shared memory, verified writes, per-client attribution and approvals, and client-side GEM execution. EMET verifies the record, not the computation.';
const CONFORMANCE_LINK = 'Conformance';
const CONFORMANCE_HREF = 'https://github.com/dreamforgestudiollc/EMET/blob/main/gem-library/CONFORMANCE.md';

const SEQUENCES = [
  [
    [
      "No delete, on any store, by design.",
      "Corrections are made by adding: entries are superseded, documents are revised or retired, and retired means obsolete, not gone.",
      "Prior versions are retained, and templates are controlled documents.",
      "EMET supports that work; it holds no certification and claims no conformity.",
    ],
    1,
  ],
  [
    [
      "emet_initialize (it can provision a missing board; it stays a read), save_to_layer, revise_memory, save_transcript, revise_transcript, emet_session_open, emet_transcript_append, emet_session_close, rename_doc, accept_nonconformance.",
      "They add.",
      "They do not remove or replace.",
      "Opening a session still needs emet.write, because it stamps the drop list a board edit trusts.",
    ],
    1,
  ],
  [
    [
      "Records, including the handoff and any id in EMET_RECORD_DOCS, are superseded whole.",
      "patch_doc is refused on them.",
      "A new revision is written in full and names the version it supersedes.",
      "Templates are controlled documents.",
      "The shipped copy governs.",
      "validate_doc checks form and continuity, and the same check runs inside the write path, where no caller can skip it.",
      "A record that fails is marked and kept, never silently accepted or discarded.",
      "It stays counted at session start until a later revision corrects it or accept_nonconformance dispositions it.",
      "Whether an answer is true is not something this check decides.",
    ],
    1,
  ],
  [
    [
      "The server provisions a blank board at setup.",
      "No session can write the board as a new document.",
      "It is edited with patch_doc and a reason.",
      "Once any working document exists, it is edited, not rewritten.",
      "A change that leaves a document under half the size it had when this session first touched it, or under half of its largest size in the last 24 hours, is refused.",
      "retire_doc refuses a working document.",
      "rename_doc issues a new id and marks the old id retired.",
      "The text stays readable and stays in the list.",
      "restore_doc is the one whole-document recovery, for an owner-listed tag, and only a stored conforming revision whose digest matches.",
      "A record is not restored.",
      "A shipped copy is never restored.",
    ],
    1,
  ],
  [
    [
      "EMET supports document-control work.",
      "It holds no certification and claims no conformity.",
      "An organization that uses it stays responsible for its own quality system, including validating EMET for its intended use.",
    ],
    1,
  ],
  [
    [
      "EMET holds no certification and claims no conformity.",
    ],
    1,
  ],
  [
    [
      "Validate with the checks in the conformance list.",
    ],
    1,
  ],
  [
    [
      "EMET holds no certification and claims no conformity.",
      "An organization that uses a GEM stays responsible for validating it for its own use.",
    ],
    1,
  ],
  [
    [
      "Conformance\n            The gem-check list, including the floor-negation lint and the released check.",
    ],
    1,
  ],
  [
    [
      "The GEM standard under review: SPEC.md (Draft, revision 2026-10-12), the schema, authoring, and conformance.",
      "A GEM loads only from gems/ inside a release, and only after gem-check.",
    ],
    1,
  ],
];

const SENTENCE_PIN = new Map([
  ["EMET supports that work; it holds no certification and claims no conformity.", 1],
  ["emet_initialize (it can provision a missing board; it stays a read), save_to_layer, revise_memory, save_transcript, revise_transcript, emet_session_open, emet_transcript_append, emet_session_close, rename_doc, accept_nonconformance.", 1],
  ["It stays counted at session start until a later revision corrects it or accept_nonconformance dispositions it.", 1],
  ["restore_doc is the one whole-document recovery, for an owner-listed tag, and only a stored conforming revision whose digest matches.", 1],
  ["It holds no certification and claims no conformity.", 1],
  ["EMET holds no certification and claims no conformity.", 2],
  ["Validate with the checks in the conformance list.", 1],
  ["Conformance\n            The gem-check list, including the floor-negation lint and the released check.", 1],
  ["The GEM standard under review: SPEC.md (Draft, revision 2026-10-12), the schema, authoring, and conformance.", 1],
]);

const SEQUENCE_PIN = new Map(SEQUENCES.map(([seq, count]) => [JSON.stringify(seq), count]));
const NODE_PIN = new Map([
  [CONFORMANCE_LINK, 1],
  [CONFORMANCE_HREF, 1],
]);

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

function attributeValues(interior) {
  const rest = interior.replace(/^\/?\s*[^\s/>]+/, '');
  const values = [];
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match;
  while ((match = re.exec(rest))) {
    const value = match[2] ?? match[3] ?? match[4];
    if (value !== undefined) values.push(value);
  }
  return values;
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

function finish(text) {
  return stripFormat(decodeEntities(text)).replace(/^\s+|\s+$/g, '');
}

function walk(text) {
  const blocks = [];
  const nodes = [];
  let prose = '';
  const anchors = [];
  const src = stripComments(text);
  let i = 0;
  const append = (chunk) => {
    prose += chunk;
    for (const anchor of anchors) anchor.buf += chunk;
  };
  const flush = () => {
    const block = finish(prose);
    if (block) blocks.push(block);
    prose = '';
  };
  while (i < src.length) {
    const found = nextTag(src, i);
    if (!found) {
      append(src.slice(i));
      break;
    }
    const [start, end] = found;
    append(src.slice(i, start));
    const interior = src.slice(start + 1, end);
    const name = tagName(interior).toLowerCase();
    const closing = /^\s*\//.test(interior);
    if (!closing) {
      for (const value of attributeValues(interior)) {
        const attr = finish(value);
        if (attr) nodes.push(attr);
      }
    }
    if (!closing && LIFTED.has(name)) {
      const rest = src.slice(end + 1);
      const close = new RegExp(`^([\\s\\S]*?)</${name}\\b[^>]*>`, 'i').exec(rest);
      if (close) {
        const whole = normalize(close[1]).trim();
        if (whole) nodes.push(whole);
        i = end + 1 + close[0].length;
        continue;
      }
    }
    if (name === 'a' && !closing) anchors.push({ buf: '' });
    if (name === 'a' && closing && anchors.length) {
      const link = finish(anchors.pop().buf);
      if (link) nodes.push(link);
    }
    if (BOUNDARY.has(name)) flush();
    else if (!closing && SPACE.has(name)) append(' ');
    i = end + 1;
  }
  flush();
  return { blocks, nodes };
}

function splitSentences(text) {
  const out = [];
  let start = 0;
  const re = /[.!?]+/g;
  let match;
  while ((match = re.exec(text))) {
    const after = text.slice(match.index + match[0].length);
    if (after.length === 0 || /^\s/.test(after)) {
      const sentence = text.slice(start, match.index + match[0].length).trim();
      if (sentence) out.push(sentence);
      const ws = /^\s*/.exec(after);
      start = match.index + match[0].length + ws[0].length;
      if (start >= text.length) break;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function hasFamily(text) {
  return new RegExp(FAMILY.source, 'i').test(text);
}

function hitsIn(text) {
  return [...text.matchAll(new RegExp(FAMILY.source, 'gi'))].map((match) => match[0]);
}

function pageWith(claim) {
  const at = html.lastIndexOf('</body>');
  return at < 0 ? html + claim : `${html.slice(0, at)}${claim}${html.slice(at)}`;
}

function familyHits(text) {
  return [...normalize(text).matchAll(new RegExp(FAMILY.source, 'gi'))].map((match) => match[0]);
}

function analyze(text) {
  const walked = walk(text);
  const sequences = [];
  const sentences = [];
  const nodes = [];
  for (const block of walked.blocks) {
    if (!hasFamily(block)) continue;
    const seq = splitSentences(block);
    sequences.push(seq);
    for (const sentence of seq) if (hasFamily(sentence)) sentences.push(sentence);
  }
  for (const node of walked.nodes) if (hasFamily(node)) nodes.push(node);
  return { sequences, sentences, nodes };
}

function tally(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function sorted(map) {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function sequenceKey(seq) {
  return JSON.stringify(seq);
}

function mark(text) {
  const hits = hitsIn(text);
  return hits.length ? hits : [text];
}

function uncovered(text) {
  const found = analyze(text);
  const bad = [];
  const seqCounts = tally(found.sequences.filter((seq) => SEQUENCE_PIN.has(sequenceKey(seq))), sequenceKey);
  const sentenceCounts = new Map();
  const nodeCounts = tally(found.nodes.filter((node) => NODE_PIN.has(node)), (node) => node);
  for (const seq of found.sequences) {
    const lone = seq.length === 1 && SENTENCE_PIN.has(seq[0]);
    if (!SEQUENCE_PIN.has(sequenceKey(seq)) && !lone) bad.push(...mark(seq.join(' ')));
    for (const sentence of seq) {
      if (!hasFamily(sentence)) continue;
      if (!SENTENCE_PIN.has(sentence)) bad.push(...mark(sentence));
      else sentenceCounts.set(sentence, (sentenceCounts.get(sentence) || 0) + 1);
    }
  }
  for (const node of found.nodes) {
    if (!NODE_PIN.has(node)) bad.push(...mark(node));
  }
  for (const [key, count] of seqCounts) {
    if (count > SEQUENCE_PIN.get(key)) bad.push(...mark(JSON.parse(key).join(' ')));
  }
  for (const [sentence, count] of sentenceCounts) {
    if (count > SENTENCE_PIN.get(sentence)) bad.push(...mark(sentence));
  }
  for (const [node, count] of nodeCounts) {
    if (count > NODE_PIN.get(node)) bad.push(...mark(node));
  }
  return bad;
}

function countSequences(text, seq) {
  const key = sequenceKey(seq);
  return analyze(text).sequences.filter((item) => sequenceKey(item) === key).length;
}

function countSentences(text, sentence) {
  return analyze(text).sentences.filter((item) => item === sentence).length;
}

function countNodes(text, node) {
  return analyze(text).nodes.filter((item) => item === node).length;
}

function oneLine(text) {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 96 ? `${flat.slice(0, 93)}...` : flat;
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

  test('the four descriptions keep 0.3.2 and the rest of each sentence', () => {
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

  test('family-sentence counts are the sentences inside the pinned blocks', () => {
    const derived = new Map();
    for (const [seq, count] of SEQUENCES) {
      for (const sentence of seq) {
        if (!hasFamily(sentence)) continue;
        derived.set(sentence, (derived.get(sentence) || 0) + count);
      }
    }
    assert.deepStrictEqual(sorted(derived), sorted(SENTENCE_PIN));
  });

  test('pinned blocks are unique', () => {
    assert.strictEqual(SEQUENCE_PIN.size, SEQUENCES.length);
  });

  test('the whole of site/index.html matches the pinned sentences and nodes', () => {
    const found = analyze(html);
    assert.deepStrictEqual(uncovered(html), []);
    assert.deepStrictEqual(sorted(tally(found.sequences, sequenceKey)), sorted(SEQUENCE_PIN));
    assert.deepStrictEqual(sorted(tally(found.sentences, (sentence) => sentence)), sorted(SENTENCE_PIN));
    assert.deepStrictEqual(sorted(tally(found.nodes, (node) => node)), sorted(NODE_PIN));
  });

  for (const [seq, count] of SEQUENCES) {
    const sentences = seq.length === 1 ? '1 sentence' : `${seq.length} sentences`;
    test(`pinned block ×${count}, ${sentences}: ${oneLine(seq.find(hasFamily) || seq[0])}`, () => {
      assert.strictEqual(countSequences(html, seq), count);
    });
  }

  for (const [sentence, count] of SENTENCE_PIN) {
    test(`passes ×${count}: ${oneLine(sentence)}`, () => {
      assert.strictEqual(countSentences(html, sentence), count, sentence);
      assert.ok(familyHits(sentence).length > 0, sentence);
      assert.deepStrictEqual(uncovered(sentence), []);
    });
  }

  for (const [node, count] of NODE_PIN) {
    test(`pinned node ×${count}: ${oneLine(node)}`, () => {
      assert.strictEqual(countNodes(html, node), count, node);
      assert.ok(familyHits(node).length > 0, node);
    });
  }

  for (const sentence of DISCLAIMER_SENTENCES) {
    test(`passes: ${sentence}`, () => {
      assert.ok(html.includes(sentence), sentence);
      assert.ok(familyHits(sentence).length > 0, sentence);
      assert.ok(SENTENCE_PIN.get(sentence) > 0, sentence);
      assert.deepStrictEqual(uncovered(sentence), []);
    });
  }

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

  const overclaims = [
    'EMET passes the ISO 13485 conformance list.',
    'EMET covers ISO 13485 authoring, and conformance.',
    'Every conforming revision is ISO 13485 approved.',
  ];
  for (const claim of overclaims) {
    test(`fails: ${claim}`, () => {
      assert.ok(uncovered(claim).length > 0, claim);
      assert.ok(uncovered(pageWith(`<p>${claim}</p>`)).length > 0, claim);
    });
  }

  test('fails: EMET has full ISO 13485 followed by the Conformance link', () => {
    const claim = `EMET has full ISO 13485 <a href="${CONFORMANCE_HREF}">${CONFORMANCE_LINK}</a>`;
    assert.ok(uncovered(claim).length > 0, uncovered(claim).join(', '));
    assert.ok(uncovered(pageWith(`<p>${claim}</p>`)).length > 0);
  });

  test('fails: text appended right after an allowed sentence', () => {
    const sentence = 'EMET holds no certification and claims no conformity.';
    const appended = `${sentence} Extra.`;
    assert.deepStrictEqual(uncovered(sentence), []);
    assert.ok(uncovered(appended).length > 0, appended);
    assert.ok(uncovered(pageWith(`<p>${appended}</p>`)).length > 0, appended);
    const changed = html.replace(`<li>${sentence}</li>`, `<li>${appended}</li>`);
    assert.notStrictEqual(changed, html);
    assert.ok(changed.includes(appended));
    assert.ok(uncovered(changed).length > 0, 'in place');
  });

  test('fails: a duplicated allowed sentence', () => {
    const sentence = 'EMET holds no certification and claims no conformity.';
    assert.strictEqual(SENTENCE_PIN.get(sentence), 2);
    assert.strictEqual(countSentences(html, sentence), 2);
    assert.deepStrictEqual(uncovered(sentence), []);
    assert.ok(uncovered(pageWith(`<p>${sentence}</p>`)).length > 0);
  });

  test('fails: a certification claim in the meta description', () => {
    const changed = html.replace(
      'name="description" content="',
      'name="description" content="EMET is ISO 13485 certified. ',
    );
    assert.notStrictEqual(changed, html);
    assert.ok(uncovered(changed).some((hit) => /certified/i.test(hit)));
  });

  test('fails: a certification claim in JSON-LD', () => {
    const changed = html.replace(
      '"description": "',
      '"description": "EMET is ISO 13485 certified. ',
    );
    assert.notStrictEqual(changed, html);
    assert.ok(uncovered(changed).some((hit) => /certified/i.test(hit)));
  });
});

summary('site ISO descriptions');
