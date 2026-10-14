/**
 * Attribution per session v2 (2026-10-12). Regression for a project host (grok-project)
 * and the intake bot (intake-bot) stamped hub-bot on the shared Grok
 * client shared-client-0001, for review findings A1-A4 of an earlier version,
 * and for the owner's new-client requirements (COS flag, owner fallback, solo
 * auto-approve, ties across restarts, real tag at startup).
 */
import assert from 'node:assert/strict';
import { test, testGroup, summary } from './harness.js';

console.log('\n=== attribution v2 ===');
const CLIENT = 'shared-client-0001';

function fakeDb({ tokens = [], transcripts = [], documents = [], layer = [] } = {}) {
  const data = { oauth_tokens: tokens, transcripts, documents };
  const matchV = (val, cond) => cond instanceof RegExp ? typeof val === 'string' && cond.test(val) : val === cond;
  const get = (row, k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), row);
  const mk = (rows) => ({
    find(q) {
      const out = rows.filter((r) => Object.entries(q).every(([k, v]) => matchV(get(r, k), v)));
      return { limit() { return { toArray: async () => out }; }, toArray: async () => out };
    }
  });
  return {
    layerCol: mk(layer),
    collection(name) { const key = name.replace(/^emet_/, ''); return mk(data[key] || []); }
  };
}
function memDeps(initial = null) {
  const store = { content: initial, version: initial === null ? null : 1, writes: 0, beforeWrite: null };
  return {
    store,
    readDoc: async () => { if (store.content === null) throw new Error('Document not found: emet/CLIENT_APPROVALS.md'); return { content: store.content, version: store.version }; },
    writeDoc: async (_id, c, expected) => {
      if (store.beforeWrite) { const f = store.beforeWrite; store.beforeWrite = null; await f(); }
      if ((expected ?? null) !== (store.version ?? null)) { const e = new Error('conflict'); e.versionConflict = true; throw e; }
      store.content = c; store.version = (store.version || 0) + 1; store.writes++;
      return { version: store.version };
    }
  };
}
// The owner acting as the owner: the owner's own host login (not a bot tag).
const ownerHost = (extra = {}) => ({ personId: 'owner1', ownerId: 'owner1', clientId: 'claude-host', transport: 'http', authenticated: true, sourceTag: 'cowork-cloud', sourceBasis: 'login', scopes: [], ...extra });
const actorFor = (extra = {}) => ({ personId: 'owner1', ownerId: 'owner1', clientId: CLIENT, transport: 'http', authenticated: true, sourceTag: 'hub-bot', scopes: [], ...extra });
async function fresh() { const a = await import('../src/attribution.js'); a._resetForTests(); return a; }
const ctx = (over = {}) => ({ db: fakeDb(), prefix: 'emet_', ownerId: 'owner1', deps: memDeps(), registry: ['hub-bot', 'intake-bot', 'grok-project', 'cowork-cloud'], ...over });

testGroup('stamp', () => {
  test('the intake bot declared on the hub bot login is stamped intake-bot, login kept', async () => {
    const att = await fresh();
    const { resolvedSourceTag } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const a = actorFor();
    await att.preflight(ctx(), a, { source: 'intake-bot', session_id: '2026-10-12_weekly-corpus-intake_verbatim_part1' }, 'save_to_layer');
    assert.deepStrictEqual(actorStore.run(a, () => resolvedSourceTag('intake-bot')), { tag: 'intake-bot', from: 'declared', login: 'hub-bot' });
  });
  test('without preflight a caller tag is still ignored', async () => {
    await fresh();
    const { resolvedSourceTag } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    assert.strictEqual(actorStore.run(actorFor(), () => resolvedSourceTag('intake-bot')).tag, 'hub-bot');
  });
  test('stdio is unchanged', async () => {
    const { resolvedSourceTag } = await import('../src/tools.js');
    assert.deepStrictEqual(resolvedSourceTag('grok-project'), { tag: 'grok-project', from: 'caller' });
  });
});

