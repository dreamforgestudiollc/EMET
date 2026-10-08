/**
 * EMET - what the paste block alone could not reach (2026-09-26).
 *
 * No database. The proof of concept of 2026-09-26 ran an established install on
 * the repo's one-time paste block alone and found six gaps between what the
 * server served and what the install had been doing by hand. The user ruled
 * them fixed in the product. Each group below guards one fix:
 *   1. install notes and session ids  - hostSetupInstructions, installDoc
 *   2. source tags                    - hostSetupInstructions, registeredSourceTags
 *   3. the paste block's close order  - docs/BOOTSTRAP.md defers to the server
 *   4. seeds and threads              - summarizeSeed, seedsAndThreadsInstructions
 *   6. a board too long for one read  - pageContent, the read_doc schema
 *      (pages in UTF-8 bytes, never splitting a character - 2026-10-03)
 * (5, the user's delivery preferences, was store content - bootstrap/USER.md -
 * not code, and is not tested here.)
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { readyInstructions, startupListInstructions, hostSetupInstructions,
         seedsAndThreadsInstructions, summarizeSeed, installDoc, registeredSourceTags,
         charterPayload, shortInstructions, seedLine } from '../src/setup.js';
import { pageContent, READ_DOC_PAGE_DEFAULT, READ_DOC_ENVELOPE_SPARE, jsonEscapedBytes, TOOLS } from '../src/tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');




function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

testGroup('1-2. Host setup - install notes, session ids, source tags', () => {
  const host = hostSetupInstructions();
  for (const [label, re] of [
    ['it runs before the startup list', /Before the startup list/],
    ['it follows the install notes when present', /If `install_notes` is\s+present/],
    ['it runs their checks in their order', /run the checks it\s+names, in its order/],
    ['it mints a session id', /Mint a session id/],
    ['the id form can be set by the install notes', /unless `install_notes` sets another/],
    ['the server tag wins when set', /`source_tag` when the server has one/],
    ['then the install notes\' tag', /otherwise the tag `install_notes` gives this/],
    ['then a registered tag, said aloud', /otherwise the tag bootstrap\/INSTALL\.md gives this host, named once to the user/],
    ['an untagged write is named for what it is', /untagged write is ambiguity, not attribution/]
  ]) {
    test(label, () => assert.match(host, re));
  }
  test('both forms carry it, before the startup list', () => {
    for (const form of [readyInstructions(true), readyInstructions(false)]) {
      assert(form.includes(host), 'host setup missing');
      assert(form.indexOf(host) < form.indexOf(startupListInstructions()), 'host setup after the list');
    }
  });
  test('the install document defaults to bootstrap/INSTALL.md', () =>
    withEnv({ EMET_INSTALL_DOC: undefined, CASCADE_INSTALL_DOC: undefined }, () =>
      assert.strictEqual(installDoc(), 'bootstrap/INSTALL.md')));
  test('the install document follows EMET_INSTALL_DOC', () =>
    withEnv({ EMET_INSTALL_DOC: 'notes/HOSTS.md' }, () => assert.strictEqual(installDoc(), 'notes/HOSTS.md')));
  test('registered tags parse from EMET_SOURCE_TAGS, blanks dropped', () =>
    withEnv({ EMET_SOURCE_TAGS: ' mobile, cloud-host,,cli ' }, () =>
      assert.deepStrictEqual(registeredSourceTags(), ['mobile', 'cloud-host', 'cli'])));
  test('no registry is an empty list, not an error', () =>
    withEnv({ EMET_SOURCE_TAGS: undefined, CASCADE_SOURCE_TAGS: undefined }, () =>
      assert.deepStrictEqual(registeredSourceTags(), [])));
});

testGroup('3. The paste block defers to the served close order', () => {
  const brief = fs.readFileSync(path.join(ROOT, 'docs', 'BOOTSTRAP.md'), 'utf8');
  const start = brief.indexOf('## Memory');
  const block = brief.slice(start, brief.indexOf('```', start));
  test('the block is found', () => assert(start > 0 && block.length > 200, 'no block'));
  test('it no longer lists its own close order (handoff first)', () =>
    assert.doesNotMatch(block, /write the handoff, the state, the episodic entry/));
  test('it points at the protocol the server serves', () =>
    assert.match(block, /session_close_protocol/));
  test('it still ends at emet_session_close returning "complete"', () =>
    assert.match(block, /emet_session_close[\s\S]*"complete"/));
});

const SEED_REV11 = [
  '---',
  'template: templates/SEED.md rev 11',
  'trigger:',
  '  - kind: SIGNAL',
  '    test: a session starts on DESKTOP-A - checked at startup',
  '  - kind: DATE',
  '    test: 2026-11-01 - backstop before the due date',
  'status: DORMANT',
  'planted: 2026-09-23',
  '---',
  '',
  '# SEED - Switch the registered agent',
  ''
].join('\r\n');

testGroup('4. Seeds indexed for the startup scan; threads listed', () => {
  const before = summarizeSeed('seeds/a.md', SEED_REV11, '2026-09-26');
  test('status is read', () => assert.strictEqual(before.status, 'DORMANT'));
  test('title is read (CRLF tolerated)', () => assert.strictEqual(before.title, 'SEED - Switch the registered agent'));
  test('both triggers are read, kind and test', () => {
    assert.strictEqual(before.triggers.length, 2);
    assert.strictEqual(before.triggers[0].kind, 'SIGNAL');
    assert.match(before.triggers[0].test, /DESKTOP-A/);
  });
  test('a DATE trigger not yet reached is not due', () => {
    assert.strictEqual(before.triggers[1].date, '2026-11-01');
    assert.strictEqual(before.triggers[1].due, false);
    assert.strictEqual(before.due, false);
  });
  test('a DATE trigger reached on the day is due', () =>
    assert.strictEqual(summarizeSeed('seeds/a.md', SEED_REV11, '2026-11-01').due, true));
  test('a SIGNAL trigger is left to the model - never marked due by the server', () =>
    assert.strictEqual(summarizeSeed('seeds/a.md', SEED_REV11, '2030-01-01').triggers[0].due, undefined));
  test('an older scalar trigger is still surfaced', () => {
    const s = summarizeSeed('seeds/b.md', '---\ntrigger: when the repo is public\nplanted: 2026-05-01\n---\n# B');
    assert.deepStrictEqual(s.triggers, [{ kind: null, test: 'when the repo is public' }]);
  });
  test('no front matter is an empty scan, not an error', () => {
    const s = summarizeSeed('seeds/c.md', '# Just a title\n\ntext');
    assert.deepStrictEqual([s.status, s.triggers.length, s.due, s.title], [null, 0, false, 'Just a title']);
  });
  test('null content does not throw', () => assert.strictEqual(summarizeSeed('seeds/d.md', null).due, false));
  const list = startupListInstructions();
  test('the startup list tells the model to scan seeds and name what fired', () => {
    assert(list.includes(seedsAndThreadsInstructions()));
    assert.match(list, /name any that fired,\s+with its first step/);
  });
  test('threads are read when pointed at, not all at once', () =>
    assert.match(list, /read one when the handoff, the board or the user points at it/));
});

testGroup('6. read_doc pages a long document', () => {
  const text = 'abcdefghij'.repeat(10); // 100 chars
  // A limit that leaves n bytes of JSON-escaped page: the envelope spare and the two quotes come first.
  const L = (n) => READ_DOC_ENVELOPE_SPARE + 2 + n;
  test('no page requested: the whole document, no page block', () => {
    const r = pageContent(text);
    assert.strictEqual(r.content, text); assert.strictEqual(r.page, null);
  });
  test('limit 0 is the whole document', () => assert.strictEqual(pageContent(text, 0, 0).page, null));
  test('a page larger than the document is no page', () => assert.strictEqual(pageContent(text, 0, L(1000)).page, null));
  test('first page carries next_offset and the whole size', () => {
    const r = pageContent(text, 0, L(40));
    assert.strictEqual(r.content, text.slice(0, 40));
    assert.deepStrictEqual([r.page.offset, r.page.returned, r.page.size, r.page.next_offset], [0, 40, 100, 40]);
    assert.deepStrictEqual([r.page.returned_escaped, r.page.envelope_spare, r.page.size_bytes], [42, READ_DOC_ENVELOPE_SPARE, 100]);
  });
  test('following next_offset reassembles the document exactly', () => {
    let out = ''; let off = 0; let guard = 0;
    do { const r = pageContent(text, off, L(33)); out += r.content; off = r.page ? r.page.next_offset : null; guard++; }
    while (off !== null && guard < 10);
    assert.strictEqual(out, text);
  });
  test('the last page says so', () => {
    const r = pageContent(text, 80, L(40));
    assert.strictEqual(r.page.next_offset, null); assert.match(r.page.note, /Final page/);
  });
  test('an offset past the end is an empty final page, not an error', () => {
    const r = pageContent(text, 500, L(40));
    assert.strictEqual(r.content, ''); assert.strictEqual(r.page.next_offset, null);
  });
  test('the default page is 18,000 bytes', () => assert.strictEqual(READ_DOC_PAGE_DEFAULT, 18000));
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  const allPages = (doc, limit) => {
    const pages = []; let off = 0; let guard = 0;
    do { const r = pageContent(doc, off, limit); pages.push(r); off = r.page ? r.page.next_offset : null; guard++; }
    while (off !== null && guard < 10000);
    return pages;
  };
  test('a multibyte character at a page edge is not split', () => {
    const doc = 'abcd\u00e9fgh\u{1F600}ijk'; // e-acute 2 bytes at bytes 4-5, emoji 4 bytes at 9-12
    const r1 = pageContent(doc, 0, L(5)); // byte 5 is inside the e-acute
    assert.strictEqual(r1.content, 'abcd'); assert.deepStrictEqual([r1.page.returned, r1.page.next_offset], [4, 4]);
    const r2 = pageContent(doc, 4, L(7)); // bytes 4-10 would end inside the emoji
    assert.strictEqual(r2.content, '\u00e9fgh'); assert.strictEqual(r2.page.next_offset, 9);
    const r3 = pageContent(doc, 9, L(2)); // limit smaller than the character still moves forward
    assert.strictEqual(r3.content, '\u{1F600}'); assert.strictEqual(r3.page.next_offset, 13);
    const r4 = pageContent(doc, 11, L(100)); // an offset inside a character starts at its first byte
    assert.strictEqual(r4.page.offset, 9); assert.strictEqual(r4.content, '\u{1F600}ijk');
    assert.strictEqual(r4.page.size, bytes(doc)); assert.strictEqual(r4.page.unit, 'bytes');
    for (const r of [r1, r2, r3, r4]) assert(!r.content.includes('\uFFFD'));
  });
  test('joining every page gives back the document exactly, sha256 matching', () => {
    const doc = ('Board \u2014 Row \u00e9t\u00e9 \u65e5\u672c\u8a9e \u{1F600}\u{1F30A} line\n').repeat(400);
    for (const limit of [L(7), L(100), L(1001), 18000]) {
      const pages = allPages(doc, limit);
      const joined = pages.map((r) => r.content).join('');
      assert.strictEqual(joined, doc); assert.strictEqual(sha(joined), sha(doc));
      assert.strictEqual(pages.reduce((a, r) => a + bytes(r.content), 0), bytes(doc));
      for (const r of pages) if (r.page) {
        assert.strictEqual(r.page.returned, bytes(r.content));
        assert.strictEqual(r.page.returned_escaped, jsonEscapedBytes(r.content));
      }
    }
  });
  test('a ~50 KB document comes back in pages whose escaped size plus the spare is at most 18,000 bytes', () => {
    const doc = ('| Row | caf\u00e9 \u2014 \u65e5\u672c \u{1F600} | OPEN | next action here |\n').repeat(880);
    assert(bytes(doc) > 48000 && bytes(doc) < 60000, `doc is ${bytes(doc)} bytes`);
    const pages = allPages(doc, READ_DOC_PAGE_DEFAULT);
    assert(pages.length >= 3, `${pages.length} pages`);
    for (const r of pages) {
      assert(bytes(r.content) <= 18000, `page of ${bytes(r.content)} bytes`);
      assert(jsonEscapedBytes(r.content) + READ_DOC_ENVELOPE_SPARE <= 18000, `page of ${jsonEscapedBytes(r.content)} escaped bytes`);
    }
    assert.match(pages[0].page.note, /Partial/); assert.match(pages.at(-1).page.note, /Final page/);
    assert.strictEqual(sha(pages.map((r) => r.content).join('')), sha(doc));
  });
  test('limit 1 still moves forward one character per page', () => {
    const r = pageContent('ab', 0, 1);
    assert.strictEqual(r.content, 'a'); assert.strictEqual(r.page.next_offset, 1);
  });
  test('the escaped size counts what JSON adds: quotes, backslashes, newlines, tabs, control characters, lone surrogates', () => {
    const doc = 'a"b\\c\nd\te\u0001f\ud800g\u2028h\u00e9\u{1F600}';
    const r = pageContent(doc + 'x'.repeat(5000), 0, L(jsonEscapedBytes(doc) - 2));
    assert.strictEqual(r.content, doc); assert.strictEqual(r.page.returned_escaped, jsonEscapedBytes(doc));
  });
  test('the read_doc tool offers offset and limit and explains paging', () => {
    const tool = TOOLS.find((t) => t.name === 'read_doc');
    assert(tool.inputSchema.properties.offset && tool.inputSchema.properties.limit);
    assert.match(tool.description, /next_offset/);
    assert.match(tool.description, /WHOLE document/);
  });
});

testGroup('7. Charter is pointed, not pasted', () => {
  const p = charterPayload(null);
  test('content is not in the payload', () => assert.strictEqual(p.content, null));
  test('content_in_payload is false', () => assert.strictEqual(p.content_in_payload, false));
  test('sha256 of the shipped copy is still served', () => {
    const shipped = fs.readFileSync(path.join(ROOT, 'CHARTER.md'));
    const actual = crypto.createHash('sha256').update(shipped).digest('hex');
    assert.strictEqual(p.sha256, actual);
  });
  test('the note points at read_doc', () => assert.match(p.note, /read_doc/));
  test('the character form of the instructions names floor identity character user as binding', () => {
    assert.match(readyInstructions(true), /not optional/);
    assert.match(readyInstructions(true), /read_doc CHARTER.md/);
  });
});

testGroup('8. Close-order tool survives a 20k truncate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'setup.js'), 'utf8');
  const ready = src.slice(src.indexOf("state: 'ready'"));
  test('tools_in_force is declared before identity', () => {
    assert(ready.indexOf('tools_in_force') < ready.indexOf('identity:'), 'tools_in_force must precede identity');
  });
  test('session_close_protocol is declared before identity', () => {
    assert(ready.indexOf('session_close_protocol') < ready.indexOf('identity:'), 'session_close_protocol must precede identity');
  });
  test('tools_in_force is marked non_negotiable', () => {
    assert.match(ready, /non_negotiable:\s*true/);
  });
  // Code audit 2026-09-27 (2.1): the long instructions were the LAST key, at
  // the 20K-token mark. A short form now rides directly behind tools_in_force.
  test('instructions_short is declared right after tools_in_force, before identity', () => {
    const i = ready.indexOf('instructions_short:');
    assert(i > 0, 'instructions_short missing from the ready payload');
    assert(ready.indexOf('tools_in_force') < i && i < ready.indexOf('session_close_protocol:'), 'instructions_short must sit between tools_in_force and session_close_protocol');
    assert(i < ready.indexOf('identity:'));
  });
  // Code audit 2026-09-27 (2.3, the owner): seeds are served one line each.
  test('seedLine folds a seed to one line with title, status, dated cues and clipped topic cues', () => {
    const s = summarizeSeed('seeds/x.md', '---\nstatus: DORMANT\ntrigger:\n  - kind: DATE\n    test: "2026-01-01 fires on or after"\n  - kind: TOPIC\n    test: "' + 'the owner raises the thing '.repeat(20) + '"\n---\n# SEED — Example seed\n', '2026-09-27');
    const l = seedLine(s);
    assert.strictEqual(l.doc_id, 'seeds/x.md');
    assert.strictEqual(l.due, true);
    assert.match(l.line, /^Example seed — DORMANT — DATE 2026-01-01 DUE · TOPIC: the owner raises the thing/);
    assert.ok(l.line.length < 220, `line is ${l.line.length} chars`);
    assert.ok(!('triggers' in l), 'the full trigger list must not ride along');
  });
  test('the ready payload serves seeds through seedLine', () => {
    assert.match(ready, /seeds: seeds\.map\(\(s\) => seedLine\(s\)\)/);
  });
  test('the short form carries the six steps a cut must not take', () => {
    const s = shortInstructions();
    for (const must of ['emet_line', 'identity phrase', 'install_notes', 'emet_session_open', 'HANDOFF.md', 'STATE.md', 'parked', 'lessons_pending', 'question alone', 'emet_transcript_append', 'session_close_protocol', 'emet_session_close']) {
      assert(s.includes(must), `short instructions lack: ${must}`);
    }
    assert(s.length < 1400, `short form is ${s.length} chars - it is meant to be short`);
  });
});

testGroup('9. named_items reads the board and the handoff', () => {
  test('half-finished, dated, open, parked, and undecided rows are named, and a blank section is not a skip', async () => {
    const { namedItemsFrom } = await import('../src/named-items.js');
    const board = [
      '## §1 HALF-STATE',
      '| What | State it was left in | Next action | Id |',
      '|---|---|---|---|',
      '| transcript marker | untested | confirm the stamp | B-058 |',
      '## §2 DATED',
      '| Date | Item | Owner | Id |',
      '|---|---|---|---|',
      '| 2026-10-08 | dentist | user | B-070 |',
      '| 2026-12-01 | far date | user | B-071 |',
      '## §3 OPEN BOARD',
      '| Item | Status | Next action | Id |',
      '|---|---|---|---|',
      '| Contoso Health | OPEN | send the form | B-031 |',
      '| the shed | PARKED resumes when: the user raises it |  | B-040 |',
      '| waiting on the lab | WAITING |  | B-041 |'
    ].join('\n');
    const handoff = '## §1 START HERE\n- **Left undecided this session:**\n  - Ship on Friday?\n  - None.\n';
    const named = namedItemsFrom(board, handoff, '2026-10-07');
    assert.deepStrictEqual(named.half_finished.map((r) => r.name), ['transcript marker']);
    assert.strictEqual(named.dated[0].within_seven_days, true);
    assert.strictEqual(named.dated[1].within_seven_days, false);
    assert.strictEqual(named.dated[1].name, 'far date');
    assert.deepStrictEqual(named.open.map((r) => r.name), ['Contoso Health']);
    assert.strictEqual(named.parked[0].name, 'the shed');
    assert.match(named.parked[0].resumes_when, /user raises it/);
    assert.deepStrictEqual(named.waiting.map((r) => r.name), ['waiting on the lab']);
    assert.deepStrictEqual(named.undecided, ['Ship on Friday?']);
    const blank = namedItemsFrom('## §1 HALF-STATE\nNone — checked against: none yet.\n', null, '2026-10-07');
    assert.deepStrictEqual(blank.half_finished, []);
    assert.strictEqual(blank.sections.half_finished, 'unread');
    assert.notStrictEqual(blank.sections.half_finished, 'read');
    assert.match(blank.note, /marked unread/);
    assert.match(blank.note, /not a reason to skip/);
    assert.strictEqual(blank.sections.dated, 'unread');
    assert.deepStrictEqual(blank.dated, []);
    assert.strictEqual(blank.sections.undecided, 'unread');
  });
});

summary('Startup (2026-09-26) Test Summary');
