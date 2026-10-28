/**
 * BOUND door (init audit items 3 and 5, 2026-10-27).
 *
 * Client bound-login-client bound to hub-bot must not stamp
 * that tag on a grok-project claim. A grok-project credential stamps grok-project.
 * Episodic ref 697 is corrected by a later note, not by revise_memory.
 */
import assert from 'node:assert/strict';
import { test, testGroup, summary } from './harness.js';
import { layerHonouringDb, makeStore, withStore, withEnv } from './memstore.js';
import { actorStore } from '../src/persons.js';
import { saveMemory, resolvedSourceTag, writeDoc, saveTranscript, transcriptAppend } from '../src/tools.js';
import {
  CLAIM_TAG, MB_TAG, SHARED_GROK_CLIENT, EPISODIC_697_ID, CORRECTION_NOTE_DATE,
  BOUND_LOGIN_MESSAGE, episodic697CorrectionNote, recordSophiaCredential, sophiaListingAfterWriterIssue,
  isSophiaCredential, sophiaClaimOnSharedLogin
} from '../src/bound-door.js';

// Invites and the HTTP listener freeze these at import. Set them before either module loads.
process.env.EMET_HTTP_LISTEN = '0';
process.env.EMET_OAUTH_PASSPHRASE = 'bound-door-passphrase';
process.env.EMET_INVITES = '1';
process.env.EMET_MEMBER_ACCESS = '1';
process.env.EMET_REQUEST_LOG = '0';

const BOTH_TAGS = `${MB_TAG},${CLAIM_TAG}`;
const PASSPHRASE = 'bound-door-passphrase';
const APPROVE_REDIRECT = 'https://example.com/cb';
const httpHold = { server: null, base: '', remote: null };
const chooserHold = { server: null };

const mb = () => ({
  personId: 'alex', ownerId: 'alex', clientId: SHARED_GROK_CLIENT, transport: 'http',
  authenticated: true, sourceTag: MB_TAG, scopes: []
});
const bound = (extra = {}) => ({
  personId: 'alex', ownerId: 'alex', clientId: 'bound-login', transport: 'http',
  authenticated: true, sourceTag: CLAIM_TAG, door: 'member', grantId: 'bound-grant-1', scopes: [],
  ...extra
});

function memDeps(initial = null) {
  const store = { content: initial, version: initial === null ? null : 1, writes: 0 };
  return {
    store,
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
      store.writes++;
      return { version: store.version };
    }
  };
}

function approvalsOf(db) {
  const row = db.doc('emet/CLIENT_APPROVALS.md');
  return row ? row.content : null;
}

async function listedTag(db) {
  const content = approvalsOf(db);
  if (!content) return null;
  const att = await import('../src/attribution.js');
  const data = att.parseApprovals(content);
  return data && data.approved ? data.approved[CLAIM_TAG] : null;
}

async function httpApp() {
  if (!httpHold.remote) {
    if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'error';
    httpHold.remote = await import('../src/http-remote.js');
    httpHold.server = await new Promise((resolve) => {
      const listening = httpHold.remote.app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    httpHold.base = `http://127.0.0.1:${httpHold.server.address().port}`;
  }
  return httpHold;
}

async function closeServer(server) {
  if (!server) return;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}

function parseToolBody(body) {
  const chunks = [];
  if (body.includes('data:')) {
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith('data:')) chunks.push(line.slice(5).trim());
    }
  } else {
    chunks.push(body);
  }
  let msg = null;
  for (const chunk of chunks) {
    if (!chunk) continue;
    try { msg = JSON.parse(chunk); } catch { /* an SSE comment is not the result */ }
  }
  if (!msg) throw new Error(`unreadable HTTP body: ${body.slice(0, 500)}`);
  const text = msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text;
  let payload = null;
  if (typeof text === 'string') {
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  }
  return { rpc: msg, payload };
}