testGroup('A1 session tie on every write', () => {
  test('a login-tag write into a session owned by another tag is refused', async () => {
    const att = await fresh();
    const c = ctx();
    await att.preflight(c, actorFor(), { source: 'intake-bot', session_id: 's1_verbatim_part1' }, 'emet_transcript_append');
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: 's1_verbatim_part1' }, 'save_to_layer'), /belongs to "intake-bot"/);
    await assert.rejects(() => att.preflight(c, actorFor(), { source: 'hub-bot', session_id: 's1_verbatim_part2' }, 'write_doc'), /belongs to "intake-bot"/);
  });
  test('reads are not tied', async () => {
    const att = await fresh();
    const c = ctx();
    await att.preflight(c, actorFor(), { source: 'intake-bot', session_id: 's2' }, 'save_to_layer');
    await att.preflight(c, actorFor(), { session_id: 's2' }, 'query_transcripts');
  });
});

testGroup('A2 owner tokens', () => {
  test("the owner's tokens with subject owner1, owner or none do not lock the owner out", async () => {
    const att = await fresh();
    const db = fakeDb({ tokens: [{ source_tag: 'intake-bot', subject: 'owner1' }, { source_tag: 'intake-bot', subject: 'owner' }, { source_tag: 'intake-bot' }] });
    const a = actorFor();
    await att.preflight(ctx({ db }), a, { source: 'intake-bot' }, 'save_to_layer');
    assert.strictEqual(a.declaredTag, 'intake-bot');
  });
  test("a member may not claim the owner's tag; the owner may not claim a member's", async () => {
    const att = await fresh();
    const db = fakeDb({ tokens: [{ source_tag: 'intake-bot', subject: 'owner1' }, { source_tag: 'ana-bot', subject: 'ana' }] });
    await assert.rejects(() => att.preflight(ctx({ db }), actorFor({ personId: 'ana', sourceTag: 'ana-bot' }), { source: 'intake-bot' }, 'save_to_layer'), /another person's login/);
    await assert.rejects(() => att.preflight(ctx({ db }), actorFor(), { source: 'ana-bot' }, 'save_to_layer'), /another person's login/);
  });
});

testGroup('A2 owner status needs the owner acting as the owner', () => {
  test('a bot on the owner login, or a declared tag on it, is not the owner', async () => {
    const att = await fresh();
    process.env.EMET_RECORD_DOCS = 'bots/hub-bot/HANDOFF.md,bots/intake-bot/HANDOFF.md';
    const mb = actorFor(); mb.sourceBasis = 'login';
    assert.strictEqual(att.actorIsOwner(mb, 'owner1'), false);
    const decl = ownerHost(); decl.declaredTag = 'intake-bot'; decl.sourceBasis = 'declared';
    assert.strictEqual(att.actorIsOwner(decl, 'owner1'), false);
    assert.strictEqual(att.actorIsOwner(ownerHost(), 'owner1'), true);
    assert.strictEqual(att.actorIsOwner(ownerHost({ personId: 'ana' }), 'owner1'), false);
    delete process.env.EMET_RECORD_DOCS;
  });
});

testGroup('A3 no rights beyond the login tag', () => {
  test('an intake-bound login declaring grok-project cannot write HANDOFF.md, STATE.md or another bot dir', async () => {
    const att = await fresh();
    const { refuseBotMainRecord, refuseBotRetireRename } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    process.env.EMET_RECORD_DOCS = 'bots/intake-bot/HANDOFF.md,bots/tester-bot/HANDOFF.md';
    process.env.EMET_SOURCE_TAGS = 'hub-bot,intake-bot,grok-project';
    const a = actorFor({ sourceTag: 'intake-bot' });
    await att.preflight(ctx(), a, { source: 'grok-project' }, 'write_doc');
    actorStore.run(a, () => {
      assert.throws(() => refuseBotMainRecord('HANDOFF.md', 'grok-project', 'write_doc'), /bot tag/);
      assert.throws(() => refuseBotMainRecord('STATE.md', 'grok-project', 'patch_doc'), /bot tag/);
      assert.throws(() => refuseBotMainRecord('bots/tester-bot/HANDOFF.md', 'grok-project', 'write_doc'), /outside/);
      assert.throws(() => refuseBotRetireRename('grok-project', 'retire_doc'), /not a bot tool/);
    });
    delete process.env.EMET_RECORD_DOCS; delete process.env.EMET_SOURCE_TAGS;
  });
  test('with no registry a declared tag may not write another bot folder, nor its own until approved', async () => {
    const att = await fresh();
    const { refuseBotMainRecord } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const a = actorFor({ sourceTag: null, clientId: 'cx' });
    a.declaredTag = 'newbot'; a.sourceBasis = 'declared'; a.effectiveTag = 'newbot';
    actorStore.run(a, () => {
      assert.throws(() => refuseBotMainRecord('bots/intake-bot/HANDOFF.md', 'newbot', 'write_doc'), /declared tag/);
      assert.throws(() => refuseBotMainRecord('bots/newbot/HANDOFF.md', 'newbot', 'write_doc'), /not yet approved/);
    });
    const auto = actorFor({ sourceTag: null, clientId: 'Zz-9' });
    auto.declaredTag = 'auto-zz9'; auto.sourceBasis = 'auto'; auto.effectiveTag = 'auto-zz9';
    actorStore.run(auto, () => assert.throws(() => refuseBotMainRecord('bots/auto-zz9/notes.md', 'auto-zz9', 'write_doc'), /not yet approved/));
  });
  test('the approvals record is server-only: write_doc, patch_doc, retire_doc, rename_doc refused', async () => {
    await fresh();
    const { refuseBotMainRecord } = await import('../src/tools.js');
    for (const tool of ['write_doc', 'patch_doc', 'retire_doc', 'rename_doc', 'restore_doc']) {
      assert.throws(() => refuseBotMainRecord('emet/CLIENT_APPROVALS.md', 'cowork-cloud', tool), /kept by the server/);
    }
    assert.throws(() => refuseBotMainRecord('emet/client_approvals.md', 'cowork-cloud', 'write_doc'), /kept by the server|variant/);
    refuseBotMainRecord('emet/CLIENT_APPROVALS.md', 'emet-server', 'write_doc', { serverProvision: true, approvalsRecord: true });
  });
  test('a host login declaring a registered host tag keeps host rights', async () => {
    const att = await fresh();
    const { refuseBotMainRecord } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    process.env.EMET_SOURCE_TAGS = 'hub-bot,grok-project';
    const a = actorFor();
    await att.preflight(ctx(), a, { source: 'grok-project' }, 'write_doc');
    actorStore.run(a, () => refuseBotMainRecord('HANDOFF.md', 'grok-project', 'write_doc'));
    delete process.env.EMET_SOURCE_TAGS;
  });
});

testGroup('A4 / (b) ties survive a restart', () => {
  test('after a restart the tie is rebuilt from stored transcript rows', async () => {
    const att = await fresh();
    const db = fakeDb({ transcripts: [{ session_id: 's3_verbatim_part1', channel: 'intake-bot' }] });
    await assert.rejects(() => att.preflight(ctx({ db }), actorFor(), { source: 'grok-project', session_id: 's3_verbatim_part1' }, 'save_to_layer'), /belongs to "intake-bot"/);
  });
  test('rebuilt from documents and layer rows too; the owning tag may continue', async () => {
    const att = await fresh();
    const db = fakeDb({ documents: [{ session_id: 's4_verbatim_part1', updated_by: 'intake-bot' }], layer: [{ metadata: { source: 'intake-bot', derived_from: { session_id: 's4' } } }] });
    const c = ctx({ db, layerCollections: [db.layerCol] });
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: 's4_verbatim_part1' }, 'patch_doc'), /belongs to "intake-bot"/);
    await att.preflight(c, actorFor(), { source: 'intake-bot', session_id: 's4_verbatim_part1' }, 'patch_doc');
  });
  test('a store read error fails closed', async () => {
    const att = await fresh();
    const db = { collection() { return { find() { return { limit() { return { toArray: async () => { throw new Error('db down'); } }; } }; } }; } };
    await assert.rejects(() => att.preflight(ctx({ db, deps: null }), actorFor(), { session_id: 's9_verbatim_part1' }, 'save_to_layer'), /fail closed/);
  });
  test('emet_session_open claims the session it opens', async () => {
    const att = await fresh();
    const c = ctx({ now: new Date('2026-10-12T12:00:00Z') });
    await att.preflight(c, actorFor(), { source: 'intake-bot', slug: 'weekly-corpus-intake' }, 'emet_session_open');
    assert.strictEqual(att.SESSION_BINDINGS.get('2026-10-12_weekly-corpus-intake').agent_tag, 'intake-bot');
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: '2026-10-12_weekly-corpus-intake_verbatim_part1' }, 'emet_transcript_append'), /belongs to "intake-bot"/);
  });
  test('the in-memory cache is bounded at BINDING_MAX', async () => {
    const att = await fresh();
    for (let i = 0; i < att.BINDING_MAX + 25; i++) att.bindSession(`b${i}`, 'x');
    assert.strictEqual(att.SESSION_BINDINGS.size, att.BINDING_MAX);
    assert.ok(!att.SESSION_BINDINGS.has('b0'));
    assert.ok(att.SESSION_BINDINGS.has(`b${att.BINDING_MAX + 24}`));
  });
});

