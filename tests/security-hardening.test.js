/**
 * Proofs for the 10/7 security audit. Each test fails when its fix is reverted.
 * In-memory store only. No database and no secrets.
 */
process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
process.env.EMET_INVITES = '1';
process.env.EMET_MEMBER_ACCESS = '1';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';
import { resolveModulePath } from '../src/module-path.js';
import { makeStore, memDb, withStore, withEnv, layerDb, layerHonouringDb } from './memstore.js';

/** findOne returns a snapshot, as MongoDB does, so a check-then-update race is visible. */
function snapshotDb() {
  const cols = {};
  function match(row, q) {
    if (!q) return true;
    return Object.entries(q).every(([k, v]) => {
      const cur = row[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        if ('$exists' in v && ((cur !== undefined) !== Boolean(v.$exists))) return false;
        return true;
      }
      return cur === v;
    });
  }
  function collection() {
    const rows = [];
    const indexes = [];
    return {
      rows,
      async findOne(q) {
        await Promise.resolve();
        const row = rows.find((r) => match(r, q));
        return row ? { ...row } : null;
      },
      async insertOne(doc) {
        for (const idx of indexes) {
          if (!idx.unique) continue;
          const keys = Object.keys(idx.spec);
          const clash = rows.find((r) => keys.every((k) => doc[k] !== undefined && r[k] === doc[k]));
          if (clash) {
            const err = new Error('E11000 duplicate key');
            err.code = 11000;
            throw err;
          }
        }
        const stored = { _id: doc._id || (rows.length + 1), ...doc };
        rows.push(stored);
        return { insertedId: stored._id };
      },
      async updateOne(q, u) {
        await Promise.resolve();
        const row = rows.find((r) => match(r, q));
        if (!row) return { matchedCount: 0 };
        Object.assign(row, u.$set || {});
        return { matchedCount: 1 };
      },
      findOneAndUpdate(q, u) {
        const row = rows.find((r) => match(r, q));
        if (!row) return Promise.resolve(null);
        if (u && u.$set) Object.assign(row, u.$set);
        return Promise.resolve({ ...row });
      },
      async deleteOne() { return { deletedCount: 0 }; },
      async deleteMany() { return { deletedCount: 0 }; },
      async createIndex(spec, opts = {}) { indexes.push({ spec, unique: !!(opts && opts.unique) }); return 'ok'; }
    };
  }
  return { collection(name) { return (cols[name] ||= collection()); } };
}

const ROOT = resolveModulePath(import.meta.url, ['..']);
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

testGroup('module paths survive a Windows file URL', () => {
  test('a Windows absolute path stays on its drive instead of becoming C:\\C:\\', () => {
    const fileUrl = 'file:///C:/work/app/pkg/tests/suite.js';
    const opened = resolveModulePath(fileUrl, ['..', 'src', 'file.js'], {
      path: path.win32,
      toPath: (u) => fileURLToPath(u, { windows: true })
    });
    assert.equal(opened, 'C:\\work\\app\\pkg\\src\\file.js');
    // The pathname form is what the suite used to pass to path.resolve. Against
    // a C: working directory it joins a second drive onto the front.
    const pathname = new URL(fileUrl).pathname;
    const broken = path.win32.resolve('C:\\work', path.win32.dirname(pathname), '..', 'src', 'file.js');
    assert.equal(broken, 'C:\\C:\\work\\app\\pkg\\src\\file.js');
    assert.notEqual(opened, broken);
    assert.equal(path.resolve(ROOT, 'src', 'module-path.js').endsWith(`${path.sep}src${path.sep}module-path.js`), true);
    assert.ok(fs.existsSync(path.join(ROOT, 'src', 'module-path.js')));
  });
});
const ANSWERS = {
  assistant_name: 'Ada',
  assistant_character: 'Direct and brief.',
  user_name: 'Alex',
  user_context: 'A project store.'
};
const REASON = 'fixture reason for the edit';

console.log('\n=== security hardening ===');

testGroup('S1 file read and exchange size', () => {
  test('save_transcript has no file path and requires exchanges', async () => {
    const { TOOLS } = await import('../src/tools.js');
    const tool = TOOLS.find((t) => t.name === 'save_transcript');
    assert.ok(tool, 'save_transcript missing');
    assert.ok(!('jsonl_path' in tool.inputSchema.properties), 'jsonl_path is still a parameter');
    assert.ok(tool.inputSchema.required.includes('exchanges'));
    assert.match(tool.description, /does not read a file/i);
  });

  test('an exchange field over 32000 characters is refused', async () => {
    const { saveTranscript, EXCHANGE_FIELD_MAX } = await import('../src/tools.js');
    await assert.rejects(
      () => saveTranscript('s', 1, 2, [{ user_message: 'u'.repeat(EXCHANGE_FIELD_MAX + 1), assistant_message: 'a' }]),
      /exceeds 32000 characters/
    );
  });

  test('saveTranscript refuses an empty exchange list before any store call', async () => {
    const { saveTranscript } = await import('../src/tools.js');
    await assert.rejects(() => saveTranscript('s', 1, 2, []), /non-empty array/);
    await assert.rejects(() => saveTranscript('s', 1, 2, null), /non-empty array/);
  });
});

