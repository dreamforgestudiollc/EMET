/**
 * EMET - write-path invariant (THE DOOR, a decision record; work list E1).
 *
 * The guarantee EMET makes - every write attested, attributed, redacted, and
 * every absence visible - holds only if there is exactly one way to write each
 * store. This suite is the fixture that will not close on a second door.
 *
 * It scans src/ for MongoDB write verbs and fails if any occurs outside the
 * sanctioned functions below, and it asserts that each sanctioned door calls
 * the redaction scrubber before its digest. It found its first defect before
 * it existed: setup.js carried a private copy of writeDoc's archive/upsert/
 * digest/read-back sequence for the three setup documents (fixed 2026-09-07,
 * same commit). The identity-layer insert had the same history (2026-09-05).
 *
 * If this test fails, the fix is to route the write through the door, not to
 * extend the allowlist. Extending the allowlist is the decision this test
 * exists to make visible.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');


// ---------------------------------------------------------------------------
// The sanctioned doors. Keyed by file, valued by enclosing function (or
// Class.method). '*' means the whole file owns its own collections and never
// touches a layer, documents, or transcripts (verified separately below).
// ---------------------------------------------------------------------------
const SANCTIONED = {
  'database.js': new Set([
    'EmetDatabase.insertMemory',   // THE layer insert, native (2026-09-27) - reached only from saveMemory
    'EmetDatabase.nextId'          // the id counter, owned by insertMemory
  ]),
  'tools.js': new Set([
    'reviseMemory',                // supersession: marks the parent; the child goes through saveMemory
    // ADDED 2026-10-02 with the option A correction back-pointer (the owner's approval, the owner's decision record item 4).
    // Same grounds as reviseMemory and retireDoc: a MARK on an existing row, not a content write and not a
    // removal. It appends the correcting entry's id to the parent's corrected_by, leaves content, digest
    // and is_live untouched, re-attests the parent's metadata digest in the same write, and reads back.
    // The correcting entry itself goes through saveMemory.
    'markCorrectedBy',
    'saveTranscript',
    'reviseTranscript',
    'transcriptAppend',
    'writeDoc',                    // patch_doc delegates here
    // ADDED 2026-09-08 with retire_doc. It is a supersession MARK, not a
    // content write and not a removal: it sets retired/retired_at/retired_by on
    // an existing row, leaves content, version and digest untouched, and
    // re-reads to prove all three. Sanctioned on the same grounds as
    // reviseMemory, which marks a parent superseded. rename_doc has no entry
    // because it writes through writeDoc and marks through retireDoc.
    'retireDoc',
    // ADDED 2026-09-11 with accept_nonconformance. Same grounds as retireDoc,
    // and the grounds are the point rather than the convenience: it sets
    // conformance.accepted on an existing row and touches neither content,
    // version nor digest, then re-reads to prove the disposition persisted.
    //
    // It CANNOT be routed through writeDoc, and that is not a preference. An
    // acceptance covers exactly the revision it names (STANDARD 9a L6). Writing
    // it through the door would create a NEW revision, which the fresh
    // validation would immediately leave unaccepted - the acceptance would void
    // itself in the act of being recorded. rename_doc's L5 mark WAS routed
    // through the door in the same commit, because it could be; this one is
    // here because it could not be.
    'acceptNonconformance'
  ]),
  'setup.js': new Set([
    'verifyConnection'             // the connection probe: a throwaway collection, dropped in the same call
  ]),
  // ADDED 2026-09-27 with the blocked-close cap (Build 2). sessionClose still
  // writes nothing to the record: no layer, no document, no transcript. The
  // one write is a counter in `close_attempts`, keyed by base session id - the
  // server's own bookkeeping of how many times a host was told "blocked", so
  // the third time can be "escalate". It is sanctioned on the same grounds as
  // the invites and persons collections: its own collection, not memory.
  'session.js': new Set([
    'sessionClose'
  ]),
  'oauth-provider.js': '*',        // OAuth clients / codes / tokens - its own collections
  'persons.js': '*',               // persons table - not a memory layer
  'invites.js': '*',               // invite codes - not a memory layer
  // ADDED 2026-09-29 with the session graph. Its one write is the
  // session's state in `<prefix>sessions` (opened, board, episodic, handoff,
  // closed) - the server's own bookkeeping of where a session stands, read
  // before every governed write. Never a layer, a document or a transcript.
  // Its second write (2026-09-29, lab results) inserts one timestamped row
  // per check into `<prefix>graph_lab`; it never updates or removes one.
  // ADDED 2026-10-01 with the closing-exchange window: markCloseGrace sets (or,
  // when the claimed append failed, unsets) the grace marker on the session's
  // own row in `<prefix>sessions` - an atomic claim so two racing appends
  // cannot both be the closing exchange. Same collection, same grounds.
  'session-graph.js': new Set(['graphAfter', 'labRecord', 'markCloseGrace'])
};

// Doors that must scrub before they hash. The test checks the identifier
// appears inside the function body, which is the cheapest assertion that
// cannot be satisfied by accident.
const MUST_REDACT = {
  'tools.js': ['saveMemory', 'saveTranscript', 'reviseTranscript', 'writeDoc', 'transcriptAppend']
};

const WRITE_VERBS = /\.(insertOne|insertMany|updateOne|updateMany|replaceOne|bulkWrite|deleteOne|deleteMany|findOneAndUpdate|findOneAndReplace|findOneAndDelete|renameCollection|drop)\s*\(/g;

// ---------------------------------------------------------------------------
// A small scope tracker: enough JavaScript to know which top-level function
// or class method a line belongs to. Strings and comments are stripped before
// braces are counted so a '{' in a template literal does not shift the depth.
// ---------------------------------------------------------------------------
function stripNoise(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i], nx = line[i + 1];
    if (state.block) { if (ch === '*' && nx === '/') { state.block = false; i += 2; continue; } i++; continue; }
    if (state.tpl) { if (ch === '\\') { i += 2; continue; } if (ch === '`') { state.tpl = false; } i++; continue; }
    if (ch === '/' && nx === '*') { state.block = true; i += 2; continue; }
    if (ch === '/' && nx === '/') break;
    if (ch === '`') { state.tpl = true; i++; continue; }
    if (ch === '"' || ch === "'") {
      const q = ch; i++;
      while (i < line.length && line[i] !== q) { if (line[i] === '\\') i++; i++; }
      i++; continue;
    }
    out += ch; i++;
  }
  return out;
}

// Scope by INDENTATION rather than by brace counting: regex literals such as
// {1,3} in database.js's redaction rules defeat any brace counter that does
// not parse JavaScript. The tree is consistently two-space indented, so a
// column-0 line is top level and a two-space line inside a class is a method.
// A codebase reformatted to something else would fail this test loudly, which
// is the correct failure.
function scanFile(file) {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n');
  const state = { block: false, tpl: false };
  let cls = null;
  let current = '(module)';
  const hits = [];          // { line, verb, fn, text }
  const bodies = {};        // fn -> concatenated body text (for MUST_REDACT)

  lines.forEach((raw, idx) => {
    const line = stripNoise(raw, state);
    if (line.trim().length > 0) {
      const indent = line.match(/^ */)[0].length;
      let m;
      if (indent === 0) {
        if ((m = line.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
          cls = m[1]; current = '(module)';
        } else if ((m = line.match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
          cls = null; current = m[1];
        } else if ((m = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/))) {
          cls = null; current = m[1];
        } else if (/^\}/.test(line)) {
          cls = null; current = '(module)';
        }
        // Any other column-0 line (import, export {, a top-level const) is module scope,
        // but a closing bracket of a multi-line top-level object is too, so leave
        // `current` alone only when it is already module scope.
        else if (current !== '(module)' && !cls) { current = '(module)'; }
      } else if (cls && indent === 2) {
        if ((m = line.match(/^  (?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/))) {
          if (!/^(if|for|while|switch|catch|return|constructor)$/.test(m[1]) || m[1] === 'constructor') current = `${cls}.${m[1]}`;
        } else if (/^  \}/.test(line)) {
          current = '(module)';
        }
      }
    }

    // Record write verbs on the ORIGINAL line (verbs never hide in strings).
    let w;
    WRITE_VERBS.lastIndex = 0;
    while ((w = WRITE_VERBS.exec(raw)) !== null) {
      hits.push({ line: idx + 1, verb: w[1], fn: current, text: raw.trim().slice(0, 100) });
    }
    if (current !== '(module)') bodies[current] = (bodies[current] || '') + raw + '\n';
  });
  return { hits, bodies };
}

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js'));
const scans = Object.fromEntries(files.map(f => [f, scanFile(f)]));

