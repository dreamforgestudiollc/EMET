/**
 * Recall rank and visibility (10/7 audit, build B).
 *
 * Rank is keyword hits, then importance. Time order happens only when the
 * query asks for the latest, the newest, or the most recent. Expired,
 * superseded and retired rows stay reachable and marked. revise_memory
 * records an end date and a link; it does not hide the old row.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { makeStore, withStore, layerHonouringDb, applyAggregate, matches as storeMatches } from './memstore.js';
import { payloadOf } from './startup-fixture.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';

const {
  recallMemories, queryLayer, reviseMemory, listDocs, saveMemory,
  collectSemanticHits, rankSemanticHits
} = await import('../src/tools.js');
const { initialize } = await import('../src/setup.js');
const { withLiveness, EmetDatabase, COLLECTION_PREFIX, buildRankPipeline } = await import('../src/database.js');
const { dispatchTool } = await import('../src/dispatch.js');

function valueMatches(d, v) {
  if (v === null) return d == null;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('$regex' in v) {
      const flags = String(v.$options || '').includes('i') ? 'i' : '';
      if (!(typeof d === 'string' && new RegExp(v.$regex, flags).test(d))) return false;
    }
    if ('$gt' in v && !(typeof d === 'number' && d > v.$gt)) return false;
    if ('$exists' in v && ((d !== undefined) !== Boolean(v.$exists))) return false;
    return true;
  }
  return d === v;
}

function matches(doc, q) {
  if (!q || typeof q !== 'object') return true;
  return Object.entries(q).every(([k, v]) => {
    if (k === '$or') return v.some((s) => matches(doc, s));
    if (k === '$and') return v.every((s) => matches(doc, s));
    return valueMatches(doc[k], v);
  });
}

/** Honours sort, limit and the liveness predicate, so a reverted read path fails here. */
function rankingDb(rowsByLayer) {
  const layers = {};
  for (const [layer, rows] of Object.entries(rowsByLayer)) layers[layer] = rows.map((r) => ({ ...r }));
  return {
    async getConnection() { return {}; },
    async findMemories(layer, filter = {}, opts = {}) {
      const sort = opts.sort;
      const limit = opts.limit;
      const applyLiveness = opts.applyLiveness === true;
      const includeSuperseded = opts.includeSuperseded === true;
      let rows = (layers[layer] || []).map((r) => structuredClone(r));
      const effective = applyLiveness ? withLiveness(filter, includeSuperseded) : (filter || {});
      rows = rows.filter((r) => matches(r, effective));
      if (sort && typeof sort === 'object' && Object.keys(sort).length) {
        const k = Object.keys(sort)[0];
        const dir = sort[k];
        rows.sort((a, b) => {
          if (a[k] === b[k]) return 0;
          if (a[k] == null) return 1;
          if (b[k] == null) return -1;
          return a[k] > b[k] ? (dir === 1 ? 1 : -1) : (dir === 1 ? -1 : 1);
        });
      }
      if (limit !== null && limit !== undefined && Number.isFinite(Number(limit))) rows = rows.slice(0, Number(limit));
      return rows;
    },
    // The rank pipeline. findMemories above is the old column-sort-then-limit,
    // so a revert to that path fails the window probes.
    async aggregateMemories(layer, pipeline) {
      return applyAggregate(layers[layer] || [], pipeline);
    }
  };
}

const ids = (rows) => rows.map((r) => r.id);