testGroup('S2 single use', () => {
  test('one invite code creates one person when redeemed twice at once', async () => {
    const { createInvite, redeemInvite } = await import('../src/invites.js');
    const db = snapshotDb();
    const minted = await createInvite(db, { display_name: 'Guest', created_by: 'owner' });
    const results = await Promise.all([redeemInvite(db, minted.code), redeemInvite(db, minted.code)]);
    const wins = results.filter((r) => r.ok);
    assert.strictEqual(wins.length, 1);
    assert.strictEqual(db.collection('persons').rows.length, 1);
    assert.deepStrictEqual(wins[0].scopes, ['emet.read']);
  });

  test('an authorization code is stored only as its digest and can be spent once', async () => {
    const { MongoOAuthProvider, tokenDigest } = await import('../src/oauth-provider.js');
    const db = snapshotDb();
    const provider = new MongoOAuthProvider(() => db, { passphrase: 'test-passphrase' });
    const client = { client_id: 'app' };
    const code = await provider.createAuthorizationCode({
      client_id: 'app', redirect_uri: 'http://127.0.0.1:9/cb', code_challenge: 'challenge', scopes: ['emet.read']
    });
    assert.strictEqual(await db.collection('emet_oauth_codes').findOne({ code }), null);
    const stored = await db.collection('emet_oauth_codes').findOne({ code: tokenDigest(code) });
    assert.ok(stored && stored.hashed === true);
    const spent = await Promise.allSettled([
      provider.exchangeAuthorizationCode(client, code, 'verifier', 'http://127.0.0.1:9/cb', null),
      provider.exchangeAuthorizationCode(client, code, 'verifier', 'http://127.0.0.1:9/cb', null)
    ]);
    assert.strictEqual(spent.filter((r) => r.status === 'fulfilled').length, 1);
  });

  test('a refresh inside the grace window returns the replacement already issued', async () => {
    const { MongoOAuthProvider, tokenDigest } = await import('../src/oauth-provider.js');
    const db = memDb();
    const provider = new MongoOAuthProvider(() => db, { passphrase: 'test-passphrase' });
    const refresh = 'r'.repeat(40);
    db.collection('emet_oauth_tokens').rows.push({
      _id: 'seed-refresh',
      token: tokenDigest(refresh),
      hashed: true,
      kind: 'refresh',
      client_id: 'app',
      scopes: ['emet'],
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
      family: 'fam-seed',
      source_tag: 'laptop'
    });
    const client = { client_id: 'app' };
    const first = await provider.exchangeRefreshToken(client, refresh, [], null);
    const second = await provider.exchangeRefreshToken(client, refresh, [], null);
    assert.strictEqual(second.refresh_token, first.refresh_token);
    assert.strictEqual(second.access_token, first.access_token);
    const rotated = db.collection('emet_oauth_tokens').rows.find((r) => r._id === 'seed-refresh');
    rotated.rotated_at = Math.floor(Date.now() / 1000) - 120;
    await assert.rejects(
      () => provider.exchangeRefreshToken(client, refresh, [], null),
      /already been replaced/
    );
    assert.strictEqual(
      db.collection('emet_oauth_tokens').rows.find((r) => r.token === tokenDigest(first.refresh_token)),
      undefined
    );
  });

  test('a refresh of a token with no source tag is refused and mints nothing', async () => {
    const { MongoOAuthProvider } = await import('../src/oauth-provider.js');
    const db = memDb();
    const provider = new MongoOAuthProvider(() => db, { passphrase: 'test-passphrase' });
    const issued = await provider._issueTokens('app', ['emet.write'], null);
    const before = db.collection('emet_oauth_tokens').rows.length;
    await assert.rejects(
      () => provider.exchangeRefreshToken({ client_id: 'app' }, issued.refresh_token, [], null),
      (e) => e.errorCode === 'invalid_grant' && /sign in again/i.test(e.message) && /source tag/i.test(e.message)
    );
    assert.strictEqual(db.collection('emet_oauth_tokens').rows.length, before);
    const expired = await provider._issueTokens('app', ['emet.write'], null, null, null, null, 'laptop');
    const row = db.collection('emet_oauth_tokens').rows.find((r) => r.kind === 'refresh' && r.source_tag === 'laptop');
    row.expiresAt = Math.floor(Date.now() / 1000) - 5;
    row.source_tag = null;
    await assert.rejects(
      () => provider.exchangeRefreshToken({ client_id: 'app' }, expired.refresh_token, [], null),
      /expired/
    );
  });
});