testGroup('Exactly one door per store: no MongoDB write verb outside a sanctioned function', () => {
  for (const file of files) {
    const rule = SANCTIONED[file];
    const { hits } = scans[file];
    test(`${file}: ${hits.length} write call(s), all sanctioned`, () => {
      if (rule === '*') return;
      const allowed = rule || new Set();
      const bad = hits.filter(h => !allowed.has(h.fn));
      assert.strictEqual(bad.length, 0,
        'unsanctioned write(s):\n' + bad.map(h => `          ${file}:${h.line} in ${h.fn}: ${h.text}`).join('\n') +
        '\n        Route the write through saveMemory / writeDoc / saveTranscript. Do not extend the allowlist.');
    });
  }
  test('every sanctioned door still exists and still writes (a stale allowlist is a blind test)', () => {
    for (const [file, rule] of Object.entries(SANCTIONED)) {
      if (rule === '*') continue;
      const fns = new Set(scans[file].hits.map(h => h.fn));
      for (const fn of rule) assert.ok(fns.has(fn), `${file}: sanctioned door ${fn} has no write call - remove it from the allowlist or restore it`);
    }
  });
});

testGroup('The layer insert is reachable only through saveMemory', () => {
  const all = Object.fromEntries(files.map(f => [f, fs.readFileSync(path.join(SRC, f), 'utf8')]));
  // 2026-09-27 (code audit 1.7, stage 1): the layer insert is native. insertMemory is
  // the door, called from saveMemory only; the INSERT-string path has no callers left.
  test('insertMemory is called from saveMemory and nowhere else', () => {
    const callers = [];
    for (const [f, src] of Object.entries(all)) {
      src.split('\n').forEach((l, i) => { if (/\binsertMemory\s*\(/.test(l) && !/async\s+insertMemory/.test(l)) callers.push(`${f}:${i + 1}`); });
    }
    assert.deepStrictEqual(callers.map(c => c.split(':')[0]), ['tools.js'], `insertMemory callers: ${callers.join(', ')}`);
    const saveBody = scans['tools.js'].bodies.saveMemory || '';
    assert.match(saveBody, /\binsertMemory\s*\(/, 'saveMemory does not call insertMemory');
    const elsewhere = Object.entries(scans['tools.js'].bodies)
      .filter(([name, body]) => name !== 'saveMemory' && /\binsertMemory\s*\(/.test(body))
      .map(([name]) => name);
    assert.deepStrictEqual(elsewhere, [], `insertMemory also appears in: ${elsewhere.join(', ')}`);
  });
  test('the writer builds no INSERT string (the parser in database.js goes with the translator, stage 2)', () => {
    const code = all['tools.js'].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/INSERT INTO memories/.test(code), 'tools.js still builds an INSERT string');
  });
  test('writeRecord has no callers (kept only until the SQL translator goes)', () => {
    const callers = [];
    for (const [f, src] of Object.entries(all)) {
      src.split('\n').forEach((l) => { if (/\bwriteRecord\s*\(/.test(l) && !/async\s+writeRecord/.test(l)) callers.push(f); });
    }
    assert.deepStrictEqual(callers, [], `writeRecord callers: ${callers.join(', ')}`);
  });
  test('executeWrite is called only from writeRecord / the shim inside database.js', () => {
    const callers = [];
    for (const [f, src] of Object.entries(all)) {
      src.split('\n').forEach((l, i) => { if (/\bexecuteWrite\s*\(/.test(l) && !/async\s+executeWrite/.test(l)) callers.push(f); });
    }
    assert.ok(callers.every(f => f === 'database.js'), `executeWrite callers outside database.js: ${callers.filter(f => f !== 'database.js').join(', ')}`);
  });
  // ⭐ THE STORE HAS NO DELETE. the user's decision, 2026-09-08, on ISO grounds:
  // document control retains and marks obsolete, it does not remove, and
  // "recoverable from an archive" does not satisfy a retention requirement.
  // The layers already worked this way; the document store now does too.
  // A delete_doc was written and backed out before it ever shipped - this test
  // is what stops it, or anything like it, coming back quietly.
  test('nothing in the memory or document stores is ever removed', () => {
    const offenders = [];
    for (const f of Object.keys(all)) {
      for (const hit of scans[f].hits) {
        if (!/^delete(One|Many)$|^drop$/.test(hit.verb)) continue;
        if (f === 'oauth-provider.js') continue;          // its own short-lived auth collections
        if (f === 'setup.js' && hit.fn === 'verifyConnection') continue;  // throwaway probe, dropped in the same call
        offenders.push(`${f}:${hit.line} in ${hit.fn}: ${hit.text}`);
      }
    }
    assert.deepStrictEqual(offenders, [],
      `removal found in a store that must only ever be added to:\n  ${offenders.join('\n  ')}` +
      '\n        Supersede, retire, or revise. Do not delete, and do not add an exemption here.');
  });
  test('retireDoc marks obsolete without touching content, version or digest', () => {
    const body = (all['tools.js'].match(/export async function retireDoc[\s\S]*?\r?\n\}\r?\n/) || [''])[0];
    assert.ok(body.length > 0, 'retireDoc not found in tools.js');
    assert.ok(!/deleteOne|deleteMany|\bdrop\(/.test(body), 'retireDoc must not remove anything');
    assert.ok(!/\bcontent\s*:/.test(body), 'retireDoc must not write content');
    assert.ok(/sha256 !== doc\.sha256/.test(body), 'no read-back proving the digest was not altered');
    assert.ok(/version !== doc\.version/.test(body), 'no read-back proving the version was not altered');
  });
  test('a retired document is still readable, and says that it is obsolete', () => {
    const body = (all['tools.js'].match(/export async function readDoc[\s\S]*?\r?\n\}\r?\n/) || [''])[0];
    assert.ok(/doc\.content/.test(body), 'read_doc must return the content of a retired document');
    assert.ok(/retired: true/.test(body), 'read_doc must flag a retired document as obsolete');
  });
  test('oauth-provider.js never touches a layer, documents, or transcripts collection', () => {
    const src = all['oauth-provider.js'];
    assert.ok(!/collection\(\s*['"`](?:transcripts|documents|documents_history)['"`]/.test(src));
    assert.ok(!/COLLECTION_PREFIX\s*\+\s*['"`](?:episodic|semantic|procedural|meta|identity|working)/.test(src));
    assert.ok(!/\$\{COLLECTION_PREFIX\}(?:episodic|semantic|procedural|meta|identity|working)/.test(src));
  });
});

testGroup('Every door scrubs secrets before it hashes', () => {
  for (const [file, fns] of Object.entries(MUST_REDACT)) {
    for (const fn of fns) {
      test(`${file}: ${fn} calls the redaction scrubber`, () => {
        const body = scans[file].bodies[fn];
        assert.ok(body, `${fn} not found in ${file}`);
        assert.ok(/redact(WithReport|Deep|Text)\s*\(/.test(body), `${fn} does not call redactWithReport/redactDeep/redactText`);
        // The digest must be computed from the scrubbed text: the scrub call
        // has to come before the first digest( call in the body.
        const scrubAt = body.search(/redact(WithReport|Deep|Text)\s*\(/);
        const digestAt = body.search(/\bdigest\s*\(/);
        if (digestAt >= 0) assert.ok(scrubAt < digestAt, `${fn}: digest() is computed before the scrub`);
      });
    }
  }
  test('the logger scrubs its rendered line', () => {
    // StructuredLogger moved out of index.js into logger.js on 2026-09-13 so the
    // HTTP transport could use it instead of a stub. The invariant is unchanged.
    const src = fs.readFileSync(path.join(SRC, 'logger.js'), 'utf8');
    assert.ok(/redactText\(this\._formatOutput\(/.test(src), 'StructuredLogger._write must wrap _formatOutput in redactText');
  });
});

test('a document write and a layer write leave both rows and call no delete', async () => {
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
  const { makeStore, withStore } = await import('./memstore.js');
  const { writeDoc, saveMemory } = await import('../src/tools.js');
  const { EmetDatabase } = await import('../src/database.js');
  const store = makeStore();
  await withStore(store, async () => {
    const db = new EmetDatabase(null);
    await writeDoc('drops/audit-stays.md', 'this drop stays in the store', 'audit');
    await saveMemory(db, 'a working note that stays', 'working', { source: 'audit' }, null, null);
    assert.ok(store.doc('drops/audit-stays.md'), 'the document row is gone');
    assert.ok(store.collection('emet_working').docs.some((d) => d.content === 'a working note that stays'), 'the layer row is gone');
    const removal = store.writes.filter((w) => /\bdelete|\bdrop\b/.test(w));
    assert.deepStrictEqual(removal, [], `a write removed a row: ${removal.join(', ')}`);
  });
});

summary('Write-Path Invariant Test Summary');