testGroup('recall ranks by relevance and importance', () => {
  test('recall ranks by keyword hits then importance, and a newer lower match does not win', async () => {
    const db = rankingDb({
      semantic: [
        { id: 1, timestamp: 100, importance: 0.2, content: 'alpha beta durable', context: '', metadata: {}, is_live: true, superseded_by: null },
        { id: 2, timestamp: 900, importance: 0.9, content: 'alpha recent', context: '', metadata: {}, is_live: true, superseded_by: null }
      ]
    });
    const hits = await recallMemories(db, 'alpha beta', 'semantic', 1);
    assert.deepStrictEqual(ids(hits), [1], `expected the two-word match, got ${ids(hits)}`);
    const importance = await recallMemories(rankingDb({
      semantic: [
        { id: 1, timestamp: 100, importance: 0.9, content: 'alpha', context: '', metadata: {}, is_live: true, superseded_by: null },
        { id: 2, timestamp: 900, importance: 0.2, content: 'alpha', context: '', metadata: {}, is_live: true, superseded_by: null }
      ]
    }), 'alpha', 'semantic', 1);
    assert.deepStrictEqual(ids(importance), [1], `expected the more important match, got ${ids(importance)}`);
    const tie = await recallMemories(rankingDb({
      semantic: [
        { id: 1, timestamp: 100, importance: 0.5, content: 'alpha', context: '', metadata: {}, is_live: true, superseded_by: null },
        { id: 2, timestamp: 900, importance: 0.5, content: 'alpha', context: '', metadata: {}, is_live: true, superseded_by: null }
      ]
    }), 'alpha', 'semantic', 2);
    assert.deepStrictEqual(ids(tie), [1, 2], `a timestamp must not break the tie, got ${ids(tie)}`);
  });

  test('recall orders by time only when the query asks for the latest, newest, or most recent', async () => {
    const rows = {
      semantic: [
        { id: 1, timestamp: 100, importance: 0.9, content: 'alpha', context: '', metadata: {}, is_live: true, superseded_by: null },
        { id: 2, timestamp: 900, importance: 0.2, content: 'alpha', context: '', metadata: {}, is_live: true, superseded_by: null }
      ]
    };
    for (const phrase of ['latest alpha', 'newest alpha', 'most recent alpha']) {
      const out = await recallMemories(rankingDb(rows), phrase, 'semantic', 2);
      assert.deepStrictEqual(ids(out), [2, 1], `${phrase} should be newest first, got ${ids(out)}`);
    }
    const plain = await recallMemories(rankingDb(rows), 'alpha', 'semantic', 2);
    assert.deepStrictEqual(ids(plain), [1, 2], `plain query must stay on importance, got ${ids(plain)}`);
  });

  test('query_layer defaults to importance, and uses time only when order_by names timestamp', async () => {
    const db = rankingDb({
      semantic: [
        { id: 1, timestamp: 100, importance: 0.9, content: 'one', context: '', metadata: {}, is_live: true, superseded_by: null },
        { id: 2, timestamp: 900, importance: 0.2, content: 'two', context: '', metadata: {}, is_live: true, superseded_by: null }
      ]
    });
    const byImportance = await queryLayer(db, 'semantic', {});
    assert.deepStrictEqual(ids(byImportance), [1, 2], `default order got ${ids(byImportance)}`);
    const byTime = await queryLayer(db, 'semantic', { order_by: 'timestamp DESC' });
    assert.deepStrictEqual(ids(byTime), [2, 1], `timestamp DESC got ${ids(byTime)}`);
  });
});

testGroup('ended memories stay reachable and marked', () => {
  const past = 1_000;
  const rows = {
    semantic: [
      { id: 5, timestamp: 10, importance: 0.4, content: 'alpha current', context: '', metadata: {}, is_live: true, superseded_by: null },
      { id: 4, timestamp: 50, importance: 0.9, content: 'alpha expired', context: '', metadata: { valid_until: past }, valid_until: past, is_live: true, superseded_by: null },
      { id: 3, timestamp: 20, importance: 0.95, content: 'alpha old rule', context: '', metadata: { superseded_by: 5, superseded_at: 200 }, superseded_by: 5, superseded_at: 200, is_live: false }
    ]
  };

  test('an expired entry stays in recall and query_layer, marked with its end date', async () => {
    const recalled = await recallMemories(rankingDb(rows), 'alpha', 'semantic', 10);
    const expired = recalled.find((r) => r.id === 4);
    assert.ok(expired, `expired id 4 missing from ${ids(recalled)}`);
    assert.strictEqual(expired.is_expired, true);
    assert.strictEqual(expired.ended, true);
    assert.strictEqual(expired.end_date, past);
    assert.strictEqual(expired.valid_until, past);
    assert.strictEqual(expired.replaced_by, null);
    assert.ok(ids(recalled).indexOf(5) < ids(recalled).indexOf(4), `current should precede expired, got ${ids(recalled)}`);
    const queried = await queryLayer(rankingDb(rows), 'semantic', {});
    const qe = queried.find((r) => r.id === 4);
    assert.ok(qe && qe.ended === true && qe.end_date === past, JSON.stringify(qe && { id: qe.id, ended: qe.ended, end_date: qe.end_date }));
  });

  test('a superseded entry stays in query_layer when include_superseded is false, current version first', async () => {
    const queried = await queryLayer(rankingDb(rows), 'semantic', { include_superseded: false });
    const old = queried.find((r) => r.id === 3);
    assert.ok(old, `superseded id 3 missing from ${ids(queried)}`);
    assert.strictEqual(old.is_superseded, true);
    assert.strictEqual(old.ended, true);
    assert.strictEqual(old.replaced_by, 5);
    assert.strictEqual(old.superseded_by, 5);
    assert.strictEqual(old.end_date, 200);
    assert.strictEqual(old.superseded_at, 200);
    assert.ok(ids(queried).indexOf(5) < ids(queried).indexOf(3), `current should precede superseded, got ${ids(queried)}`);
    const recalled = await recallMemories(rankingDb(rows), 'alpha', 'semantic', 10);
    const parent = recalled.find((r) => r.id === 3);
    assert.ok(parent && parent.replaced_by === 5 && parent.end_date === 200, JSON.stringify(parent && { id: parent.id, replaced_by: parent.replaced_by, end_date: parent.end_date }));
  });

  test('history true returns ended entries when current ones fill the limit', async () => {
    const db = rankingDb({
      semantic: [
        { id: 1, timestamp: 10, importance: 0.4, content: 'alpha now', context: '', metadata: {}, is_live: true, superseded_by: null },
        { id: 3, timestamp: 20, importance: 0.9, content: 'alpha then', context: '', metadata: { superseded_by: 1, superseded_at: 30 }, superseded_by: 1, superseded_at: 30, is_live: true }
      ]
    });
    const page = await recallMemories(db, 'alpha', 'semantic', 1);
    assert.deepStrictEqual(ids(page), [1], `default page got ${ids(page)}`);
    const history = await recallMemories(db, 'alpha', 'semantic', 1, null, null, { history: true });
    assert.deepStrictEqual(ids(history), [3], `history page got ${ids(history)}`);
    assert.strictEqual(history[0].ended, true);
    assert.strictEqual(history[0].end_date, 30);
    const queried = await queryLayer(db, 'semantic', { limit: 1, history: true });
    assert.deepStrictEqual(ids(queried), [3], `query history got ${ids(queried)}`);
  });
});

