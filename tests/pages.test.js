/**
 * Topic pages and page lint. Pages are views. These tests plant ten problems,
 * prove lint flags at least eight of them, prove page and lint calls do not
 * change a record, and prove a non-owner cannot read a page.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';
import { makeStore, withStore, withEnv } from './memstore.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  parseArea, compilePage, citeMemory, readPage, listPages, lintPages, pageLintDigest,
  PAGE_LINT_CLASSES, currentAt, assertAreaOwner
} = await import('../src/pages.js');
const { checkRecord, loadShipped, templateFor, clearShippedCache } = await import('../src/conformance.js');
const { actorStore } = await import('../src/persons.js');
const { dispatchTool } = await import('../src/dispatch.js');
const { isBotTag } = await import('../src/session-graph.js');

const CITE = /\[(?:mem:\d+ · [a-z]+ · [^·\]]+ · \d{4}-\d{2}-\d{2}|doc:[^\]@]+@v\d+)\]$/;
const RECENT = Date.now() / 1000 - 86400;
const OLD = Date.parse('2020-01-01T00:00:00Z') / 1000;

function snapshot(store) {
  // Empty collection handles are not records. A read cursor materializes one
  // in this stand-in the moment a layer is named, and a refused area write
  // opens the history collection before the owner check throws. Neither
  // stores a document. The hash is every stored document, nothing else.
  const cols = [...store.cols.entries()].filter(([, col]) => col.docs.length > 0).sort((a, b) => a[0].localeCompare(b[0]));
  const body = cols.map(([name, col]) => name + '\n' + col.docs.map((d) => JSON.stringify(d)).sort().join('\n')).join('\n---\n');
  return crypto.createHash('sha256').update(body).digest('hex');
}

function areaDoc(slug, { staleness = 30, cap = 80, tags = 'lintplant', layers = 'semantic', prefixes = 'threads/lintplant', title = 'Audit' } = {}) {
  return {
    doc_id: `areas/${slug}.md`,
    version: 1,
    updated_at: new Date('2026-10-20T12:00:00Z'),
    updated_by: 'claude-host',
    retired: false,
    content: `# Area — ${title}

## §0 RECORD CONTROL
- Template: \`templates/AREA.md\` · Area revision: the store's version governs
- Slug: ${slug}
- Title: ${title}

## §1 SELECTOR
- **Layers:** ${layers}
- **Tags:** ${tags}
- **Keywords:** none
- **Doc id prefixes:** ${prefixes}
- **Source clients:** any
- **Staleness days:** ${staleness}
- **Item cap:** ${cap}

## §2 SCOPE
Selector for the ${slug} page. This document names what to look at.
`
  };
}

function row(id, extra = {}) {
  const sourced = extra.unsourced !== true;
  return {
    id,
    content: extra.content,
    timestamp: extra.timestamp === undefined ? RECENT : extra.timestamp,
    importance: extra.importance ?? 0.7,
    metadata: {
      ...(extra.source ? { source: extra.source } : {}),
      tags: ['lintplant'],
      ...(extra.subject ? { subject: extra.subject, claim: extra.claim } : {}),
      ...(extra.status ? { status: extra.status } : {})
    },
    source_session_id: sourced && extra.pointer !== false ? 'sess-lint' : null,
    derived_from_ids: [],
    superseded_by: extra.superseded_by ?? null,
    superseded_at: extra.superseded_at ?? null,
    is_live: true
  };
}

const PLANTED = [
  { key: 'contra-budget', class: 'contradictions', ids: ['semantic#1', 'semantic#2'] },
  { key: 'contra-vendor', class: 'contradictions', ids: ['semantic#3', 'semantic#4'] },
  { key: 'superseded-claim', class: 'superseded_but_current', ids: ['semantic#91', 'semantic#90'] },
  { key: 'unsourced-noclient', class: 'unsourced', ids: ['semantic#7'] },
  { key: 'unsourced-noprovenance', class: 'unsourced', ids: ['semantic#8'] },
  { key: 'duplicate-invoice', class: 'duplicates', ids: ['semantic#11', 'semantic#12'] },
  { key: 'duplicate-lease', class: 'duplicates', ids: ['semantic#13', 'semantic#14'] },
  { key: 'broken-doc', class: 'broken_links', ids: ['semantic#15', 'doc:threads/missing-lease.md'] },
  { key: 'broken-mem', class: 'broken_links', ids: ['semantic#16', 'mem:40404'] },
  { key: 'stale-status', class: 'long_unconfirmed', ids: ['semantic#17'] }
];

function plant(store) {
  const semantic = store.collection('emet_semantic');
  const rows = [
    row(1, { content: 'budget is 100', source: 'claude-host', subject: 'budget', claim: '$100' }),
    row(2, { content: 'budget is 200', source: 'intake-bot', subject: 'budget', claim: '$200' }),
    row(3, { content: 'vendor is acme', source: 'claude-host', subject: 'vendor', claim: 'acme' }),
    row(4, { content: 'vendor is initech', source: 'intake-bot', subject: 'vendor', claim: 'initech' }),
    row(90, { content: 'old rent figure', source: 'claude-host', timestamp: OLD, superseded_by: 91, superseded_at: OLD + 86400 }),
    row(91, { content: 'treat mem:90 as current', source: 'claude-host' }),
    row(7, { content: 'a claim with no client', timestamp: null, unsourced: true }),
    row(8, { content: 'standing fact without a session pointer', source: 'claude-host', pointer: false }),
    row(11, { content: 'the invoice is paid', source: 'claude-host' }),
    row(12, { content: 'the invoice is paid', source: 'intake-bot' }),
    row(13, { content: 'renew the lease in march', source: 'claude-host' }),
    row(14, { content: 'renew the lease in march', source: 'intake-bot' }),
    row(15, { content: 'see doc:threads/missing-lease.md for the scan', source: 'claude-host' }),
    row(16, { content: 'see mem:40404 for the missing row', source: 'claude-host' }),
    row(17, { content: 'rent status is steady', source: 'claude-host', timestamp: OLD, status: 'standing' }),
    row(18, { content: 'the roof was replaced in 2024', source: 'claude-host' }),
    row(19, { content: 'see doc:threads/lintplant-note.md@v1 for the old note', source: 'claude-host' }),
    row(20, { content: 'see doc:threads/lintplant-old.md for the retired note', source: 'claude-host' })
  ];
  for (const r of rows) semantic.docs.push(r);
  const docs = store.collection('documents');
  docs.docs.push(areaDoc('audit'));
  docs.docs.push({
    doc_id: 'threads/lintplant-note.md',
    version: 2,
    content: 'The lint fixture keeps one sourced note.\n',
    updated_at: new Date('2026-10-19T12:00:00Z'),
    updated_by: 'claude-host',
    retired: false
  });
  docs.docs.push({
    doc_id: 'threads/lintplant-old.md',
    version: 4,
    content: 'Retired rent note that must not read as current.\n',
    updated_at: new Date('2024-01-01T00:00:00Z'),
    updated_by: 'claude-host',
    retired: true,
    retired_at: new Date('2024-06-01T00:00:00Z')
  });
  store.collection('persons').docs.push({ person_id: 'alex', role: 'owner' });
  store.collection('persons').docs.push({ person_id: 'ada', role: 'member' });
  return store;
}

const ownerHttp = { personId: 'alex', transport: 'http', authenticated: true, scopes: ['emet.read', 'emet.write'] };
const memberHttp = { personId: 'ada', transport: 'http', authenticated: true, scopes: ['emet.read', 'emet.write'] };
const guestHttp = { personId: 'ada', transport: 'http', authenticated: true, scopes: ['emet.read'] };
const httpNoPerson = { personId: null, transport: 'http', authenticated: true, scopes: ['emet.read', 'emet.write'] };
const httpUnknown = { personId: 'no-such-person', transport: 'http', authenticated: true, scopes: ['emet.read', 'emet.write'] };

function caught(findings, spec) {
  return findings.some((f) => f.class === spec.class && spec.ids.every((id) => f.ids.includes(id)));
}

function bullets(markdown) {
  return String(markdown).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '));
}

testGroup('shipped area selectors', () => {
  test('areas/ contains exactly the generic set', () => {
    const generic = ['emet.md', 'garden.md', 'health.md', 'home.md', 'learning.md', 'state.md'];
    const expectSet = (names) => assert.deepStrictEqual([...names].sort(), generic);
    const names = fs.readdirSync(path.join(ROOT, 'areas'));
    expectSet(names);
    assert.throws(() => expectSet([...names, 'family.md']));
    const css = fs.readFileSync(path.join(ROOT, 'site/styles.css'), 'utf8');
    const oauth = fs.readFileSync(path.join(ROOT, 'src/oauth-provider.js'), 'utf8');
    assert.ok(css.includes('font-family:'));
    assert.ok(oauth.includes('family: fam'));
    expectSet(fs.readdirSync(path.join(ROOT, 'areas')));
  });
  test('areas map to the area template', () => {
    assert.strictEqual(templateFor('areas/health.md'), 'templates/AREA.md');
    assert.strictEqual(templateFor('areas/state.md'), 'templates/AREA.md');
  });
  test('the six shipped area documents conform and parse', () => {
    clearShippedCache();
    const template = loadShipped('templates/AREA.md', { cache: false });
    const expect = {
      'emet.md': { slug: 'emet', title: 'EMET', days: 30 },
      'garden.md': { slug: 'garden', title: 'Garden', days: 30 },
      'home.md': { slug: 'home', title: 'Home', days: 30 },
      'health.md': { slug: 'health', title: 'Health', days: 30 },
      'learning.md': { slug: 'learning', title: 'Learning', days: 30 },
      'state.md': { slug: 'state', title: 'State', days: 30 }
    };
    for (const [file, want] of Object.entries(expect)) {
      const content = fs.readFileSync(path.join(ROOT, 'areas', file), 'utf8');
      const checked = checkRecord(content, template, { doc_id: `areas/${file}` });
      assert.deepStrictEqual(checked.failures, [], `${file} ${checked.failures.join('; ')}`);
      const parsed = parseArea(content, `areas/${file}`);
      assert.strictEqual(parsed.slug, want.slug);
      assert.strictEqual(parsed.title, want.title);
      assert.strictEqual(parsed.staleness_days, want.days);
      assert.ok(parsed.layers.length > 0, file);
    }
  });
  test('area rule 3 is the owner login sentence and does not say only bots may write', () => {
    const text = fs.readFileSync(path.join(ROOT, 'templates', 'AREA.md'), 'utf8');
    const rule = text.split('\n').find((line) => line.startsWith('3. '));
    assert.strictEqual(rule, '3. **Only the owner\'s login** creates or edits an area document: a local (stdio) session, or a remote login whose person has the owner role. Other logins, including Member and Guest, cannot. In practice the owner\'s AI clients make the entries; the server does not tell a bot from a person.');
    for (const phrase of [
      "owner's login",
      'a local (stdio) session',
      'a remote login whose person has the owner role',
      'Other logins, including Member and Guest, cannot.',
      'the server does not tell a bot from a person'
    ]) {
      assert.ok(rule.includes(phrase), phrase);
    }
    assert.doesNotMatch(rule, /bots only|only by bots|only bots/i);
  });
  test('the state selector keeps STATE.md as the hand-kept board', () => {
    const text = fs.readFileSync(path.join(ROOT, 'areas', 'state.md'), 'utf8');
    assert.match(text, /STATE\.md stays the board/);
    const src = fs.readFileSync(path.join(ROOT, 'src', 'pages.js'), 'utf8');
    assert.ok(!/retireDoc|writeDoc|saveMemory|reviseMemory/.test(src));
  });
});

testGroup('compiled page rules', () => {
  const health = fs.readFileSync(path.join(ROOT, 'areas', 'health.md'), 'utf8');
  const selector = parseArea(health, 'areas/health.md');
  const t1 = Date.parse('2026-01-01T00:00:00Z') / 1000;
  const t2 = Date.parse('2026-06-01T00:00:00Z') / 1000;
  const memories = [
    { id: 1, layer: 'semantic', content: 'rent is 900', timestamp: t1, importance: 0.8, metadata: { source: 'claude-host', tags: ['health'] }, superseded_by: 2, superseded_at: t2, source_session_id: 's1' },
    { id: 2, layer: 'semantic', content: 'rent is 950', timestamp: t2, importance: 0.8, metadata: { source: 'intake-bot', tags: ['health'] }, source_session_id: 's2' },
    { id: 3, layer: 'semantic', content: 'no client on this line', timestamp: null, metadata: { tags: ['health'] } },
    { id: 4, layer: 'episodic', content: 'paid the invoice', timestamp: t2, metadata: { source: 'claude-host', tags: ['health'] }, source_session_id: 's2', retired_at: t2 - 10 }
  ];
  const now = new Date('2026-10-20T12:00:00Z');

  test('superseded and retired records stay out of the current page', () => {
    const page = compilePage(selector, memories, [], { now });
    const ids = page.lines.map((l) => l.cite);
    assert.ok(ids.some((c) => c.includes('mem:2')));
    assert.ok(!ids.some((c) => c.includes('mem:1') || c.includes('mem:4')));
    assert.ok(!page.markdown.includes('rent is 900'));
    assert.ok(!page.markdown.includes('## History'));
  });
  test('history is present only when requested, and it is labelled', () => {
    const page = compilePage(selector, memories, [], { includeHistory: true, now });
    const at = page.markdown.indexOf('## History');
    assert.ok(at > 0);
    assert.ok(page.markdown.slice(0, at).includes('rent is 950'));
    assert.ok(!page.markdown.slice(0, at).includes('rent is 900'));
    assert.match(page.markdown.slice(at), /rent is 900 \(superseded\)/);
    assert.ok(page.history.some((l) => l.ended === 'superseded' && l.cite.includes('mem:1')));
    assert.ok(!page.lines.some((l) => l.cite.includes('mem:1')));
  });
  test('every current line cites a source that resolves, and an unsourced line is dropped', () => {
    const page = compilePage(selector, memories, [], { now });
    assert.ok(page.lines.length > 0);
    for (const line of page.lines) {
      assert.match(`${line.text} ${line.cite}`.replace(line.text + ' ', '- ' + line.text + ' '), /./);
      assert.match(`- ${line.text} ${line.cite}`, CITE);
      const id = Number(/mem:(\d+)/.exec(line.cite)[1]);
      const row = memories.find((m) => m.id === id);
      assert.ok(row && currentAt(row, null, now.getTime() / 1000));
      assert.strictEqual(line.cite, citeMemory(row));
    }
    assert.ok(page.dropped.some((d) => d.ref === 'semantic#3'));
    assert.ok(!page.markdown.includes('no client on this line'));
  });
  test('citations keep the record client', () => {
    const page = compilePage(selector, memories, [], { now });
    const line = page.lines.find((l) => l.cite.includes('mem:2'));
    assert.match(line.cite, /\[mem:2 · semantic · intake-bot · 2026-06-01\]/);
  });
  test('as_of reproduces the view from before the later write', () => {
    const mid = Date.parse('2026-03-01T00:00:00Z') / 1000;
    const then = compilePage(selector, memories, [], { asOf: mid, now });
    assert.ok(then.lines.some((l) => l.cite.includes('mem:1')));
    assert.ok(!then.lines.some((l) => l.cite.includes('mem:2')));
    const later = compilePage(selector, memories, [], { asOf: t2 + 10, now });
    assert.ok(later.lines.some((l) => l.cite.includes('mem:2')));
    assert.ok(!later.lines.some((l) => l.cite.includes('mem:1')));
  });
  test('a per-area staleness window overrides the 30-day default', () => {
    const tenDays = Date.parse('2026-10-10T12:00:00Z') / 1000;
    const mems = [{ id: 9, layer: 'semantic', content: 'balance is current', timestamp: tenDays, metadata: { source: 'claude-host', tags: ['health'] }, source_session_id: 's' }];
    const wide = compilePage(selector, mems, [], { now });
    assert.strictEqual(wide.lines[0].stale, false);
    const narrow = { ...selector, staleness_days: 7 };
    const tight = compilePage(narrow, mems, [], { now });
    assert.strictEqual(tight.lines[0].stale, true);
    assert.match(tight.markdown, /\(stale\) \[mem:9 · semantic · claude-host · 2026-10-10\]/);
  });
  test('a document line cites its version and a retired document is not current', () => {
    const docs = [
      { doc_id: 'threads/health.md', version: 3, content: '- The account is open.\n', updated_at: new Date('2026-10-01T00:00:00Z'), updated_by: 'claude-host' },
      { doc_id: 'threads/health-old.md', version: 1, content: '- Closed account.\n', updated_at: new Date('2024-01-01T00:00:00Z'), retired: true, retired_at: new Date('2024-02-01T00:00:00Z') }
    ];
    const page = compilePage(selector, [], docs, { now });
    assert.ok(page.lines.some((l) => l.cite === '[doc:threads/health.md@v3]' && l.text === 'The account is open.'));
    assert.ok(!page.markdown.includes('Closed account'));
  });
  test('a document with no version is dropped as unsourced', () => {
    const docs = [{
      doc_id: 'threads/health-unversioned.md',
      content: '- An unversioned rent note.\n',
      updated_at: new Date('2026-10-01T00:00:00Z'),
      updated_by: 'claude-host'
    }];
    const page = compilePage(selector, [], docs, { now });
    assert.ok(page.dropped.some((d) => d.ref === 'doc:threads/health-unversioned.md' && d.reason === 'unsourced'));
    assert.ok(!page.lines.some((l) => l.text.includes('unversioned') || l.cite == null || String(l.cite).includes('null')));
    assert.ok(!page.markdown.includes('unversioned'));
    assert.ok(!page.markdown.includes('null'));
  });
  test('cache_hit is false on every compile', () => {
    const page = compilePage(selector, memories, [], { now });
    assert.strictEqual(page.cache_hit, false);
  });
});

testGroup('seeded lint, no record changes, owner only', () => {
  test('lint flags at least 8 of the 10 planted issues and leaves the clean row alone', async () => {
    const store = plant(makeStore());
    await withStore(store, async () => {
      const lint = await lintPages({ area: 'audit' });
      const hit = PLANTED.filter((spec) => caught(lint.findings, spec));
      assert.ok(hit.length >= 8, `caught ${hit.length}: missing ${PLANTED.filter((s) => !hit.includes(s)).map((s) => s.key).join(', ')}\n${JSON.stringify(lint.findings, null, 2)}`);
      for (const spec of PLANTED) {
        assert.ok(caught(lint.findings, spec), `${spec.key} was not flagged\n${JSON.stringify(lint.findings, null, 2)}`);
      }
      assert.ok(caught(lint.findings, { class: 'broken_links', ids: ['semantic#19', 'doc:threads/lintplant-note.md@v1'] }), JSON.stringify(lint.findings));
      assert.ok(caught(lint.findings, { class: 'superseded_but_current', ids: ['semantic#20', 'doc:threads/lintplant-old.md@v4'] }), JSON.stringify(lint.findings));
      assert.ok(PAGE_LINT_CLASSES.every((name) => hit.some((s) => s.class === name)));
      assert.ok(!lint.findings.some((f) => f.ids.includes('semantic#18')), JSON.stringify(lint.findings));
      const page = await readPage({ area: 'audit' });
      assert.strictEqual(page.cache_hit, false);
      assert.ok(!page.markdown.includes('a claim with no client'));
      assert.ok(!page.markdown.includes('old rent figure'));
      assert.ok(!page.markdown.includes('Retired rent note'));
      for (const line of bullets(page.markdown)) assert.match(line, CITE);
      assert.match(page.markdown, /claude-host/);
      assert.match(page.markdown, /intake-bot/);
      assert.ok(page.lines.every((l) => l.cite && l.text));
      const listed = await listPages();
      const audit = listed.areas.find((a) => a.area === 'audit');
      assert.ok(audit.lines > 0);
      assert.ok(audit.stale >= 1);
      assert.ok(audit.last_source_change);
    });
  });

  test('page and lint calls do not change any record', async () => {
    const store = plant(makeStore());
    await withStore(store, async () => {
      const before = snapshot(store);
      const writes = store.writes.length;
      await readPage({ area: 'audit' });
      await readPage({ area: 'audit', include_history: true });
      await readPage({ area: 'audit', as_of: '2026-01-15' });
      await listPages();
      await lintPages({ area: 'audit' });
      await lintPages();
      const via = await dispatchTool('emet_page', { area: 'audit' }, {});
      const body = JSON.parse(via.content[0].text);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.data.cache_hit, false);
      await dispatchTool('emet_pages', {}, {});
      await dispatchTool('emet_page_lint', { area: 'audit' }, {});
      assert.strictEqual(snapshot(store), before);
      assert.strictEqual(store.writes.length, writes);
      const again = await readPage({ area: 'audit' });
      const first = body.data.lines;
      assert.deepStrictEqual(again.lines, first);
      const semantic = store.collection('emet_semantic').docs.find((d) => d.id === 18);
      semantic.content = 'the roof was replaced in 2025';
      const afterEdit = snapshot(store);
      assert.notStrictEqual(afterEdit, before);
      const changed = await readPage({ area: 'audit' });
      assert.ok(changed.lines.some((l) => l.text === 'the roof was replaced in 2025'));
      assert.strictEqual(snapshot(store), afterEdit);
      assert.ok(![...store.cols.keys()].some((name) => /cache/i.test(name)));
    });
  });

  test('history stays hidden unless requested', async () => {
    const store = plant(makeStore());
    await withStore(store, async () => {
      const plain = await readPage({ area: 'audit' });
      assert.ok(!plain.markdown.includes('## History'));
      assert.ok(!plain.history);
      const withHistory = await readPage({ area: 'audit', include_history: true });
      assert.ok(withHistory.markdown.includes('## History'));
      assert.ok(withHistory.markdown.includes('Not current'));
      assert.ok(withHistory.history.some((l) => String(l.cite).includes('mem:90')));
      assert.ok(!withHistory.lines.some((l) => String(l.cite).includes('mem:90')));
    });
  });

  test('only the owner can read pages', async () => {
    const store = plant(makeStore());
    await withStore(store, async () => {
      const before = snapshot(store);
      await assert.rejects(() => actorStore.run(memberHttp, () => readPage({ area: 'audit' })), /only the owner/);
      await assert.rejects(() => actorStore.run(guestHttp, () => listPages()), /only the owner/);
      await assert.rejects(() => actorStore.run(memberHttp, () => lintPages()), /only the owner/);
      const denied = await actorStore.run(guestHttp, () => dispatchTool('emet_page', { area: 'audit' }, {}));
      assert.match(JSON.stringify(denied), /only the owner/);
      const allowed = await actorStore.run(ownerHttp, () => readPage({ area: 'audit' }));
      assert.ok(allowed.lines.length > 0);
      const local = await readPage({ area: 'audit' });
      assert.strictEqual(local.area, 'audit');
      assert.strictEqual(snapshot(store), before);
    });
  });

  test('only the owner can create or edit an area document', async () => {
    const store = plant(makeStore());
    const { writeDoc, patchDoc } = await import('../src/tools.js');
    const homeArea = fs.readFileSync(path.join(ROOT, 'areas', 'home.md'), 'utf8');
    await withStore(store, async () => {
      const before = snapshot(store);
      const writes = store.writes.length;
      await assert.rejects(
        () => actorStore.run(memberHttp, () => writeDoc('areas/home.md', homeArea, 'pages-owner')),
        /only the owner/
      );
      assert.strictEqual(snapshot(store), before);
      assert.strictEqual(store.writes.length, writes);
      await withEnv({ EMET_SOURCE_TAGS: 'pages-owner' }, async () => {
        const written = await writeDoc('areas/home.md', homeArea, 'pages-owner');
        assert.strictEqual(written.conformance.template, 'templates/AREA.md');
        assert.strictEqual(written.conformance.verdict, 'conforms');
      });
      const saved = snapshot(store);
      const writesAfter = store.writes.length;
      await assert.rejects(
        () => actorStore.run(memberHttp, () => patchDoc('areas/home.md', 'Selector for the home topic', 'Selector for the home topic', 'pages-owner', null, null, { reason: 'member must not edit an area' })),
        /only the owner/
      );
      assert.strictEqual(snapshot(store), saved);
      assert.strictEqual(store.writes.length, writesAfter);
      assert.match(store.collection('documents').docs.find((d) => d.doc_id === 'areas/home.md').content, /Title: Home/);
    });
  });

  test('assertAreaOwner allows a local stdio caller and an owner-role caller with a non-bot tag, and refuses Member, Guest, and no person', async () => {
    const store = plant(makeStore());
    store.collection('persons').docs.push({ person_id: 'pat', role: 'member', door: 'guest' });
    const db = new store.Client().db();
    const tag = 'cowork-cloud';
    const local = { transport: 'stdio', sourceTag: tag };
    const owner = { personId: 'alex', transport: 'http', authenticated: true, sourceTag: tag, scopes: ['emet.read', 'emet.write'] };
    const member = { personId: 'ada', transport: 'http', authenticated: true, sourceTag: tag, scopes: ['emet.read', 'emet.write'] };
    const guest = { personId: 'pat', transport: 'http', authenticated: true, sourceTag: tag, scopes: ['emet.read'] };
    const noPerson = { personId: null, transport: 'http', authenticated: true, sourceTag: tag, scopes: ['emet.read', 'emet.write'] };
    await withEnv({ EMET_RECORD_DOCS: 'bots/intake-bot/HANDOFF.md' }, async () => {
      assert.strictEqual(isBotTag(tag), false);
      assert.strictEqual(isBotTag('intake-bot'), true);
      await actorStore.run(local, () => assertAreaOwner(db, 'write_doc'));
      await actorStore.run(owner, () => assertAreaOwner(db, 'write_doc'));
      for (const actor of [member, guest, noPerson]) {
        await assert.rejects(
          () => actorStore.run(actor, () => assertAreaOwner(db, 'write_doc')),
          (err) => err && err.emetCode === 'EMET-PAGE-002'
        );
      }
    });
  });

  test('the initialize digest carries the weekly summary for the owner only', async () => {
    const store = plant(makeStore());
    await withStore(store, async () => {
      const monday = new Date('2026-10-19T15:00:00Z');
      assert.strictEqual(monday.getUTCDay(), 1);
      const digest = await pageLintDigest(monday);
      assert.strictEqual(digest.included, true);
      assert.ok(digest.findings >= 8);
      assert.strictEqual(digest.counts.contradictions >= 1, true);
      const tuesday = await pageLintDigest(new Date('2026-10-20T15:00:00Z'));
      assert.strictEqual(tuesday.included, false);
      assert.ok(!tuesday.findings);
      const hidden = await actorStore.run(guestHttp, () => pageLintDigest(monday));
      assert.strictEqual(hidden.owner_only, true);
      assert.ok(!hidden.findings);
      assert.ok(!hidden.counts);
    });
  });

  test('a member cannot retire or rename an area, and the hash stays', async () => {
    const store = plant(makeStore());
    const { retireDoc, renameDoc } = await import('../src/tools.js');
    await withStore(store, async () => {
      const before = snapshot(store);
      const writes = store.writes.length;
      const reason = 'member must not change an area document';
      await assert.rejects(
        () => actorStore.run(memberHttp, () => retireDoc('areas/audit.md', reason, 'claude-host')),
        /only the owner/
      );
      await assert.rejects(
        () => actorStore.run(memberHttp, () => renameDoc('areas/audit.md', 'threads/audit-moved.md', 'claude-host', null, reason)),
        /only the owner/
      );
      await assert.rejects(
        () => actorStore.run(memberHttp, () => renameDoc('threads/lintplant-note.md', 'areas/sneak.md', 'claude-host', null, reason)),
        /only the owner/
      );
      assert.strictEqual(snapshot(store), before);
      assert.strictEqual(store.writes.length, writes);
      const area = store.collection('documents').docs.find((d) => d.doc_id === 'areas/audit.md');
      assert.notStrictEqual(area.retired, true);
      assert.ok(!store.collection('documents').docs.some((d) => d.doc_id === 'threads/audit-moved.md' || d.doc_id === 'areas/sneak.md'));
    });
  });

  test('an HTTP actor with no person, and an unknown person, cannot read pages', async () => {
    const store = plant(makeStore());
    await withStore(store, async () => {
      const before = snapshot(store);
      const writes = store.writes.length;
      await assert.rejects(() => actorStore.run(httpNoPerson, () => readPage({ area: 'audit' })), /only the owner/);
      await assert.rejects(() => actorStore.run(httpNoPerson, () => listPages()), /only the owner/);
      await assert.rejects(() => actorStore.run(httpNoPerson, () => lintPages()), /only the owner/);
      await assert.rejects(() => actorStore.run(httpUnknown, () => readPage({ area: 'audit' })), /only the owner/);
      await assert.rejects(() => actorStore.run(httpUnknown, () => listPages()), /only the owner/);
      await assert.rejects(() => actorStore.run(httpUnknown, () => lintPages()), /only the owner/);
      assert.strictEqual(snapshot(store), before);
      assert.strictEqual(store.writes.length, writes);
    });
  });

  test('only the owner can accept a nonconformance on an area', async () => {
    const store = plant(makeStore());
    const { acceptNonconformance } = await import('../src/tools.js');
    const area = store.collection('documents').docs.find((d) => d.doc_id === 'areas/audit.md');
    area.conformance = { verdict: 'nonconforming', failures: ['selector missing a layer'] };
    await withStore(store, async () => {
      const before = snapshot(store);
      const writes = store.writes.length;
      await assert.rejects(
        () => actorStore.run(memberHttp, () => acceptNonconformance('areas/audit.md', 'member must not accept an area', 'claude-host')),
        /only the owner/
      );
      assert.strictEqual(snapshot(store), before);
      assert.strictEqual(store.writes.length, writes);
      assert.ok(!area.conformance.accepted);
    });
  });
});

testGroup('spec defaults and past views', () => {
  test('a blank staleness field is 30 days, so a row 31 days old is stale', async () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const store = makeStore();
    store.collection('documents').docs.push(areaDoc('blank', { staleness: '', tags: 'blank', prefixes: 'threads/blank', title: 'Blank' }));
    const semantic = store.collection('emet_semantic');
    semantic.docs.push(row(1, { content: 'the old blank-window status', source: 'claude-host', timestamp: now.getTime() / 1000 - 31 * 86400 }));
    semantic.docs.push(row(2, { content: 'the fresh blank-window status', source: 'claude-host', timestamp: now.getTime() / 1000 - 29 * 86400 }));
    for (const doc of semantic.docs) doc.metadata.tags = ['blank'];
    await withStore(store, async () => {
      const parsed = parseArea(store.collection('documents').docs[0].content, 'areas/blank.md');
      assert.strictEqual(parsed.staleness_days, 30);
      const page = await readPage({ area: 'blank' }, now);
      const old = page.lines.find((l) => l.text === 'the old blank-window status');
      const fresh = page.lines.find((l) => l.text === 'the fresh blank-window status');
      assert.ok(old && fresh);
      assert.strictEqual(old.stale, true);
      assert.strictEqual(fresh.stale, false);
    });
  });

  test('readPage as_of leaves out a row written later', async () => {
    const store = makeStore();
    store.collection('documents').docs.push(areaDoc('audit'));
    const semantic = store.collection('emet_semantic');
    semantic.docs.push(row(1, { content: 'early fact', source: 'claude-host', timestamp: Date.parse('2026-01-01T00:00:00Z') / 1000 }));
    semantic.docs.push(row(2, { content: 'later fact', source: 'claude-host', timestamp: Date.parse('2026-06-01T00:00:00Z') / 1000 }));
    await withStore(store, async () => {
      const page = await readPage({ area: 'audit', as_of: '2026-03-01' }, new Date('2026-10-20T12:00:00Z'));
      assert.ok(page.lines.some((l) => l.text === 'early fact'));
      assert.ok(!page.lines.some((l) => l.text === 'later fact'));
      assert.ok(!page.markdown.includes('later fact'));
    });
  });

  test('a row with a timestamp and no client is dropped', async () => {
    const store = makeStore();
    store.collection('documents').docs.push(areaDoc('audit'));
    store.collection('emet_semantic').docs.push(row(1, {
      content: 'clientless fact that must not render',
      timestamp: Date.parse('2026-06-01T00:00:00Z') / 1000,
      unsourced: true
    }));
    await withStore(store, async () => {
      const page = await readPage({ area: 'audit' }, new Date('2026-10-20T12:00:00Z'));
      assert.ok(!page.lines.some((l) => l.text.includes('clientless')));
      assert.ok(!page.markdown.includes('clientless'));
    });
  });

  test('a past view labels a record whose end date was not recorded', async () => {
    const store = makeStore();
    store.collection('documents').docs.push(areaDoc('audit'));
    const early = Date.parse('2026-01-01T00:00:00Z') / 1000;
    store.collection('emet_semantic').docs.push(row(5, {
      content: 'undated supersession',
      source: 'claude-host',
      timestamp: early,
      superseded_by: 99,
      superseded_at: null
    }));
    const retired = row(6, { content: 'undated retirement', source: 'claude-host', timestamp: early });
    retired.is_live = false;
    store.collection('emet_semantic').docs.push(retired);
    store.collection('documents').docs.push({
      doc_id: 'threads/lintplant-undated.md', version: 1, content: '- undated retired note\n',
      updated_at: new Date('2026-01-01T00:00:00Z'), updated_by: 'claude-host', retired: true
    });
    await withStore(store, async () => {
      const now = new Date('2026-10-20T12:00:00Z');
      const current = await readPage({ area: 'audit' }, now);
      assert.ok(!current.lines.some((l) => /undated/.test(l.text)));
      assert.deepStrictEqual(current.end_date_unknown, []);
      assert.ok(!current.markdown.includes('end date unknown'));
      const then = await readPage({ area: 'audit', as_of: '2026-03-01' }, now);
      assert.ok(!then.lines.some((l) => /undated/.test(l.text)));
      const heading = then.markdown.indexOf('## End date unknown');
      assert.ok(heading > 0);
      assert.ok(!then.markdown.slice(0, heading).includes('undated'));
      for (const text of ['undated supersession', 'undated retirement', 'undated retired note']) {
        const line = then.end_date_unknown.find((l) => l.text === text);
        assert.ok(line, text);
        assert.strictEqual(line.label, 'end date unknown');
        assert.match(line.cite, CITE);
        assert.match(then.markdown, new RegExp(`${text} \\(end date unknown\\)`));
      }
    });
  });

  test('as_of cites the document revision in force on that date', async () => {
    const store = makeStore();
    store.collection('documents').docs.push(areaDoc('audit'));
    store.collection('documents').docs.push({
      doc_id: 'threads/lintplant-rent.md', version: 2, content: '- rent is 900\n',
      updated_at: new Date('2026-06-01T00:00:00Z'), updated_by: 'claude-host', retired: false
    });
    store.collection('documents').docs.push({
      doc_id: 'threads/lintplant-future.md', version: 1, content: '- future lease\n',
      updated_at: new Date('2026-08-01T00:00:00Z'), updated_by: 'claude-host', retired: false
    });
    store.collection('documents_history').docs.push({
      doc_id: 'threads/lintplant-rent.md', version: 1, content: '- rent was 500\n',
      updated_at: new Date('2024-06-01T00:00:00Z'), archived_at: new Date('2026-06-01T00:00:00Z'),
      updated_by: 'claude-host'
    });
    await withStore(store, async () => {
      const then = await readPage({ area: 'audit', as_of: '2025-01-01' }, new Date('2026-10-20T12:00:00Z'));
      assert.ok(then.lines.some((l) => l.text === 'rent was 500' && l.cite === '[doc:threads/lintplant-rent.md@v1]'));
      assert.ok(!then.lines.some((l) => l.text === 'rent is 900' || l.text === 'future lease'));
      const later = await readPage({ area: 'audit', as_of: '2026-07-01' }, new Date('2026-10-20T12:00:00Z'));
      assert.ok(later.lines.some((l) => l.text === 'rent is 900' && l.cite === '[doc:threads/lintplant-rent.md@v2]'));
      assert.ok(!later.lines.some((l) => l.cite.includes('threads/lintplant-rent.md@v1')));
      assert.ok(!later.markdown.includes('future lease'));
    });
  });

  test('as_of cites the newest revision when older rows have no archive date', async () => {
    const store = makeStore();
    store.collection('documents').docs.push(areaDoc('audit'));
    store.collection('documents').docs.push({
      doc_id: 'threads/lintplant-later.md', version: 2, content: '- stack was later write\n',
      updated_at: new Date('2024-09-01T00:00:00Z'), updated_by: 'claude-host', retired: false
    });
    store.collection('documents').docs.push({
      doc_id: 'threads/lintplant-tie.md', version: 3, content: '- tie low\n',
      updated_at: new Date('2024-06-01T00:00:00Z'), updated_by: 'claude-host', retired: false
    });
    const history = store.collection('documents_history');
    history.docs.push({
      doc_id: 'threads/lintplant-later.md', version: 5, content: '- stack was high version\n',
      updated_at: new Date('2024-01-01T00:00:00Z'), updated_by: 'claude-host'
    });
    history.docs.push({
      doc_id: 'threads/lintplant-tie.md', version: 8, content: '- tie high\n',
      updated_at: new Date('2024-06-01T00:00:00Z'), updated_by: 'claude-host'
    });
    await withStore(store, async () => {
      const page = await readPage({ area: 'audit', as_of: '2025-01-01' }, new Date('2026-10-20T12:00:00Z'));
      assert.ok(page.lines.some((l) => l.text === 'stack was later write' && l.cite === '[doc:threads/lintplant-later.md@v2]'));
      assert.ok(!page.lines.some((l) => l.text === 'stack was high version'));
      assert.ok(page.lines.some((l) => l.text === 'tie high' && l.cite === '[doc:threads/lintplant-tie.md@v8]'));
      assert.ok(!page.lines.some((l) => l.text === 'tie low'));
    });
  });

  test('as_of shows nothing when v1 was archived and no later revision was recorded', async () => {
    const store = makeStore();
    store.collection('documents').docs.push(areaDoc('audit'));
    // The id has to be visited. It is not a v2: it has no write time.
    store.collection('documents').docs.push({
      doc_id: 'threads/lintplant-gap.md', updated_by: 'claude-host'
    });
    store.collection('documents_history').docs.push({
      doc_id: 'threads/lintplant-gap.md', version: 1, content: '- gap rent was 100\n',
      updated_at: new Date('2024-01-01T00:00:00Z'), archived_at: new Date('2024-06-01T00:00:00Z'),
      updated_by: 'claude-host'
    });
    await withStore(store, async () => {
      const page = await readPage({ area: 'audit', as_of: '2025-01-01' }, new Date('2026-10-20T12:00:00Z'));
      assert.ok(!page.lines.some((l) => l.text === 'gap rent was 100' || String(l.cite).includes('lintplant-gap')));
      assert.ok(!page.end_date_unknown.some((l) => l.text === 'gap rent was 100'));
      assert.ok(!page.markdown.includes('gap rent was 100'));
    });
  });
});

testGroup('area selection', () => {
  test('lint uses the area staleness window', async () => {
    const store = makeStore();
    store.collection('documents').docs.push(areaDoc('tight', { staleness: 7, tags: 'tight', prefixes: 'threads/tight', title: 'Tight' }));
    const tenDays = Date.now() / 1000 - 10 * 86400;
    store.collection('emet_semantic').docs.push(row(1, {
      content: 'status is waiting on the tight window', source: 'claude-host', timestamp: tenDays, status: 'standing'
    }));
    store.collection('emet_semantic').docs[0].metadata.tags = ['tight'];
    await withStore(store, async () => {
      const lint = await lintPages({ area: 'tight' });
      assert.ok(lint.findings.some((f) => f.class === 'long_unconfirmed' && f.ids.includes('semantic#1')), JSON.stringify(lint.findings));
    });
  });

  test('a retired area is not listed or linted', async () => {
    const store = makeStore();
    store.collection('documents').docs.push(areaDoc('audit'));
    const retired = areaDoc('retired-topic', { tags: 'retiredonly', prefixes: 'threads/retiredonly', title: 'Retired topic' });
    retired.retired = true;
    retired.retired_at = new Date('2026-01-01T00:00:00Z');
    store.collection('documents').docs.push(retired);
    const semantic = store.collection('emet_semantic');
    semantic.docs.push(row(1, { content: 'budget is 1', source: 'claude-host', subject: 'retired-budget', claim: '1' }));
    semantic.docs.push(row(2, { content: 'budget is 2', source: 'intake-bot', subject: 'retired-budget', claim: '2' }));
    for (const doc of semantic.docs) doc.metadata.tags = ['retiredonly'];
    await withStore(store, async () => {
      const listed = await listPages();
      assert.ok(!listed.areas.some((a) => a.area === 'retired-topic'));
      const lint = await lintPages();
      assert.ok(!lint.findings.some((f) => f.area === 'retired-topic'), JSON.stringify(lint.findings));
      assert.ok(!lint.areas.includes('retired-topic'));
      await assert.rejects(() => lintPages({ area: 'retired-topic' }), /no current area/);
    });
  });

  test('an area document is never page content', () => {
    const health = fs.readFileSync(path.join(ROOT, 'areas', 'health.md'), 'utf8');
    const selector = parseArea(health, 'areas/health.md');
    const leaky = { ...selector, prefixes: ['areas/', 'threads/health'] };
    const docs = [{
      doc_id: 'areas/health.md', version: 1,
      content: `${health}\nThe vault code is 2468.\n`,
      updated_at: new Date('2026-10-01T00:00:00Z'), updated_by: 'claude-host'
    }];
    const page = compilePage(leaky, [], docs, { now: new Date('2026-10-20T12:00:00Z') });
    assert.ok(!page.markdown.includes('vault code'));
    assert.ok(!page.markdown.includes('areas/health.md'));
    assert.ok(!page.lines.some((l) => String(l.cite).includes('areas/')));
  });
});

summary('TOPIC PAGES TEST SUMMARY');