testGroup('(a) new clients: COS configured', () => {
  test('a new tag is flagged to the COS, read-limited, and the COS (on its own login) approves it', async () => {
    const att = await fresh();
    process.env.EMET_COS_TAG = 'hub-bot';
    const c = ctx();
    const newcomer = () => actorFor({ clientId: 'claude-xyz', sourceTag: null });
    await assert.rejects(() => att.preflight(c, newcomer(), { source: 'claude-desktop', layer: 'semantic', content: 'hello' }, 'save_to_layer'), /read-limited until the chief of staff \(hub-bot\)/);
    await att.preflight(c, newcomer(), { source: 'claude-desktop' }, 'recall');
    const data = att.parseApprovals(c.deps.store.content);
    assert.strictEqual(data.pending['claude-desktop'].client_id, 'claude-xyz');
    assert.match(data.pending['claude-desktop'].what, /save_to_layer · layer semantic · "hello"/);
    assert.strictEqual(data.pending['claude-desktop'].routed_to, 'hub-bot');
    const cos = actorFor(); cos.sourceBasis = 'login'; cos.effectiveTag = 'hub-bot';
    assert.strictEqual(att.approvalsView(att.cachedApprovals(), cos).pending[0].tag, 'claude-desktop');
    assert.strictEqual(att.approvalsView(att.cachedApprovals(), ownerHost()).pending_count, 1);
    const member = actorFor({ personId: 'ana', sourceTag: 'ana-bot' }); member.sourceBasis = 'login';
    assert.strictEqual(att.approvalsView(att.cachedApprovals(), member), null);
    await att.clientApprove(c.deps, cos, 'owner1', { tag: 'claude-desktop', decision: 'approve' });
    await att.preflight(c, newcomer(), { source: 'claude-desktop', layer: 'semantic', content: 'hello' }, 'save_to_layer');
    delete process.env.EMET_COS_TAG;
  });
  test('a declared copy of the COS tag on another login is not the COS', async () => {
    const att = await fresh();
    process.env.EMET_COS_TAG = 'hub-bot';
    const fake = actorFor({ sourceTag: 'intake-bot' }); fake.declaredTag = 'hub-bot'; fake.sourceBasis = 'declared'; fake.effectiveTag = 'hub-bot';
    assert.strictEqual(att.actorIsCos(fake), false);
    await assert.rejects(() => att.clientApprove(memDeps(), fake, 'owner1', { tag: 'x', decision: 'approve' }), /only the owner or the chief of staff/);
    delete process.env.EMET_COS_TAG;
  });
});