testGroup('S3 board guard', () => {
  test('an append does not open a board-editing session', async () => {
    const { recordStep } = await import('../src/session-graph.js');
    assert.strictEqual(recordStep('emet_transcript_append', { session_id: 's' }, { ok: true }), null);
    assert.strictEqual(recordStep('save_transcript', { session_id: 's' }, { ok: true }), null);
    assert.strictEqual(recordStep('emet_session_open', {}, { base: 'b' }).opened, true);
  });

  test('a board patch without a verified drops_seen array is refused', async () => {
    const { writeDoc, patchDoc } = await import('../src/tools.js');
    const { provisionBoardText } = await import('../src/setup.js');
    const db = makeStore();
    await withStore(db, async () => {
      await writeDoc('STATE.md', provisionBoardText(), 'project-host', null, null, { provision: true });
      db.collection('emet_sessions').docs.push({ _id: 'no-list', opened: true });
      const current = db.doc('STATE.md').content;
      await assert.rejects(
        () => patchDoc('STATE.md', 'Provisioned by the server.', 'Provisioned by the server.', 'project-host', null, null, { reason: REASON, session_id: 'no-list' }),
        /could not be loaded|verified drop/
      );
      assert.strictEqual(db.doc('STATE.md').content, current);
    });
  });

  test('a verified reopen clears drops_unverified even when open drops remain', async () => {
    const { writeDoc, patchDoc } = await import('../src/tools.js');
    const { graphAfter } = await import('../src/session-graph.js');
    const { provisionBoardText } = await import('../src/setup.js');
    const db = makeStore();
    await withStore(db, async () => {
      await writeDoc('STATE.md', provisionBoardText(), 'project-host', null, null, { provision: true });
      await writeDoc('drops/open.md', 'still open\n', 'project-host');
      const failed = { base: 'sess-drops', drops_seen: null, drops_unverified: true };
      await graphAfter('emet_session_open', {}, failed, db);
      const stuck = db.collection('emet_sessions').docs.find((d) => d._id === 'sess-drops');
      assert.strictEqual(stuck.drops_unverified, true);
      const before = db.doc('STATE.md').content;
      await assert.rejects(
        () => patchDoc('STATE.md', 'Provisioned by the server.', 'Provisioned by the server.', 'project-host', null, null, { reason: REASON, session_id: 'sess-drops' }),
        /could not be loaded/
      );
      const opened = { base: 'sess-drops', drops_seen: ['drops/open.md'] };
      await graphAfter('emet_session_open', {}, opened, db);
      const row = db.collection('emet_sessions').docs.find((d) => d._id === 'sess-drops');
      assert.strictEqual(row.drops_unverified, undefined);
      assert.ok(row.drops_seen.includes('drops/open.md'));
      await assert.rejects(
        () => patchDoc('STATE.md', 'Provisioned by the server.', 'Provisioned by the server. early', 'project-host', null, null, { reason: REASON, session_id: 'sess-drops' }),
        /must be retired/
      );
      db.doc('drops/open.md').retired = true;
      await patchDoc('STATE.md', 'Provisioned by the server.', 'Provisioned by the server. kept', 'project-host', null, null, { reason: REASON, session_id: 'sess-drops' });
      assert.match(db.doc('STATE.md').content, /kept/);
      assert.notStrictEqual(db.doc('STATE.md').content, before);
    });
  });

  test('a new session cannot cut a document below half its size in the last 24 hours', async () => {
    const { writeDoc, patchDoc } = await import('../src/tools.js');
    const db = makeStore();
    await withStore(db, async () => {
      await writeDoc('threads/peak.md', 'x'.repeat(100), 'project-host', null, null, { session_id: 'first' });
      await patchDoc('threads/peak.md', 'x'.repeat(100), 'x'.repeat(80), 'project-host', null, null, { reason: REASON, session_id: 'first' });
      await assert.rejects(
        () => patchDoc('threads/peak.md', 'x'.repeat(80), 'x'.repeat(45), 'project-host', null, null, { reason: REASON, session_id: 'second' }),
        /24 hours/
      );
      assert.strictEqual(db.doc('threads/peak.md').content.length, 80);
    });
  });
});