testGroup('revise_memory records an end, it does not hide', () => {
  test('revise_memory records the end date and the new id and does not set is_live false', async () => {
    const db = layerHonouringDb();
    const SRC = { source: 'tester-bot', assertion_origin: 'assistant', derived_from: { session_id: '2026-10-07_a', exchange_start: 1, exchange_end: 1 } };
    const parent = await saveMemory(db, 'The alpha rule as first written.', 'semantic', { ...SRC });
    const rev = await reviseMemory(db, 'semantic', parent.id, 'The alpha rule as revised.', { source: 'tester-bot', assertion_origin: 'assistant' });
    assert.strictEqual(rev.verified, true);
    const stored = db.row('semantic', parent.id);
    assert.strictEqual(Number(stored.superseded_by), Number(rev.id));
    assert.strictEqual(stored.superseded_at, rev.timestamp);
    assert.notStrictEqual(stored.is_live, false, 'supersession must not set is_live false');
    assert.strictEqual(stored.metadata.superseded_at, rev.timestamp);
    const recalled = await recallMemories(db, 'alpha rule', 'semantic', 10);
    const old = recalled.find((r) => r.id === parent.id);
    assert.ok(old, `revised parent missing from recall: ${ids(recalled)}`);
    assert.strictEqual(old.ended, true);
    assert.strictEqual(old.end_date, rev.timestamp);
    assert.strictEqual(old.replaced_by, rev.id);
    const current = recalled.find((r) => r.id === rev.id);
    assert.ok(current && current.ended !== true, 'the new entry should be the current one');
    assert.ok(ids(recalled).indexOf(rev.id) < ids(recalled).indexOf(parent.id));
  });
});

