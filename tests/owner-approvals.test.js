/**
 * /owner/approvals is retired by R4. It points at the chooser and does not
 * delete sub-key records. emet_client_approve still refuses a login deciding
 * a sub-key whose tag is that login's own tag.
 */

import assert from 'node:assert/strict';
import express from 'express';
import { test, testGroup, summary } from './harness.js';
import { withEnv } from './memstore.js';
import { createMemoryStore } from '../src/subkey-store.js';
import { mountOwnerApprovals } from '../src/owner-approvals.js';
import { OWNER_APPROVALS_RETIRED } from '../src/grants.js';

console.log('\n=== owner approvals retired ===');

const PEPPER = 'pepper-pepper-pepper-pepper-pepper-32b';
const OWNER = 'alex';
const REG = ['hub-bot', 'intake-bot', 'cowork-cloud'];
const ON = {
  EMET_SUBKEYS: '1',
  EMET_SUBKEY_PEPPER: PEPPER,
  EMET_SOURCE_TAGS: REG.join(','),
  EMET_RECORD_DOCS: 'bots/hub-bot/HANDOFF.md,bots/intake-bot/HANDOFF.md'
};

const holder = { deps: null };
const app = express();
mountOwnerApprovals(app, {});
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

function requester() {
  return {
    personId: OWNER, ownerId: OWNER, clientId: 'bot-client', grantId: 'bot-grant',
    transport: 'http', authenticated: true, sourceTag: 'hub-bot', sourceBasis: 'login'
  };
}

try {
  await testGroup('retired owner approvals', async () => {
    await test('the contract keeps the path and the records', () => {
      assert.strictEqual(OWNER_APPROVALS_RETIRED.deleted, false);
      assert.strictEqual(OWNER_APPROVALS_RETIRED.retained, true);
      assert.strictEqual(OWNER_APPROVALS_RETIRED.superseded_by, '/owner/chooser');
    });

    await test('GET and POST refuse with a pointer and set no cookie', async () => {
      const page = await fetch(`${base}/owner/approvals`);
      const html = await page.text();
      assert.equal(page.status, 410);
      assert.match(html, /R4/);
      assert.match(html, /href="\/owner\/chooser"/);
      assert.match(html, /retained/i);
      assert.equal(html.includes('type="password"'), false);
      assert.equal(page.headers.get('set-cookie'), null);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      const posted = await fetch(`${base}/owner/approvals/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'passphrase=secret&decision=approve'
      });
      assert.equal(posted.status, 410);
      assert.match(await posted.text(), /\/owner\/chooser/);
      assert.equal(posted.headers.get('set-cookie'), null);
      const decide = await fetch(`${base}/owner/approvals/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'decision=approve&key_id=abc'
      });
      assert.equal(decide.status, 410);
    });

    await test('a legacy sub-key record is still readable after the retired path is hit', async () => withEnv(ON, async () => {
      holder.deps = { subkeys: createMemoryStore() };
      const sk = await import('../src/subkeys.js');
      const pending = await sk.requestSubkey(holder.deps, requester(), { tag: 'intake-bot' }, REG, new Date('2026-10-15T16:00:00Z'));
      const hit = await fetch(`${base}/owner/approvals`);
      assert.equal(hit.status, 410);
      const data = await sk.loadSubkeyRecords(holder.deps);
      assert.equal(data.keys[pending.key_id].status, 'pending');
      assert.equal(data.keys[pending.key_id].tag, 'intake-bot');
    }));

    await test('an app that does not mount the path is still a 404', async () => {
      const off = express();
      const offServer = await new Promise((resolve) => { const s = off.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const owner = await fetch(`http://127.0.0.1:${offServer.address().port}/owner/approvals`);
        const other = await fetch(`http://127.0.0.1:${offServer.address().port}/no-such-route`);
        assert.equal(owner.status, 404);
        assert.equal(other.status, 404);
      } finally {
        offServer.close();
      }
    });

    await test('emet_client_approve still refuses a login deciding its own sub-key tag', async () => withEnv(ON, async () => {
      holder.deps = { subkeys: createMemoryStore() };
      const sk = await import('../src/subkeys.js');
      const pending = await sk.requestSubkey(holder.deps, requester(), { tag: 'intake-bot' }, REG, new Date('2026-10-15T16:00:00Z'));
      const att = await import('../src/attribution.js');
      att._resetForTests();
      const actor = {
        personId: OWNER, ownerId: OWNER, clientId: 'other-client', grantId: 'other-grant',
        transport: 'http', authenticated: true, sourceTag: 'intake-bot', sourceBasis: 'login'
      };
      await assert.rejects(
        () => att.clientApprove(holder.deps, actor, OWNER, { tag: 'intake-bot', decision: 'approve' }),
        /may not decide its own approval/
      );
      assert.equal((await sk.loadSubkeyRecords(holder.deps)).keys[pending.key_id].status, 'pending');
    }));
  });
} finally {
  server.close();
}

summary('owner approvals retired');