testGroup('S4 source tags and stamps', () => {
  test('an unregistered source refusal does not publish the registry', async () => {
    const { requireRegisteredSource } = await import('../src/dispatch.js');
    await withEnv({ EMET_SOURCE_TAGS: 'host-secret-tag,other-host' }, () => {
      assert.throws(
        () => requireRegisteredSource('not-a-host', 'save_transcript'),
        (e) => {
          const m = String(e.message);
          assert.ok(!m.includes('host-secret-tag') && !m.includes('other-host'), m);
          assert.match(m, /pass "source"/);
          return true;
        }
      );
    });
  });

  test('a cloud-scheduled prefix is not a registered tag', async () => {
    const { requireRegisteredSource } = await import('../src/dispatch.js');
    const { isRegisteredSource } = await import('../src/session.js');
    await withEnv({ EMET_SOURCE_TAGS: 'laptop' }, () => {
      assert.throws(() => requireRegisteredSource('cloud-scheduled-intake', 'emet_transcript_append'), /not registered/);
      assert.strictEqual(isRegisteredSource('cloud-scheduled-weekly', ['laptop']), false);
    });
  });

  test('HTTP authorizes the bound source, not the caller source', async () => {
    const { sourceOf } = await import('../src/dispatch.js');
    const { actorStore, writerStamp, LOCAL_SUBJECT } = await import('../src/persons.js');
    const bound = actorStore.run({ transport: 'http', sourceTag: 'bound-host' }, () => sourceOf({ source: 'attacker' }));
    assert.strictEqual(bound, 'bound-host');
    const missing = actorStore.run({ transport: 'http', sourceTag: '  ' }, () => sourceOf({ source: 'attacker' }));
    assert.strictEqual(missing, null);
    const local = writerStamp();
    assert.strictEqual(local.person_id, LOCAL_SUBJECT);
    assert.strictEqual(local.client_id, 'stdio');
  });

  test('a write-scoped HTTP login cannot stamp another host on a memory', async () => {
    const { saveMemory, reviseMemory } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const db = layerHonouringDb();
    const http = { transport: 'http', sourceTag: 'laptop', scopes: ['emet.write'], personId: 'alex', authenticated: true };
    await actorStore.run(http, () => saveMemory(db, 'a note for the record', 'episodic', { source: 'phone' }));
    assert.strictEqual(db.writes[0].doc.metadata.source, 'laptop');
    const cited = db.writes[0].id;
    await actorStore.run(http, () => saveMemory(db, 'a durable claim from this session', 'semantic', { source: 'phone', derived_from: { entries: [cited] } }));
    assert.strictEqual(db.writes[1].doc.metadata.source, 'laptop');
    await actorStore.run(http, () => reviseMemory(db, 'semantic', db.writes[1].id, 'a revised durable claim from this session', { source: 'phone' }));
    assert.strictEqual(db.writes[2].doc.metadata.source, 'laptop');
  });

  test('a token with no source tag uses a caller tag only when it is registered', async () => {
    const { sourceOf } = await import('../src/dispatch.js');
    const { saveMemory } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    await withEnv({ EMET_SOURCE_TAGS: 'laptop,phone' }, async () => {
      assert.strictEqual(actorStore.run({ transport: 'http', sourceTag: null }, () => sourceOf({ source: 'laptop' })), 'laptop');
      assert.strictEqual(actorStore.run({ transport: 'http', sourceTag: '' }, () => sourceOf({ source: 'other-host' })), null);
      assert.strictEqual(actorStore.run({ transport: 'http' }, () => sourceOf({ channel: 'cloud-scheduled-laptop' })), null);
      const db = layerDb();
      await actorStore.run({ transport: 'http', sourceTag: null, scopes: ['emet.write'], authenticated: true }, () => saveMemory(db, 'a note for the record', 'episodic', { source: 'phone' }));
      assert.strictEqual(db.writes[0].doc.metadata.source, 'phone');
      await actorStore.run({ transport: 'http', sourceTag: null, scopes: ['emet.write'], authenticated: true }, () => saveMemory(db, 'another note for the record', 'episodic', { source: 'other-host' }));
      assert.strictEqual(db.writes[1].doc.metadata.source, null);
    });
    assert.strictEqual(actorStore.run({ transport: 'http', sourceTag: null }, () => sourceOf({ source: 'attacker' })), null);
  });

  test('stdio stamps the fixed local subject and drops a caller client id', async () => {
    const { saveMemory } = await import('../src/tools.js');
    const db = layerDb();
    await saveMemory(db, 'a note for the record', 'episodic', {
      source: 'project-host',
      client_id: 'attacker',
      custom: { client_id: 'attacker', person_id: 'attacker', note: 'keep' }
    });
    const meta = db.writes[0].doc.metadata;
    assert.strictEqual(meta.person_id, 'local');
    assert.strictEqual(meta.client_id, 'stdio');
    assert.strictEqual(meta.custom.note, 'keep');
    assert.ok(!('client_id' in meta.custom) && !('person_id' in meta.custom));
  });

  test('the readme says HTTP writes use the tag bound at approval', () => {
    const readme = readSrc('README.md');
    assert.match(readme, /Over HTTP, document, transcript, and memory writes use the\s+tag bound at approval/);
    assert.ok(!/each host passes its own tag as `source` on its writes/.test(readme));
    assert.ok(!/the host passes it as `source` on its writes/.test(readme));
    assert.match(readme, /A local stdio host\s+still passes an exact registered tag/);
  });

  test('startup does not publish source_tags_registered', () => {
    for (const rel of ['src/setup.js', 'src/startup-pages.js', 'src/startup-payload.js', 'src/index.js']) {
      assert.ok(!readSrc(rel).includes('source_tags_registered'), rel);
    }
  });
});