testGroup('retired documents stay listed', () => {
  test('list_docs keeps a retired document after current ones, with retired_at and what replaced it', async () => {
    const store = makeStore();
    const when = '2026-04-01T00:00:00.000Z';
    store.collection('documents').docs.push(
      { doc_id: 'threads/b.md', content: 'current', version: 1, sha256: 'b', size: 7, retired: false },
      { doc_id: 'threads/a.md', content: 'old', version: 2, sha256: 'a', size: 3, retired: true, retired_at: when, retired_reason: 'Reissued as threads/b.md' }
    );
    const listed = await withStore(store, () => listDocs(null, null, false));
    assert.deepStrictEqual(listed.documents.map((d) => d.doc_id), ['threads/b.md', 'threads/a.md']);
    const retired = listed.documents[1];
    assert.strictEqual(retired.retired, true);
    assert.strictEqual(retired.retired_at, when);
    assert.strictEqual(retired.replaced_by, 'threads/b.md');
    assert.strictEqual(listed.retired_shown, 1);
    assert.strictEqual(listed.include_retired, true);
  });

  test('startup lists retired seeds, threads and drops marked, and a retired drop is not unhandled', async () => {
    const store = makeStore();
    const docs = store.collection('documents');
    const when = '2026-03-01T00:00:00.000Z';
    docs.docs.push(
      { doc_id: 'bootstrap/IDENTITY.md', content: '# Identity\n\nAda\n', version: 1 },
      { doc_id: 'bootstrap/USER.md', content: '# User\n\nSam\n', version: 1 },
      { doc_id: 'bootstrap/INSTALL.md', content: '# Install\n\nnotes\n', version: 1, retired: true, retired_at: when, retired_reason: 'Reissued as bootstrap/INSTALL-2.md' },
      { doc_id: 'seeds/current.md', content: '---\nstatus: DORMANT\n---\n# Current seed\n', version: 1 },
      { doc_id: 'seeds/old.md', content: '---\nstatus: DORMANT\ntrigger:\n  - kind: DATE\n    test: "2020-01-01"\n---\n# Old seed\n', version: 1, retired: true, retired_at: when, retired_reason: 'done' },
      { doc_id: 'threads/live.md', content: 'live', version: 1, updated_at: new Date('2026-05-02T00:00:00.000Z') },
      { doc_id: 'threads/old.md', content: 'old thread', version: 1, updated_at: new Date('2026-06-01T00:00:00.000Z'), retired: true, retired_at: when, retired_reason: 'Reissued as threads/live.md' },
      { doc_id: 'drops/open.md', content: 'open', version: 1, retired: false, updated_at: new Date('2026-05-01T00:00:00.000Z') },
      { doc_id: 'drops/done.md', content: 'done', version: 1, retired: true, retired_at: when, retired_reason: 'filed', updated_at: new Date('2026-05-03T00:00:00.000Z') }
    );
    const whole = await withStore(store, () => initialize({ page: 'all' }));
    const payload = payloadOf(whole);
    assert.deepStrictEqual(payload.seeds.map((s) => s.doc_id), ['seeds/current.md', 'seeds/old.md']);
    const oldSeed = payload.seeds[1];
    assert.strictEqual(oldSeed.retired, true);
    assert.strictEqual(oldSeed.retired_at, when);
    assert.ok(!payload.seeds_due.includes('seeds/old.md'), `retired seed must not be due: ${payload.seeds_due}`);
    assert.deepStrictEqual(payload.threads.map((t) => t.doc_id), ['threads/live.md', 'threads/old.md']);
    assert.strictEqual(payload.threads[1].retired, true);
    assert.strictEqual(payload.threads[1].replaced_by, 'threads/live.md');
    assert.strictEqual(payload.threads[1].retired_at, when);
    assert.deepStrictEqual(payload.unhandled_drops, ['drops/open.md']);
    assert.strictEqual(payload.retired_drops.length, 1);
    assert.strictEqual(payload.retired_drops[0].doc_id, 'drops/done.md');
    assert.strictEqual(payload.retired_drops[0].retired_at, when);
    assert.strictEqual(payload.install_notes.retired, true);
    assert.strictEqual(payload.install_notes.retired_at, when);
    assert.strictEqual(payload.install_notes.replaced_by, 'bootstrap/INSTALL-2.md');
  });
});

testGroup('semantic recall keeps ended hits', () => {
  test('semantic hit collection keeps an expired row and ranks the current one first', () => {
    const docs = [
      { id: 4, content: 'old plant', timestamp: 50, importance: 0.9, score: 0.99, metadata: { valid_until: 1000 }, is_live: true, superseded_by: null },
      { id: 5, content: 'live plant', timestamp: 10, importance: 0.2, score: 0.1, metadata: {}, is_live: true, superseded_by: null }
    ];
    const hits = collectSemanticHits(docs, 'semantic');
    const expired = hits.find((r) => r.id === 4);
    assert.ok(expired, 'expired hit was dropped before ranking');
    assert.strictEqual(expired.is_expired, true);
    assert.strictEqual(expired.ended, true);
    assert.strictEqual(expired.end_date, 1000);
    const ranked = rankSemanticHits(hits, 'plants');
    assert.strictEqual(ranked[0].id, 5, `current entry should lead, got ${ids(ranked)}`);
    const latest = rankSemanticHits(hits, 'latest plants');
    assert.strictEqual(latest[0].id, 5, `current entry leads even for latest, got ${ids(latest)}`);
    assert.strictEqual(latest[1].id, 4, `ended entry follows the current one, got ${ids(latest)}`);
    const columnOnly = collectSemanticHits([
      { id: 8, content: 'column only', timestamp: 1, importance: 0.1, score: 0.5, metadata: {}, valid_until: 1000, is_live: true, superseded_by: null }
    ], 'semantic');
    assert.strictEqual(columnOnly[0].is_expired, true, 'a promoted valid_until column is the end date');
    assert.strictEqual(columnOnly[0].end_date, 1000);
    assert.strictEqual(columnOnly[0].ended, true);
  });
});