async function plantAccessToken(db, fields) {
  const { tokenDigest } = await import('../src/oauth-provider.js');
  const access = `access-${fields.family}`;
  await db.collection('emet_oauth_tokens').insertOne({
    token: tokenDigest(access),
    hashed: true,
    kind: 'access',
    client_id: fields.client_id,
    source_tag: fields.source_tag,
    family: fields.family,
    scopes: fields.scopes || ['emet.read', 'emet.write'],
    issued_via: fields.issued_via || 'member',
    subject: fields.subject || 'alex',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: new Date()
  });
  return access;
}

function oauthClient(clientId) {
  return {
    client_id: clientId,
    client_name: 'BOUND door test',
    redirect_uris: [APPROVE_REDIRECT]
  };
}

async function postApprove(fields) {
  const http = await httpApp();
  const db = makeStore();
  http.remote.dbManager.db = db;
  await db.collection('emet_oauth_clients').insertOne(oauthClient(fields.client_id));
  const att = await import('../src/attribution.js');
  att._resetForTests();
  const body = {
    client_id: fields.client_id,
    redirect_uri: APPROVE_REDIRECT,
    code_challenge: 'bound-challenge',
    scopes: 'emet.read emet.write'
  };
  if (fields.invite_code) body.invite_code = fields.invite_code;
  else {
    body.passphrase = PASSPHRASE;
    body.source = fields.source;
  }
  const posted = await withStore(db, async () => {
    const res = await fetch(`${http.base}/oauth/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString()
    });
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  });
  return { db, ...posted };
}

testGroup('a grok-project claim on the Master Hub login is not stamped Master Hub', () => {
  test('without preflight the caller tag is not replaced by the bound tag', () => {
    const decision = actorStore.run(mb(), () => resolvedSourceTag(CLAIM_TAG));
    assert.notStrictEqual(decision.tag, MB_TAG);
    assert.strictEqual(decision.from, 'bound-door');
    assert.strictEqual(decision.tag, null);
  });

  test('a intake claim on that login is still the bound tag', () => {
    assert.strictEqual(actorStore.run(mb(), () => resolvedSourceTag('intake-bot')).tag, MB_TAG);
  });

  test('stdio still returns the caller tag', () => {
    assert.deepStrictEqual(resolvedSourceTag(CLAIM_TAG), { tag: CLAIM_TAG, from: 'caller' });
  });

  test('save_to_layer rejects and writes nothing', async () => {
    const db = layerHonouringDb();
    const before = db.writes.length;
    await assert.rejects(
      () => actorStore.run(mb(), () => saveMemory(db, 'BOUND episodic note.', 'episodic', { source: CLAIM_TAG, assertion_origin: 'assistant' })),
      (error) => error.emetCode === 'EMET-AUTH-044' && error.message.includes(BOUND_LOGIN_MESSAGE) && error.chooser && error.chooser.kind === 'onboarding_required'
    );
    assert.strictEqual(db.writes.length, before);
  });

  test('preflight refuses the claim and does not queue it as an approved stamp', async () => {
    const att = await import('../src/attribution.js');
    att._resetForTests();
    const deps = memDeps();
    const actor = mb();
    await assert.rejects(
      () => att.preflight({ db: { collection() { return { find() { return { limit() { return { toArray: async () => [] }; } }; } }; } }, prefix: 'emet_', ownerId: 'alex', deps, registry: [MB_TAG, CLAIM_TAG, 'intake-bot', 'cowork-cloud'] }, actor, { source: CLAIM_TAG, content: 'x' }, 'save_to_layer'),
      (error) => error.attributionRefusal === true && error.message.includes('A bound login cannot stamp another tag') && error.emetCode === 'EMET-AUTH-044' && error.chooser.tag === CLAIM_TAG
    );
    assert.notStrictEqual(actor.effectiveTag, CLAIM_TAG);
    assert.strictEqual(deps.store.writes, 0);
    await assert.rejects(
      () => att.preflight({ db: { collection() { return { find() { return { limit() { return { toArray: async () => [] }; } }; } }; } }, prefix: 'emet_', ownerId: 'alex', deps, registry: [MB_TAG, CLAIM_TAG] }, mb(), { source: CLAIM_TAG }, 'emet_initialize'),
      (error) => error.emetCode === 'EMET-AUTH-044'
    );
    await att.preflight({ db: { collection() { return { find() { return { limit() { return { toArray: async () => [] }; } }; } }; } }, prefix: 'emet_', ownerId: 'alex', deps, registry: [MB_TAG, CLAIM_TAG] }, mb(), { source: CLAIM_TAG }, 'query_layer');
  });
});

testGroup('a grok-project credential stamps grok-project', () => {
  test('a caller tag of hub-bot does not stick', async () => {
    const att = await import('../src/attribution.js');
    att._resetForTests();
    const actor = bound();
    await att.preflight({ db: { collection() { return { find() { return { limit() { return { toArray: async () => [] }; } }; } }; } }, prefix: 'emet_', deps: memDeps(), registry: [CLAIM_TAG, MB_TAG] }, actor, { source: MB_TAG }, 'save_to_layer');
    const decision = actorStore.run(actor, () => resolvedSourceTag(MB_TAG));
    assert.strictEqual(decision.tag, CLAIM_TAG);
    assert.notStrictEqual(decision.tag, MB_TAG);
    assert.strictEqual(decision.from, 'credential');
    const db = layerHonouringDb();
    const saved = await actorStore.run(actor, () => saveMemory(db, 'BOUND on her own door.', 'episodic', { source: MB_TAG, assertion_origin: 'assistant' }));
    assert.strictEqual(saved.source, CLAIM_TAG);
    assert.strictEqual(db.row('episodic', saved.id).metadata.source, CLAIM_TAG);
    assert.strictEqual(db.row('episodic', saved.id).metadata.source_basis, 'credential');
  });

  test('Master Hub with no grok-project claim still stamps Master Hub', () => {
    const omitted = actorStore.run(mb(), () => resolvedSourceTag(undefined));
    assert.strictEqual(omitted.tag, MB_TAG);
    assert.strictEqual(omitted.from, 'bound');
    const named = actorStore.run(mb(), () => resolvedSourceTag(MB_TAG));
    assert.strictEqual(named.tag, MB_TAG);
  });

  test('a guest door is not the BOUND writer credential', () => {
    const guest = bound({ door: 'guest' });
    assert.strictEqual(isSophiaCredential(guest), false);
    const decision = actorStore.run(guest, () => resolvedSourceTag(MB_TAG));
    assert.notStrictEqual(decision.from, 'credential');
    assert.strictEqual(decision.tag, CLAIM_TAG);
  });

  test('a grok-project sub-key on the shared login is a credential', () => {
    const actor = mb();
    actor.subkeySession = true;
    actor.subkeyTag = CLAIM_TAG;
    actor.subkeyId = 'key-bound';
    const decision = actorStore.run(actor, () => resolvedSourceTag(MB_TAG));
    assert.strictEqual(decision.tag, CLAIM_TAG);
    assert.strictEqual(decision.from, 'subkey');
    assert.notStrictEqual(decision.tag, MB_TAG);
  });
});

testGroup('the approvals row is a credential, not a remembered claim on 8xm', () => {
  test('recordSophiaCredential lists the door and does not remember grok-project onto 8xm', async () => {
    const att = await import('../src/attribution.js');
    att._resetForTests();
    const deps = memDeps(att.renderApprovals({
      approved: {},
      pending: { [CLAIM_TAG]: { basis: 'declared', client_id: SHARED_GROK_CLIENT } },
      denied: {},
      clients: { [SHARED_GROK_CLIENT]: { tags: { [MB_TAG]: { basis: 'login' } } } }
    }));
    const listed = await recordSophiaCredential(deps, {
      client_id: SHARED_GROK_CLIENT, door: 'member', grant_id: null, by: 'alex'
    });
    assert.strictEqual(listed.written, true);
    assert.strictEqual(listed.approved.basis, 'credential');
    assert.strictEqual(listed.approved.door, 'member');
    assert.strictEqual(listed.approved.client_id, SHARED_GROK_CLIENT);
    assert.strictEqual(listed.approved.grant_id, null);
    assert.strictEqual(listed.approved.separate_from_tag, MB_TAG);
    const data = att.parseApprovals(deps.store.content);
    assert.strictEqual(data.pending[CLAIM_TAG], undefined);
    assert.deepStrictEqual(att.rememberedFor(data, SHARED_GROK_CLIENT), [MB_TAG]);
    const again = await recordSophiaCredential(deps, {
      client_id: SHARED_GROK_CLIENT, door: 'member', grant_id: null, by: 'alex'
    });
    assert.strictEqual(again.written, false);
  });

  test('the chooser listing stores no preparer grant and skips a guest door', async () => {
    const att = await import('../src/attribution.js');
    att._resetForTests();
    const deps = memDeps();
    const skipped = await sophiaListingAfterWriterIssue({
      recorded: { claimed_tag: CLAIM_TAG, door: 'guest', client_id: 'bound-login', grant_id: 'mb-grant' },
      issued: { issued: true },
      deps, by: 'alex'
    });
    assert.strictEqual(skipped.reason, 'guest');
    assert.strictEqual(deps.store.writes, 0);
    const listed = await sophiaListingAfterWriterIssue({
      recorded: { claimed_tag: CLAIM_TAG, door: 'member', client_id: 'bound-login', grant_id: 'mb-grant' },
      issued: { issued: true },
      deps, by: 'alex'
    });
    assert.strictEqual(listed.written, true);
    assert.strictEqual(listed.approved.grant_id, null);
    assert.strictEqual(listed.approved.client_id, 'bound-login');
    assert.notStrictEqual(listed.approved.grant_id, 'mb-grant');
  });
});

testGroup('episodic ref 697 correction note', () => {
  test('the dated note cites 697 and the same shape marks a parent without superseding it', async () => {
    const note = episodic697CorrectionNote();
    assert.strictEqual(note.layer, 'episodic');
    assert.strictEqual(note.metadata.corrects, EPISODIC_697_ID);
    assert.strictEqual(note.metadata.corrects, 697);
    assert.match(note.content, new RegExp(CORRECTION_NOTE_DATE));
    assert.match(note.content, /grok-project/);
    assert.match(note.content, /hub-bot/);
    assert.match(note.content, new RegExp(SHARED_GROK_CLIENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(note.content, /original row is retained/);
    assert.match(note.content, /does not supersede/);
    assert.strictEqual(note.metadata.custom.cited_source, MB_TAG);
    assert.strictEqual(note.metadata.custom.correct_source, CLAIM_TAG);
    const db = layerHonouringDb();
    const parent = await saveMemory(db, 'Episode that will stand.', 'episodic', { source: 'tester-bot', assertion_origin: 'assistant' });
    const before = JSON.parse(JSON.stringify(db.row('episodic', parent.id)));
    const child = await saveMemory(db, note.content, 'episodic', { ...note.metadata, corrects: parent.id });
    const stored = db.row('episodic', parent.id);
    assert.deepStrictEqual(stored.corrected_by, [child.id]);
    assert.strictEqual(stored.content, before.content);
    assert.ok(!stored.superseded_by);
    assert.notStrictEqual(stored.is_live, false);
    assert.strictEqual(db.row('episodic', child.id).metadata.corrects, parent.id);
  });
});

testGroup('write_doc stamps the credential and refuses the shared-login claim', () => {
  test('write_doc stores grok-project when the caller string is hub-bot', async () => {
    const db = makeStore();
    await withEnv({ EMET_SOURCE_TAGS: BOTH_TAGS }, () => withStore(db, () => actorStore.run(bound(), () =>
      writeDoc('threads/bound-stamp.md', '# BOUND stamp\n', MB_TAG))));
    const row = db.doc('threads/bound-stamp.md');
    assert.ok(row);
    assert.strictEqual(row.updated_by, CLAIM_TAG);
    assert.notStrictEqual(row.updated_by, MB_TAG);
    assert.strictEqual(row.source_basis, 'credential');
  });

  test('write_doc on the shared login refuses grok-project with EMET-AUTH-044 and writes nothing', async () => {
    const db = makeStore();
    await withEnv({ EMET_SOURCE_TAGS: BOTH_TAGS }, () => withStore(db, async () => {
      await assert.rejects(
        () => actorStore.run(mb(), () => writeDoc('threads/bound-claim.md', '# Claim\n', CLAIM_TAG)),
        (error) => error.emetCode === 'EMET-AUTH-044' && error.message.includes(BOUND_LOGIN_MESSAGE)
      );
    }));
    assert.strictEqual(db.doc('threads/bound-claim.md'), undefined);
    assert.strictEqual(db.collection('documents').docs.length, 0);
  });
});

testGroup('transcript stamps the credential and refuses the shared-login claim', () => {
  const exchange = { user_message: 'hello from BOUND', assistant_message: 'a reply with no machine line' };

  test('save_transcript stores grok-project when the caller channel is hub-bot', async () => {
    const db = makeStore();
    const saved = await withStore(db, () => actorStore.run(bound(), () => saveTranscript(
      '2026-10-27_claim_save', 1761600000, 1761600060, [exchange], MB_TAG
    )));
    assert.strictEqual(saved.channel, CLAIM_TAG);
    const session = db.transcripts().find((row) => row.session_id === '2026-10-27_claim_save');
    assert.ok(session);
    assert.strictEqual(session.channel, CLAIM_TAG);
    assert.notStrictEqual(session.channel, MB_TAG);
    assert.strictEqual(session.exchanges[0].source, CLAIM_TAG);
  });

  test('save_transcript on the shared login refuses grok-project with EMET-AUTH-044 and writes nothing', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      await assert.rejects(
        () => actorStore.run(mb(), () => saveTranscript(
          '2026-10-27_claim_save_claim', 1761600000, 1761600060, [exchange], CLAIM_TAG
        )),
        (error) => error.emetCode === 'EMET-AUTH-044' && error.message.includes(BOUND_LOGIN_MESSAGE)
      );
    });
    assert.strictEqual(db.transcripts().length, 0);
  });

  test('transcript_append stores grok-project when the caller channel is hub-bot', async () => {
    const db = makeStore();
    await withStore(db, () => actorStore.run(bound(), () => transcriptAppend({
      session_id: '2026-10-27_claim_append',
      user_message: exchange.user_message,
      assistant_message: exchange.assistant_message,
      channel: MB_TAG
    })));
    const session = db.transcripts().find((row) => row.session_id === '2026-10-27_claim_append');
    assert.ok(session);
    assert.strictEqual(session.channel, CLAIM_TAG);
    assert.notStrictEqual(session.channel, MB_TAG);
    assert.strictEqual(session.exchanges[0].source, CLAIM_TAG);
  });

  test('transcript_append on the shared login refuses grok-project with EMET-AUTH-044 and writes nothing', async () => {
    const db = makeStore();
    await withStore(db, async () => {
      await assert.rejects(
        () => actorStore.run(mb(), () => transcriptAppend({
          session_id: '2026-10-27_claim_append_claim',
          user_message: exchange.user_message,
          assistant_message: exchange.assistant_message,
          channel: CLAIM_TAG
        })),
        (error) => error.emetCode === 'EMET-AUTH-044' && error.message.includes(BOUND_LOGIN_MESSAGE)
      );
    });
    assert.strictEqual(db.transcripts().length, 0);
  });
});

testGroup('the HTTP wire returns EMET-AUTH-044 for the shared-login claim', () => {
  test('a non-http or unauthenticated actor is not the shared-login claim', () => {
    const stdio = { ...mb(), transport: 'stdio', authenticated: true };
    const anon = { ...mb(), authenticated: false };
    assert.strictEqual(sophiaClaimOnSharedLogin(stdio, CLAIM_TAG), false);
    assert.strictEqual(sophiaClaimOnSharedLogin(anon, CLAIM_TAG), false);
    const decision = actorStore.run(stdio, () => resolvedSourceTag(CLAIM_TAG));
    assert.strictEqual(decision.from, 'caller');
    assert.strictEqual(decision.tag, CLAIM_TAG);
    assert.notStrictEqual(decision.from, 'bound-door');
  });

  test('the HTTP claim refusal on /mcp is EMET-AUTH-044', async () => {
    const http = await httpApp();
    const db = makeStore();
    http.remote.dbManager.db = db;
    const access = await plantAccessToken(db, {
      family: 'mbgrant00000000000044',
      client_id: SHARED_GROK_CLIENT,
      source_tag: MB_TAG,
      issued_via: 'member'
    });
    const docId = 'threads/bound-http-claim.md';
    const res = await withStore(db, () => fetch(`${http.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 44,
        method: 'tools/call',
        params: {
          name: 'write_doc',
          arguments: { doc_id: docId, content: '# Claim\n', updated_by: CLAIM_TAG, source: CLAIM_TAG }
        }
      })
    }));
    const body = await res.text();
    assert.strictEqual(res.status, 200, body.slice(0, 500));
    const parsed = parseToolBody(body);
    const code = parsed.payload && parsed.payload.error && parsed.payload.error.emet_code;
    assert.strictEqual(code, 'EMET-AUTH-044', body.slice(0, 800));
    assert.notStrictEqual(code, 'EMET-AUTH-039');
    assert.strictEqual(parsed.rpc.result && parsed.rpc.result.isError, true);
    assert.strictEqual(db.doc(docId), undefined);
  });
});