testGroup('S5 roles and scopes', () => {
  test('invite tools are marked destructive', async () => {
    const { TOOL_ANNOTATIONS } = await import('../src/annotations.js');
    assert.strictEqual(TOOL_ANNOTATIONS.emet_invite_create.destructiveHint, true);
    assert.strictEqual(TOOL_ANNOTATIONS.emet_member_access_create.destructiveHint, true);
  });

  test('a guest invite accepts only emet.read', async () => {
    const { createInvite } = await import('../src/invites.js');
    await assert.rejects(
      () => createInvite(memDb(), { display_name: 'Guest', scopes: ['emet.write'] }),
      (e) => e.code === 'GUEST_SCOPE'
    );
  });

  test('the local stdio actor can create guest and member codes, and HTTP still requires an owner', async () => {
    const { inviteCreate, memberAccessCreate } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const db = memDb();
    const dbManager = { db, async getConnection() { return {}; } };
    const guest = await inviteCreate(dbManager, { display_name: 'Guest' });
    const member = await memberAccessCreate(dbManager, { display_name: 'Member' });
    assert.strictEqual(guest.door, 'guest');
    assert.strictEqual(member.door, 'member');
    assert.strictEqual(guest.created_by || db.collection('invites').rows[0].created_by, 'local');
    const stdioGuest = await actorStore.run({ transport: 'stdio' }, () => inviteCreate(dbManager, { display_name: 'Local guest' }));
    const stdioMember = await actorStore.run({ transport: 'stdio' }, () => memberAccessCreate(dbManager, { display_name: 'Local member' }));
    assert.ok(stdioGuest.code && stdioMember.code);
    db.collection('persons').rows.push({ person_id: 'ada', role: 'member' }, { person_id: 'alex', role: 'owner' });
    await actorStore.run({ transport: 'http', personId: 'ada', scopes: ['emet.write'], authenticated: true }, async () => {
      await assert.rejects(() => inviteCreate(dbManager, { display_name: 'Nope' }), /Only the owner can create invites/);
      await assert.rejects(() => memberAccessCreate(dbManager, { display_name: 'Nope' }), /Only the owner can create EMET Member Access/);
    });
    await actorStore.run({ transport: 'http', scopes: ['emet.write'], authenticated: true }, async () => {
      await assert.rejects(() => inviteCreate(dbManager, { display_name: 'Nope' }), /Only the owner can create invites/);
    });
    const httpGuest = await actorStore.run({ transport: 'http', personId: 'alex', scopes: ['emet'] }, () => inviteCreate(dbManager, { display_name: 'Owner guest' }));
    const httpMember = await actorStore.run({ transport: 'http', personId: 'alex', scopes: ['emet'] }, () => memberAccessCreate(dbManager, { display_name: 'Owner member' }));
    assert.strictEqual(httpGuest.door, 'guest');
    assert.strictEqual(httpMember.door, 'member');
  });

  test('a member code stores a registered source tag and redeem binds it', async () => {
    const { memberAccessCreate } = await import('../src/tools.js');
    const { redeemInvite } = await import('../src/invites.js');
    const { actorStore } = await import('../src/persons.js');
    await withEnv({ EMET_SOURCE_TAGS: 'laptop,phone' }, async () => {
      const db = memDb();
      const dbManager = { db, async getConnection() { return {}; } };
      db.collection('persons').rows.push({ person_id: 'alex', role: 'owner' });
      await actorStore.run({ transport: 'http', personId: 'alex' }, async () => {
        await assert.rejects(
          () => memberAccessCreate(dbManager, { display_name: 'Ada', source: 'other-host' }),
          /registered tag/
        );
      });
      const made = await actorStore.run({ transport: 'stdio' }, () => memberAccessCreate(dbManager, { display_name: 'Ada', source: 'laptop' }));
      assert.strictEqual(made.source_tag, 'laptop');
      const stored = db.collection('invites').rows.find((r) => r.door === 'member' && r.display_name === 'Ada');
      assert.strictEqual(stored.source_tag, 'laptop');
      const redeemed = await redeemInvite(db, made.code);
      assert.strictEqual(redeemed.ok, true);
      assert.strictEqual(redeemed.source_tag, 'laptop');
      assert.strictEqual(db.collection('invites').rows.filter((r) => r.display_name === 'Ada').length, 1);
    });
  });

  test('setup complete refuses a member and an HTTP caller with no person', async () => {
    const { setupComplete } = await import('../src/setup.js');
    const { actorStore } = await import('../src/persons.js');
    const db = makeStore();
    db.collection('persons').docs.push({ person_id: 'ada', role: 'member', display_name: 'Ada' });
    await withStore(db, async () => {
      await actorStore.run({ personId: 'ada', scopes: ['emet.write'] }, () => assert.rejects(
        () => setupComplete(ANSWERS),
        /requires the owner/
      ));
      await actorStore.run({ transport: 'http', scopes: ['emet'] }, () => assert.rejects(
        () => setupComplete(ANSWERS),
        /requires the owner/
      ));
    });
    assert.strictEqual(db.doc('bootstrap/IDENTITY.md'), undefined);
  });

  test('an empty authenticated HTTP scope list is denied', async () => {
    const { scopesAllow, scopeForTool } = await import('../src/scopes.js');
    assert.strictEqual(scopesAllow([], 'read_doc', { http: true, authenticated: true }), false);
    assert.strictEqual(scopesAllow([], 'read_doc'), true);
    assert.strictEqual(scopeForTool('emet_session_open'), 'emet.write');
    assert.strictEqual(scopeForTool('emet_status', { probe: true }), 'emet.write');
    assert.strictEqual(scopeForTool('emet_status'), 'emet.read');
  });

  test('the status probe deletes the document and does not drop the collection', async () => {
    const { DELETE_ALLOWED } = await import('../src/atlas-role.js');
    assert.deepStrictEqual([...DELETE_ALLOWED._emet_verify], ['REMOVE']);
    const src = readSrc('src/setup.js');
    assert.match(src, /probe\.deleteOne/);
    assert.ok(!src.includes('.drop('));
  });

  test('the consent page shows the scopes and sets frame and transport headers', async () => {
    const { MongoOAuthProvider } = await import('../src/oauth-provider.js');
    const provider = new MongoOAuthProvider(() => memDb(), { passphrase: 'test-passphrase' });
    const headers = {};
    let body = '';
    await provider.authorize(
      { client_id: 'app', client_name: 'Host' },
      { redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: 'challenge', scopes: ['emet.read'] },
      { setHeader(k, v) { headers[k] = v; }, end(html) { body = html; } }
    );
    assert.match(headers['Content-Security-Policy'], /default-src 'none'/);
    assert.strictEqual(headers['X-Frame-Options'], 'DENY');
    assert.match(headers['Strict-Transport-Security'], /max-age=31536000/);
    assert.match(body, /emet\.read/);
    assert.match(body, /name="source"/);
  });

  test('a governed write that names a session fails closed when the graph cannot be read', async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    const db = makeStore({ failRead: true });
    const r = await dispatchTool('patch_doc', { session_id: '2026-10-07_sec', doc_id: 'threads/x.md', source: 'test' }, { dbManager: db, logger: null });
    const text = JSON.stringify(r);
    assert.ok(r.isError && /session graph unavailable/.test(text) && /Nothing was written/.test(text), text.slice(0, 400));
  });
});