function row(id, timestamp, importance, content, extra = {}) {
  return {
    id, timestamp, importance, content, context: '', metadata: {},
    is_live: true, superseded_by: null, ...extra
  };
}

testGroup('current entries lead every order', () => {
  test('latest alpha with limit 1 returns the current match, not a newer ended one', async () => {
    const one = await recallMemories(rankingDb({
      semantic: [
        row(1, 100, 0.2, 'alpha now'),
        row(2, 900, 0.9, 'alpha then', { metadata: { superseded_by: 1, superseded_at: 800 }, superseded_by: 1, superseded_at: 800 })
      ]
    }), 'latest alpha', 'semantic', 1);
    assert.deepStrictEqual(ids(one), [1], `current must lead a latest page, got ${ids(one)}`);
  });

  test('order_by timestamp DESC lists current rows first, then ended rows by time', async () => {
    const byTime = await queryLayer(rankingDb({
      semantic: [
        row(1, 100, 0.2, 'alpha now'),
        row(7, 500, 0.2, 'alpha also'),
        row(2, 900, 0.9, 'alpha then', { metadata: { superseded_by: 1, superseded_at: 800 }, superseded_by: 1, superseded_at: 800 })
      ]
    }), 'semantic', { order_by: 'timestamp DESC' });
    assert.deepStrictEqual(ids(byTime), [7, 1, 2], `timestamp DESC got ${ids(byTime)}`);
  });
});

testGroup('latest is explicit, and a loose word does not change the match', () => {
  test('latest-budget is a keyword, not a time order', async () => {
    const out = await recallMemories(rankingDb({
      semantic: [
        row(1, 100, 0.9, 'latest-budget plan'),
        row(2, 900, 0.1, 'latest-budget other'),
        row(3, 800, 0.5, 'plain budget')
      ]
    }), 'latest-budget', 'semantic', 10);
    assert.deepStrictEqual(ids(out), [1, 2], `latest-budget got ${ids(out)}`);
  });

  test('the latest reorders matches of the other words and does not return every row', async () => {
    const out = await recallMemories(rankingDb({
      semantic: [
        row(1, 100, 0.9, 'the alpha'),
        row(2, 900, 0.1, 'the beta'),
        row(3, 800, 0.8, 'gamma alone')
      ]
    }), 'the latest', 'semantic', 10);
    assert.deepStrictEqual(ids(out), [2, 1], `the latest got ${ids(out)}`);
  });

  test('not the latest does not ask for time order', async () => {
    const out = await recallMemories(rankingDb({
      semantic: [
        row(1, 100, 0.2, 'not the latest budget'),
        row(2, 900, 0.9, 'not the budget')
      ]
    }), 'not the latest', 'semantic', 1);
    assert.deepStrictEqual(ids(out), [1], `not the latest got ${ids(out)}`);
  });

  test('bare latest is an ordinary keyword and does not return every row', async () => {
    const out = await recallMemories(rankingDb({
      semantic: [
        row(1, 100, 0.9, 'the latest plan'),
        row(2, 900, 0.1, 'the latest note'),
        row(3, 800, 0.5, 'unrelated alpha')
      ]
    }), 'latest', 'semantic', 10);
    assert.deepStrictEqual(ids(out), [1, 2], `bare latest got ${ids(out)}`);
  });

  test('order latest reorders matches and does not widen them', async () => {
    const rows = {
      semantic: [
        row(1, 100, 0.9, 'alpha'),
        row(2, 900, 0.1, 'alpha'),
        row(3, 50, 0.5, 'other')
      ]
    };
    const timed = await recallMemories(rankingDb(rows), 'alpha', 'semantic', 10, null, null, { order: 'latest' });
    assert.deepStrictEqual(ids(timed), [2, 1], `order latest got ${ids(timed)}`);
    const plain = await recallMemories(rankingDb(rows), 'alpha', 'semantic', 10);
    assert.deepStrictEqual(ids(plain), [1, 2], `without order got ${ids(plain)}`);
  });

  test('order rejects anything other than latest', async () => {
    await assert.rejects(
      () => recallMemories(rankingDb({ semantic: [row(1, 1, 0.5, 'alpha')] }), 'alpha', 'semantic', 1, null, null, { order: 'newest' }),
      (e) => e instanceof Error && /order must be 'latest'/.test(e.message)
    );
  });
});

