/**
 * Staged multi-part document write (BOUND init audit item 9).
 * A host that truncates a large write_doc argument sends the record in parts.
 * Commit checks the sha256 and lands through write_doc. A refused commit,
 * an abort, or an expiry leaves the current document unchanged.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { digest } from '../src/aleph.js';
import { actorStore } from '../src/persons.js';
import { dispatchTool } from '../src/dispatch.js';
import { writeDoc, readDoc, handleError } from '../src/tools.js';
import { ValidationError } from '../src/validation.js';
import { evaluate, recordStep } from '../src/session-graph.js';
import { STAGED_LIMITS } from '../src/staged-write.js';
import { makeStore, withStore, withEnv } from './memstore.js';

const SID = '2026-10-27_staged';
const REASON = 'staged close of this session';
const ada = {
  transport: 'http', personId: 'ada', clientId: 'login-9', grantId: 'fam-1', door: 'member',
  authenticated: true, scopes: ['emet.write'], sourceTag: 'grok-project'
};

function handoffBody() {
  const unit = 'Continuity note for the staged handoff. ';
  let body = '';
  while (body.length < 46402) body += unit;
  return body.slice(0, 46402);
}

function partsOf(body) {
  const out = [];
  for (let i = 0; i < body.length; i += STAGED_LIMITS.maxPartChars) out.push(body.slice(i, i + STAGED_LIMITS.maxPartChars));
  return out;
}

function parsed(res) {
  return JSON.parse(res.content[0].text);
}

function codeOf(res) {
  return parsed(res).error && parsed(res).error.emet_code;
}

function readyStore() {
  return makeStore({
    state: { opened: true, board: true, episodic: true },
    highest: 3,
    sessionId: SID
  });
}

async function asAda(db, fn) {
  return withEnv({ EMET_SOURCE_TAGS: 'grok-project' }, () => withStore(db, () => actorStore.run(ada, fn)));
}

async function call(db, name, args, now) {
  return asAda(db, () => dispatchTool(name, { session_id: SID, source: 'grok-project', ...args }, { dbManager: db, logger: null, now }));
}

async function seed(db) {
  await asAda(db, () => writeDoc('HANDOFF.md', 'short handoff v1 for the staged write test.', 'grok-project', null, null, { session_id: SID }));
}

testGroup('the handoff gate', () => {
  test('begin and commit of a handoff are early until the board, the episodic record, and the transcript exist', () => {
    for (const tool of ['write_doc_begin', 'write_doc_commit']) {
      const decision = evaluate(tool, { doc_id: 'HANDOFF.md', session_id: SID }, { opened: true }, 0);
      assert.strictEqual(decision.verdict, 'refuse', tool);
      assert.strictEqual(decision.gate, 'handoff_early', tool);
    }
  });
  test('a successful begin points at append and commit, and does not record the handoff', () => {
    const decision = evaluate('write_doc_begin', { doc_id: 'HANDOFF.md' }, { opened: true, board: true, episodic: true }, 3);
    assert.strictEqual(decision.verdict, 'ok');
    assert.match(decision.next, /write_doc_append each part in order, then write_doc_commit/);
    assert.strictEqual(recordStep('write_doc_begin', { doc_id: 'HANDOFF.md' }, { stage_id: 'stg_x' }), null);
  });
  test('a successful commit records the handoff and points at close', () => {
    const decision = evaluate('write_doc_commit', { doc_id: 'HANDOFF.md' }, { opened: true, board: true, episodic: true }, 3);
    assert.strictEqual(decision.verdict, 'ok');
    assert.match(decision.next, /emet_session_close/);
    assert.deepStrictEqual(recordStep('write_doc_commit', { doc_id: 'HANDOFF.md' }, { version: 2 }), { handoff: true, handoff_version: 2 });
  });
});

testGroup('staged handoff write', () => {
  test('three parts of a 46402-character handoff commit through write_doc and a second commit does not write again', async () => {
    const db = readyStore();
    const body = handoffBody();
    assert.strictEqual(body.length, 46402);
    const chunks = partsOf(body);
    assert.deepStrictEqual(chunks.map((part) => part.length), [16000, 16000, 14402]);
    const sha = digest(body);
    await seed(db);
    const begun = parsed(await call(db, 'write_doc_begin', { doc_id: 'HANDOFF.md', supersedes: 1, reason: REASON }));
    assert.strictEqual(begun.success, true);
    assert.match(begun.data.session_graph.next, /write_doc_append/);
    assert.strictEqual(begun.data.parts, 0);
    assert.strictEqual(begun.data.limits.max_part_chars, 16000);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.notStrictEqual(db.row(SID).handoff, true);
    let appended;
    for (let i = 0; i < chunks.length; i++) {
      appended = parsed(await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: i + 1, chunk: chunks[i] }));
      assert.strictEqual(appended.data.duplicate, false, `part ${i + 1}`);
    }
    assert.strictEqual(appended.data.parts, 3);
    assert.strictEqual(appended.data.size, 46402);
    const committed = parsed(await call(db, 'write_doc_commit', {
      stage_id: begun.data.stage_id, doc_id: 'HANDOFF.md', sha256: sha, part_count: 3
    }));
    assert.strictEqual(committed.data.version, 2);
    assert.strictEqual(committed.data.staged, true);
    assert.strictEqual(committed.data.assembled_sha256, sha);
    assert.strictEqual(committed.data.parts, 3);
    const doc = await asAda(db, () => readDoc('HANDOFF.md'));
    assert.strictEqual(doc.content, body);
    assert.strictEqual(doc.sha256, sha);
    assert.strictEqual(doc.version, 2);
    assert.strictEqual(doc.client_id, 'login-9');
    assert.strictEqual(doc.grant_id, 'fam-1');
    assert.strictEqual(doc.door, 'member');
    const history = db.collection('documents_history').docs.filter((row) => row.doc_id === 'HANDOFF.md');
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].version, 1);
    const deadline = Date.now() + 2000;
    while (db.row(SID).handoff !== true) {
      if (Date.now() > deadline) assert.fail('handoff step was not recorded');
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.strictEqual(db.row(SID).handoff_version, 2);
    const again = parsed(await call(db, 'write_doc_commit', {
      stage_id: begun.data.stage_id, doc_id: 'HANDOFF.md', sha256: sha, part_count: 3
    }));
    assert.strictEqual(again.data.already, true);
    assert.strictEqual(again.data.version, 2);
    assert.strictEqual(db.doc('HANDOFF.md').version, 2);
    assert.strictEqual(db.collection('documents_history').docs.filter((row) => row.doc_id === 'HANDOFF.md').length, 1);
  });

  test('a wrong sha256 leaves the current document and its history unchanged', async () => {
    const db = readyStore();
    const body = handoffBody();
    const chunks = partsOf(body);
    await seed(db);
    const begun = parsed(await call(db, 'write_doc_begin', { doc_id: 'HANDOFF.md', supersedes: 1, reason: REASON }));
    for (let i = 0; i < chunks.length; i++) {
      await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: i + 1, chunk: chunks[i] });
    }
    const refused = await call(db, 'write_doc_commit', {
      stage_id: begun.data.stage_id, doc_id: 'HANDOFF.md', sha256: digest('not the handoff'), part_count: 3
    });
    assert.strictEqual(codeOf(refused), 'EMET-DOC-069');
    assert.strictEqual(db.doc('HANDOFF.md').version, 1);
    assert.strictEqual(db.collection('documents_history').docs.length, 0);
    const stage = db.collection('emet_doc_stages').docs[0];
    assert.strictEqual(stage.status, 'open');
    assert.strictEqual(stage.parts.length, 3);
  });

  test('a commit that names more parts than arrived is refused', async () => {
    const db = readyStore();
    const chunks = partsOf(handoffBody());
    await seed(db);
    const begun = parsed(await call(db, 'write_doc_begin', { doc_id: 'HANDOFF.md', supersedes: 1, reason: REASON }));
    await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: 1, chunk: chunks[0] });
    await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: 2, chunk: chunks[1] });
    const refused = await call(db, 'write_doc_commit', {
      stage_id: begun.data.stage_id, doc_id: 'HANDOFF.md', sha256: digest(chunks[0] + chunks[1]), part_count: 3
    });
    assert.strictEqual(codeOf(refused), 'EMET-DOC-070');
    assert.strictEqual(db.doc('HANDOFF.md').version, 1);
    assert.strictEqual(db.collection('documents_history').docs.length, 0);
  });

  test('abort leaves the document and its history unchanged', async () => {
    const db = readyStore();
    await seed(db);
    const begun = parsed(await call(db, 'write_doc_begin', { doc_id: 'HANDOFF.md', supersedes: 1, reason: REASON }));
    await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: 1, chunk: 'a partial handoff chunk' });
    const aborted = parsed(await call(db, 'write_doc_abort', { stage_id: begun.data.stage_id }));
    assert.strictEqual(aborted.data.aborted, true);
    assert.strictEqual(aborted.data.already, false);
    const again = parsed(await call(db, 'write_doc_abort', { stage_id: begun.data.stage_id }));
    assert.strictEqual(again.data.already, true);
    assert.strictEqual(db.doc('HANDOFF.md').version, 1);
    assert.strictEqual(db.doc('HANDOFF.md').content, 'short handoff v1 for the staged write test.');
    assert.strictEqual(db.collection('documents_history').docs.length, 0);
    assert.strictEqual(db.collection('emet_doc_stages').docs[0].status, 'aborted');
    assert.deepStrictEqual(db.collection('emet_doc_stages').docs[0].parts, []);
  });

  test('an expired stage writes nothing and keeps no parts', async () => {
    const db = readyStore();
    const start = new Date('2026-10-27T15:00:00.000Z');
    const later = new Date(start.getTime() + 31 * 60 * 1000);
    await seed(db);
    const begun = parsed(await call(db, 'write_doc_begin', { doc_id: 'HANDOFF.md', supersedes: 1, reason: REASON }, start));
    await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: 1, chunk: 'still inside the window' }, start);
    const refused = await call(db, 'write_doc_commit', {
      stage_id: begun.data.stage_id, doc_id: 'HANDOFF.md', sha256: digest('still inside the window'), part_count: 1
    }, later);
    assert.strictEqual(codeOf(refused), 'EMET-DOC-061');
    assert.strictEqual(db.doc('HANDOFF.md').version, 1);
    assert.strictEqual(db.collection('documents_history').docs.length, 0);
    const stage = db.collection('emet_doc_stages').docs[0];
    assert.strictEqual(stage.status, 'expired');
    assert.deepStrictEqual(stage.parts, []);
  });

  test('a read-scoped caller is refused before a stage exists', async () => {
    const db = readyStore();
    const guest = { ...ada, scopes: ['emet.read'], door: 'guest' };
    const refused = await withEnv({ EMET_SOURCE_TAGS: 'grok-project' }, () => withStore(db, () => actorStore.run(guest, () => dispatchTool('write_doc_begin', {
      doc_id: 'HANDOFF.md', session_id: SID, source: 'grok-project', supersedes: 1, reason: REASON
    }, { dbManager: db, logger: null }))));
    assert.strictEqual(codeOf(refused), 'EMET-TOOL-005');
    assert.strictEqual(db.collection('emet_doc_stages').docs.length, 0);
    assert.strictEqual(db.doc('HANDOFF.md'), undefined);
  });

  test('an unregistered source cannot begin a handoff', async () => {
    const db = readyStore();
    const local = { personId: 'ada', clientId: 'stdio', scopes: ['emet.write'] };
    const refused = await withEnv({ EMET_SOURCE_TAGS: 'grok-project' }, () => withStore(db, () => actorStore.run(local, () => dispatchTool('write_doc_begin', {
      doc_id: 'HANDOFF.md', session_id: SID, source: 'stranger', supersedes: 1, reason: REASON
    }, { dbManager: db, logger: null }))));
    assert.strictEqual(codeOf(refused), 'EMET-DOC-014');
    assert.strictEqual(db.collection('emet_doc_stages').docs.length, 0);
  });

  test('another writer cannot append, and the owner still can', async () => {
    const db = readyStore();
    await seed(db);
    const begun = parsed(await call(db, 'write_doc_begin', { doc_id: 'HANDOFF.md', supersedes: 1, reason: REASON }));
    const bob = { ...ada, personId: 'bob', clientId: 'login-8' };
    const refused = await withEnv({ EMET_SOURCE_TAGS: 'grok-project' }, () => withStore(db, () => actorStore.run(bob, () => dispatchTool('write_doc_append', {
      stage_id: begun.data.stage_id, part: 1, chunk: 'not bob', session_id: SID, source: 'grok-project'
    }, { dbManager: db, logger: null }))));
    assert.strictEqual(codeOf(refused), 'EMET-DOC-060');
    const appended = parsed(await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: 1, chunk: 'ada owns this part' }));
    assert.strictEqual(appended.data.part, 1);
    assert.strictEqual(appended.data.duplicate, false);
  });

  test('out of order, oversized, and a changed retry are refused; the same bytes are a no-op', async () => {
    const db = readyStore();
    await seed(db);
    const begun = parsed(await call(db, 'write_doc_begin', { doc_id: 'HANDOFF.md', supersedes: 1, reason: REASON }));
    const skipped = await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: 2, chunk: 'skipped the first part' });
    assert.strictEqual(codeOf(skipped), 'EMET-DOC-065');
    const oversized = await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: 1, chunk: 'x'.repeat(16001) });
    assert.strictEqual(codeOf(oversized), 'EMET-DOC-064');
    const chunk = 'the first part, unchanged';
    const first = parsed(await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: 1, chunk }));
    assert.strictEqual(first.data.duplicate, false);
    const same = parsed(await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: '1', chunk }));
    assert.strictEqual(same.data.duplicate, true);
    assert.strictEqual(same.data.parts, 1);
    const changed = await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: 1, chunk: 'the first part, edited' });
    assert.strictEqual(codeOf(changed), 'EMET-DOC-066');
    assert.strictEqual(db.collection('emet_doc_stages').docs[0].parts.length, 1);
    assert.strictEqual(db.doc('HANDOFF.md').version, 1);
  });
});

function snap(db) {
  const docs = db.collection('documents').docs
    .map((row) => ({ id: row.doc_id, version: row.version, content: row.content }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const stages = db.collection('emet_doc_stages').docs
    .map((row) => ({
      id: row._id, doc_id: row.doc_id, status: row.status, source: row.source || null,
      parts: (row.parts || []).length, size: row.size
    }))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return JSON.stringify({ docs, history: db.collection('documents_history').docs.length, stages });
}

const OPEN_ENV = {
  EMET_SOURCE_TAGS: 'grok-project,other-host',
  EMET_STRICT_LOGIN_TAG: undefined,
  EMET_SUBKEYS: undefined,
  CASCADE_SUBKEYS: undefined
};
const STRICT_ENV = { ...OPEN_ENV, EMET_STRICT_LOGIN_TAG: '1' };
const HANDLE = `emh_${'a'.repeat(43)}`;

async function httpCall(db, tool, args, env) {
  return withEnv(env, () => withStore(db, async () => {
    const att = await import('../src/attribution.js');
    att._resetForTests();
    const actor = { ...ada };
    try {
      await actorStore.run(actor, () => att.preflight({
        db, prefix: 'emet_', ownerId: ada.personId, registry: ['grok-project', 'other-host']
      }, actor, args, tool));
    } catch (e) {
      if (e && e.attributionRefusal) {
        return actorStore.run(actor, () => handleError(new ValidationError('source', e.message, { code: 'EMET-AUTH-039' }), tool));
      }
      throw e;
    }
    return actorStore.run(actor, () => dispatchTool(tool, args, { dbManager: db, logger: null }));
  }));
}

async function armForeign(db) {
  const chunk = 'foreign stage chunk';
  const begun = parsed(await httpCall(db, 'write_doc_begin', {
    doc_id: 'notes/strict-arm.md', session_id: SID, source: 'other-host'
  }, OPEN_ENV));
  assert.strictEqual(begun.success, true, begun.error && begun.error.message);
  const appended = parsed(await httpCall(db, 'write_doc_append', {
    stage_id: begun.data.stage_id, part: 1, chunk, session_id: SID, source: 'other-host'
  }, OPEN_ENV));
  assert.strictEqual(appended.success, true, appended.error && appended.error.message);
  return { stage_id: begun.data.stage_id, sha: digest(chunk), doc_id: 'notes/strict-arm.md' };
}

async function armOwn(db) {
  const chunk = 'own stage chunk';
  const begun = parsed(await call(db, 'write_doc_begin', { doc_id: 'notes/handle-arm.md' }));
  assert.strictEqual(begun.success, true, begun.error && begun.error.message);
  const appended = parsed(await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: 1, chunk }));
  assert.strictEqual(appended.success, true, appended.error && appended.error.message);
  return { stage_id: begun.data.stage_id, sha: digest(chunk), doc_id: 'notes/handle-arm.md' };
}

function strictAttack(tool, stage) {
  const common = { session_id: SID, source: 'other-host' };
  if (tool === 'write_doc_begin') return { ...common, doc_id: 'notes/strict-next.md' };
  if (tool === 'write_doc_append') return { ...common, stage_id: stage.stage_id, part: 2, chunk: 'second part' };
  if (tool === 'write_doc_commit') return { ...common, stage_id: stage.stage_id, doc_id: stage.doc_id, sha256: stage.sha, part_count: 1 };
  return { ...common, stage_id: stage.stage_id };
}

function handleAttack(tool, stage) {
  const common = { session_id: SID, source: 'grok-project', session_handle: HANDLE };
  if (tool === 'write_doc_begin') return { ...common, doc_id: 'notes/handle-next.md' };
  if (tool === 'write_doc_append') return { ...common, stage_id: stage.stage_id, part: 2, chunk: 'second part' };
  if (tool === 'write_doc_commit') return { ...common, stage_id: stage.stage_id, doc_id: stage.doc_id, sha256: stage.sha, part_count: 1 };
  return { ...common, stage_id: stage.stage_id };
}

testGroup('staged writes are attribution writes', () => {
  const staged = ['write_doc_begin', 'write_doc_append', 'write_doc_commit', 'write_doc_abort'];
  for (const tool of staged) {
    test(`${tool} refuses a mismatched login tag under EMET_STRICT_LOGIN_TAG and writes nothing`, async () => {
      const db = readyStore();
      const stage = await armForeign(db);
      const before = snap(db);
      const refused = await httpCall(db, tool, strictAttack(tool, stage), STRICT_ENV);
      assert.strictEqual(codeOf(refused), 'EMET-AUTH-039');
      assert.match(parsed(refused).error.message, /may not write as "other-host"/);
      assert.strictEqual(snap(db), before);
    });
    test(`${tool} refuses an emh_ handle while EMET_SUBKEYS is off and writes nothing`, async () => {
      const db = readyStore();
      const stage = await armOwn(db);
      const before = snap(db);
      const refused = await httpCall(db, tool, handleAttack(tool, stage), OPEN_ENV);
      assert.strictEqual(codeOf(refused), 'EMET-AUTH-039');
      assert.match(parsed(refused).error.message, /sub-key session handle was presented/);
      assert.strictEqual(snap(db), before);
    });
  }
});

testGroup('staged limits', () => {
  test('the 129th part is refused and the stage stays at 128 parts', async () => {
    const db = readyStore();
    const docId = 'notes/staged-parts.md';
    const begun = parsed(await call(db, 'write_doc_begin', { doc_id: docId }));
    assert.strictEqual(begun.success, true, begun.error && begun.error.message);
    for (let part = 1; part <= STAGED_LIMITS.maxParts; part++) {
      const row = parsed(await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part, chunk: 'x' }));
      assert.strictEqual(row.data.parts, part);
    }
    const before = snap(db);
    const refused = await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: STAGED_LIMITS.maxParts + 1, chunk: 'x' });
    assert.strictEqual(codeOf(refused), 'EMET-DOC-068');
    assert.strictEqual(snap(db), before);
    assert.strictEqual(db.collection('emet_doc_stages').docs[0].parts.length, STAGED_LIMITS.maxParts);
    assert.strictEqual(db.doc(docId), undefined);
  });

  test('one character past the total size limit is refused and the stage stays at the limit', async () => {
    const db = readyStore();
    const docId = 'notes/staged-size.md';
    const chunk = 'a'.repeat(STAGED_LIMITS.maxPartChars);
    const full = Math.floor(STAGED_LIMITS.maxTotalChars / STAGED_LIMITS.maxPartChars);
    assert.strictEqual(full * STAGED_LIMITS.maxPartChars, STAGED_LIMITS.maxTotalChars);
    const begun = parsed(await call(db, 'write_doc_begin', { doc_id: docId }));
    assert.strictEqual(begun.success, true, begun.error && begun.error.message);
    for (let part = 1; part <= full; part++) {
      const row = parsed(await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part, chunk }));
      assert.strictEqual(row.data.size, part * STAGED_LIMITS.maxPartChars);
    }
    const before = snap(db);
    const refused = await call(db, 'write_doc_append', { stage_id: begun.data.stage_id, part: full + 1, chunk: 'z' });
    assert.strictEqual(codeOf(refused), 'EMET-DOC-067');
    assert.strictEqual(snap(db), before);
    const stage = db.collection('emet_doc_stages').docs[0];
    assert.strictEqual(stage.size, STAGED_LIMITS.maxTotalChars);
    assert.strictEqual(stage.parts.length, full);
    assert.strictEqual(db.doc(docId), undefined);
  });

  test('a fifth open stage is refused, and an expired stage does not count toward the four', async () => {
    const db = readyStore();
    const start = new Date('2026-10-27T15:00:00.000Z');
    const later = new Date(start.getTime() + STAGED_LIMITS.ttlMs + 60 * 1000);
    for (let i = 1; i <= STAGED_LIMITS.maxOpenPerWriter; i++) {
      const begun = parsed(await call(db, 'write_doc_begin', { doc_id: `notes/open-${i}.md` }, start));
      assert.strictEqual(begun.success, true, begun.error && begun.error.message);
    }
    const atCap = snap(db);
    const fifth = await call(db, 'write_doc_begin', { doc_id: 'notes/open-5.md' }, start);
    assert.strictEqual(codeOf(fifth), 'EMET-DOC-074');
    assert.strictEqual(snap(db), atCap);
    assert.strictEqual(db.collection('emet_doc_stages').docs.length, STAGED_LIMITS.maxOpenPerWriter);

    const renewed = parsed(await call(db, 'write_doc_begin', { doc_id: 'notes/open-5.md' }, later));
    assert.strictEqual(renewed.success, true, renewed.error && renewed.error.message);
    assert.strictEqual(db.collection('emet_doc_stages').docs.filter((row) => row.status === 'expired').length, STAGED_LIMITS.maxOpenPerWriter);
    for (let i = 6; i <= STAGED_LIMITS.maxOpenPerWriter + 4; i++) {
      const begun = parsed(await call(db, 'write_doc_begin', { doc_id: `notes/open-${i}.md` }, later));
      assert.strictEqual(begun.success, true, begun.error && begun.error.message);
    }
    const full = snap(db);
    const blocked = await call(db, 'write_doc_begin', { doc_id: 'notes/open-9.md' }, later);
    assert.strictEqual(codeOf(blocked), 'EMET-DOC-074');
    assert.strictEqual(snap(db), full);
    const rows = db.collection('emet_doc_stages').docs;
    assert.strictEqual(rows.filter((row) => row.status === 'open').length, STAGED_LIMITS.maxOpenPerWriter);
    assert.strictEqual(rows.filter((row) => row.status === 'expired').length, STAGED_LIMITS.maxOpenPerWriter);
    assert.strictEqual(rows.length, STAGED_LIMITS.maxOpenPerWriter * 2);
    assert.strictEqual(db.collection('documents').docs.length, 0);
  });
});

testGroup('begin applies the record supersedes gate', () => {
  test('a handoff begin without supersedes leaves no stage', async () => {
    const db = readyStore();
    await seed(db);
    const before = snap(db);
    const refused = await call(db, 'write_doc_begin', { doc_id: 'HANDOFF.md', reason: REASON });
    assert.strictEqual(codeOf(refused), 'EMET-DOC-017');
    assert.strictEqual(snap(db), before);
    assert.strictEqual(db.collection('emet_doc_stages').docs.length, 0);
  });
  test('a handoff begin that names the wrong revision leaves no stage', async () => {
    const db = readyStore();
    await seed(db);
    const before = snap(db);
    const refused = await call(db, 'write_doc_begin', { doc_id: 'HANDOFF.md', supersedes: 9, reason: REASON });
    assert.strictEqual(codeOf(refused), 'EMET-DOC-018');
    assert.strictEqual(snap(db), before);
    assert.strictEqual(db.collection('emet_doc_stages').docs.length, 0);
  });
  test('a handoff begin with a short reason leaves no stage', async () => {
    const db = readyStore();
    await seed(db);
    const before = snap(db);
    const refused = await call(db, 'write_doc_begin', { doc_id: 'HANDOFF.md', supersedes: 1, reason: 'too short' });
    assert.strictEqual(codeOf(refused), 'EMET-DOC-019');
    assert.strictEqual(snap(db), before);
    assert.strictEqual(db.collection('emet_doc_stages').docs.length, 0);
  });
});

summary('Staged Write Test Summary');