testGroup('S6 network and denial of service', () => {
  test('CIMD refuses blocked address ranges by parsed bits', async () => {
    const { isBlockedCimdAddress } = await import('../src/oauth-provider.js');
    const blocked = [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1',
      '169.254.169.254', '169.254.1.1', '100.64.0.1', '100.127.255.255',
      '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.255',
      '100.100.100.200', '168.63.129.16',
      '::1', '::', '0:0:0:0:0:0:0:1',
      'fe80::1', 'fe90::1', 'febf::1', 'FE90::1', 'fe80::1%eth0', '[fe80::1]',
      'fc00::1', 'fd00::1', 'fd00:ec2::254', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:a00:1', '::7f00:1',
      '64:ff9b::1', '64:ff9b::8.8.8.8'
    ];
    const allowed = [
      '1.1.1.1', '8.8.8.8', '100.128.0.1', '172.32.0.1', '172.15.255.255',
      '192.169.0.1', '223.255.255.255',
      'fec0::1', 'fe7f::1', 'fbff::1', '64:ff9b:1::1',
      '2001:4860:4860::8888', 'claude.ai'
    ];
    for (const ip of blocked) assert.strictEqual(isBlockedCimdAddress(ip), true, ip);
    for (const ip of allowed) assert.strictEqual(isBlockedCimdAddress(ip), false, ip);
  });

  test('a CIMD target that resolves to a private address is not fetched', async () => {
    const { MongoOAuthProvider } = await import('../src/oauth-provider.js');
    let fetched = false;
    const provider = new MongoOAuthProvider(() => memDb(), {
      cimd: true,
      lookup: async () => [{ address: '10.0.0.1', family: 4 }],
      fetch: async () => { fetched = true; return { ok: true, status: 200, text: async () => '{}' }; }
    });
    await assert.rejects(() => provider._fetchCimdDocument('https://evil.example/client.json'), /blocked address/);
    assert.strictEqual(fetched, false);
  });

  test('rate limits are per subject and client, and stdio is one bucket', async () => {
    const { RateLimiter, RATE_LIMIT_CONFIG, rateBucket } = await import('../src/tools.js');
    const lim = new RateLimiter();
    try {
      const cap = RATE_LIMIT_CONFIG.TOOL_MAX_REQUESTS.emet_status;
      for (let i = 0; i < cap; i++) lim.recordRequest('emet_status', 'ada|app');
      assert.strictEqual(lim.checkLimit('emet_status', 'ada|app').allowed, false);
      assert.strictEqual(lim.checkLimit('emet_status', 'bea|app').allowed, true);
      assert.strictEqual(rateBucket({ transport: 'stdio', personId: 'ada' }), 'stdio');
      assert.strictEqual(rateBucket({ transport: 'http', personId: 'ada', clientId: 'app' }), 'ada|app');
      assert.strictEqual(rateBucket(null), 'stdio');
    } finally {
      lim.stop();
    }
  });

  test('the HTTP body limit is 256kb and trust proxy is one hop', () => {
    const src = readSrc('src/http-remote.js');
    assert.match(src, /limit: '256kb'/);
    assert.match(src, /const TRUST_PROXY = 1/);
    assert.ok(!src.includes('process.env.TRUST_PROXY'));
    assert.ok(!/cors\s*\(/.test(src));
    const idx = readSrc('src/index.js');
    const actorAt = idx.indexOf('const actor = {');
    const limitAt = idx.indexOf('rateLimiter.checkLimit');
    assert.ok(actorAt > 0 && actorAt < limitAt);
  });
});

testGroup('S7 headers, debug, and the audit log', () => {
  test('HTTP error responses do not carry _debug', async () => {
    const { handleError } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const prev = process.env.DEBUG;
    process.env.DEBUG = 'true';
    try {
      const err = new Error('boom');
      const http = await actorStore.run({ transport: 'http', personId: 'ada' }, () => handleError(err, 'read_doc'));
      const stdio = await actorStore.run({ transport: 'stdio' }, () => handleError(err, 'read_doc'));
      const outside = handleError(err, 'read_doc');
      assert.ok(!JSON.stringify(http).includes('_debug'));
      assert.ok(JSON.stringify(stdio).includes('_debug'));
      assert.ok(JSON.stringify(outside).includes('_debug'));
      const httpSrc = readSrc('src/http-remote.js');
      const rateLine = httpSrc.slice(httpSrc.indexOf('if (!rl.allowed)')).split('\n')[0];
      assert.match(rateLine, /actorStore\.run\(actor, \(\) => t\.handleError/);
      const idx = readSrc('src/index.js');
      const idxRate = idx.slice(idx.indexOf('const rateLimitError')).split('\n').slice(0, 2).join('\n');
      assert.match(idxRate, /actorStore\.run\(actor, \(\) => handleError/);
    } finally {
      if (prev === undefined) delete process.env.DEBUG; else process.env.DEBUG = prev;
    }
  });

  test('the audit log redacts secrets before they are written', async () => {
    const { StructuredLogger, AuditOperation } = await import('../src/logger.js');
    const file = path.join(os.tmpdir(), `emet-audit-${process.pid}.log`);
    const logger = new StructuredLogger({ auditLogPath: file, auditBufferSize: 100, minLevel: 'debug', jsonOutput: true });
    try {
      logger.audit(AuditOperation.TOOL_CALL, { note: 'Bearer abcdefghijklmnop' });
      await logger.shutdown();
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes('abcdefghijklmnop'), text.slice(0, 300));
      assert.match(text, /\*\*\*\*\*/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

testGroup('CIMD pin and baseline headers', () => {
  const DOC_URL = 'https://public.example/client.json';
  const GOOD = { client_id: DOC_URL, redirect_uris: ['https://public.example/cb'] };

  function fakeHttps(status, body, seen) {
    return {
      request(opts, cb) {
        seen.opts = opts;
        const res = new EventEmitter();
        res.statusCode = status;
        const req = new EventEmitter();
        req.end = () => {
          cb(res);
          res.emit('data', Buffer.from(body));
          res.emit('end');
        };
        req.destroy = () => {};
        return req;
      }
    };
  }

  test('CIMD connects to the address already checked, not a later private answer', async () => {
    const { MongoOAuthProvider } = await import('../src/oauth-provider.js');
    let lookups = 0;
    const seen = {};
    const provider = new MongoOAuthProvider(() => memDb(), {
      cimd: true,
      lookup: async () => {
        lookups += 1;
        return lookups === 1
          ? [{ address: '203.0.113.9', family: 4 }]
          : [{ address: '169.254.169.254', family: 4 }];
      },
      https: fakeHttps(200, JSON.stringify(GOOD), seen)
    });
    const doc = await provider._fetchCimdDocument(DOC_URL);
    assert.strictEqual(doc.client_id, DOC_URL);
    assert.strictEqual(lookups, 1, 'the connection must not resolve the name again');
    assert.strictEqual(seen.opts.hostname, 'public.example');
    const pinned = await new Promise((resolve, reject) => {
      seen.opts.lookup('rebound.example', { all: true }, (err, list) => err ? reject(err) : resolve(list));
    });
    assert.deepStrictEqual(pinned, [{ address: '203.0.113.9', family: 4 }]);
  });

  test('a pinned connection checks the certificate, sends the original name, and refuses a redirect', async () => {
    const { pinnedHttpsGet, cimdPinnedLookup } = await import('../src/oauth-provider.js');
    // Throwaway self-signed pair for a local server. It is not a credential.
    const key = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIKnpR7+LXo6J2uX8qvmTHQNqfswipaNLDGXx6XadsWZBoAoGCCqGSM49
AwEHoUQDQgAE5TRDO5lQNef0Shyw4JYMR8FmTQEO86tmKx4sAYihPY2Jq9MvhcIV
1m2+aY345h+DHOSfP2mZL7aL0yHrbmfBDw==
-----END EC PRIVATE KEY-----`;
    const cert = `-----BEGIN CERTIFICATE-----
MIIBhzCCAS2gAwIBAgIUEpJFfxlD+Ep7zZSodfp8QrwkvAAwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOcHVibGljLmV4YW1wbGUwHhcNMjYxMDA3MjI0MTI3WhcNMzYx
MDA0MjI0MTI3WjAZMRcwFQYDVQQDDA5wdWJsaWMuZXhhbXBsZTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABOU0QzuZUDXn9EocsOCWDEfBZk0BDvOrZiseLAGIoT2N
iavTL4XCFdZtvmmN+OYfgxzknz9pmS+2i9Mh625nwQ+jUzBRMB0GA1UdDgQWBBSX
Tky2L/QpcuUfc+Eym9W5am4EBzAfBgNVHSMEGDAWgBSXTky2L/QpcuUfc+Eym9W5
am4EBzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIF8KKEfjkbSp
+5xE6+UppHunB/XE/TzROve8UPbeGSGjAiEA7KttrDgAgUy6hYjRj1+kFozO4iyw
r0NymkA+XrVhD/U=
-----END CERTIFICATE-----`;
    let servername = null;
    let hostHeader = null;
    const server = tls.createServer({ key, cert }, (sock) => {
      servername = sock.servername;
      let buf = '';
      sock.on('data', (c) => {
        buf += c;
        if (!buf.includes('\r\n\r\n')) return;
        const host = buf.match(/host: ([^\r]+)/i);
        hostHeader = host && host[1];
        if (buf.includes(' /redir')) {
          sock.end('HTTP/1.1 302 See Other\r\nLocation: https://evil.example/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          return;
        }
        const body = '{"ok":true}';
        sock.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const uncaught = [];
    const onUncaught = (err) => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
      const res = await pinnedHttpsGet(`https://public.example:${port}/client.json`, {
        redirect: 'error',
        headers: { Accept: 'application/json' },
        lookup: cimdPinnedLookup('127.0.0.1', 4),
        ca: cert
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(await res.text(), '{"ok":true}');
      assert.strictEqual(servername, 'public.example');
      assert.strictEqual(hostHeader, `public.example:${port}`);
      await assert.rejects(
        () => pinnedHttpsGet(`https://public.example:${port}/redir`, {
          redirect: 'error',
          lookup: cimdPinnedLookup('127.0.0.1', 4),
          ca: cert
        }),
        /redirect refused \(302\)/
      );
      await assert.rejects(
        () => pinnedHttpsGet('https://public.example/client.json', {
          redirect: 'error',
          lookup: cimdPinnedLookup('127.0.0.1', 4),
          signal: AbortSignal.abort()
        }),
        /CIMD fetch aborted/
      );
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await new Promise((resolve) => server.close(resolve));
    }
    assert.deepStrictEqual(uncaught, []);
  });

  test('an unreachable pinned IPv6 address rejects and does not crash', async () => {
    const { pinnedHttpsGet, cimdPinnedLookup } = await import('../src/oauth-provider.js');
    const uncaught = [];
    const onUncaught = (err) => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
      await assert.rejects(
        () => pinnedHttpsGet('https://public.example/client.json', {
          redirect: 'error',
          lookup: cimdPinnedLookup('2001:db8:ffff::1', 6)
        }),
        (err) => err && err.code === 'ENETUNREACH'
      );
      await new Promise((r) => setTimeout(r, 50));
      assert.deepStrictEqual(uncaught.map((e) => e && e.code), []);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });

  test('CIMD keeps redirect error and does not follow a 3xx', async () => {
    const { MongoOAuthProvider } = await import('../src/oauth-provider.js');
    const seen = {};
    const provider = new MongoOAuthProvider(() => memDb(), {
      cimd: true,
      lookup: async () => [{ address: '203.0.113.9', family: 4 }],
      fetch: async (_url, init) => {
        assert.strictEqual(init.redirect, 'error');
        const pinned = await new Promise((resolve, reject) => {
          init.lookup('rebound.example', {}, (err, address) => err ? reject(err) : resolve(address));
        });
        assert.strictEqual(pinned, '203.0.113.9');
        return { ok: false, status: 302, text: async () => '' };
      },
      https: fakeHttps(302, '', seen)
    });
    await assert.rejects(() => provider._fetchCimdDocument(DOC_URL), /HTTP 302/);
    const live = new MongoOAuthProvider(() => memDb(), {
      cimd: true,
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      https: fakeHttps(302, '', seen)
    });
    await assert.rejects(() => live._fetchCimdDocument(DOC_URL), /redirect refused \(302\)/);
    assert.strictEqual(seen.opts.lookup('ignored.example', { all: true }, () => {}), undefined);
  });

  test('every HTTP response carries nosniff, DENY, no-referrer, and HSTS, and the consent policy stays', async () => {
    const { securityHeaders } = await import('../src/security-headers.js');
    const app = express();
    app.use(securityHeaders);
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ issuer: 'https://emet.example' });
    });
    app.get('/consent', (_req, res) => {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<p>ok</p>');
    });
    app.post('/mcp', (_req, res) => res.json({ jsonrpc: '2.0', result: {} }));
    const server = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const port = server.address().port;
      const hit = async (method, path) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
        const headers = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        return { status: res.status, headers, text: await res.text() };
      };
      for (const [method, path] of [['GET', '/health'], ['GET', '/.well-known/oauth-authorization-server'], ['GET', '/consent'], ['POST', '/mcp']]) {
        const got = await hit(method, path);
        assert.strictEqual(got.headers['x-content-type-options'], 'nosniff', path);
        assert.strictEqual(got.headers['x-frame-options'], 'DENY', path);
        assert.strictEqual(got.headers['referrer-policy'], 'no-referrer', path);
        assert.match(got.headers['strict-transport-security'], /max-age=31536000/, path);
      }
      const consent = await hit('GET', '/consent');
      assert.match(consent.headers['content-security-policy'], /default-src 'none'/);
      assert.match(consent.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.match(consent.text, /<p>ok<\/p>/);
      const src = readSrc('src/http-remote.js');
      const useAt = src.indexOf('app.use(securityHeaders)');
      const healthAt = src.indexOf("app.get('/health'");
      assert.ok(useAt > 0 && useAt < healthAt);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

summary('Security hardening');
