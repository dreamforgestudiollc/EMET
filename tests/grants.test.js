/**
 * R2 door-grant contract. Locks what this rung ships and what it refuses to invent.
 * The grant id is the OAuth token family. Rotate-all is R5. Owl wiring stays.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { test, testGroup, summary } from './harness.js';
import { memDb, makeStore, withStore, layerDb } from './memstore.js';
import { actorStore, httpToolActor } from '../src/persons.js';
import {
  ROTATE_ALL, OWL_KILL, CLAUDE_CHATGPT_DOOR, OWNER_PAGE,
  DEEP_LINK, BREAK_GLASS, OWNER_APPROVALS_RETIRED,
  doorFromIssuedVia, grantIdFromFamily, grantView, logGrantId, logClientId, logDoor,
  toolCallAuditDetails
} from '../src/grants.js';
import { MongoOAuthProvider, OWNER_GRANT, INVITE_GRANT, MEMBER_GRANT, tokenDigest } from '../src/oauth-provider.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

testGroup('the grant id is the token family', () => {
  test('blank is not a grant, and a family is copied through unchanged', () => {
    assert.strictEqual(grantIdFromFamily(''), null);
    assert.strictEqual(grantIdFromFamily('  '), null);
    assert.strictEqual(grantIdFromFamily(null), null);
    assert.strictEqual(grantIdFromFamily('fam-1'), 'fam-1');
  });
  test('issued_via maps to a door, and a missing marker is not guessed', () => {
    assert.strictEqual(doorFromIssuedVia(OWNER_GRANT), 'owner');
    assert.strictEqual(doorFromIssuedVia(MEMBER_GRANT), 'member');
    assert.strictEqual(doorFromIssuedVia(INVITE_GRANT), 'guest');
    assert.strictEqual(doorFromIssuedVia(undefined), null);
    assert.strictEqual(doorFromIssuedVia('other'), null);
  });
  test('two consents on one client are two grants, and verify exposes that id and the door', async () => {
    const db = memDb();
    const provider = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example', fetch: async () => ({ ok: false, status: 404 }) });
    const client = { client_id: '8xm-shared' };
    const first = await provider._issueTokens(client.client_id, ['emet'], null, 'owner', OWNER_GRANT, null, 'host-a');
    const second = await provider._issueTokens(client.client_id, ['emet'], null, 'owner', OWNER_GRANT, null, 'host-a');
    const a = await provider.verifyAccessToken(first.access_token);
    const b = await provider.verifyAccessToken(second.access_token);
    assert.ok(a.extra.grantId && b.extra.grantId);
    assert.notStrictEqual(a.extra.grantId, b.extra.grantId);
    assert.strictEqual(a.extra.door, 'owner');
    const row = db.collection(`${provider.prefix}oauth_tokens`).rows.find((r) => r.token === tokenDigest(first.access_token));
    assert.strictEqual(grantView(row).grant_id, a.extra.grantId);
    assert.deepStrictEqual(Object.keys(grantView(row)).sort(), ['client_id', 'door', 'grant_id', 'source_tag']);
    assert.ok(!JSON.stringify(grantView(row)).includes(first.access_token));
    const refreshed = await provider.exchangeRefreshToken(client, first.refresh_token, undefined, null);
    const again = await provider.verifyAccessToken(refreshed.access_token);
    assert.strictEqual(again.extra.grantId, a.extra.grantId);
    assert.strictEqual(again.extra.door, 'owner');
  });
  test('a legacy token with no issued_via still verifies, with a null door', async () => {
    const db = memDb();
    const provider = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example', fetch: async () => ({ ok: false, status: 404 }) });
    const issued = await provider._issueTokens('c1', [], null, 'alex', null, 'fam-legacy', 'laptop');
    const v = await provider.verifyAccessToken(issued.access_token);
    assert.strictEqual(v.extra.grantId, 'fam-legacy');
    assert.strictEqual(v.extra.door, null);
  });
  test('an owner door is not frozen when invites are off', async () => {
    const db = memDb();
    const provider = new MongoOAuthProvider(() => db, {
      passphrase: 'p', issuerUrl: 'https://emet.example', fetch: async () => ({ ok: false, status: 404 }),
      invitesFrozen: () => true, memberAccessFrozen: () => true
    });
    const issued = await provider._issueTokens('c1', ['emet'], null, 'alex', OWNER_GRANT, 'fam-owner', 'laptop');
    const out = await provider.exchangeRefreshToken({ client_id: 'c1' }, issued.refresh_token, undefined, null);
    const v = await provider.verifyAccessToken(out.access_token);
    assert.strictEqual(v.extra.door, 'owner');
    assert.strictEqual(v.extra.grantId, 'fam-owner');
  });
});

testGroup('writes and refusals carry the grant, and a caller value does not', () => {
  test('a document row takes the HTTP grant from the actor', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const db = makeStore();
    await withStore(db, async () => {
      await actorStore.run({ transport: 'http', personId: 'owner', clientId: 'login-9', grantId: 'fam-1', door: 'owner' }, () =>
        writeDoc('threads/grant.md', '# Grant\n', 'host'));
      const row = db.doc('threads/grant.md');
      assert.strictEqual(row.grant_id, 'fam-1');
      assert.strictEqual(row.door, 'owner');
      assert.strictEqual(row.client_id, 'login-9');
    });
  });
  test('a caller grant id is not stored on a memory or a transcript exchange', async () => {
    const { saveMemory, transcriptAppend, stampExchange } = await import('../src/tools.js');
    const guest = {
      transport: 'http', personId: 'ada', clientId: 'login-guest',
      grantId: 'fam-g', door: 'guest', sourceTag: 'laptop', authenticated: true
    };
    const db = layerDb();
    await actorStore.run(guest, () => saveMemory(db, 'a guest note for the record', 'working', {
      grant_id: 'spoof',
      door: 'owner',
      custom: { grant_id: 'spoof', door: 'owner' }
    }));
    const meta = db.writes[0].doc.metadata;
    assert.strictEqual(meta.grant_id, 'fam-g');
    assert.strictEqual(meta.door, 'guest');
    assert.ok(!meta.custom || !('grant_id' in meta.custom));
    assert.ok(!meta.custom || !('door' in meta.custom));
    assert.match(read('src/tools.js'), /const row = stampExchange\(storedExchange\(/);

    const store = makeStore();
    await withStore(store, () => actorStore.run(guest, () => transcriptAppend({
      session_id: '2026-10-26_grant',
      user_message: 'hello from the guest',
      assistant_message: 'a reply that carries no machine line',
      channel: 'laptop'
    })));
    const ex = store.transcripts()[0].exchanges[0];
    assert.strictEqual(ex.grant_id, 'fam-g');
    assert.strictEqual(ex.door, 'guest');

    const forged = actorStore.run(guest, () => stampExchange({
      grant_id: 'spoof',
      door: 'owner',
      user_message: 'x',
      assistant_message: 'y'
    }, 'laptop'));
    assert.strictEqual(forged.grant_id, 'fam-g');
    assert.strictEqual(forged.door, 'guest');
  });
  test('stdio stamps a null grant', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const db = makeStore();
    await withStore(db, async () => {
      await writeDoc('threads/local.md', '# Local\n', 'host');
      assert.strictEqual(db.doc('threads/local.md').grant_id, null);
      assert.strictEqual(db.doc('threads/local.md').door, 'stdio');
    });
  });
  test('a refusal log keeps client and grant ids and drops a bearer-shaped grant', async () => {
    const { useMemoryErrorLog, recordError, flushErrorLog } = await import('../src/error-log.js');
    const store = useMemoryErrorLog();
    const bearer = 'emet_tok_' + 'a'.repeat(40);
    await actorStore.run({
      transport: 'http', personId: 'ada', clientId: 'https://claude.ai/oauth/mcp', grantId: 'fam-guest', door: 'guest', sourceTag: 'unregistered-tag'
    }, () => recordError({ emet_code: 'EMET-DOC-025', class_code: 'VALIDATION_ERROR', tool: 'write_doc', correlation_id: '0123456789abcdef' }));
    await actorStore.run({
      transport: 'http', personId: 'ada', clientId: 'login 9', grantId: bearer, door: 'nope'
    }, () => recordError({ emet_code: 'EMET-DOC-025', class_code: 'VALIDATION_ERROR', tool: 'write_doc', correlation_id: 'fedcba9876543210' }));
    await flushErrorLog();
    const kept = store.entries.find((row) => row.correlation_id === '0123456789abcdef');
    const dropped = store.entries.find((row) => row.correlation_id === 'fedcba9876543210');
    assert.strictEqual(kept.client_id, 'https://claude.ai/oauth/mcp');
    assert.strictEqual(kept.grant_id, 'fam-guest');
    assert.strictEqual(kept.door, 'guest');
    assert.strictEqual(dropped.client_id, 'unknown');
    assert.strictEqual(dropped.grant_id, 'none');
    assert.strictEqual(dropped.door, 'unknown');
    assert.ok(!JSON.stringify(store.entries).includes(bearer));
    assert.strictEqual(logGrantId(bearer), 'none');
    assert.strictEqual(logClientId('stdio'), 'stdio');
    assert.strictEqual(logDoor(null), 'unknown');
  });
  test('a passphrase token reaches initialize attribution and the stored row', async () => {
    const { saveMemory } = await import('../src/tools.js');
    const { callerAttribution } = await import('../src/setup.js');
    const db = memDb();
    const provider = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example', fetch: async () => ({ ok: false, status: 404 }) });
    const issued = await provider._issueTokens('login-owner', ['emet'], null, 'alex', OWNER_GRANT, null, 'laptop');
    const verified = await provider.verifyAccessToken(issued.access_token);
    const remote = read('src/http-remote.js');
    const start = remote.indexOf('setRequestHandler(CallToolRequestSchema');
    const handler = remote.slice(start, remote.indexOf('async function callTool', start));
    assert.match(handler, /httpToolActor\(extra\)/);
    assert.doesNotMatch(handler, /grantId:/);
    assert.doesNotMatch(handler, /door:/);
    const actor = httpToolActor({ authInfo: verified });
    assert.strictEqual(actor.grantId, verified.extra.grantId);
    assert.strictEqual(actor.door, 'owner');
    assert.ok(verified.extra.grantId && verified.extra.grantId !== 'spoof');
    const layers = layerDb();
    await actorStore.run(actor, async () => {
      const attr = callerAttribution();
      assert.strictEqual(attr.grant_id, verified.extra.grantId);
      assert.strictEqual(attr.door, 'owner');
      await saveMemory(layers, 'a note under this passphrase grant', 'working', { grant_id: 'spoof', door: 'guest' });
    });
    assert.strictEqual(layers.writes[0].doc.metadata.grant_id, verified.extra.grantId);
    assert.strictEqual(layers.writes[0].doc.metadata.door, 'owner');
  });
  test('tool-call audit and the error report keep the grant and the door', async () => {
    const { useMemoryErrorLog, recordError, flushErrorLog } = await import('../src/error-log.js');
    const { runErrorReport } = await import('../src/error-report.js');
    const bearer = 'emet_tok_' + 'a'.repeat(40);
    const calls = [];
    const logger = { audit(op, details) { calls.push({ op, details }); } };
    const httpActor = httpToolActor({
      authInfo: {
        clientId: 'https://claude.ai/oauth/mcp',
        scopes: ['emet'],
        extra: { subject: 'ada', sourceTag: null, grantId: bearer, door: 'guest' }
      }
    });
    logger.audit('TOOL_CALL', toolCallAuditDetails(httpActor, { tool: 'write_doc', success: true, durationMs: 4, params: ['doc_id'] }));
    const stdioActor = { personId: null, clientId: 'stdio', scopes: [], transport: 'stdio', authenticated: false };
    logger.audit('TOOL_CALL', toolCallAuditDetails(stdioActor, { tool: 'write_doc', success: false, durationMs: 2, params: [] }));
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].details.client_id, 'https://claude.ai/oauth/mcp');
    assert.strictEqual(calls[0].details.grant_id, 'none');
    assert.strictEqual(calls[0].details.door, 'guest');
    assert.ok(!JSON.stringify(calls[0].details).includes(bearer));
    assert.strictEqual(calls[1].details.client_id, 'stdio');
    assert.strictEqual(calls[1].details.grant_id, 'none');
    assert.strictEqual(calls[1].details.door, 'stdio');
    for (const file of ['src/index.js', 'src/http-remote.js']) {
      const src = read(file);
      const start = src.indexOf('setRequestHandler(CallToolRequestSchema');
      const handler = src.slice(start, src.indexOf('async function callTool', start));
      assert.match(handler, /toolCallAuditDetails\(actor/);
      assert.match(read('src/grants.js'), /\.\.\.auditIdentity\(actor\)/);
    }

    const store = useMemoryErrorLog();
    await actorStore.run({
      transport: 'http', personId: 'ada', clientId: 'login-9', grantId: 'fam-guest', door: 'member'
    }, () => recordError({ emet_code: 'EMET-DOC-025', class_code: 'VALIDATION_ERROR', tool: 'write_doc', correlation_id: 'abcdefabcdefabcd' }));
    await flushErrorLog();
    const report = await actorStore.run({ transport: 'stdio' }, () => runErrorReport({}));
    const recent = report.report.split('Most recent')[1];
    assert.ok(recent);
    assert.match(recent, /fam-guest\s+member\s+none\s+abcdefabcdefabcd/);
    assert.strictEqual(store.entries.find((row) => row.correlation_id === 'abcdefabcdefabcd').grant_id, 'fam-guest');
  });
});

testGroup('later rungs stay where this cut left them', () => {
  test('rotate-all has no grace window and is owner-only', () => {
    assert.strictEqual(ROTATE_ALL.implemented, true);
    assert.strictEqual(ROTATE_ALL.grace_window_seconds, null);
    assert.strictEqual(ROTATE_ALL.rung, 'R5');
    assert.strictEqual(ROTATE_ALL.confirm, 'rotate-all');
    const oauth = read('src/oauth-provider.js');
    assert.ok(oauth.includes('credentialBlocked'));
    assert.ok(!oauth.includes('ROTATE_ALL'));
    assert.ok(!oauth.includes('grace_window_seconds'));
    assert.ok(oauth.includes('REFRESH_ROTATION_GRACE_S = 60'));
  });
  test('Claude/ChatGPT door is unset', () => {
    assert.strictEqual(CLAUDE_CHATGPT_DOOR.decided, false);
    assert.strictEqual(CLAUDE_CHATGPT_DOOR.door, null);
  });
  test('R4 names the chooser and keeps the retired approvals path', () => {
    assert.strictEqual(DEEP_LINK.rung, 'R4');
    assert.strictEqual(DEEP_LINK.ttl_ms, 15 * 60 * 1000);
    assert.strictEqual(DEEP_LINK.grants_access, false);
    assert.strictEqual(BREAK_GLASS.path, '/owner/break-glass');
    assert.strictEqual(BREAK_GLASS.reachable_by_member_or_guest_grant, false);
    assert.strictEqual(OWNER_APPROVALS_RETIRED.status, 'retired');
    assert.strictEqual(OWNER_APPROVALS_RETIRED.deleted, false);
    assert.strictEqual(OWNER_APPROVALS_RETIRED.superseded_by, '/owner/chooser');
    assert.strictEqual(OWNER_PAGE.decision_path, '/owner/chooser');
  });
  test('the owner page is not a grant, and its wiring is still mounted', () => {
    assert.strictEqual(OWNER_PAGE.is_grant, false);
    assert.strictEqual(OWNER_PAGE.grant_id, null);
    assert.match(read('src/owner-approvals.js'), /export function mountOwnerApprovals/);
    assert.strictEqual(OWL_KILL.implemented, true);
    assert.strictEqual(OWL_KILL.delete_wiring, false);
    assert.strictEqual(OWL_KILL.rung, 'R6');
    assert.strictEqual(OWL_KILL.status, 'retired');
    assert.strictEqual(OWL_KILL.deleted, false);
  });
  test('tag memory is still keyed by client_id (K2 is scheduled, not done)', async () => {
    const { rememberedFor } = await import('../src/attribution.js');
    const d = { approved: { 'tag-a': { client_id: 'shared' }, 'tag-b': { client_id: 'shared' } }, clients: {}, pending: {}, denied: {} };
    assert.deepStrictEqual(rememberedFor(d, 'shared').sort(), ['tag-a', 'tag-b']);
    assert.strictEqual(rememberedFor.length, 2);
  });
});

testGroup('the grant template is draft and unmapped', () => {
  test('templates/GRANT.md ships as DRAFT under the shipped-copy lock', async () => {
    const { loadShipped, clearShippedCache, isGovernedByShippedCopy, templateFor, STATUS } = await import('../src/conformance.js');
    clearShippedCache();
    const t = loadShipped('templates/GRANT.md', { cache: false });
    assert.strictEqual(t.template_id, 'templates/GRANT.md');
    assert.strictEqual(t.status, STATUS.DRAFT);
    assert.ok(t.required_sections.length >= 5);
    assert.strictEqual(isGovernedByShippedCopy('templates/GRANT.md'), true);
    assert.strictEqual(templateFor('grants/example.md'), null);
  });
});

summary('GRANT DOORS TEST SUMMARY');