testGroup('the store ranks before it limits', () => {
  test('a better keyword match outside the importance window is kept', async () => {
    const semantic = [];
    for (let i = 1; i <= 200; i++) semantic.push(row(i, i, 0.9, 'alpha only'));
    semantic.push(row(999, 1, 0.01, 'alpha beta both'));
    const out = await recallMemories(rankingDb({ semantic }), 'alpha beta', 'semantic', 10);
    assert.strictEqual(out[0] && out[0].id, 999, `better match was cut, got ${ids(out).slice(0, 3)}`);
    assert.ok(out.some((r) => r.id === 999));
  });

  test('latest alpha limit 1 is not hidden by newer ended rows filling the window', async () => {
    const semantic = [row(1, 1, 0.2, 'alpha current')];
    for (let i = 0; i < 200; i++) {
      semantic.push(row(1000 + i, 1000 + i, 0.9, 'alpha ended', {
        metadata: { superseded_by: 1, superseded_at: 500 },
        superseded_by: 1,
        superseded_at: 500
      }));
    }
    const out = await recallMemories(rankingDb({ semantic }), 'latest alpha', 'semantic', 1);
    assert.deepStrictEqual(ids(out), [1], `ended row hid the current one, got ${ids(out)}`);
    assert.strictEqual(out[0].ended, false);
  });

  test('a $gt or $ne keyword is matched as text', async () => {
    const semantic = [];
    for (let i = 1; i <= 200; i++) semantic.push(row(i, i, 0.9, '$ne only'));
    semantic.push(row(999, 1, 0.01, '$ne $gt both'));
    const out = await recallMemories(rankingDb({ semantic }), '$ne $gt', 'semantic', 10);
    assert.strictEqual(out[0] && out[0].id, 999, `operator keyword was cut, got ${ids(out).slice(0, 3)}`);
    const pipeline = buildRankPipeline({
      filter: { content: { $regex: '\\$gt', $options: 'i' } },
      keywords: ['$gt', '$ne'],
      bound: 10,
      kind: 'recall'
    });
    const literals = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Object.keys(node).length === 1 && Object.prototype.hasOwnProperty.call(node, '$literal')) literals.push(node.$literal);
      for (const value of Object.values(node)) walk(value);
    };
    walk(pipeline.find((stage) => stage.$addFields));
    assert.ok(literals.includes('\\$gt'), `keyword was not a literal: ${JSON.stringify(literals)}`);
    assert.ok(literals.includes('\\$ne'), `keyword was not a literal: ${JSON.stringify(literals)}`);
  });

  test('École counts as a hit for école and stays in the window', async () => {
    const semantic = [];
    for (let i = 1; i <= 200; i++) semantic.push(row(i, i, 0.9, 'école'));
    semantic.push(row(999, 1, 0.99, 'École'));
    const out = await recallMemories(rankingDb({ semantic }), 'école', 'semantic', 10);
    assert.strictEqual(out[0] && out[0].id, 999, `École was not counted, got ${ids(out).slice(0, 3)}`);
  });

  test('ẞ and ß count as the same hit, in both directions', async () => {
    const probe = async (query, filler, kept) => {
      const semantic = [];
      for (let i = 1; i <= 200; i++) semantic.push(row(i, i, 0.9, filler));
      semantic.push(row(999, 1, 0.01, kept));
      const out = await recallMemories(rankingDb({ semantic }), query, 'semantic', 10);
      assert.strictEqual(out.length, 10, `${query} page ${ids(out)}`);
      assert.ok(!ids(out).includes(999), `${query} kept the row the window cuts: ${ids(out)}`);
      assert.ok(out.every((r) => r.content === filler), `${query} got ${out.slice(0, 3).map((r) => r.content)}`);
    };
    await probe('ß', 'ẞ', 'ß');
    await probe('ẞ', 'ß', 'ẞ');
  });

  test('full-width ａ matches Ａ and ASCII a does not', async () => {
    const rows = { semantic: [row(1, 1, 0.8, 'Ａ'), row(2, 1, 0.2, 'a')] };
    const ascii = await recallMemories(rankingDb(rows), 'a', 'semantic', 10);
    assert.deepStrictEqual(ids(ascii), [2], `ASCII a matched full-width: ${ids(ascii)}`);
    const wide = await recallMemories(rankingDb(rows), 'ａ', 'semantic', 10);
    assert.deepStrictEqual(ids(wide), [1], `full-width a missed Ａ: ${ids(wide)}`);
    const dotted = await recallMemories(rankingDb({
      semantic: [row(1, 1, 0.8, 'i'), row(2, 1, 0.9, 'İ')]
    }), 'İ', 'semantic', 10);
    assert.deepStrictEqual(ids(dotted), [2], `İ ${ids(dotted)}`);
  });

  test('history still reaches an ended row when current matches fill the window', async () => {
    const semantic = [];
    for (let i = 1; i <= 200; i++) semantic.push(row(i, i, 0.5, 'alpha now'));
    semantic.push(row(999, 1, 0.1, 'alpha then', {
      metadata: { superseded_by: 1, superseded_at: 50 },
      superseded_by: 1,
      superseded_at: 50
    }));
    const out = await recallMemories(rankingDb({ semantic }), 'alpha', 'semantic', 1, null, null, { history: true });
    assert.deepStrictEqual(ids(out), [999], `history missed the ended row, got ${ids(out)}`);
  });
});