testGroup('oauth consent lists the door it actually granted', () => {
  test('owner consent lists grok-project with door owner', async () => {
    const posted = await withEnv({ EMET_SOURCE_TAGS: BOTH_TAGS }, () => postApprove({
      client_id: 'bound-owner-login',
      source: CLAIM_TAG
    }));
    assert.strictEqual(posted.status, 302, posted.text.slice(0, 400));
    const listed = await listedTag(posted.db);
    assert.ok(listed, approvalsOf(posted.db));
    assert.strictEqual(listed.basis, 'credential');
    assert.strictEqual(listed.door, 'owner');
    assert.strictEqual(listed.client_id, 'bound-owner-login');
    assert.strictEqual(listed.grant_id, null);
  });

  test('member consent lists grok-project with door member', async () => {
    const db = makeStore();
    const { createMemberAccess } = await import('../src/invites.js');
    const invite = await createMemberAccess(db, { created_by: 'alex', display_name: CLAIM_TAG, source_tag: CLAIM_TAG });
    const http = await httpApp();
    http.remote.dbManager.db = db;
    await db.collection('emet_oauth_clients').insertOne(oauthClient('bound-member-login'));
    const att = await import('../src/attribution.js');
    att._resetForTests();
    const posted = await withStore(db, async () => {
      const res = await fetch(`${http.base}/oauth/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'bound-member-login',
          redirect_uri: APPROVE_REDIRECT,
          code_challenge: 'bound-challenge',
          invite_code: invite.code
        }).toString()
      });
      return { status: res.status, text: await res.text() };
    });
    assert.strictEqual(posted.status, 302, posted.text.slice(0, 400));
    const listed = await listedTag(db);
    assert.ok(listed, approvalsOf(db));
    assert.strictEqual(listed.basis, 'credential');
    assert.strictEqual(listed.door, 'member');
    assert.strictEqual(listed.client_id, 'bound-member-login');
    assert.strictEqual(listed.grant_id, null);
  });

  test('guest consent writes no grok-project credential', async () => {
    const db = makeStore();
    const { createInvite } = await import('../src/invites.js');
    const invite = await createInvite(db, { created_by: 'alex', display_name: CLAIM_TAG, source_tag: CLAIM_TAG });
    const http = await httpApp();
    http.remote.dbManager.db = db;
    await db.collection('emet_oauth_clients').insertOne(oauthClient('bound-guest-login'));
    const att = await import('../src/attribution.js');
    att._resetForTests();
    const posted = await withStore(db, async () => {
      const res = await fetch(`${http.base}/oauth/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'bound-guest-login',
          redirect_uri: APPROVE_REDIRECT,
          code_challenge: 'bound-challenge',
          invite_code: invite.code
        }).toString()
      });
      return { status: res.status, text: await res.text() };
    });
    assert.strictEqual(posted.status, 302, posted.text.slice(0, 400));
    assert.strictEqual(approvalsOf(db), null);
    assert.strictEqual(await listedTag(db), null);
  });
});