testGroup('(a) approvals: no self-approval, idempotent, compare-and-set, fail closed', () => {
  test('a client may not approve itself; a bot on the owner login may not approve', async () => {
    const att = await fresh();
    process.env.EMET_RECORD_DOCS = 'bots/hub-bot/HANDOFF.md';
    const self = ownerHost({ sourceTag: 'chatgpt' }); self.effectiveTag = 'chatgpt';
    await assert.rejects(() => att.clientApprove(memDeps(), self, 'owner1', { tag: 'chatgpt', decision: 'approve' }), /its own approval/);
    const mb = actorFor(); mb.sourceBasis = 'login'; mb.effectiveTag = 'hub-bot';
    await assert.rejects(() => att.clientApprove(memDeps(), mb, 'owner1', { tag: 'chatgpt', decision: 'approve' }), /only the owner/);
    delete process.env.EMET_RECORD_DOCS;
  });
  test('emet_client_approve and emet_session_open are write tools', async () => {
    const att = await fresh();
    assert.ok(att.WRITE_TOOLS.has('emet_client_approve'));
    assert.ok(att.WRITE_TOOLS.has('emet_session_open'));
  });
  test('review r3: a pending newbot on the owner login that omits source cannot approve itself', async () => {
    const att = await fresh();
    const c = ctx();
    // newbot connects on the owner's shared host login, declares itself, gets queued.
    await assert.rejects(() => att.preflight(c, ownerHost({ sourceBasis: undefined, grantId: 'g-host' }), { source: 'newbot', content: 'x' }, 'write_doc'));
    assert.ok(att.parseApprovals(c.deps.store.content).pending.newbot, 'newbot is pending');
    // Same connection, no source: it now looks exactly like the owner.
    const a = ownerHost({ sourceBasis: undefined, grantId: 'g-host' });
    await att.preflight(c, a, { tag: 'newbot', decision: 'approve' }, 'emet_client_approve');
    await assert.rejects(() => att.clientApprove(c.deps, a, 'owner1', { tag: 'newbot', decision: 'approve' }), /queued the request/);
    // Same grant on a different client id is refused too.
    await assert.rejects(() => att.clientApprove(c.deps, ownerHost({ clientId: 'other', grantId: 'g-host' }), 'owner1', { tag: 'newbot', decision: 'approve' }), /queued the request/);
    assert.ok(att.parseApprovals(c.deps.store.content).pending.newbot, 'still pending');
    assert.ok(!att.parseApprovals(c.deps.store.content).approved.newbot);
    // The owner on another connection can decide it.
    await att.clientApprove(c.deps, ownerHost({ clientId: 'claude-phone', grantId: 'g-phone' }), 'owner1', { tag: 'newbot', decision: 'approve' });
    assert.ok(att.parseApprovals(c.deps.store.content).approved.newbot);
  });
  test('approving twice writes once and keeps the first at and request', async () => {
    const att = await fresh();
    const c = ctx();
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt' }), { source: 'chatgpt', content: 'x' }, 'write_doc'));
    const first = await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'chatgpt', decision: 'approve' }, [], new Date('2026-10-12T12:00:00Z'));
    const writes = c.deps.store.writes;
    const again = await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'chatgpt', decision: 'approve' }, [], new Date('2026-10-12T13:00:00Z'));
    assert.strictEqual(c.deps.store.writes, writes);
    assert.strictEqual(again.unchanged, true);
    assert.strictEqual(again.at, first.at);
    const d = att.parseApprovals(c.deps.store.content);
    assert.strictEqual(d.approved.chatgpt.request.client_id, 'gpt');
  });
  test('a concurrent writer is detected by version and the change is retried, not lost', async () => {
    const att = await fresh();
    const deps = memDeps();
    const c = ctx({ deps });
    // Another server writes the record between our read and our write.
    deps.store.beforeWrite = async () => {
      deps.store.content = att.renderApprovals({ approved: {}, pending: { other: { first_seen: 'x' } }, denied: {} });
      deps.store.version = 7;
    };
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt' }), { source: 'chatgpt' }, 'save_to_layer'), /read-limited/);
    const d = att.parseApprovals(deps.store.content);
    assert.ok(d.pending.other && d.pending.chatgpt);
    assert.strictEqual(deps.store.version, 8);
  });
  test('two first writes at once queue one request, not two overwrites', async () => {
    const att = await fresh();
    const c = ctx();
    const mk = (tag, cid) => att.preflight(c, actorFor({ sourceTag: null, clientId: cid }), { source: tag }, 'save_to_layer').catch(() => null);
    await Promise.all([mk('a1', 'c1'), mk('a2', 'c2'), mk('a1', 'c1')]);
    const d = att.parseApprovals(c.deps.store.content);
    assert.deepStrictEqual(Object.keys(d.pending).sort(), ['a1', 'a2']);
  });
  test('an unparseable record fails closed', async () => {
    const att = await fresh();
    const c = ctx({ deps: memDeps('# CLIENT APPROVALS\n\nnot json') });
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt' }), { source: 'chatgpt' }, 'save_to_layer'), /does not parse/);
    await assert.rejects(() => att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'chatgpt', decision: 'approve' }), /does not parse/);
  });
});