testGroup('a layer read stays bounded', () => {
  test('a large layer read is bounded', async () => {
    const db = layerHonouringDb();
    for (let i = 0; i < 400; i++) {
      await db.insertMemory('semantic', {
        content: `alpha item ${i}`, timestamp: i, importance: i / 1000,
        metadata: {}, is_live: true, superseded_by: null, context: ''
      });
    }
    const inner = db.aggregateMemories.bind(db);
    let seen = null;
    let fetched = 0;
    db.aggregateMemories = async (layer, pipeline) => {
      seen = pipeline;
      const rows = await inner(layer, pipeline);
      fetched = rows.length;
      return rows;
    };
    const page = await recallMemories(db, 'alpha', 'semantic', 10);
    assert.strictEqual(page.length, 10);
    const recallLimit = seen && seen.find((st) => st.$limit);
    const recallSort = seen && seen.find((st) => st.$sort);
    assert.strictEqual(recallLimit && recallLimit.$limit, 200, `recall loaded ${recallLimit && recallLimit.$limit}`);
    assert.strictEqual(recallSort && recallSort.$sort._ended, 1);
    assert.strictEqual(recallSort && recallSort.$sort._hits, -1);
    assert.strictEqual(recallSort && recallSort.$sort.importance, -1);
    assert.ok(fetched <= 200 && fetched < 400, `recall fetched ${fetched}`);

    let qseen = null;
    let qfetched = 0;
    db.aggregateMemories = async (layer, pipeline) => {
      qseen = pipeline;
      const rows = await inner(layer, pipeline);
      qfetched = rows.length;
      return rows;
    };
    const queried = await queryLayer(db, 'semantic', { limit: 10 });
    assert.strictEqual(queried.length, 10);
    const queryLimit = qseen && qseen.find((st) => st.$limit);
    const querySort = qseen && qseen.find((st) => st.$sort);
    assert.strictEqual(queryLimit && queryLimit.$limit, 200, `query_layer loaded ${queryLimit && queryLimit.$limit}`);
    assert.strictEqual(querySort && querySort.$sort._ended, 1);
    assert.strictEqual(querySort && querySort.$sort.importance, -1);
    assert.ok(qfetched <= 200 && qfetched < 400, `query_layer fetched ${qfetched}`);
  });

  test('aggregateMemories sets allowDiskUse so a large sort can finish', async () => {
    const store = makeStore();
    const db = new EmetDatabase(null);
    let opts = null;
    await withStore(store, async () => {
      await db.ensureClient();
      const col = store.collection(`${COLLECTION_PREFIX}semantic`);
      const orig = col.aggregate.bind(col);
      col.aggregate = (pipeline, options) => {
        opts = options;
        return orig(pipeline, options);
      };
      await recallMemories(db, 'alpha', 'semantic', 1);
    });
    assert.strictEqual(opts && opts.allowDiskUse, true, `allowDiskUse was ${opts && opts.allowDiskUse}`);
  });

  test('ascending sort puts null and missing first, descending puts them last', async () => {
    const db = layerHonouringDb();
    await db.insertMemory('semantic', { content: 'high', timestamp: 1, importance: 0.9, metadata: {}, is_live: true, superseded_by: null, context: '' });
    await db.insertMemory('semantic', { content: 'low', timestamp: 2, importance: 0.2, metadata: {}, is_live: true, superseded_by: null, context: '' });
    await db.insertMemory('semantic', { content: 'missing', timestamp: 3, metadata: {}, is_live: true, superseded_by: null, context: '' });
    await db.insertMemory('semantic', { content: 'blank', timestamp: 4, importance: null, metadata: {}, is_live: true, superseded_by: null, context: '' });
    const asc = (await db.findMemories('semantic', {}, { sort: { importance: 1 } })).map((r) => r.content);
    assert.ok(asc.indexOf('missing') < asc.indexOf('low'), `asc missing not first: ${asc}`);
    assert.ok(asc.indexOf('blank') < asc.indexOf('low'), `asc null not first: ${asc}`);
    assert.ok(asc.indexOf('low') < asc.indexOf('high'), `asc order ${asc}`);
    const desc = (await db.findMemories('semantic', {}, { sort: { importance: -1 } })).map((r) => r.content);
    assert.strictEqual(desc[0], 'high', `desc ${desc}`);
    assert.ok(desc.indexOf('low') < desc.indexOf('missing'), `desc missing not last: ${desc}`);
    assert.ok(desc.indexOf('low') < desc.indexOf('blank'), `desc null not last: ${desc}`);
    const ascPage = (await queryLayer(db, 'semantic', { order_by: 'importance ASC', limit: 10 })).map((r) => r.content);
    assert.ok(ascPage.indexOf('missing') < ascPage.indexOf('low') && ascPage.indexOf('blank') < ascPage.indexOf('low'), `query asc ${ascPage}`);
    const descPage = (await queryLayer(db, 'semantic', { order_by: 'importance DESC', limit: 10 })).map((r) => r.content);
    assert.strictEqual(descPage[0], 'high', `query desc ${descPage}`);
    assert.ok(descPage.indexOf('low') < descPage.indexOf('missing') && descPage.indexOf('low') < descPage.indexOf('blank'), `query desc ${descPage}`);

    const docs = [
      { _id: 'a', importance: 0.2 },
      { _id: 'b' },
      { _id: 'c', importance: null },
      { _id: 'd', importance: 0.9 }
    ];
    assert.deepStrictEqual(applyAggregate(docs, [{ $sort: { importance: 1, _id: 1 } }]).map((d) => d._id), ['b', 'c', 'a', 'd']);
    assert.deepStrictEqual(applyAggregate(docs, [{ $sort: { importance: -1, _id: 1 } }]).map((d) => d._id), ['d', 'a', 'b', 'c']);
    assert.throws(() => applyAggregate(docs, [{ $noSuchStage: 1 }]), /unknown stage/);
    assert.throws(() => applyAggregate(docs, [{ $addFields: { b: { $noSuchOp: 1 } } }]), /unknown operator/);
  });

  test('memstore throws on an unknown operator and accepts the ones recall uses', () => {
    assert.throws(() => storeMatches({ a: 1 }, { a: { $bogus: 1 } }), /unknown operator/);
    assert.strictEqual(storeMatches({ content: 'latest-budget plan' }, { content: { $regex: 'latest-budget', $options: 'i' } }), true);
    assert.strictEqual(storeMatches({ content: 'other' }, { $or: [{ content: { $regex: 'latest-budget', $options: 'i' } }] }), false);
  });
});

