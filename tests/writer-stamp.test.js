/**
 * Writer stamp: client_id is server-stamped. A caller value is ignored.
 */
import assert from 'node:assert/strict';
import { test, testGroup, summary } from './harness.js';
import { makeStore, withStore } from './memstore.js';

console.log('\n=== writer stamp ===');

testGroup('server stamp', () => {
  test('a caller-supplied client_id is not stored', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const db = makeStore();
    await withStore(db, async () => {
      await writeDoc('threads/stamp.md', '# Stamp\n', 'project-host', null, null, { client_id: 'someone-else' });
      assert.strictEqual(db.doc('threads/stamp.md').client_id, 'stdio');
    });
  });
  test('the login client id is stored and a caller value is not', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const db = makeStore();
    await withStore(db, async () => {
      await actorStore.run({ personId: 'owner', clientId: 'login-9' }, () => writeDoc('threads/stamp2.md', '# Stamp\n', 'project-host', null, null, { client_id: 'someone-else' }));
      assert.strictEqual(db.doc('threads/stamp2.md').client_id, 'login-9');
    });
  });
  test('restore is refused for a tag outside EMET_RESTORE_TAGS', async () => {
    const { restoreDoc } = await import('../src/tools.js');
    const db = makeStore();
    await withStore(db, async () => {
      await assert.rejects(
        () => restoreDoc('threads/x.md', 1, 'stranger', null, 'not an allowed tag'),
        /EMET_RESTORE_TAGS/
      );
    });
  });
});

test('an unregistered source may write a new drop and nothing else', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const db = makeStore();
    const prev = process.env.EMET_SOURCE_TAGS;
    process.env.EMET_SOURCE_TAGS = 'project-host';
    try {
      await withStore(db, async () => {
        await assert.rejects(() => writeDoc('threads/nope.md', '# No\n', 'stranger'), /new drop only/);
        const drop = await writeDoc('drops/visitor.md', 'a visitor note\n', 'stranger');
        assert.strictEqual(drop.version, 1);
      });
    } finally {
      if (prev === undefined) delete process.env.EMET_SOURCE_TAGS; else process.env.EMET_SOURCE_TAGS = prev;
    }
  });

test('history shows the session and client stamped on the revision', async () => {
  const { writeDoc, readDoc, readDocHistory } = await import('../src/tools.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    await actorStore.run({ personId: 'owner', clientId: 'login-9' }, () =>
      writeDoc('threads/hist.md', '# Hist\n', 'project-host', null, null, { session_id: 'sess-1', client_id: 'nope' }));
    const live = await readDoc('threads/hist.md');
    assert.strictEqual(live.client_id, 'login-9');
    assert.strictEqual(live.session_id, 'sess-1');
    const cur = await readDocHistory('threads/hist.md', 1);
    assert.strictEqual(cur.client_id, 'login-9');
    assert.strictEqual(cur.session_id, 'sess-1');
  });
});

test('a retire marker carries person, client and session', async () => {
  const { writeDoc, retireDoc } = await import('../src/tools.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    await writeDoc('drops/gone.md', 'a note to retire\n');
    await actorStore.run({ personId: 'owner', clientId: 'login-9' }, () =>
      retireDoc('drops/gone.md', 'moved onto the board', 'project-host', null, { session_id: 'sess-2' }));
    const row = db.doc('drops/gone.md');
    assert.strictEqual(row.retired_person_id, 'owner');
    assert.strictEqual(row.retired_client_id, 'login-9');
    assert.strictEqual(row.retired_session_id, 'sess-2');
  });
});

test('an acceptance carries person, client and session', async () => {
  const { buildAcceptance } = await import('../src/conformance.js');
  const a = buildAcceptance({ reason: 'disposition of record', by: 'project-host', version: 1, person_id: 'owner', client_id: 'login-9', session_id: 'sess-3' });
  assert.strictEqual(a.person_id, 'owner');
  assert.strictEqual(a.client_id, 'login-9');
  assert.strictEqual(a.session_id, 'sess-3');
});

test('a lab row takes the login client, not the caller value', async () => {
  const { labRow } = await import('../src/session-graph.js');
  const row = labRow('write_doc', { doc_id: 'threads/x.md', client_id: 'someone-else', person_id: 'spoof' },
    { base: 's', decision: { verdict: 'ok', next: 'n' }, mode: 'enforce' }, new Date(), { personId: 'owner', clientId: 'login-9' });
  assert.strictEqual(row.client_id, 'login-9');
  assert.strictEqual(row.person_id, 'owner');
});

test('a session that is not open may write a new drop and nothing else', async () => {
  const { graphBefore, evaluate } = await import('../src/session-graph.js');
  const db = makeStore();
  await withStore(db, async () => {
    const drop = await graphBefore('write_doc', { doc_id: 'drops/late.md', content: 'note' }, db);
    assert.strictEqual(drop.decision.verdict, 'ok');
    await assert.rejects(() => graphBefore('write_doc', { doc_id: 'threads/x.md', content: 'x' }, db), /no session|new drop/);
    const notOpen = evaluate('write_doc', { doc_id: 'drops/late.md', session_id: 'sess-9' }, {}, 0);
    assert.strictEqual(notOpen.verdict, 'ok');
    const blocked = evaluate('write_doc', { doc_id: 'threads/x.md', session_id: 'sess-9' }, {}, 0);
    assert.strictEqual(blocked.verdict, 'refuse');
  });
});

test('opening a session stamps opened_by', async () => {
  const { graphAfter } = await import('../src/session-graph.js');
  const { actorStore } = await import('../src/persons.js');
  const db = makeStore();
  await withStore(db, async () => {
    await actorStore.run({ personId: 'owner', clientId: 'login-9' }, () =>
      graphAfter('emet_session_open', {}, { base: 'sess-4' }, db));
    const row = db.collection('emet_sessions').docs.find((d) => d._id === 'sess-4' || d.base === 'sess-4');
    assert.ok(row);
    assert.strictEqual(row.opened_by.person_id, 'owner');
    assert.strictEqual(row.opened_by.client_id, 'login-9');
  });
});

test('a caller client_id is not a valid memory field', async () => {
  const { VALID_METADATA_FIELDS } = await import('../src/validation.js');
  assert.strictEqual(VALID_METADATA_FIELDS.includes('client_id'), false);
});
test('writerStamp ignores a caller value', async () => {
  const { writerStamp, actorStore } = await import('../src/persons.js');
  assert.strictEqual(writerStamp().client_id, 'stdio');
  await actorStore.run({ personId: 'owner', clientId: 'login-9' }, () => {
    assert.strictEqual(writerStamp().client_id, 'login-9');
  });
});

summary('WRITER STAMP TEST SUMMARY');