testGroup('(a) new clients: no COS (single-instance users)', () => {
  test('a first, solo client on a truly fresh store is auto-approved as the primary', async () => {
    const att = await fresh();
    const c = ctx({ registry: [], db: fakeDb({ tokens: [{ client_id: 'claude-only', subject: 'owner1' }] }) });
    const solo = ownerHost({ sourceTag: null, clientId: 'claude-only', sourceBasis: undefined });
    await att.preflight(c, solo, { source: 'claude', layer: 'semantic', content: 'first note' }, 'save_to_layer');
    assert.strictEqual(att.parseApprovals(c.deps.store.content).approved.claude.primary, true);
  });
  test('no auto-approve when the store already has other clients and no record (fail closed)', async () => {
    const att = await fresh();
    const c = ctx({ registry: [], db: fakeDb({ tokens: [{ client_id: 'claude-only' }, { client_id: 'grok-1' }] }) });
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'claude-only' }), { source: 'claude' }, 'save_to_layer'), /until the owner approves/);
    assert.ok(att.parseApprovals(c.deps.store.content).pending.claude);
  });
  test('a second client is flagged to the owner, who sees it at startup and approves it', async () => {
    const att = await fresh();
    const c = ctx({ registry: [], db: fakeDb({ tokens: [{ client_id: 'claude-only' }] }) });
    await att.preflight(c, actorFor({ sourceTag: null, clientId: 'claude-only' }), { source: 'claude' }, 'save_to_layer');
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt-1' }), { source: 'chatgpt' }, 'save_to_layer'), /until the owner approves/);
    const v = att.approvalsView(att.cachedApprovals(), ownerHost());
    assert.strictEqual(v.routed_to, 'owner');
    assert.strictEqual(v.pending[0].tag, 'chatgpt');
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'chatgpt', decision: 'approve' });
    await att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt-1' }), { source: 'chatgpt' }, 'save_to_layer');
  });
  test('a denied tag stays read-only', async () => {
    const att = await fresh();
    const c = ctx();
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt' }), { source: 'chatgpt' }, 'write_doc'));
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'chatgpt', decision: 'deny' });
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt' }), { source: 'chatgpt' }, 'write_doc'), /denied/);
  });
  test('a login with no tag and no declaration gets an auto- tag, gated the same way', async () => {
    const att = await fresh();
    await assert.rejects(() => att.preflight(ctx(), actorFor({ sourceTag: null, clientId: 'Zz-9' }), {}, 'save_to_layer'), /"auto-zz9" is a new client/);
  });
});