function toolData(res) {
  const body = JSON.parse(res.content[0].text);
  assert.strictEqual(body.success, true, JSON.stringify(body).slice(0, 400));
  return body.data;
}

testGroup('history reaches the tool', () => {
  test('dispatchTool passes history: true through to recall and semantic_recall', async () => {
    const pair = [
      row(1, 10, 0.4, 'alpha now'),
      row(3, 20, 0.9, 'alpha then', { metadata: { superseded_by: 1, superseded_at: 30 }, superseded_by: 1, superseded_at: 30 })
    ];
    const recalled = toolData(await dispatchTool('recall', {
      query: 'alpha', layer: 'semantic', limit: 1, history: true
    }, { dbManager: rankingDb({ semantic: pair }), logger: null }));
    assert.deepStrictEqual(ids(recalled), [3], `recall history via dispatch got ${ids(recalled)}`);

    const semantic = toolData(await dispatchTool('semantic_recall', {
      query: 'alpha', layer: 'semantic', limit: 1, history: true
    }, {
      dbManager: {
        async vectorRecall() {
          return pair.map((r) => ({ ...r, score: r.id === 3 ? 0.99 : 0.1 }));
        }
      },
      logger: null
    }));
    assert.deepStrictEqual(semantic.results.map((r) => r.id), [3], `semantic history via dispatch got ${semantic.results && semantic.results.map((r) => r.id)}`);
  });
});

summary('Recall ranking and visibility');
