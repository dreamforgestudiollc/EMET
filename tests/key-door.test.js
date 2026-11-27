/**
 * Key sign-in. A bot, a member, or a guest presents its sub-key and source
 * tag. A secondary owner also presents the connect passphrase. The primary
 * owner presents the passphrase alone.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';

process.env.EMET_HTTP_LISTEN = '0';
process.env.EMET_OAUTH_PASSPHRASE = 'owner-secret-value';
process.env.EMET_REQUEST_LOG = '0';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const SECRET = 'owner-secret-value';
const REDIRECT = 'https://example.com/cb';
const PEPPER = 'pepper-pepper-pepper-pepper-pepper-32b';
const TAGS = 'grok-project,hub-bot,note-bot';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = {
  EMET_SUBKEYS: '1',
  EMET_SUBKEY_PEPPER: PEPPER,
  EMET_SOURCE_TAGS: TAGS,
  EMET_SOURCE_TAG: undefined,
  EMET_SUBKEY_PEPPER_VERSION: undefined,
  EMET_SUBKEY_PEPPER_PREV: undefined
};

console.log('\n=== key sign-in ===');

const { makeStore, withStore, withEnv } = await import('./memstore.js');
const { MongoOAuthProvider } = await import('../src/oauth-provider.js');
const { actorStore, httpToolActor } = await import('../src/persons.js');
const { createMemoryStore } = await import('../src/subkey-store.js');
const { approvalsDeps } = await import('../src/tools.js');
const { ISSUED_VIA } = await import('../src/grants.js');

const remote = await import('../src/http-remote.js');
const server = await new Promise((resolve) => {
  const listening = remote.app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;

function clientRow(clientId) {
  return { client_id: clientId, client_name: 'Host', redirect_uris: [REDIRECT] };
}

const ownerActor = () => ({
  personId: 'owner', ownerId: 'owner', clientId: 'owner-host', transport: 'http',
  authenticated: true, sourceTag: 'grok-project', sourceBasis: 'login', door: 'owner', scopes: ['emet']
});

async function issueMole(deps) {
  const { requestSubkey, decideSubkeyIfPending, claimSubkey } = await import('../src/subkeys.js');
  const bot = {
    personId: 'owner', ownerId: 'owner', clientId: 'note-client', transport: 'http',
    authenticated: true, sourceTag: 'hub-bot', sourceBasis: 'login', door: 'owner', scopes: ['emet']
  };
  const now = new Date('2026-11-23T12:00:00.000Z');
  const registry = TAGS.split(',');
  const req = await requestSubkey(deps, bot, { tag: 'note-bot' }, registry, now);
  await decideSubkeyIfPending(deps, ownerActor(), 'owner', { tag: 'note-bot', decision: 'approve' }, now);
  const claimed = await claimSubkey(deps, bot, { key_id: req.key_id, nonce: req.nonce }, now);
  return { claimed, deps, now };
}

async function postApprove(db, fields) {
  remote.dbManager.db = db;
  await db.collection('emet_oauth_clients').insertOne(clientRow(fields.client_id));
  const body = {
    client_id: fields.client_id,
    redirect_uri: REDIRECT,
    code_challenge: 'challenge'
  };
  if (fields.passphrase !== undefined) body.passphrase = fields.passphrase;
  if (fields.subkey) body.subkey = fields.subkey;
  if (fields.source) body.source = fields.source;
  return withStore(db, async () => {
    const res = await fetch(`${base}/oauth/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString()
    });
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  });
}

function codeFrom(location) {
  const url = new URL(location);
  return url.searchParams.get('code');
}

async function loginFrom(db, clientId, location) {
  const provider = new MongoOAuthProvider(() => db, { passphrase: SECRET });
  const issued = await provider.exchangeAuthorizationCode(
    { client_id: clientId }, codeFrom(location), null, REDIRECT, null
  );
  const verified = await provider.verifyAccessToken(issued.access_token);
  return { provider, issued, actor: httpToolActor({ authInfo: verified }) };
}

testGroup('the door table', () => {
    test('fourteen rows, and a key session is never the owner', async () => {
      const mod = await import('../src/key-door-statechart.js');
      const rows = mod.keyDoorRows();
      assert.equal(rows.length, 14);
      const key = rows.find((row) => row.signIn === 'key_only' && row.key === 'active');
      assert.equal(key.role, 'key');
      assert.equal(key.ownerRights, false);
      assert.equal(key.attribution, 'key_tag');
      assert.equal(key.granted, true);
      const secondary = rows.find((row) => row.signIn === 'owner_key' && row.key === 'active');
      assert.equal(secondary.role, 'secondary');
      assert.equal(secondary.ownerRights, false);
      assert.equal(secondary.attribution, 'key_tag');
      const primary = rows.find((row) => row.signIn === 'passphrase');
      assert.equal(primary.role, 'primary');
      assert.equal(primary.ownerRights, true);
      assert.equal(primary.attribution, 'owner_login');
      assert.equal(primary.key, 'none');
      for (const keyState of ['revoked', 'expired', 'unregistered', 'mismatch', 'none']) {
        for (const signIn of ['key_only', 'owner_key']) {
          const row = rows.find((item) => item.signIn === signIn && item.key === keyState);
          assert.equal(row.granted, false, `${signIn} ${keyState}`);
          assert.equal(row.ownerRights, false);
        }
      }
      assert.equal(mod.classifyKeySignIn({ passphrase: SECRET, subkey: '' }), 'passphrase');
      assert.equal(mod.classifyKeySignIn({ passphrase: SECRET, subkey: 'emk_x' }), 'owner_key');
      assert.equal(mod.classifyKeySignIn({ passphrase: '', subkey: 'emk_x' }), 'key_only');
      assert.equal(mod.keyDoorOutcome({ signIn: 'passphrase', key: 'active' }).role, 'primary');
      const live = { phase: 'live', granted: true, key: 'active', role: 'key', consents: 1, wrote: false, last: 'grant', ownerRights: false };
      const wrote = mod.keyConsentStep(live, 'write');
      assert.equal(wrote.last, 'write');
      assert.equal(wrote.phase, 'live');
      const revoked = mod.keyConsentStep(wrote, 'revoke');
      assert.equal(revoked.phase, 'closed');
      assert.equal(revoked.consents, 0);
      assert.equal(revoked.key, 'revoked');
      const after = mod.keyConsentStep(revoked, 'write');
      assert.equal(after.last, 'refused');
      const replaced = mod.keyConsentStep(live, 'replace');
      assert.equal(replaced.consents, 1);
      assert.equal(replaced.phase, 'live');
      const expired = mod.keyConsentStep(live, 'expire');
      assert.equal(mod.keyConsentStep(expired, 'write').last, 'refused');
      const doc = fs.readFileSync(path.join(ROOT, 'docs', 'key-door-statechart.md'), 'utf8');
      const fenced = /```mermaid\n([\s\S]*?)\n```/.exec(doc);
      assert.equal(fenced[1], mod.KEY_DOOR_MERMAID);
      const { statechartBody } = await import('../src/access-statechart.js');
      const html = statechartBody();
      assert.match(html, /Key sign-in/);
      assert.match(html, /KeyOnly/);
      assert.match(html, /OwnerAndKey/);
    });
  });

  testGroup('the connect page', () => {
    test('the owner page stays the passphrase, and door=key asks for the key and the tag', async () => {
      const provider = new MongoOAuthProvider(() => makeStore(), { passphrase: SECRET });
      let owner = '';
      await provider.authorize(
        { client_id: 'app', client_name: 'Host' },
        { redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: 'challenge', scopes: ['emet.read'] },
        { setHeader() {}, end(html) { owner = html; }, req: { query: {}, originalUrl: '/authorize?client_id=app&code_challenge=challenge' } }
      );
      assert.match(owner, /name="passphrase"/);
      assert.match(owner, /name="source"/);
      assert.equal(/name="subkey"/.test(owner), false);
      assert.match(owner, /door=key/);
      let key = '';
      await provider.authorize(
        { client_id: 'app', client_name: 'Host' },
        { redirectUri: 'https://example.com/cb', codeChallenge: 'challenge', scopes: ['emet.read'] },
        { setHeader() {}, end(html) { key = html; }, req: { query: { door: 'key' }, originalUrl: '/authorize?client_id=app&door=key&code_challenge=challenge' } }
      );
      assert.match(key, /name="subkey"/);
      assert.match(key, /name="source"/);
      assert.match(key, /name="passphrase"/);
      assert.match(key, /secondary owner/);
    });
  });

  testGroup('a registered key', () => {
    test('a key-only bot writes as its tag and cannot call an owner tool', async () => {
      const db = makeStore();
      const memory = createMemoryStore();
      approvalsDeps.subkeys = memory;
      try {
        await withEnv(ENV, async () => {
          const { claimed } = await issueMole({ subkeys: memory, readDoc: approvalsDeps.readDoc, writeDoc: approvalsDeps.writeDoc });
          const posted = await postApprove(db, {
            client_id: 'note-key', subkey: claimed.subkey, source: 'note-bot'
          });
          assert.equal(posted.status, 302, posted.text.slice(0, 400));
          const row = (await db.collection('emet_oauth_codes').find({}).toArray())[0];
          assert.equal(row.source_tag, 'note-bot');
          assert.equal(row.issued_via, ISSUED_VIA.key);
          assert.equal(row.subject, 'key:note-bot');
          assert.deepEqual(row.scopes, ['emet.read', 'emet.write']);
          const { provider, issued, actor } = await loginFrom(db, 'note-key', posted.location);
          assert.equal(actor.door, 'key');
          assert.equal(actor.sourceTag, 'note-bot');
          assert.equal(actor.personId, 'key:note-bot');
          const { actorIsOwner, clientApprove, preflight } = await import('../src/attribution.js');
          assert.equal(actorIsOwner(actor, 'owner'), false);
          await assert.rejects(
            () => preflight({ db, prefix: 'emet_', ownerId: 'owner', deps: { subkeys: memory }, registry: TAGS.split(',') }, actor, { source: 'third-bot' }, 'write_doc'),
            /may not write as "third-bot"/
          );
          await withStore(db, () => actorStore.run(actor, async () => {
            const { writeDoc, patchDoc } = await import('../src/tools.js');
            const { sourceOf } = await import('../src/dispatch.js');
            assert.equal(sourceOf({ source: 'third-bot' }), 'note-bot');
            await writeDoc('notes/note-key.md', 'The bot wrote this.\n', sourceOf({}), null, null, {});
            const stored = db.collection('documents').docs.find((doc) => doc.doc_id === 'notes/note-key.md');
            assert.equal(stored.updated_by, 'note-bot');
            await patchDoc('notes/note-key.md', 'The bot wrote this.', 'The bot patched this.', sourceOf({}), null, null, { reason: 'stamp the key tag on the edit' });
            const patched = db.collection('documents').docs.find((doc) => doc.doc_id === 'notes/note-key.md');
            assert.equal(patched.updated_by, 'note-bot');
            assert.equal(patched.version, 2);
          }));
          await assert.rejects(
            () => clientApprove({ readDoc: approvalsDeps.readDoc, writeDoc: approvalsDeps.writeDoc }, actor, 'owner', { tag: 'grok-project', decision: 'approve' }),
            /only the owner/,
            'clientApprove'
          );
          const { revokeSubkey } = await import('../src/subkeys.js');
          await assert.rejects(
            () => revokeSubkey({ subkeys: memory }, actor, 'owner', { tag: 'note-bot' }),
            /owner/,
            'revokeSubkey'
          );
          const refreshed = await provider.exchangeRefreshToken({ client_id: 'note-key' }, issued.refresh_token, ['emet.read'], null);
          const again = await provider.verifyAccessToken(refreshed.access_token);
          assert.equal(again.extra.door, 'key');
          assert.equal(again.extra.sourceTag, 'note-bot');
          assert.equal(again.extra.subject, 'key:note-bot');
          assert.equal(actorIsOwner(httpToolActor({ authInfo: again }), 'owner'), false);
        });
      } finally {
        delete approvalsDeps.subkeys;
      }
    });

    test('a revoked, expired, unregistered, or mismatched key is refused and names the tag', async () => {
      const memory = createMemoryStore();
      approvalsDeps.subkeys = memory;
      try {
        await withEnv(ENV, async () => {
          const { claimed } = await issueMole({ subkeys: memory, readDoc: approvalsDeps.readDoc, writeDoc: approvalsDeps.writeDoc });
          const mismatch = makeStore();
          const mismatched = await postApprove(mismatch, {
            client_id: 'note-mismatch', subkey: claimed.subkey, source: 'third-bot'
          });
          assert.equal(mismatched.status, 401, mismatched.text);
          assert.match(mismatched.text, /third-bot/);
          assert.match(mismatched.text, /note-bot/);
          assert.equal((await mismatch.collection('emet_oauth_codes').find({}).toArray()).length, 0);

          const { revokeSubkey } = await import('../src/subkeys.js');
          await revokeSubkey({ subkeys: memory }, ownerActor(), 'owner', { tag: 'note-bot', reason: 'test' });
          const revokedDb = makeStore();
          const revoked = await postApprove(revokedDb, {
            client_id: 'note-revoked', subkey: claimed.subkey, source: 'note-bot'
          });
          assert.equal(revoked.status, 401, revoked.text);
          assert.match(revoked.text, /note-bot/);
          assert.match(revoked.text, /revoked/);
          assert.equal((await revokedDb.collection('emet_oauth_codes').find({}).toArray()).length, 0);
        });

        const expiredMemory = createMemoryStore();
        approvalsDeps.subkeys = expiredMemory;
        await withEnv(ENV, async () => {
          const { claimed } = await issueMole({ subkeys: expiredMemory, readDoc: approvalsDeps.readDoc, writeDoc: approvalsDeps.writeDoc });
          await expiredMemory.mutate((data) => {
            const row = Object.values(data.keys).find((item) => item && item.tag === 'note-bot' && item.status === 'active');
            row.expires_at = '2020-01-01T00:00:00.000Z';
            return true;
          });
          const expiredDb = makeStore();
          const expired = await postApprove(expiredDb, {
            client_id: 'note-expired', subkey: claimed.subkey, source: 'note-bot'
          });
          assert.equal(expired.status, 401, expired.text);
          assert.match(expired.text, /note-bot/);
          assert.match(expired.text, /expired/);
        });

        const quiet = createMemoryStore();
        approvalsDeps.subkeys = quiet;
        await withEnv({ ...ENV, EMET_SOURCE_TAGS: 'grok-project' }, async () => {
          const issued = await withEnv(ENV, () => issueMole({ subkeys: quiet, readDoc: approvalsDeps.readDoc, writeDoc: approvalsDeps.writeDoc }));
          const db = makeStore();
          const posted = await postApprove(db, {
            client_id: 'note-unregistered', subkey: issued.claimed.subkey, source: 'note-bot'
          });
          assert.equal(posted.status, 401, posted.text);
          assert.match(posted.text, /note-bot/);
          assert.match(posted.text, /not registered/);
          assert.equal((await db.collection('emet_oauth_codes').find({}).toArray()).length, 0);
        });
      } finally {
        delete approvalsDeps.subkeys;
      }
    });

    test('a passphrase plus the key writes as that tag only', async () => {
      const db = makeStore();
      const memory = createMemoryStore();
      approvalsDeps.subkeys = memory;
      try {
        await withEnv(ENV, async () => {
          const { claimed } = await issueMole({ subkeys: memory, readDoc: approvalsDeps.readDoc, writeDoc: approvalsDeps.writeDoc });
          const posted = await postApprove(db, {
            client_id: 'note-secondary', subkey: claimed.subkey, source: 'note-bot', passphrase: SECRET
          });
          assert.equal(posted.status, 302, posted.text.slice(0, 400));
          const row = (await db.collection('emet_oauth_codes').find({}).toArray())[0];
          assert.equal(row.source_tag, 'note-bot');
          assert.equal(row.issued_via, ISSUED_VIA.secondary);
          assert.equal(row.subject, 'key:note-bot');
          const { actor } = await loginFrom(db, 'note-secondary', posted.location);
          assert.equal(actor.door, 'secondary');
          const { actorIsOwner, preflight } = await import('../src/attribution.js');
          assert.equal(actorIsOwner(actor, 'owner'), false);
          await assert.rejects(
            () => preflight({ db, prefix: 'emet_', ownerId: 'owner', deps: { subkeys: memory }, registry: TAGS.split(',') }, actor, { source: 'grok-project' }, 'write_doc'),
            /may not write as "grok-project"/
          );
          await withStore(db, () => actorStore.run(actor, async () => {
            const { writeDoc } = await import('../src/tools.js');
            const { sourceOf } = await import('../src/dispatch.js');
            await writeDoc('notes/secondary.md', 'Secondary owner note.\n', sourceOf({ source: 'grok-project' }), null, null, {});
            const stored = db.collection('documents').docs.find((doc) => doc.doc_id === 'notes/secondary.md');
            assert.equal(stored.updated_by, 'note-bot');
          }));
          const wrongDb = makeStore();
          const wrong = await postApprove(wrongDb, {
            client_id: 'note-bad-pass', subkey: claimed.subkey, source: 'note-bot', passphrase: 'not-the-passphrase'
          });
          assert.equal(wrong.status, 401, wrong.text);
          assert.match(wrong.text, /passphrase does not match/);
          assert.equal(wrong.text.includes(claimed.subkey), false);
          assert.equal((await wrongDb.collection('emet_oauth_codes').find({}).toArray()).length, 0);
        });
      } finally {
        delete approvalsDeps.subkeys;
      }
    });
  });

  testGroup('a dead key ends the consent', () => {
    test('revoke refuses the next write and the next refresh', async () => {
      const db = makeStore();
      const memory = createMemoryStore();
      approvalsDeps.subkeys = memory;
      const { revokeTokensForKey } = await import('../src/oauth-provider.js');
      const deps = {
        subkeys: memory,
        readDoc: approvalsDeps.readDoc,
        writeDoc: approvalsDeps.writeDoc,
        endConsents: (keyId) => revokeTokensForKey(db, 'emet_', keyId)
      };
      try {
        await withEnv(ENV, async () => {
          const { claimed } = await issueMole(deps);
          const posted = await postApprove(db, { client_id: 'note-live', subkey: claimed.subkey, source: 'note-bot' });
          assert.equal(posted.status, 302, posted.text.slice(0, 400));
          const code = (await db.collection('emet_oauth_codes').find({}).toArray())[0];
          assert.equal(code.key_id, claimed.key_id);
          const { provider, issued, actor } = await loginFrom(db, 'note-live', posted.location);
          assert.equal(actor.keyId, claimed.key_id);
          const { preflight } = await import('../src/attribution.js');
          const ctx = { db, prefix: 'emet_', ownerId: 'owner', deps, registry: TAGS.split(',') };
          await withStore(db, () => preflight(ctx, actor, {}, 'write_doc'));
          const { revokeSubkey } = await import('../src/subkeys.js');
          await revokeSubkey(deps, ownerActor(), 'owner', { key_id: claimed.key_id, reason: 'cut the bot off' });
          await assert.rejects(() => withStore(db, () => preflight(ctx, actor, {}, 'write_doc')), /the key for "note-bot" is revoked/);
          await assert.rejects(
            () => provider.exchangeRefreshToken({ client_id: 'note-live' }, issued.refresh_token, undefined, null),
            /not recognised|revoked/
          );
          await assert.rejects(() => provider.verifyAccessToken(issued.access_token), /not recognised/);
        });
      } finally {
        delete approvalsDeps.subkeys;
      }
    });

    test('an expired key refuses the next write and the next refresh', async () => {
      const db = makeStore();
      const memory = createMemoryStore();
      approvalsDeps.subkeys = memory;
      const { revokeTokensForKey } = await import('../src/oauth-provider.js');
      const deps = {
        subkeys: memory,
        readDoc: approvalsDeps.readDoc,
        writeDoc: approvalsDeps.writeDoc,
        endConsents: (keyId) => revokeTokensForKey(db, 'emet_', keyId)
      };
      try {
        await withEnv(ENV, async () => {
          const { claimed } = await issueMole(deps);
          const posted = await postApprove(db, { client_id: 'note-age', subkey: claimed.subkey, source: 'note-bot' });
          assert.equal(posted.status, 302, posted.text.slice(0, 400));
          const { provider, issued, actor } = await loginFrom(db, 'note-age', posted.location);
          await memory.mutate((data) => {
            const row = data.keys[claimed.key_id];
            row.expires_at = '2020-01-01T00:00:00.000Z';
            return true;
          });
          const { preflight } = await import('../src/attribution.js');
          await assert.rejects(
            () => preflight({ db, prefix: 'emet_', ownerId: 'owner', deps, registry: TAGS.split(',') }, actor, {}, 'write_doc'),
            /the key for "note-bot" is expired/
          );
          await assert.rejects(
            () => provider.exchangeRefreshToken({ client_id: 'note-age' }, issued.refresh_token, undefined, null),
            /expired|not recognised/
          );
        });
      } finally {
        delete approvalsDeps.subkeys;
      }
    });

    test('a second consent for the same key replaces the first', async () => {
      const db = makeStore();
      const memory = createMemoryStore();
      approvalsDeps.subkeys = memory;
      const deps = { subkeys: memory, db, prefix: 'emet_', readDoc: approvalsDeps.readDoc, writeDoc: approvalsDeps.writeDoc };
      try {
        await withEnv(ENV, async () => {
          const { claimed } = await issueMole(deps);
          const first = await postApprove(db, { client_id: 'note-a', subkey: claimed.subkey, source: 'note-bot' });
          assert.equal(first.status, 302, first.text.slice(0, 300));
          const a = await loginFrom(db, 'note-a', first.location);
          const second = await postApprove(db, { client_id: 'note-b', subkey: claimed.subkey, source: 'note-bot' });
          assert.equal(second.status, 302, second.text.slice(0, 300));
          const b = await loginFrom(db, 'note-b', second.location);
          assert.equal(b.actor.keyId, claimed.key_id);
          assert.equal(b.actor.sourceTag, 'note-bot');
          await assert.rejects(() => a.provider.verifyAccessToken(a.issued.access_token), /not recognised/);
          const still = await b.provider.verifyAccessToken(b.issued.access_token);
          assert.equal(still.extra.keyId, claimed.key_id);
          assert.equal(still.extra.door, 'key');
        });
      } finally {
        delete approvalsDeps.subkeys;
      }
    });

    test('a key sign-in cannot create an invite, member access, or a setup', async () => {
      const db = makeStore();
      const memory = createMemoryStore();
      approvalsDeps.subkeys = memory;
      const deps = { subkeys: memory, db, prefix: 'emet_', readDoc: approvalsDeps.readDoc, writeDoc: approvalsDeps.writeDoc };
      try {
        await withEnv({ ...ENV, EMET_INVITES: '1', EMET_MEMBER_ACCESS: '1' }, async () => {
          const { claimed } = await issueMole(deps);
          const posted = await postApprove(db, { client_id: 'note-tools', subkey: claimed.subkey, source: 'note-bot' });
          const { actor } = await loginFrom(db, 'note-tools', posted.location);
          const dbManager = { db, async getConnection() { return {}; } };
          await actorStore.run(actor, async () => {
            const { inviteCreate, memberAccessCreate } = await import('../src/tools.js');
            const { setupComplete } = await import('../src/setup.js');
            await assert.rejects(() => inviteCreate(dbManager, { display_name: 'Ada' }), /a key sign-in cannot call this/);
            await assert.rejects(() => memberAccessCreate(dbManager, { display_name: 'Ada' }), /a key sign-in cannot call this/);
            await assert.rejects(
              () => withStore(db, () => setupComplete({})),
              /a key sign-in cannot call this/
            );
          });
        });
      } finally {
        delete approvalsDeps.subkeys;
      }
    });
  });

  testGroup('a key token stays a key', () => {
    test('member-access freeze does not end a key refresh', async () => {
      const db = makeStore();
      const provider = new MongoOAuthProvider(() => db, {
        passphrase: SECRET,
        memberAccessFrozen: () => true,
        invitesFrozen: () => true
      });
      const issued = await provider._issueTokens(
        'c1', ['emet.read', 'emet.write'], null, 'key:note-bot', ISSUED_VIA.key, 'fam-key', 'note-bot'
      );
      const out = await provider.exchangeRefreshToken({ client_id: 'c1' }, issued.refresh_token, undefined, null);
      const verified = await provider.verifyAccessToken(out.access_token);
      assert.equal(verified.extra.door, 'key');
      assert.equal(verified.extra.sourceTag, 'note-bot');
      assert.equal(verified.extra.subject, 'key:note-bot');
    });
  });

  testGroup('the passphrase consent', () => {
    test('a passphrase with no key still binds owner, and a sub-key on that login does not move the tag', async () => {
      const db = makeStore();
      const posted = await withEnv(ENV, () => postApprove(db, { client_id: 'owner-only', passphrase: SECRET }));
      assert.equal(posted.status, 302, posted.text.slice(0, 300));
      const row = (await db.collection('emet_oauth_codes').find({}).toArray())[0];
      assert.equal(row.source_tag, 'owner');
      assert.equal(row.issued_via, 'owner');
      const { actor } = await loginFrom(db, 'owner-only', posted.location);
      assert.equal(actor.door, 'owner');
      assert.equal(actor.sourceTag, 'owner');
      const widened = {
        ...actor,
        sourceBasis: 'subkey',
        effectiveTag: 'note-bot',
        subkeyId: 'key-note',
        declaredTag: null
      };
      await withEnv(ENV, () => withStore(db, () => actorStore.run(widened, async () => {
        const { rightsTags, writeDoc } = await import('../src/tools.js');
        assert.deepEqual(rightsTags('note-bot'), ['note-bot', 'owner']);
        await assert.rejects(
          () => writeDoc('notes/owner-key.md', 'Should not land.\n', 'note-bot', null, null, {}),
          (error) => error.emetCode === 'EMET-DOC-020'
        );
        assert.equal(db.collection('documents').docs.find((doc) => doc.doc_id === 'notes/owner-key.md'), undefined);
      })));
    });
  });

const done = test('release the listener', () => { server.close(); });
await done;

summary('key sign-in');