testGroup('(d) remembered client tags (the owner 2026-10-12)', () => {
  test('an approved client keeps its tag on a later login; startup tells it to use it', async () => {
    const att = await fresh();
    const c = ctx();
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt', grantId: 'g1' }), { source: 'chatgpt', content: 'x' }, 'write_doc'));
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'chatgpt', decision: 'approve' });
    const d = att.parseApprovals(c.deps.store.content);
    assert.strictEqual(d.clients.gpt.tags.chatgpt.declared_name, 'chatgpt');
    // New login (new grant), same client_id.
    const a = actorFor({ sourceTag: null, clientId: 'gpt', grantId: 'g2' });
    await att.preflight(c, a, { source: 'chatgpt', content: 'y' }, 'write_doc');
    assert.strictEqual(a.effectiveTag, 'chatgpt');
    const v = att.rememberedView(a);
    assert.strictEqual(v.use_tag, 'chatgpt');
    assert.match(v.instruction, /Pass source "chatgpt"/);
  });
  test('a different declared tag is refused and queued as a rename; owner approval switches it', async () => {
    const att = await fresh();
    const c = ctx();
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt' }), { source: 'chatgpt', content: 'x' }, 'write_doc'));
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'chatgpt', decision: 'approve' });
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt' }), { source: 'gpt-five', content: 'x' }, 'write_doc'), /rename/);
    assert.strictEqual(att.parseApprovals(c.deps.store.content).pending['gpt-five'].kind, 'rename');
    await assert.rejects(() => att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'gpt-five', decision: 'approve' }), /Pass "as"/);
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'gpt-five', decision: 'approve', as: 'rename' });
    const d = att.parseApprovals(c.deps.store.content);
    assert.strictEqual(d.clients.gpt.tags.chatgpt.retired, true);
    assert.deepStrictEqual(att.rememberedFor(d, 'gpt'), ['gpt-five']);
    const a = actorFor({ sourceTag: null, clientId: 'gpt' });
    await att.preflight(c, a, { source: 'gpt-five', content: 'y' }, 'write_doc');
    assert.strictEqual(a.effectiveTag, 'gpt-five');
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'gpt' }), { source: 'chatgpt', content: 'z' }, 'write_doc'), /rename/);
  });
  test('an auto-generated tag is kept for good, never regenerated', async () => {
    const att = await fresh();
    const c = ctx();
    const first = actorFor({ sourceTag: null, clientId: 'weird-client-123' });
    await assert.rejects(() => att.preflight(c, first, { content: 'x' }, 'write_doc'));
    const auto = first.effectiveTag;
    assert.match(auto, /^auto-/);
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: auto, decision: 'approve' });
    // Even if the auto scheme changed, the remembered tag wins.
    const d = att.parseApprovals(c.deps.store.content);
    assert.strictEqual(d.clients['weird-client-123'].tags[auto].basis, 'auto');
    const a = actorFor({ sourceTag: null, clientId: 'weird-client-123' });
    await att.preflight(c, a, { content: 'y' }, 'write_doc');
    assert.strictEqual(a.effectiveTag, auto);
    assert.strictEqual(a.sourceBasis, 'remembered');
  });
  test('a shared client_id remembers a set and matches by declared name', async () => {
    const att = await fresh();
    const c = ctx();
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'shared' }), { source: 'bot-a', content: 'x' }, 'write_doc'));
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'bot-a', decision: 'approve' });
    // bot-b on the same client: queued (rename kind, since the client is known), owner approves as a second tag.
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'shared' }), { source: 'bot-b', content: 'x' }, 'write_doc'));
    assert.deepStrictEqual(att.parseApprovals(c.deps.store.content).pending['bot-b'].rename_from, ['bot-a']);
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'bot-b', decision: 'approve', as: 'add', reason: 'second bot' });
    assert.deepStrictEqual(att.rememberedFor(att.parseApprovals(c.deps.store.content), 'shared').sort(), ['bot-a', 'bot-b']);
    const a = actorFor({ sourceTag: null, clientId: 'shared' });
    await att.preflight(c, a, { source: 'bot-b', content: 'y' }, 'write_doc');
    assert.strictEqual(att.rememberedView(a).use_tag, 'bot-b');
    await assert.rejects(() => att.preflight(c, actorFor({ sourceTag: null, clientId: 'shared' }), { content: 'z' }, 'write_doc'), /several tags/);
  });
});

