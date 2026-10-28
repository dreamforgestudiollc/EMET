/**
 * R6 writer approval and owl MCP clone retirement.
 * Invites.js freezes its door flags at import, so this file sets the
 * environment before importing the modules that mint a code.
 */
process.env.EMET_INVITES = '1';
process.env.EMET_MEMBER_ACCESS = '1';
process.env.EMET_SUBKEYS = '1';
process.env.EMET_SUBKEY_PEPPER = 'pepper-pepper-pepper-pepper-pepper-32b';
process.env.EMET_RECORD_DOCS = 'bots/intake-bot/HANDOFF.md,bots/hub-bot/HANDOFF.md';
process.env.EMET_SOURCE_TAGS = 'hub-bot,intake-bot,cowork-cloud,new-writer';
process.env.EMET_OAUTH_PASSPHRASE = 'owner-secret-value';
process.env.EMET_HTTP_LISTEN = '0';

const { test, testGroup, summary } = await import('./harness.js');
const assert = (await import('node:assert/strict')).default;
const fs = await import('node:fs');
const express = (await import('express')).default;
const { makeStore } = await import('./memstore.js');
const { ApproveThrottle } = await import('../src/approve-throttle.js');
const { MongoOAuthProvider, tokenDigest } = await import('../src/oauth-provider.js');
const { mountChooser } = await import('../src/chooser.js');
const { createOwnerGate } = await import('../src/owner-session.js');
const { actorStore } = await import('../src/persons.js');
const { createMemoryStore } = await import('../src/subkey-store.js');
const {
  prepareWriterRequest, recordWriterDecision, writerApprovalLog, getWriterRequest,
  validateWriterDraft, _resetWriterApprovalsForTests
} = await import('../src/writer-approval.js');
const {
  isOwlIdentity, owlStartupCheck, owlRetirementMetric, runStartupChecks, _resetOwlForTests
} = await import('../src/owl.js');
const { OWL_KILL, CLAUDE_CHATGPT_DOOR, WRITER_VALIDATOR } = await import('../src/grants.js');
const { commitRotation } = await import('../src/rotate.js');
const { hostTools, memberAccessCreate } = await import('../src/tools.js');

console.log('\n=== R6 writer approval ===');

const SECRET = 'owner-secret-value';
const OWNER = 'alex';
const MB_GRANT = 'mbgrant00000000000001';
const CORR = 'abcdefabcdefabcd';
const OWL = 'user-EMET--owl';
const AI_CANNOT_GRANT = 'emet_client_approve: an AI cannot grant a writer. Master Hub prepares a request. the owner decides it on /owner/chooser. Nothing was changed.';
const holder = { db: null };
const provider = new MongoOAuthProvider(() => holder.db, { passphrase: SECRET, cimd: false });
const throttle = new ApproveThrottle();
const gate = createOwnerGate({
  checkPassphrase: (input) => provider.checkPassphrase(input),
  throttle
});
const app = express();
app.set('trust proxy', 1);
mountChooser(app, {
  gate,
  throttle,
  deps: () => ({ subkeys: createMemoryStore() }),
  ownerId: OWNER,
  db: () => holder.db,
  prefix: 'emet_',
  provider
});
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const approveHttp = { server: null, base: '' };