testGroup('Alex issuing a writer lists grok-project on the chooser', () => {
  test('after Alex issues, /owner/chooser lists grok-project as its own door', async () => {
    const express = (await import('express')).default;
    const { ApproveThrottle } = await import('../src/approve-throttle.js');
    const { MongoOAuthProvider } = await import('../src/oauth-provider.js');
    const { mountChooser } = await import('../src/chooser.js');
    const { createOwnerGate } = await import('../src/owner-session.js');
    const { prepareWriterRequest, _resetWriterApprovalsForTests } = await import('../src/writer-approval.js');
    const att = await import('../src/attribution.js');
    att._resetForTests();
    _resetWriterApprovalsForTests();
    const db = makeStore();
    const approvals = { content: null, version: null };
    const provider = new MongoOAuthProvider(() => db, { passphrase: PASSPHRASE, cimd: false });
    const gate = createOwnerGate({
      checkPassphrase: (input) => provider.checkPassphrase(input),
      throttle: new ApproveThrottle()
    });
    const app = express();
    app.set('trust proxy', 1);
    mountChooser(app, {
      gate,
      deps: () => ({
        readDoc: async () => {
          if (approvals.content === null) throw new Error('Document not found: emet/CLIENT_APPROVALS.md');
          return { content: approvals.content, version: approvals.version };
        },
        writeDoc: async (_id, content, expected) => {
          if ((expected ?? null) !== (approvals.version ?? null)) {
            const error = new Error('conflict');
            error.versionConflict = true;
            throw error;
          }
          approvals.content = content;
          approvals.version = (approvals.version || 0) + 1;
          return { version: approvals.version };
        }
      }),
      ownerId: 'alex',
      db: () => db,
      prefix: 'emet_',
      provider
    });
    const server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    chooserHold.server = server;
    try {
      const prepared = await prepareWriterRequest(db, 'emet_', {
        transport: 'http',
        authenticated: true,
        sourceBasis: 'login',
        sourceTag: MB_TAG,
        personId: 'alex',
        ownerId: 'alex',
        clientId: SHARED_GROK_CLIENT,
        grantId: 'mbgrant00000000000001'
      }, {
        decision: 'prepare',
        client: 'bound-login',
        claimed_tag: CLAIM_TAG,
        door: 'member',
        reason: 'BOUND needs her own door',
        correlation_id: 'a1b2c3d4e5f60718'
      });
      assert.strictEqual(prepared.status, 'validated');
      const base = `http://127.0.0.1:${server.address().port}`;
      const login = await fetch(`${base}/owner/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ passphrase: PASSPHRASE, next: '/owner/chooser' }).toString()
      });
      assert.strictEqual(login.status, 303, await login.text());
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const page = await fetch(`${base}/owner/chooser`, { headers: { cookie } });
      const html = await page.text();
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
      assert.ok(csrf, html.slice(0, 400));
      const issued = await fetch(`${base}/owner/chooser/writer`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({
          csrf: csrf[1],
          decision: 'approve',
          request_id: prepared.request_id
        }).toString()
      });
      const issuedHtml = await issued.text();
      assert.strictEqual(issued.status, 200, issuedHtml.slice(0, 500));
      assert.match(issuedHtml, /Listed grok-project as its own door\./);
      assert.ok(approvals.content, issuedHtml.slice(0, 500));
      const data = att.parseApprovals(approvals.content);
      const listed = data.approved[CLAIM_TAG];
      assert.ok(listed);
      assert.strictEqual(listed.basis, 'credential');
      assert.strictEqual(listed.door, 'member');
      assert.strictEqual(listed.client_id, 'bound-login');
      assert.strictEqual(listed.grant_id, null);
      assert.notStrictEqual(listed.grant_id, 'mbgrant00000000000001');
    } finally {
      chooserHold.server = null;
      await closeServer(server);
    }
  });
});

test('the BOUND HTTP listener is closed', async () => {
  await closeServer(httpHold.server);
  httpHold.server = null;
  await closeServer(chooserHold.server);
  chooserHold.server = null;
});

summary('BOUND door');