testGroup('(e) review delta M2: explicit as on a client with approved tags', () => {
  test("the owner's case: client 8xm with the intake bot approved, approving grok-project keeps the intake bot", async () => {
    const att = await fresh();
    const c = ctx({ registry: ['cowork-cloud'] });
    const on8xm = () => actorFor({ sourceTag: null, clientId: 'shared-client-0001', grantId: 'g-shared' });
    await assert.rejects(() => att.preflight(c, on8xm(), { source: 'intake-bot', content: 'x' }, 'write_doc'));
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'intake-bot', decision: 'approve' });
    await assert.rejects(() => att.preflight(c, on8xm(), { source: 'grok-project', content: 'x' }, 'write_doc'));
    await assert.rejects(() => att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'grok-project', decision: 'approve' }), /already has approved tags \(intake-bot\)/);
    assert.ok(att.parseApprovals(c.deps.store.content).pending['grok-project'], 'unchanged on refusal');
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'grok-project', decision: 'approve', as: 'add' });
    const d = att.parseApprovals(c.deps.store.content);
    assert.deepStrictEqual(att.rememberedFor(d, 'shared-client-0001').sort(), ['grok-project', 'intake-bot']);
    assert.ok(!d.clients['shared-client-0001'].tags['intake-bot'].retired);
  });
  test('rename on a client with several tags must name the one it replaces', async () => {
    const att = await fresh();
    const c = ctx({ registry: ['cowork-cloud'] });
    const on = () => actorFor({ sourceTag: null, clientId: 'sh' });
    await assert.rejects(() => att.preflight(c, on(), { source: 'a1', content: 'x' }, 'write_doc'));
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'a1', decision: 'approve' });
    await assert.rejects(() => att.preflight(c, on(), { source: 'a2', content: 'x' }, 'write_doc'));
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'a2', decision: 'approve', as: 'add' });
    await assert.rejects(() => att.preflight(c, on(), { source: 'a3', content: 'x' }, 'write_doc'));
    await assert.rejects(() => att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'a3', decision: 'approve', as: 'rename' }), /"from"/);
    // review should-fix: `from` must be one of the client's own approved tags.
    await assert.rejects(() => att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'a3', decision: 'approve', as: 'rename', from: 'not-a-sibling' }), /"from"/);
    await assert.rejects(() => att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'a3', decision: 'approve', as: 'rename', from: 'a3' }), /"from"/);
    assert.ok(att.parseApprovals(c.deps.store.content).pending.a3, 'still pending after a bad from');
    await att.clientApprove(c.deps, ownerHost(), 'owner1', { tag: 'a3', decision: 'approve', as: 'rename', from: 'a1' });
    assert.deepStrictEqual(att.rememberedFor(att.parseApprovals(c.deps.store.content), 'sh').sort(), ['a2', 'a3']);
  });
});