function cookiePair(setCookie) {
  assert.ok(setCookie, 'expected a cookie');
  return setCookie.split(';')[0];
}
function quiet(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  return Promise.resolve()
    .then(fn)
    .then((value) => ({ value, lines, error: null }))
    .catch((error) => ({ value: null, lines, error }))
    .finally(() => { console.error = orig; });
}
function mbActor(extra = {}) {
  return {
    transport: 'http',
    authenticated: true,
    sourceBasis: 'login',
    sourceTag: 'hub-bot',
    personId: OWNER,
    ownerId: OWNER,
    clientId: 'mb-client',
    grantId: MB_GRANT,
    ...extra
  };
}
function draft(extra = {}) {
  return {
    decision: 'prepare',
    client: 'claude-host',
    claimed_tag: 'new-writer',
    door: 'member',
    reason: 'the owner asked for a writer',
    correlation_id: CORR,
    tag: 'new-writer',
    ...extra
  };
}
function futureSeconds() {
  return Math.floor(Date.now() / 1000) + 3600;
}
async function plantToken(fields) {
  const family = fields.family;
  const access = `access-${family}`;
  const refresh = `refresh-${family}`;
  await holder.db.collection('emet_oauth_tokens').insertOne({
    token: tokenDigest(access), hashed: true, kind: 'access',
    client_id: fields.client_id, source_tag: fields.source_tag || null,
    family, scopes: fields.scopes || ['emet.read'],
    issued_via: fields.issued_via || 'member', subject: fields.subject || 'member-person',
    expiresAt: futureSeconds(), createdAt: new Date()
  });
  await holder.db.collection('emet_oauth_tokens').insertOne({
    token: tokenDigest(refresh), hashed: true, kind: 'refresh',
    client_id: fields.client_id, source_tag: fields.source_tag || null,
    family, scopes: fields.scopes || ['emet.read'],
    issued_via: fields.issued_via || 'member', subject: fields.subject || 'member-person',
    expiresAt: futureSeconds() + 86400, createdAt: new Date()
  });
  return { access, refresh, family };
}
function approvalDeps() {
  const store = { content: null, version: null };
  return {
    readDoc: async () => {
      if (store.content === null) throw new Error('Document not found: emet/CLIENT_APPROVALS.md');
      return { content: store.content, version: store.version };
    },
    writeDoc: async (_id, content, expected) => {
      if ((expected ?? null) !== (store.version ?? null)) {
        const error = new Error('conflict');
        error.versionConflict = true;
        throw error;
      }
      store.content = content;
      store.version = (store.version || 0) + 1;
      return { version: store.version };
    },
    subkeys: createMemoryStore()
  };
}
function cosActor(tag = 'hubbot-cos') {
  return {
    transport: 'http',
    authenticated: true,
    sourceBasis: 'login',
    sourceTag: tag,
    personId: OWNER,
    ownerId: OWNER,
    clientId: 'cos-client',
    grantId: 'cosgrant0000000000001'
  };
}
async function withEnv(changes, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(changes)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
function exactAiRefusal(error) {
  assert.equal(error && error.message, AI_CANNOT_GRANT);
  return true;
}
async function ownerSession() {
  const login = await fetch(`${base}/owner/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passphrase: SECRET, next: '/owner/chooser' }).toString()
  });
  assert.equal(login.status, 303);
  const cookie = cookiePair(login.headers.get('set-cookie'));
  const page = await fetch(`${base}/owner/chooser`, { headers: { cookie } });
  const html = await page.text();
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
  assert.ok(csrf, html);
  return { cookie, csrf: csrf[1] };
}
function postWriter(session, fields) {
  return fetch(`${base}/owner/chooser/writer`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    body: new URLSearchParams({ csrf: session.csrf, ...fields }).toString()
  });
}
async function plantStored(fields) {
  const row = {
    request_id: fields.request_id,
    status: fields.status,
    door: fields.door || 'member',
    claimed_tag: fields.claimed_tag || 'new-writer',
    client: 'claude-host',
    grant_id: MB_GRANT,
    correlation_id: fields.correlation_id,
    preparer: 'hub-bot',
    validator: 'server',
    decider: fields.decider || 'none',
    issued: fields.issued === true,
    deleted: false,
    retained: true,
    reason: 'kept',
    history: []
  };
  await holder.db.collection('emet_writer_approvals').insertOne({ ...row, _id: row.request_id });
  return row;
}
async function inviteCount(tag = 'new-writer') {
  const rows = await holder.db.collection('invites').find({ source_tag: tag }).toArray();
  return rows.length;
}
// The database compare-and-set also refuses a non-validated row. This store
// ignores that status filter so the chooser POST is refused by the in-memory
// `status !== 'validated'` check alone.
function ignoreWriterStatus(db) {
  const orig = db.collection.bind(db);
  db.collection = (name) => {
    const col = orig(name);
    if (name !== 'emet_writer_approvals') return col;
    return new Proxy(col, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'findOneAndUpdate') return typeof value === 'function' ? value.bind(target) : value;
        return (query, update, opts) => {
          const wide = { ...query };
          delete wide.status;
          return target.findOneAndUpdate(wide, update, opts);
        };
      }
    });
  };
  return db;
}

try {
  await testGroup('contract', async () => {
    await test('owl retirement is implemented and retained, and Claude/ChatGPT stays open', () => {
      assert.equal(OWL_KILL.implemented, true);
      assert.equal(OWL_KILL.delete_wiring, false);
      assert.equal(OWL_KILL.status, 'retired');
      assert.equal(OWL_KILL.deleted, false);
      assert.equal(OWL_KILL.retained, true);
      assert.equal(OWL_KILL.account, OWL);
      assert.equal(WRITER_VALIDATOR.implemented, 'server');
      assert.equal(WRITER_VALIDATOR.alex_choice_open, true);
      assert.equal(WRITER_VALIDATOR.not_an_option, OWL);
      assert.equal(CLAUDE_CHATGPT_DOOR.decided, false);
      assert.equal(CLAUDE_CHATGPT_DOOR.door, null);
      assert.equal(isOwlIdentity('knowledge'), false);
      assert.equal(isOwlIdentity({ client_name: 'user-EMET--owl-extra' }), false);
      assert.equal(isOwlIdentity({ client_id: OWL }), true);
      assert.equal(hostTools().some((tool) => tool.name === 'emet_writer_prepare'), false);
      assert.equal(hostTools().some((tool) => tool.name === 'emet_client_approve'), true);
    });
  });

  await testGroup('prepare and decide', async () => {
    await test('Master Hub prepares, the server records validation, and Master Hub cannot approve', async () => {
      _resetWriterApprovalsForTests();
      holder.db = makeStore();
      const caught = await quiet(() => prepareWriterRequest(holder.db, 'emet_', mbActor(), draft()));
      assert.equal(caught.error, null);
      const row = caught.value;
      assert.equal(row.status, 'validated');
      assert.equal(row.validator, 'server');
      assert.equal(row.preparer, 'hub-bot');
      assert.equal(row.decider, 'none');
      assert.equal(row.grant_id, MB_GRANT);
      assert.equal(row.correlation_id, CORR);
      assert.ok(row.history.some((step) => step.step === 'validate' && step.validator === 'server'));
      const logged = caught.lines.find((line) => line.includes('step=validate'));
      assert.match(logged, new RegExp(`grant_id=${MB_GRANT}`));
      assert.match(logged, new RegExp(`correlation_id=${CORR}`));
      assert.match(logged, /preparer=hub-bot/);
      assert.match(logged, /validator=server/);
      assert.match(logged, /decider=none/);
      const again = await prepareWriterRequest(holder.db, 'emet_', mbActor(), draft());
      assert.equal(again.unchanged, true);
      assert.equal(again.request_id, row.request_id);
      const declared = mbActor({ sourceTag: 'intake-bot', sourceBasis: 'declared', declaredTag: 'hub-bot', effectiveTag: 'hub-bot' });
      await assert.rejects(() => prepareWriterRequest(holder.db, 'emet_', declared, draft({ correlation_id: 'bbbbbbbbbbbbbbb1' })), /only Master Hub/);
      await assert.rejects(() => prepareWriterRequest(holder.db, 'emet_', mbActor(), draft({ decision: 'approve' })), /cannot approve/);
      const att = await import('../src/attribution.js');
      att._resetForTests();
      await withEnv({ EMET_RECORD_DOCS: undefined, EMET_COS_TAG: undefined }, async () => {
        await assert.rejects(
          () => att.clientApprove(approvalDeps(), mbActor(), OWNER, { tag: 'chatgpt', decision: 'approve' }),
          exactAiRefusal
        );
      });
    });

    await test('an invalid draft is retained and is not approvable', async () => {
      _resetWriterApprovalsForTests();
      holder.db = makeStore();
      const row = await prepareWriterRequest(holder.db, 'emet_', mbActor(), draft({
        correlation_id: 'bbbbbbbbbbbbbbb2',
        door: 'owner',
        claimed_tag: 'new-writer',
        tag: 'new-writer'
      }));
      assert.equal(row.status, 'invalid');
      assert.ok(row.failures.includes('door'));
      assert.equal(row.deleted, false);
      assert.equal(row.retained, true);
      const stored = await holder.db.collection('emet_writer_approvals').findOne({ _id: row.request_id });
      assert.equal(stored.status, 'invalid');
      await assert.rejects(
        () => recordWriterDecision(holder.db, 'emet_', { requestId: row.request_id, decision: 'approve', decider: OWNER, ownerSession: true, issued: false }),
        /not awaiting a decision/
      );
      assert.equal(getWriterRequest(row.request_id).status, 'invalid');
    });

    await test('owl cannot approve, and a non-owner session cannot grant a writer', async () => {
      _resetWriterApprovalsForTests();
      holder.db = makeStore();
      const att = await import('../src/attribution.js');
      const owl = {
        personId: OWNER, ownerId: OWNER, clientId: OWL, transport: 'http', authenticated: true,
        sourceTag: 'cowork-cloud', sourceBasis: 'login'
      };
      await assert.rejects(
        () => att.clientApprove({ readDoc: async () => { throw new Error('missing'); }, writeDoc: async () => ({ version: 1 }) }, owl, OWNER, { tag: 'chatgpt', decision: 'approve' }),
        /retired by R6/
      );
      await assert.rejects(
        () => prepareWriterRequest(holder.db, 'emet_', owl, draft({ correlation_id: 'cccccccccccccccc' })),
        /retired by R6/
      );
      const prepared = await prepareWriterRequest(holder.db, 'emet_', mbActor(), draft({ correlation_id: 'dddddddddddddddd' }));
      await assert.rejects(
        () => recordWriterDecision(holder.db, 'emet_', { requestId: prepared.request_id, decision: 'approve', decider: 'ana', ownerSession: false }),
        /owner session/
      );
      const anonymous = await fetch(`${base}/owner/chooser/writer`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'approve', request_id: prepared.request_id }).toString()
      });
      assert.equal(anonymous.status, 401);
      assert.match(await anonymous.text(), /Only the owner session can grant a writer/);
      assert.equal(getWriterRequest(prepared.request_id).status, 'validated');
    });

    await test('the owner on the owner session approves a validated writer and the validation record stays', async () => {
      _resetWriterApprovalsForTests();
      holder.db = makeStore();
      const prepared = await quiet(() => prepareWriterRequest(holder.db, 'emet_', mbActor(), draft({ correlation_id: 'eeeeeeeeeeeeeeee' })));
      assert.equal(prepared.error, null);
      const login = await fetch(`${base}/owner/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ passphrase: SECRET, next: '/owner/chooser' }).toString()
      });
      assert.equal(login.status, 303);
      const cookie = cookiePair(login.headers.get('set-cookie'));
      const page = await fetch(`${base}/owner/chooser`, { headers: { cookie } });
      const html = await page.text();
      assert.equal(page.status, 200, html);
      assert.match(html, /Writer requests/);
      assert.match(html, /eeeeeeeeeeeeeeee/);
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)[1];
      const decided = await quiet(() => fetch(`${base}/owner/chooser/writer`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({ csrf, decision: 'approve', request_id: prepared.value.request_id }).toString()
      }));
      assert.equal(decided.error, null);
      const body = await decided.value.text();
      assert.equal(decided.value.status, 200, body);
      const shown = /Invite code, shown once: ([0-9a-f]+)/.exec(body);
      assert.ok(shown, body);
      const code = shown[1];
      assert.equal(decided.lines.some((line) => line.includes(code)), false);
      assert.equal(JSON.stringify(writerApprovalLog()).includes(code), false);
      const decideLine = decided.lines.find((line) => line.includes('step=decide'));
      assert.match(decideLine, new RegExp(`grant_id=${MB_GRANT}`));
      assert.match(decideLine, /correlation_id=eeeeeeeeeeeeeeee/);
      assert.match(decideLine, /preparer=hub-bot/);
      assert.match(decideLine, /validator=server/);
      assert.match(decideLine, /decider=alex/);
      const row = getWriterRequest(prepared.value.request_id);
      assert.equal(row.status, 'approved');
      assert.equal(row.decider, 'alex');
      assert.equal(row.validator, 'server');
      assert.equal(row.preparer, 'hub-bot');
      assert.equal(row.issued, true);
      assert.equal(JSON.stringify(row).includes(code), false);
      const stored = await holder.db.collection('emet_writer_approvals').findOne({ _id: row.request_id });
      assert.equal(stored.deleted, false);
      assert.equal(stored.retained, true);
      assert.equal(JSON.stringify(stored).includes(code), false);
      const invite = await holder.db.collection('invites').findOne({ source_tag: 'new-writer', door: 'member' });
      assert.ok(invite);
      assert.ok(invite.scopes.includes('emet.write'));
      assert.equal(invite.door, 'member');
    });

    await test('an AI cannot mint EMET Member Access, and the owner without an AI tag still can', async () => {
      holder.db = makeStore();
      await holder.db.collection('persons').insertOne({ person_id: OWNER, role: 'owner', display_name: 'the owner' });
      const dbManager = { db: holder.db, async getConnection() { return {}; } };
      await assert.rejects(
        () => actorStore.run(mbActor(), () => memberAccessCreate(dbManager, { display_name: 'Nope' })),
        (error) => error.emetCode === 'EMET-AUTH-043' && /cannot grant a writer/.test(error.message)
      );
      await assert.rejects(
        () => actorStore.run({
          transport: 'http', authenticated: true, personId: OWNER, clientId: OWL, sourceTag: 'cowork-cloud'
        }, () => memberAccessCreate(dbManager, { display_name: 'Nope' })),
        (error) => error.emetCode === 'EMET-AUTH-043'
      );
      const made = await actorStore.run(
        { transport: 'http', personId: OWNER, scopes: ['emet'] },
        () => memberAccessCreate(dbManager, { display_name: 'Owner member' })
      );
      assert.equal(made.door, 'member');
      assert.ok(made.scopes.includes('emet.write'));
    });

    await test('the chooser claims a writer before it mints, and a non-validated request mints nothing', async () => {
      const chooserSrc = fs.readFileSync(new URL('../src/chooser.js', import.meta.url), 'utf8');
      const writerFn = chooserSrc.slice(chooserSrc.indexOf('async function finishWriter'));
      const claimAt = writerFn.indexOf('claimWriterDecision');
      const issueAt = writerFn.indexOf('issueDoor');
      assert.ok(claimAt >= 0 && issueAt > claimAt);
      const claimSrc = fs.readFileSync(new URL('../src/writer-approval.js', import.meta.url), 'utf8');
      const claimFn = claimSrc.slice(claimSrc.indexOf('export async function claimWriterDecision'), claimSrc.indexOf('export async function stampWriterIssued'));
      assert.match(claimFn, /row\.status !== 'validated'/);
      assert.match(claimFn, /status: 'validated'/);
      _resetWriterApprovalsForTests();
      holder.db = ignoreWriterStatus(makeStore());
      await plantStored({ request_id: 'req-invalid-0001', status: 'invalid', correlation_id: '1111111111111111' });
      await plantStored({ request_id: 'req-denied-00001', status: 'denied', correlation_id: '2222222222222222' });
      await plantStored({ request_id: 'req-approved-001', status: 'approved', correlation_id: '3333333333333333', issued: true });
      const session = await ownerSession();
      for (const requestId of ['req-invalid-0001', 'req-denied-00001', 'req-approved-001']) {
        const posted = await postWriter(session, { decision: 'approve', request_id: requestId });
        const body = await posted.text();
        assert.equal(posted.status, 400, body);
        assert.match(body, /not awaiting a decision/);
      }
      assert.equal(await inviteCount(), 0);
      assert.equal(getWriterRequest('req-invalid-0001').status, 'invalid');
      assert.equal(getWriterRequest('req-denied-00001').status, 'denied');
      assert.equal(getWriterRequest('req-approved-001').status, 'approved');
      await plantStored({ request_id: 'req-owner-door01', status: 'validated', door: 'owner', correlation_id: '4444444444444444', claimed_tag: 'owner-door' });
      const released = await postWriter(session, { decision: 'approve', request_id: 'req-owner-door01' });
      assert.equal(released.status, 400);
      assert.equal(getWriterRequest('req-owner-door01').status, 'validated');
      assert.equal(await inviteCount('owner-door'), 0);
    });

    await test('two chooser approves of one validated request mint one code', async () => {
      _resetWriterApprovalsForTests();
      holder.db = makeStore();
      const prepared = await prepareWriterRequest(holder.db, 'emet_', mbActor(), draft({ correlation_id: '5555555555555555', claimed_tag: 'one-code', tag: 'one-code' }));
      const session = await ownerSession();
      const [left, right] = await Promise.all([
        postWriter(session, { decision: 'approve', request_id: prepared.request_id }),
        postWriter(session, { decision: 'approve', request_id: prepared.request_id })
      ]);
      const statuses = [left.status, right.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 400]);
      assert.equal(await inviteCount('one-code'), 1);
      assert.equal(getWriterRequest(prepared.request_id).status, 'approved');
      assert.equal(getWriterRequest(prepared.request_id).issued, true);
    });

    await test('a chief of staff who is not Master Hub cannot approve a pending client', async () => {
      const att = await import('../src/attribution.js');
      att._resetForTests();
      const actor = cosActor();
      await withEnv({ EMET_COS_TAG: 'hubbot-cos' }, async () => {
        assert.equal(att.actorIsOwner(actor, OWNER), true);
        assert.equal(att.actorIsCos(actor), true);
        await assert.rejects(
          () => att.clientApprove(approvalDeps(), actor, OWNER, { tag: 'chatgpt', decision: 'approve' }),
          exactAiRefusal
        );
        att._resetForTests();
        const denied = await att.clientApprove(approvalDeps(), actor, OWNER, { tag: 'chatgpt', decision: 'deny' });
        assert.equal(denied.decision, 'deny');
        assert.equal(denied.tag, 'chatgpt');
      });
    });

    await test('a prepared draft whose client is the owl account is invalid', () => {
      const checked = validateWriterDraft(draft({ client: OWL }), mbActor());
      assert.equal(checked.ok, false);
      assert.ok(checked.failures.includes('client'));
    });
  });

  await testGroup('owl retirement', async () => {
    await test('an owl credential is refused with a pointer, and the row stays readable', async () => {
      _resetOwlForTests();
      holder.db = makeStore();
      const planted = await plantToken({ family: 'owlgrant0000000000001', client_id: OWL, source_tag: OWL });
      const access = await quiet(() => provider.verifyAccessToken(planted.access));
      assert.ok(access.error);
      assert.equal(access.error.emetCode, 'EMET-AUTH-042');
      assert.match(access.error.message, /retired by R6/);
      assert.match(access.error.message, /\/owner\/chooser/);
      assert.match(access.error.message, /grant_id: owlgrant0000000000001/);
      assert.match(access.error.message, /correlation_id: [0-9a-f]{16}/);
      assert.equal(access.error.message.includes('"'), false);
      const refresh = await quiet(() => provider.exchangeRefreshToken({ client_id: OWL }, planted.refresh, null, null));
      assert.ok(refresh.error);
      assert.equal(refresh.error.emetCode, 'EMET-AUTH-042');
      assert.match(refresh.error.message, /retired by R6/);
      const row = await holder.db.collection('emet_oauth_tokens').findOne({ family: planted.family, kind: 'access' });
      assert.ok(row);
      assert.equal(row.token, tokenDigest(planted.access));
      await holder.db.collection('emet_oauth_clients').insertOne({ client_id: 'opaque-owl-client', client_name: OWL });
      const opaque = await plantToken({ family: 'owlgrant0000000000002', client_id: 'opaque-owl-client', source_tag: 'intake-bot' });
      const check = await quiet(() => owlStartupCheck(holder.db, 'emet_'));
      assert.equal(check.value.ok, false);
      assert.ok(check.value.active >= 1);
      assert.match(check.value.line, /OWL RETIREMENT CHECK FAILED/);
      const opaqueUse = await quiet(() => provider.verifyAccessToken(opaque.access));
      assert.equal(opaqueUse.error.emetCode, 'EMET-AUTH-042');
      const marker = await holder.db.collection('emet_owl_retirement').findOne({ _id: 'owl-mcp-clone' });
      assert.equal(marker.status, 'retired');
      assert.equal(marker.deleted, false);
      await holder.db.collection('emet_oauth_tokens').updateMany(
        { family: { $in: [planted.family, opaque.family] } },
        { $set: { retired: true, superseded_by: 'R6' } }
      );
      const quietCheck = await owlStartupCheck(holder.db, 'emet_');
      assert.equal(quietCheck.ok, true);
      assert.equal(quietCheck.active, 0);
      assert.match(quietCheck.line, /check=pass/);
      const still = await holder.db.collection('emet_oauth_tokens').findOne({ family: planted.family, kind: 'access' });
      assert.equal(still.family, planted.family);
      assert.equal(still.client_id, OWL);
      const benign = await plantToken({ family: 'knowgrant000000000001', client_id: 'knowledge-client', source_tag: 'knowledge' });
      const allowed = await provider.verifyAccessToken(benign.access);
      assert.equal(allowed.clientId, 'knowledge-client');
      await assert.rejects(
        () => provider._issueTokens(OWL, ['emet.read'], null, 'alex', 'member', null, OWL),
        (error) => error.emetCode === 'EMET-AUTH-042'
      );
      const minted = await holder.db.collection('emet_oauth_tokens').findOne({ client_id: OWL, retired: { $exists: false } });
      assert.equal(minted, null);
    });

    await test('rotate-all does not invite the retired owl account, and the owl grant stays on file', async () => {
      holder.db = makeStore();
      const owl = await plantToken({ family: 'owlgrant0000000000003', client_id: OWL, source_tag: OWL, issued_via: 'member', subject: 'owl-person' });
      await plantToken({ family: 'molegrant000000000001', client_id: 'intake-client', source_tag: 'intake-bot', issued_via: 'member', subject: 'intake-person' });
      const turned = await quiet(() => commitRotation({
        db: holder.db,
        prefix: 'emet_',
        deps: { subkeys: createMemoryStore() },
        scope: 'household',
        decider: OWNER,
        correlationId: 'ffffffffffffffff'
      }));
      assert.equal(turned.error, null, turned.error && turned.error.message);
      assert.equal(turned.value.ok, true);
      const tags = turned.value.invites.map((row) => row.tag);
      assert.ok(tags.includes('intake-bot'));
      assert.equal(tags.includes(OWL), false);
      const kept = await holder.db.collection('emet_oauth_tokens').findOne({ family: owl.family, kind: 'access' });
      assert.ok(kept);
      assert.ok(kept.superseded_by);
      assert.equal(kept.deleted, false);
      const inviteRows = await holder.db.collection('invites').find({}).toArray();
      assert.equal(inviteRows.some((row) => row.source_tag === OWL), false);
      assert.ok(inviteRows.some((row) => row.source_tag === 'intake-bot'));
    });

    await test('authorization-code issue refuses an owl draft before insert', async () => {
      _resetOwlForTests();
      holder.db = makeStore();
      const issued = await quiet(() => provider.createAuthorizationCode({
        client_id: 'ordinary-client',
        redirect_uri: 'https://example.com/cb',
        code_challenge: 'challenge',
        scopes: ['emet.read'],
        source_tag: OWL
      }));
      assert.equal(issued.error && issued.error.emetCode, 'EMET-AUTH-042');
      assert.match(issued.error.message, /retired by R6/);
      const codes = await holder.db.collection('emet_oauth_codes').find({}).toArray();
      assert.equal(codes.length, 0);
    });

    await test('authorization-code exchange refuses the owl code before it is spent', async () => {
      holder.db = makeStore();
      const plain = 'exchange-code-plain';
      await holder.db.collection('emet_oauth_codes').insertOne({
        code: tokenDigest(plain),
        hashed: true,
        client_id: 'ordinary-client',
        redirect_uri: 'https://example.com/cb',
        code_challenge: 'challenge',
        scopes: ['emet.read'],
        subject: OWNER,
        source_tag: 'cowork-cloud',
        client_name: OWL,
        issued_via: 'owner',
        expiresAtMs: Date.now() + 60000,
        used: false,
        createdAt: new Date(),
        rotation_generation: 0
      });
      const exchanged = await quiet(() => provider.exchangeAuthorizationCode(
        { client_id: 'ordinary-client' },
        plain,
        'verifier',
        'https://example.com/cb',
        null
      ));
      assert.equal(exchanged.error && exchanged.error.emetCode, 'EMET-AUTH-042');
      const spent = await holder.db.collection('emet_oauth_codes').findOne({ code: tokenDigest(plain) });
      assert.equal(spent.used, false);
      const tokens = await holder.db.collection('emet_oauth_tokens').find({}).toArray();
      assert.equal(tokens.length, 0);
    });

    await test('refresh exchange refuses the owl refresh before a later issue', async () => {
      holder.db = makeStore();
      const family = 'refreshgrant000000001';
      const refreshPlain = 'refresh-plain-token';
      await holder.db.collection('emet_oauth_tokens').insertOne({
        token: tokenDigest(refreshPlain),
        hashed: true,
        kind: 'refresh',
        client_id: 'ordinary-client',
        source_tag: 'cowork-cloud',
        client_name: OWL,
        family,
        scopes: ['emet.read'],
        issued_via: 'owner',
        subject: OWNER,
        expiresAt: futureSeconds() + 86400,
        createdAt: new Date()
      });
      const before = (await holder.db.collection('emet_oauth_tokens').find({}).toArray()).length;
      const refreshed = await quiet(() => provider.exchangeRefreshToken({ client_id: 'ordinary-client' }, refreshPlain, null, null));
      assert.equal(refreshed.error && refreshed.error.emetCode, 'EMET-AUTH-042');
      assert.match(refreshed.error.message, /retired by R6/);
      const after = await holder.db.collection('emet_oauth_tokens').find({}).toArray();
      assert.equal(after.length, before);
      const kept = after.find((row) => row.family === family && row.kind === 'refresh');
      assert.equal(kept.rotated_at, undefined);
      const providerSrc = fs.readFileSync(new URL('../src/oauth-provider.js', import.meta.url), 'utf8');
      const refreshFn = providerSrc.slice(providerSrc.indexOf('async exchangeRefreshToken'), providerSrc.indexOf('async revokeGrantById'));
      const refreshGuard = refreshFn.indexOf("refuseOwlCredential(rt, 'refresh')");
      const refreshIssue = refreshFn.indexOf('_issueTokens');
      assert.ok(refreshGuard >= 0 && refreshIssue > refreshGuard);
    });

    await test('POST /oauth/approve refuses an owl client, source tag, and registered client', async () => {
      const remote = await import('../src/http-remote.js');
      if (!approveHttp.server) {
        approveHttp.server = await new Promise((resolve) => {
          const listening = remote.app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        approveHttp.base = `http://127.0.0.1:${approveHttp.server.address().port}`;
      }
      async function postApprove(fields) {
        holder.db = makeStore();
        remote.dbManager.db = holder.db;
        if (fields.clientRow) await holder.db.collection('emet_oauth_clients').insertOne(fields.clientRow);
        const posted = await quiet(async () => {
          const res = await fetch(`${approveHttp.base}/oauth/approve`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: fields.client_id,
              redirect_uri: 'https://example.com/cb',
              code_challenge: 'challenge',
              passphrase: SECRET,
              source: fields.source,
              scopes: 'emet.read'
            }).toString()
          });
          return { status: res.status, body: await res.text() };
        });
        const codes = await holder.db.collection('emet_oauth_codes').find({}).toArray();
        assert.equal(posted.error, null, fields.label);
        assert.equal(posted.value.status, 401, `${fields.label}\n${posted.value.body}`);
        assert.match(`${posted.value.body}\n${posted.lines.join('\n')}`, /owl_retired/, fields.label);
        assert.equal(codes.length, 0, fields.label);
      }
      const ordinary = {
        client_id: 'ordinary-approve',
        client_name: 'Ordinary',
        redirect_uris: ['https://example.com/cb']
      };
      await postApprove({ label: 'owl client_id', client_id: OWL, source: 'cowork-cloud' });
      await withEnv({ EMET_SOURCE_TAGS: `${process.env.EMET_SOURCE_TAGS},${OWL}` }, () => postApprove({
        label: 'owl source_tag',
        client_id: ordinary.client_id,
        source: OWL,
        clientRow: ordinary
      }));
      await postApprove({
        label: 'owl registered client',
        client_id: 'opaque-approve',
        source: 'cowork-cloud',
        clientRow: {
          client_id: 'opaque-approve',
          client_name: OWL,
          redirect_uris: ['https://example.com/cb']
        }
      });
    });

    await test('startup checks run from both entry points and do not exit', async () => {
      const indexSrc = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
      const httpSrc = fs.readFileSync(new URL('../src/http-remote.js', import.meta.url), 'utf8');
      assert.match(indexSrc, /runStartupChecks\s*\(/);
      assert.match(httpSrc, /runStartupChecks\s*\(/);
      assert.equal(/owlStartupCheck\s*\(/.test(indexSrc), false);
      assert.equal(/owlStartupCheck\s*\(/.test(httpSrc), false);
      _resetOwlForTests();
      holder.db = makeStore();
      await plantToken({ family: 'owlgrant0000000000009', client_id: OWL, source_tag: OWL });
      const lines = [];
      const checked = await quiet(() => runStartupChecks(holder.db, {
        prefix: 'emet_',
        log: (line) => lines.push(String(line))
      }));
      assert.equal(checked.error, null);
      assert.match(lines.join('\n'), /OWL RETIREMENT CHECK FAILED/);
      assert.match(checked.value.line, /OWL RETIREMENT CHECK FAILED/);
      assert.equal(checked.value.exited, false);
      const metric = owlRetirementMetric();
      assert.equal(metric.ok, false);
      assert.ok(metric.active >= 1);
      assert.match(metric.last_line, /OWL RETIREMENT CHECK FAILED/);
    });

    await test('a sub-key is not approved by owl, Master Hub, or the chief of staff', async () => {
      const sk = await import('../src/subkeys.js');
      const att = await import('../src/attribution.js');
      const deps = { subkeys: createMemoryStore() };
      const registry = ['intake-bot', 'hub-bot', 'cowork-cloud'];
      const bot = {
        personId: OWNER, ownerId: OWNER, clientId: 'intake-client', grantId: 'molegrant000000000002',
        transport: 'http', authenticated: true, sourceTag: 'intake-bot', sourceBasis: 'login'
      };
      const pending = await sk.requestSubkey(deps, bot, { tag: 'intake-bot' }, registry, new Date());
      assert.equal(pending.status, 'pending');
      const owl = {
        personId: OWNER, ownerId: OWNER, clientId: OWL, transport: 'http', authenticated: true,
        sourceTag: 'cowork-cloud', sourceBasis: 'login'
      };
      await assert.rejects(
        () => sk.decideSubkeyIfPending(deps, owl, OWNER, { tag: 'intake-bot', decision: 'approve' }),
        /retired by R6/
      );
      await withEnv({ EMET_RECORD_DOCS: undefined, EMET_COS_TAG: undefined }, async () => {
        assert.equal(att.actorIsOwner(mbActor(), OWNER), true);
        assert.equal(att.actorIsCos(mbActor()), false);
        await assert.rejects(
          () => sk.decideSubkeyIfPending(deps, mbActor(), OWNER, { tag: 'intake-bot', decision: 'approve' }),
          exactAiRefusal
        );
      });
      await withEnv({ EMET_COS_TAG: 'hubbot-cos' }, async () => {
        const actor = cosActor();
        assert.equal(att.actorIsOwner(actor, OWNER), true);
        assert.equal(att.actorIsCos(actor), true);
        await assert.rejects(
          () => sk.decideSubkeyIfPending(deps, actor, OWNER, { tag: 'intake-bot', decision: 'approve' }),
          exactAiRefusal
        );
        const other = await sk.requestSubkey(deps, bot, { tag: 'cowork-cloud' }, registry, new Date());
        const denied = await sk.decideSubkeyIfPending(deps, actor, OWNER, { tag: 'cowork-cloud', decision: 'deny', key_id: other.key_id });
        assert.equal(denied.decision, 'deny');
        assert.equal(denied.tag, 'cowork-cloud');
      });
      const host = {
        personId: OWNER, ownerId: OWNER, clientId: 'claude-host', transport: 'http', authenticated: true,
        sourceTag: 'cowork-cloud', sourceBasis: 'login'
      };
      const decided = await sk.decideSubkeyIfPending(deps, host, OWNER, { tag: 'intake-bot', decision: 'approve' });
      assert.equal(decided.decision, 'approve');
      assert.equal(JSON.stringify(decided).includes(pending.nonce), false);
    });
  });
} finally {
  server.close();
  if (approveHttp.server) approveHttp.server.close();
}

summary('R6 writer approval');
