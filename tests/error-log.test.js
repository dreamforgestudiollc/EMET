/**
 * The operational error log: allow-list, redaction, rotation, and a failed write.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert';
import fs from 'node:fs';
import { ValidationError } from '../src/validation.js';
import { handleError } from '../src/tools.js';
import { actorStore } from '../src/persons.js';
import {
  useMemoryErrorLog, setErrorLogBackend, _resetErrorLogForTests, recordError, flushErrorLog, rotateErrorLog, insertErrorLog,
  upsertErrorSummary, logSessionId, ERROR_LOG_MAX, ERROR_LOG_DAYS
} from '../src/error-log.js';
import { bindSharedClient, useTestClient } from '../src/mongo-connect.js';

const ENTRY_KEYS = ['_id', 't', 'emet_code', 'class_code', 'tool', 'version', 'transport', 'caller', 'role', 'client_id', 'grant_id', 'door', 'session_id', 'correlation_id', 'count'];
const store = useMemoryErrorLog();

function silence(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.error = orig; })
    .then((value) => ({ value, lines }));
}

testGroup('error log', () => {
  test('a forced error stores no sentinel, no message, and only the allow-list', async () => {
    store.entries.length = 0;
    const err = new ValidationError('query', 'SENTINEL_CONTENT emet_tok_abcdefghijklmnopqrstuvwxyz ada@example.com Ada Lovelace Finances');
    err.emetCode = 'EMET-VAL-005';
    err.extra = 'SENTINEL_CONTENT';
    await actorStore.run({ transport: 'http', personId: 'guest-1', sourceTag: 'SENTINEL_TAG', scopes: ['emet.read'] }, () => {
      handleError(err, 'recall_SENTINEL', null);
    });
    await flushErrorLog();
    assert.strictEqual(store.entries.length, 1);
    const row = store.entries[0];
    assert.deepStrictEqual(Object.keys(row).sort(), ENTRY_KEYS.slice().sort());
    const raw = JSON.stringify(row);
    assert.ok(!raw.includes('SENTINEL'));
    assert.ok(!raw.includes('emet_tok_'));
    assert.ok(!raw.includes('example.com'));
    assert.ok(!raw.includes('Ada'));
    assert.ok(!raw.includes('Finances'));
    assert.ok(!raw.includes('Query'));
    assert.strictEqual(row.caller, 'unregistered');
    assert.strictEqual(row.tool, 'unknown');
    assert.strictEqual(row.role, 'guest');
    assert.strictEqual(row.transport, 'http');
    assert.strictEqual(row.emet_code, 'EMET-VAL-005');
    assert.strictEqual(row.count, 1);
  });

  test('no actor and a null transport are door unknown, and stdio stays stdio', async () => {
    store.entries.length = 0;
    await recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: 'aaaaaaaaaaaaaaaa'
    });
    await actorStore.run({ transport: null, personId: 'ada', clientId: 'login-9', door: 'guest' }, () => recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: 'bbbbbbbbbbbbbbbb'
    }));
    await actorStore.run({ transport: 'stdio', personId: 'local', clientId: 'stdio' }, () => recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: 'cccccccccccccccc'
    }));
    await flushErrorLog();
    const none = store.entries.find((row) => row.correlation_id === 'aaaaaaaaaaaaaaaa');
    const nulled = store.entries.find((row) => row.correlation_id === 'bbbbbbbbbbbbbbbb');
    const local = store.entries.find((row) => row.correlation_id === 'cccccccccccccccc');
    assert.strictEqual(none.door, 'unknown');
    assert.strictEqual(none.transport, 'stdio');
    assert.strictEqual(nulled.door, 'unknown');
    assert.strictEqual(nulled.transport, 'stdio');
    assert.strictEqual(local.door, 'stdio');
    assert.strictEqual(local.transport, 'stdio');
  });

  test('client_id is the credential when the actor has one, stdio when that is the transport, and unknown when there is none', async () => {
    store.entries.length = 0;
    const shared = 'bound-login-client';
    process.env.EMET_SOURCE_TAGS = 'hub-bot';
    await recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '111111111111111a', client_id: 'spoof-client'
    });
    await actorStore.run({ transport: null, personId: 'ada', clientId: 'login-9', door: 'guest' }, () => recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '222222222222222b', client_id: 'spoof-client'
    }));
    await actorStore.run({ transport: 'stdio', personId: 'local' }, () => recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '333333333333333c'
    }));
    await actorStore.run({ transport: 'stdio', personId: 'local', clientId: 'stdio' }, () => recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '444444444444444d'
    }));
    await actorStore.run({
      transport: 'http', personId: 'ada', clientId: shared, grantId: 'fam-shared', door: 'member', sourceTag: 'hub-bot'
    }, () => recordError({
      emet_code: 'EMET-DOC-025', class_code: 'VALIDATION_ERROR', tool: 'write_doc', correlation_id: '555555555555555e', client_id: 'spoof-client'
    }));
    await actorStore.run({
      transport: 'http', personId: 'ada', clientId: 'login 9', grantId: 'fam-shared', door: 'member'
    }, () => recordError({
      emet_code: 'EMET-DOC-025', class_code: 'VALIDATION_ERROR', tool: 'write_doc', correlation_id: '666666666666666f'
    }));
    await flushErrorLog();
    delete process.env.EMET_SOURCE_TAGS;
    const byId = (id) => store.entries.find((row) => row.correlation_id === id);
    assert.strictEqual(byId('111111111111111a').client_id, 'unknown');
    assert.strictEqual(byId('222222222222222b').client_id, 'login-9');
    assert.strictEqual(byId('222222222222222b').door, 'unknown');
    assert.strictEqual(byId('333333333333333c').client_id, 'stdio');
    assert.strictEqual(byId('444444444444444d').client_id, 'stdio');
    const refused = byId('555555555555555e');
    assert.strictEqual(refused.client_id, shared);
    assert.strictEqual(refused.caller, 'hub-bot');
    assert.strictEqual(refused.grant_id, 'fam-shared');
    assert.strictEqual(refused.door, 'member');
    assert.strictEqual(byId('666666666666666f').client_id, 'unknown');
    const raw = JSON.stringify(store.entries);
    assert.ok(!raw.includes('spoof-client'));
    assert.ok(!raw.includes('login 9'));
  });

  test('a DOC-025 refusal and a session-close refusal log the actor client id', async () => {
    store.entries.length = 0;
    const { dispatchTool } = await import('../src/dispatch.js');
    const { makeStore, withStore } = await import('./memstore.js');
    const { runErrorReport } = await import('../src/error-report.js');
    const db = makeStore({
      highest: 1,
      sessionId: '2026-10-22_claim',
      state: { opened: true, board: true, episodic: true }
    });
    const body = 'x'.repeat(80);
    db.col('documents').docs.push({ doc_id: 'HANDOFF.md', content: body, version: 4, size: body.length });
    const shared = 'bound-login-client';
    const actor = {
      transport: 'http', personId: 'ada', clientId: shared, grantId: 'fam-shared', door: 'member',
      sourceTag: 'hub-bot', authenticated: true, scopes: ['emet']
    };
    process.env.EMET_SOURCE_TAGS = 'hub-bot';
    let writeRes;
    let closeRes;
    try {
      writeRes = await withStore(db, () => actorStore.run(actor, () => dispatchTool('write_doc', {
        doc_id: 'HANDOFF.md',
        content: 'short',
        source: 'hub-bot',
        supersedes: 4,
        reason: 'condensed the handoff below half',
        session_id: '2026-10-22_claim'
      }, { dbManager: db, logger: null })));
      closeRes = await actorStore.run(actor, () => dispatchTool('emet_session_close', {
        session_id: '2026-10-22_claim'
      }, { dbManager: null, logger: null }));
      await flushErrorLog();
    } finally {
      delete process.env.EMET_SOURCE_TAGS;
    }
    const writeBody = JSON.parse(writeRes.content[0].text);
    const closeBody = JSON.parse(closeRes.content[0].text);
    assert.strictEqual(writeBody.error.emet_code, 'EMET-DOC-025');
    assert.match(writeBody.error.message, /full revision/);
    assert.match(writeBody.error.message, /whole content/);
    assert.match(writeBody.error.message, /write_doc_begin/);
    assert.match(writeBody.error.message, /write_doc_append/);
    assert.match(writeBody.error.message, /write_doc_commit/);
    assert.match(writeBody.error.message, /header-only/);
    assert.strictEqual(closeRes.isError, true);
    const docRow = store.entries.find((row) => row.emet_code === 'EMET-DOC-025');
    const closeRow = store.entries.find((row) => row.tool === 'emet_session_close');
    assert.ok(docRow, 'DOC-025 reached the error log');
    assert.ok(closeRow, 'session close reached the error log');
    assert.strictEqual(docRow.client_id, shared);
    assert.strictEqual(docRow.tool, 'write_doc');
    assert.strictEqual(docRow.caller, 'hub-bot');
    assert.strictEqual(docRow.grant_id, 'fam-shared');
    assert.strictEqual(docRow.session_id, 'none');
    assert.strictEqual(closeRow.client_id, shared);
    assert.strictEqual(closeRow.caller, 'hub-bot');
    assert.strictEqual(closeRow.grant_id, 'fam-shared');
    assert.strictEqual(closeRow.door, 'member');
    assert.strictEqual(closeRow.session_id, '2026-10-22_claim');
    const logged = JSON.stringify(store.entries);
    assert.ok(!logged.includes('HANDOFF'));
    assert.ok(!JSON.stringify(docRow).includes('2026-10-22_claim'));
    assert.ok(!logged.includes('short'));
    assert.ok(!logged.includes('MONGODB_URI'));
    const report = await actorStore.run({ transport: 'stdio' }, () => runErrorReport({}));
    assert.ok(report.report.includes(shared));
    assert.ok(report.report.includes(docRow.correlation_id));
    assert.ok(report.report.includes('2026-10-22_claim'));
    assert.ok(closeBody.error.emet_code);
  });

  test('a blocked close and an escalated close log the session id, and an unsafe id is unknown', async () => {
    store.entries.length = 0;
    const { dispatchTool } = await import('../src/dispatch.js');
    const { makeStore, withStore } = await import('./memstore.js');
    const shared = 'bound-login-client';
    const actor = {
      transport: 'http', personId: 'ada', clientId: shared, grantId: 'fam-shared', door: 'member',
      sourceTag: 'hub-bot', authenticated: true, scopes: ['emet']
    };
    process.env.EMET_SOURCE_TAGS = 'hub-bot';
    const wall = Date.now();
    const start = Math.floor((wall - 3600000) / 1000);
    function ready(id) {
      const db = makeStore({
        sessionId: id,
        highest: 1,
        state: { opened: true, board: true, episodic: true, handoff: true, updated_at: new Date(wall) }
      });
      db.col('transcripts').docs.push({
        session_id: id,
        exchange_count: 1,
        exchanges: [{ exchange_index: 1, user_message: 'hi', assistant_message: 'hello', timestamp: new Date(wall) }]
      });
      db.col('documents').docs.push(
        { doc_id: 'STATE.md', version: 1, updated_at: new Date(wall), updated_by: 'hub-bot', size: 10 },
        { doc_id: 'HANDOFF.md', version: 2, updated_at: new Date(wall), updated_by: 'hub-bot', size: 20 }
      );
      db.col('emet_episodic').docs.push({
        id: 7, timestamp: wall / 1000, importance: 0.5, metadata: { source: 'hub-bot' },
        source_session_id: id, source_exchange_end: 1
      });
      return db;
    }
    try {
      const blockedId = '2026-10-27_close-block';
      const blockedDb = ready(blockedId);
      const blocked = await withStore(blockedDb, () => actorStore.run(actor, () => dispatchTool('emet_session_close', {
        session_id: blockedId, session_start: start
      }, { dbManager: blockedDb, logger: null })));
      const escalatedId = '2026-10-27_close-escalate';
      const escalatedDb = ready(escalatedId);
      escalatedDb.col('close_attempts').docs.push({ base_session_id: escalatedId, blocked_count: 2 });
      const escalated = await withStore(escalatedDb, () => actorStore.run(actor, () => dispatchTool('emet_session_close', {
        session_id: escalatedId, session_start: start
      }, { dbManager: escalatedDb, logger: null })));
      const namedOnly = await actorStore.run(actor, () => dispatchTool('emet_session_close', {
        receipts: { transcript_session_id: '2026-10-27_receipts-only' }
      }, { dbManager: null, logger: null }));
      const unsafe = await actorStore.run(actor, () => dispatchTool('emet_session_close', {
        session_id: 'secret token pasted'
      }, { dbManager: null, logger: null }));
      await flushErrorLog();
      const blockedBody = JSON.parse(blocked.content[0].text);
      const escalatedBody = JSON.parse(escalated.content[0].text);
      assert.ok(!blocked.isError, blocked.content[0].text.slice(0, 500));
      assert.strictEqual(blockedBody.data.state, 'blocked', JSON.stringify(blockedBody.data && blockedBody.data.missing));
      assert.ok(!escalated.isError, escalated.content[0].text.slice(0, 500));
      assert.strictEqual(escalatedBody.data.state, 'escalate', JSON.stringify(escalatedBody.data && escalatedBody.data.missing));
      assert.strictEqual(namedOnly.isError, true);
      assert.strictEqual(unsafe.isError, true);
      const blockedRow = store.entries.find((row) => row.emet_code === 'EMET-SESS-006');
      const escalatedRow = store.entries.find((row) => row.emet_code === 'EMET-SESS-007');
      const namedRow = store.entries.find((row) => row.session_id === '2026-10-27_receipts-only');
      const unsafeRow = store.entries.find((row) => row.tool === 'emet_session_close' && row.session_id === 'unknown');
      assert.ok(blockedRow, 'blocked close reached the error log');
      assert.strictEqual(blockedRow.session_id, blockedId);
      assert.strictEqual(blockedRow.tool, 'emet_session_close');
      assert.strictEqual(blockedRow.client_id, shared);
      assert.strictEqual(blockedRow.grant_id, 'fam-shared');
      assert.strictEqual(blockedRow.door, 'member');
      assert.ok(escalatedRow, 'escalated close reached the error log');
      assert.strictEqual(escalatedRow.session_id, escalatedId);
      assert.strictEqual(escalatedRow.client_id, shared);
      assert.strictEqual(escalatedRow.door, 'member');
      assert.ok(namedRow, 'a close named only in receipts logs that session id');
      assert.ok(unsafeRow, 'an unsafe session id is stored as unknown');
      const logged = JSON.stringify(store.entries);
      assert.ok(!logged.includes('secret token'));
      assert.ok(!logged.includes('HANDOFF'));
    } finally {
      delete process.env.EMET_SOURCE_TAGS;
    }
  });

  test('a ghp_ token, an sk- token, a JWT, and a mongodb URI are stored as unknown and stay out of the owner report', async () => {
    store.entries.length = 0;
    const { dispatchTool } = await import('../src/dispatch.js');
    const { runErrorReport } = await import('../src/error-report.js');
    const ghp = `ghp_${'A'.repeat(36)}`;
    const sk = `sk-ant-api03-${'a'.repeat(40)}`;
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc';
    const mongo = 'mongodb://user:s3cr3t-mongo-paste@host/db';
    const spaced = 'secret token pasted';
    const kept = [
      '2026-10-22_claim',
      '2026-10-22_claim-2',
      '2026-10-22_claim-99',
      '2026-10-22_claim_verbatim_part1',
      '2026-10-22_claim-2_verbatim_part1',
      `2026-10-22_${'a'.repeat(40)}`,
      `2026-10-22_${'a'.repeat(40)}-99`
    ];
    for (const id of kept) assert.strictEqual(logSessionId(id), id, id);
    const refused = [ghp, sk, jwt, mongo, spaced, `2026-10-22_${'a'.repeat(44)}`, '2026-10-22_Claim', '2026-02-31_ok_verbatim_part0'];
    for (const id of refused) assert.strictEqual(logSessionId(id), 'unknown', id);
    const actor = { transport: 'stdio' };
    for (const session_id of [ghp, sk, jwt, mongo]) {
      const res = await actorStore.run(actor, () => dispatchTool('emet_session_close', {
        session_id
      }, { dbManager: null, logger: null }));
      assert.strictEqual(res.isError, true);
    }
    await actorStore.run(actor, () => recordError({
      tool: 'emet_session_close',
      session_id: jwt,
      emet_code: 'EMET-SESS-006',
      class_code: 'VALIDATION_ERROR'
    }));
    await flushErrorLog();
    const rows = store.entries.filter((row) => row.tool === 'emet_session_close');
    assert.ok(rows.length >= 4, 'each refused close reached the error log');
    assert.ok(rows.every((row) => row.session_id === 'unknown'));
    const logged = JSON.stringify(store.entries);
    for (const raw of [ghp, sk, jwt, mongo, 's3cr3t-mongo-paste', spaced]) {
      assert.ok(!logged.includes(raw), raw);
    }
    const report = await actorStore.run(actor, () => runErrorReport({}));
    const shown = JSON.stringify(report);
    for (const raw of [ghp, sk, jwt, mongo, 's3cr3t-mongo-paste', spaced]) {
      assert.ok(!shown.includes(raw), raw);
    }
    assert.ok(report.report.includes('unknown'));
  });

  test('rotation keeps one summary per client id', async () => {
    store.entries.length = 0;
    store.summaries.length = 0;
    const old = '2020-01-02T03:04:05.000Z';
    await insertErrorLog({ _id: 'old-a', t: old, emet_code: 'EMET-DOC-025', class_code: 'VALIDATION_ERROR', tool: 'write_doc', correlation_id: 'dddddddddddddddd', client_id: 'bound-login-client' });
    await insertErrorLog({ _id: 'old-b', t: old, emet_code: 'EMET-DOC-025', class_code: 'VALIDATION_ERROR', tool: 'write_doc', correlation_id: 'eeeeeeeeeeeeeeee', client_id: 'https://claude.ai/oauth/mcp' });
    await silence(() => rotateErrorLog({ now: new Date('2026-10-20T00:00:00.000Z'), maxAgeDays: 90, maxEntries: 100 }));
    const rows = store.summaries.filter((row) => row.emet_code === 'EMET-DOC-025');
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows.map((row) => row.client_id).sort(), ['bound-login-client', 'https://claude.ai/oauth/mcp']);
    assert.ok(rows.every((row) => row.count === 1));
  });

  const LEGACY_SUMMARY_INDEX = {
    name: 'legacy_summary_no_client',
    unique: true,
    key: { day: 1, emet_code: 1, tool: 1, version: 1 }
  };
  const ID_INDEX = { name: '_id_', unique: true, key: { _id: 1 } };

  async function withSummaryDb(indexes, dropIndex) {
    const dropped = [];
    const created = [];
    const updates = [];
    const summary = {
      async indexes() { return indexes.map((idx) => ({ ...idx, key: { ...idx.key } })); },
      async dropIndex(name) {
        dropped.push(name);
        if (dropIndex) await dropIndex(name);
      },
      async createIndex(spec, opts) {
        created.push({ spec: { ...spec }, unique: !!(opts && opts.unique) });
        return 'ok';
      },
      async updateOne(filter, update, opts) {
        updates.push({ filter: { ...filter }, update, upsert: !!(opts && opts.upsert) });
        return { acknowledged: true };
      }
    };
    const db = {
      collection(name) {
        if (name === 'error_log_summary') return summary;
        return { async createIndex() { return 'ok'; } };
      }
    };
    _resetErrorLogForTests();
    setErrorLogBackend(null);
    bindSharedClient({ db: () => db });
    try {
      await upsertErrorSummary({
        day: '2026-10-22',
        emet_code: 'EMET-DOC-025',
        tool: 'write_doc',
        version: '0.3.0',
        client_id: 'bound-login-client',
        count: 1
      });
      return { dropped, created, updates };
    } finally {
      useTestClient(null);
      _resetErrorLogForTests();
      setErrorLogBackend(store);
    }
  }

  test('a legacy summary index is replaced and the upsert filter keeps client_id', async () => {
    const { dropped, created, updates } = await withSummaryDb([ID_INDEX, LEGACY_SUMMARY_INDEX]);
    assert.deepStrictEqual(dropped, ['legacy_summary_no_client']);
    assert.deepStrictEqual(created, [{
      spec: { day: 1, emet_code: 1, tool: 1, version: 1, client_id: 1 },
      unique: true
    }]);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].upsert, true);
    assert.deepStrictEqual(updates[0].update, { $inc: { count: 1 } });
    assert.strictEqual(updates[0].filter.client_id, 'bound-login-client');
    assert.strictEqual(updates[0].filter.day, '2026-10-22');
    assert.strictEqual(updates[0].filter.emet_code, 'EMET-DOC-025');
  });

  test('a legacy summary index that cannot be dropped keeps the old filter', async () => {
    const { dropped, created, updates } = await withSummaryDb([ID_INDEX, LEGACY_SUMMARY_INDEX], () => {
      throw new Error('not authorized');
    });
    assert.deepStrictEqual(dropped, ['legacy_summary_no_client']);
    assert.deepStrictEqual(created, []);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].upsert, true);
    assert.ok(!Object.hasOwn(updates[0].filter, 'client_id'));
    assert.strictEqual(updates[0].filter.day, '2026-10-22');
    assert.strictEqual(updates[0].filter.emet_code, 'EMET-DOC-025');
    assert.strictEqual(updates[0].filter.tool, 'write_doc');
  });

  test('a summary collection with no legacy index stores client_id', async () => {
    const { dropped, created, updates } = await withSummaryDb([ID_INDEX]);
    assert.deepStrictEqual(dropped, []);
    assert.deepStrictEqual(created, [{
      spec: { day: 1, emet_code: 1, tool: 1, version: 1, client_id: 1 },
      unique: true
    }]);
    assert.strictEqual(updates[0].filter.client_id, 'bound-login-client');
  });

  test('a registered source tag is kept and an unregistered one is not', async () => {
    store.entries.length = 0;
    process.env.EMET_SOURCE_TAGS = 'laptop';
    await actorStore.run({ transport: 'stdio', sourceTag: 'laptop' }, () => recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '0123456789abcdef'
    }));
    await actorStore.run({ transport: 'stdio', sourceTag: 'not-registered' }, () => recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: 'abcdef0123456789'
    }));
    await flushErrorLog();
    delete process.env.EMET_SOURCE_TAGS;
    assert.deepStrictEqual(store.entries.map((row) => row.caller).sort(), ['laptop', 'unregistered']);
  });

  test('a log write failure still returns the original envelope', async () => {
    store.fail = true;
    const { value, lines } = await silence(async () => {
      const res = handleError(new ValidationError('query', 'Query is required', { code: 'EMET-VAL-005' }), 'recall');
      await flushErrorLog();
      return res;
    });
    store.fail = false;
    const body = JSON.parse(value.content[0].text);
    assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
    assert.strictEqual(body.error.emet_code, 'EMET-VAL-005');
    assert.match(body.error.message, /Query is required/);
    assert.ok(lines.some((line) => line === 'error log write failed'));
    assert.ok(!lines.join('\n').includes('Query is required'));
  });

  test('rotation writes matching summary counts and the process-log line', async () => {
    store.entries.length = 0;
    store.summaries.length = 0;
    const old = '2020-01-02T03:04:05.000Z';
    await insertErrorLog({ _id: 'old-a', t: old, emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: 'aaaaaaaaaaaaaaaa' });
    await insertErrorLog({ _id: 'old-b', t: old, emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: 'bbbbbbbbbbbbbbbb' });
    await insertErrorLog({ _id: 'new-c', t: '2026-10-20T00:00:00.000Z', emet_code: 'EMET-VAL-005', class_code: 'VALIDATION_ERROR', tool: 'recall', correlation_id: 'cccccccccccccccc' });
    const { lines } = await silence(() => rotateErrorLog({ now: new Date('2026-10-20T00:00:00.000Z'), maxAgeDays: 90, maxEntries: 100 }));
    assert.deepStrictEqual(store.entries.map((row) => row._id), ['new-c']);
    const summary = store.summaries.find((row) => row.emet_code === 'EMET-INT-001');
    assert.ok(summary);
    assert.strictEqual(summary.count, 2);
    assert.strictEqual(summary.day, '2020-01-02');
    assert.strictEqual(summary.tool, 'recall');
    assert.strictEqual(summary.client_id, 'unknown');
    assert.deepStrictEqual(Object.keys(summary).sort(), ['client_id', 'count', 'day', 'emet_code', 'tool', 'version']);
    assert.ok(lines.some((line) => /^rotated 2 entries older than \d{4}-\d{2}-\d{2}$/.test(line)));
  });

  test('the cap is 10000 entries and retention is 90 days', () => {
    assert.strictEqual(ERROR_LOG_MAX, 10000);
    assert.strictEqual(ERROR_LOG_DAYS, 90);
    const src = fs.readFileSync(new URL('../src/error-log.js', import.meta.url), 'utf8');
    assert.match(src, /ERROR_LOG_MAX = 10000/);
    assert.match(src, /ERROR_LOG_DAYS = 90/);
  });

  test('the cap removes the oldest entries and summarizes them', async () => {
    store.entries.length = 0;
    store.summaries.length = 0;
    await insertErrorLog({ _id: '1', t: '2026-10-18T00:00:00.000Z', emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '1111111111111111' });
    await insertErrorLog({ _id: '2', t: '2026-10-19T00:00:00.000Z', emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '2222222222222222' });
    await insertErrorLog({ _id: '3', t: '2026-10-20T00:00:00.000Z', emet_code: 'EMET-VAL-005', class_code: 'VALIDATION_ERROR', tool: 'recall', correlation_id: '3333333333333333' });
    await silence(() => rotateErrorLog({ now: new Date('2026-10-20T00:00:00.000Z'), maxAgeDays: 90, maxEntries: 2 }));
    assert.deepStrictEqual(store.entries.map((row) => row._id).sort(), ['2', '3']);
    assert.strictEqual(store.summaries.reduce((sum, row) => sum + row.count, 0), 1);
  });
});

testGroup('cleanup', () => {
  test('the memory backend does not leak into other suites in this process', () => {
    setErrorLogBackend(null);
    assert.ok(true);
  });
});

summary('Error log');