testGroup('(c) startup reports the real tag', () => {
  test('callerAttribution returns the effective tag and basis over HTTP', async () => {
    const att = await fresh();
    const { callerAttribution } = await import('../src/setup.js');
    const { actorStore } = await import('../src/persons.js');
    const a = actorFor();
    await att.preflight(ctx(), a, { source: 'intake-bot' }, 'emet_initialize');
    assert.deepStrictEqual(actorStore.run(a, () => callerAttribution()), { source_tag: 'intake-bot', source_basis: 'declared', source_login: 'hub-bot', approval_state: 'registered' });
    const b = actorFor();
    await att.preflight(ctx(), b, {}, 'emet_initialize');
    assert.deepStrictEqual(actorStore.run(b, () => callerAttribution()), { source_tag: 'hub-bot', source_basis: 'login', approval_state: 'login' });
    const c = ctx();
    const n = actorFor({ sourceTag: null, clientId: 'gpt' });
    await assert.rejects(() => att.preflight(c, n, { source: 'chatgpt' }, 'save_to_layer'));
    const n2 = actorFor({ sourceTag: null, clientId: 'gpt' });
    await att.preflight(c, n2, { source: 'chatgpt' }, 'emet_initialize');
    assert.strictEqual(actorStore.run(n2, () => callerAttribution()).approval_state, 'pending');
  });
  test('emet_initialize and emet_status accept source in their schemas', async () => {
    const { TOOLS } = await import('../src/tools.js');
    for (const n of ['emet_initialize', 'emet_status']) assert.ok(TOOLS.find((t) => t.name === n).inputSchema.properties.source);
  });
});

summary();
