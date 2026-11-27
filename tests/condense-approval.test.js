/**
 * EMET-DOC-025 stays the default. An owner door, or a writer approval the owner
 * already granted, may condense when condense_approved is true and the reason
 * is not empty. A sub-key without that approval is still refused.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';
import { makeStore, withStore, withEnv } from './memstore.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.EMET_HUB_TAG = 'hub-bot';
process.env.EMET_RECORD_DOCS = 'bots/second-bot/HANDOFF.md,bots/note-bot/HANDOFF.md';
const REASON = 'shrink the handoff to the current punch list';
const BIG = `Handoff\n${'x'.repeat(400)}`;
const SHORT = 'Punch list\n- one open item\n';

const owner = {
  transport: 'http',
  authenticated: true,
  personId: 'owner',
  ownerId: 'owner',
  clientId: 'owner-client',
  sourceTag: 'owner',
  sourceBasis: 'login',
  door: 'owner'
};

const bot = {
  transport: 'http',
  authenticated: true,
  personId: 'owner',
  ownerId: 'owner',
  clientId: 'bot-client',
  sourceTag: 'second-bot',
  effectiveTag: 'second-bot',
  sourceBasis: 'subkey',
  door: 'key',
  subkeyId: 'key-1'
};

const passwordHub = {
  transport: 'http',
  authenticated: true,
  personId: 'owner',
  ownerId: 'owner',
  clientId: 'owner-client',
  sourceTag: 'hub-bot',
  sourceBasis: 'login',
  door: 'owner'
};

const HUB_ENV = {
  EMET_HUB_TAG: 'hub-bot',
  EMET_SOURCE_TAGS: 'hub-bot,owner,project-host'
};

function approvalRow(id, extra = {}) {
  return {
    _id: id,
    request_id: id,
    client_id: 'bot-client',
    claimed_tag: 'second-bot',
    doc_id: 'HANDOFF.md',
    status: 'approved',
    issued: true,
    decider: 'owner',
    deleted: false,
    retained: true,
    history: [{ step: 'decide', decision: 'approve', decider: 'owner', at: '2026-11-27T00:00:00.000Z' }],
    ...extra
  };
}

console.log('\n=== owner-approved condense ===');

testGroup('the floor', () => {
  test('a shorter write is still refused', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const db = makeStore();
    await withStore(db, async () => {
      await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
      await assert.rejects(
        () => writeDoc('HANDOFF.md', SHORT, 'project-host', null, null, {
          supersedes: 1, reason: REASON, session_id: 's1'
        }),
        (err) => {
          assert.strictEqual(err.emetCode, 'EMET-DOC-025');
          assert.match(err.message, /Condensing below half is not done on the EMET server/);
          return true;
        }
      );
      assert.strictEqual(db.doc('HANDOFF.md').content, BIG);
      assert.strictEqual(db.collection('documents_history').docs.length, 0);
    });
  });

  test('a bot sub-key with the flag is still refused', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const db = makeStore();
    await withStore(db, async () => {
      await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
      await actorStore.run(bot, () => assert.rejects(
        () => writeDoc('HANDOFF.md', SHORT, 'second-bot', null, null, {
          supersedes: 1, reason: REASON, session_id: 's-bot', condense_approved: true
        }),
        (err) => {
          assert.strictEqual(err.emetCode, 'EMET-DOC-025');
          assert.match(err.message, /Nothing was written/);
          return true;
        }
      ));
      assert.strictEqual(db.doc('HANDOFF.md').content, BIG);
    });
  });

  test('the owner password does not let the hub tag condense', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const db = makeStore();
    await withEnv(HUB_ENV, () => withStore(db, async () => {
      await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
      await actorStore.run(passwordHub, () => assert.rejects(
        () => writeDoc('HANDOFF.md', SHORT, 'hub-bot', null, null, {
          supersedes: 1, reason: REASON, session_id: 's-hub', condense_approved: true
        }),
        (err) => {
          assert.strictEqual(err.emetCode, 'EMET-DOC-025');
          assert.match(err.message, /Nothing was written/);
          return true;
        }
      ));
      const live = db.doc('HANDOFF.md');
      assert.strictEqual(live.version, 1);
      assert.strictEqual(live.content, BIG);
      assert.ok(!live.condense);
    }));
  });

  test('a missing reason is refused', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const db = makeStore();
    await withStore(db, async () => {
      await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
      await actorStore.run(owner, () => assert.rejects(
        () => writeDoc('HANDOFF.md', SHORT, 'owner', null, null, {
          supersedes: 1, session_id: 's-owner', condense_approved: true
        }),
        (err) => {
          assert.strictEqual(err.emetCode, 'EMET-DOC-090');
          assert.match(err.message, /needs a reason/);
          assert.match(err.message, /Nothing was written/);
          return true;
        }
      ));
      assert.strictEqual(db.doc('HANDOFF.md').content, BIG);
    });
  });
});

testGroup('an approved condense', () => {
  test('the owner door writes the short revision and keeps the prior text', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const { digest } = await import('../src/aleph.js');
    const { actorStore } = await import('../src/persons.js');
    const { AuditOperation } = await import('../src/logger.js');
    const db = makeStore();
    const audits = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      audit(op, details) { audits.push({ op, details }); }
    };
    await withStore(db, async () => {
      await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
      const priorSha = db.doc('HANDOFF.md').sha256;
      const receipt = await actorStore.run(owner, () => writeDoc('HANDOFF.md', SHORT, 'owner', null, logger, {
        supersedes: 1,
        reason: REASON,
        session_id: 's-owner',
        condense_approved: true,
        archive_doc: 'HANDOFF-ARCHIVE-2026-11b.md'
      }));
      assert.strictEqual(receipt.verified, true);
      assert.strictEqual(receipt.condensed, true);
      assert.strictEqual(receipt.sha256, digest(SHORT));
      assert.match(receipt.condense_note, /documents_history/);
      const live = db.doc('HANDOFF.md');
      assert.strictEqual(live.content, SHORT);
      assert.strictEqual(live.sha256, digest(SHORT));
      assert.strictEqual(live.condense.reason, REASON);
      assert.strictEqual(live.condense.approver, 'owner');
      assert.strictEqual(live.condense.basis, 'owner-door');
      assert.strictEqual(live.condense.prior_size, BIG.length);
      assert.strictEqual(live.condense.prior_sha256, priorSha);
      assert.strictEqual(live.condense.new_size, SHORT.length);
      assert.strictEqual(live.condense.new_sha256, digest(SHORT));
      assert.strictEqual(live.condense.archive_doc, 'HANDOFF-ARCHIVE-2026-11b.md');
      const kept = db.collection('documents_history').docs.find((row) => row.doc_id === 'HANDOFF.md' && row.version === 1);
      assert.strictEqual(kept.content, BIG);
      assert.strictEqual(kept.sha256, priorSha);
      const episode = db.collection('emet_episodic').docs.find((row) => row.id === receipt.episodic_id);
      assert.ok(episode, 'episodic note was stored');
      assert.match(episode.content, /Condensed HANDOFF.md/);
      assert.match(episode.content, new RegExp(String(BIG.length)));
      assert.strictEqual(episode.metadata.custom.reason, REASON);
      assert.strictEqual(episode.metadata.custom.approver, 'owner');
      assert.strictEqual(episode.metadata.custom.prior_sha256, priorSha);
      assert.strictEqual(episode.metadata.custom.new_sha256, digest(SHORT));
      assert.strictEqual(episode.sha256, digest(episode.content));
      const saved = audits.find((row) => row.op === AuditOperation.MEMORY_SAVE);
      const condensed = audits.find((row) => row.op === AuditOperation.DOCUMENT_CONDENSE);
      assert.ok(saved, 'episodic save is audited');
      assert.ok(condensed, 'condense audit is recorded');
      assert.strictEqual(condensed.details.prior_size, BIG.length);
      assert.strictEqual(condensed.details.new_sha256, digest(SHORT));
    });
  });

  test('a failed live write does not leave a condensed episode', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const db = makeStore();
    await withStore(db, async () => {
      await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
      const docs = db.collection('documents');
      const orig = docs.updateOne.bind(docs);
      docs.updateOne = async (q, u, o) => {
        if (u && u.$set && u.$set.content === SHORT) throw new Error('live write refused');
        return orig(q, u, o);
      };
      await actorStore.run(owner, () => assert.rejects(
        () => writeDoc('HANDOFF.md', SHORT, 'owner', null, null, {
          supersedes: 1, reason: REASON, session_id: 's-owner', condense_approved: true
        }),
        /live write refused/
      ));
      assert.strictEqual(db.doc('HANDOFF.md').content, BIG);
      const notes = db.collection('emet_episodic').docs.filter((row) => /Condensed/.test(String(row.content || '')));
      assert.strictEqual(notes.length, 0);
    });
  });

  test('a bot with a granted writer approval can condense the named document', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const { _resetWriterApprovalsForTests } = await import('../src/writer-approval.js');
    _resetWriterApprovalsForTests();
    const id = 'wr-0123456789abcdef';
    const db = makeStore();
    await db.collection('emet_writer_approvals').insertOne(approvalRow(id));
    await withStore(db, async () => {
      await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
      const receipt = await actorStore.run(bot, () => writeDoc('HANDOFF.md', SHORT, 'second-bot', null, null, {
        supersedes: 1,
        reason: REASON,
        session_id: 's-bot',
        condense_approved: true,
        writer_approval_id: id
      }));
      assert.strictEqual(receipt.verified, true);
      assert.strictEqual(receipt.condense.basis, 'writer-approval');
      assert.strictEqual(receipt.condense.approver, 'owner');
      assert.strictEqual(receipt.condense.writer_approval_id, id);
      const kept = db.collection('documents_history').docs.find((row) => row.doc_id === 'HANDOFF.md');
      assert.strictEqual(kept.content, BIG);
    });
  });

  test('the hub condenses HANDOFF only with a writer approval for that document', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const { _resetWriterApprovalsForTests } = await import('../src/writer-approval.js');
    _resetWriterApprovalsForTests();
    const id = 'wr-abcdef0123456789';
    const db = makeStore();
    await db.collection('emet_writer_approvals').insertOne(approvalRow(id, {
      client_id: 'owner-client',
      claimed_tag: 'hub-bot',
      doc_id: 'HANDOFF.md'
    }));
    await withEnv(HUB_ENV, () => withStore(db, async () => {
      await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
      const receipt = await actorStore.run(passwordHub, () => writeDoc('HANDOFF.md', SHORT, 'hub-bot', null, null, {
        supersedes: 1,
        reason: REASON,
        session_id: 's-hub',
        condense_approved: true,
        writer_approval_id: id
      }));
      assert.strictEqual(receipt.verified, true);
      assert.strictEqual(receipt.condense.basis, 'writer-approval');
      assert.strictEqual(receipt.condense.writer_approval_id, id);
      assert.strictEqual(db.collection('documents_history').docs.find((row) => row.doc_id === 'HANDOFF.md').content, BIG);
    }));
  });

  test('a writer approval does not condense a document it does not name', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const { _resetWriterApprovalsForTests } = await import('../src/writer-approval.js');
    _resetWriterApprovalsForTests();
    const id = 'wr-0011223344556677';
    const db = makeStore();
    await db.collection('emet_writer_approvals').insertOne(approvalRow(id, { doc_id: 'HANDOFF.md' }));
    await withEnv({ EMET_RECORD_DOCS: 'NOTES.md' }, () => withStore(db, async () => {
      await writeDoc('NOTES.md', BIG, 'project-host', null, null, { session_id: 's1' });
      await actorStore.run(bot, () => assert.rejects(
        () => writeDoc('NOTES.md', SHORT, 'second-bot', null, null, {
          supersedes: 1, reason: REASON, session_id: 's-bot', condense_approved: true, writer_approval_id: id
        }),
        (err) => {
          assert.strictEqual(err.emetCode, 'EMET-DOC-090');
          assert.match(err.message, /not valid/);
          return true;
        }
      ));
      assert.strictEqual(db.doc('NOTES.md').content, BIG);
      await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
      const bare = 'wr-fedcba9876543210';
      await db.collection('emet_writer_approvals').insertOne(approvalRow(bare, { doc_id: null }));
      await actorStore.run(bot, () => assert.rejects(
        () => writeDoc('HANDOFF.md', SHORT, 'second-bot', null, null, {
          supersedes: 1, reason: REASON, session_id: 's-bot', condense_approved: true, writer_approval_id: bare
        }),
        (err) => {
          assert.strictEqual(err.emetCode, 'EMET-DOC-090');
          return true;
        }
      ));
    }));
  });

  test('an approval that is not granted yet is refused', async () => {
    const { writeDoc } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const { _resetWriterApprovalsForTests } = await import('../src/writer-approval.js');
    _resetWriterApprovalsForTests();
    const id = 'wr-abcdefabcdefabcd';
    const db = makeStore();
    await db.collection('emet_writer_approvals').insertOne(approvalRow(id, { status: 'validated', issued: false }));
    await withStore(db, async () => {
      await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
      await actorStore.run(bot, () => assert.rejects(
        () => writeDoc('HANDOFF.md', SHORT, 'second-bot', null, null, {
          supersedes: 1, reason: REASON, session_id: 's-bot', condense_approved: true, writer_approval_id: id
        }),
        (err) => {
          assert.strictEqual(err.emetCode, 'EMET-DOC-090');
          assert.match(err.message, /has not approved/);
          return true;
        }
      ));
      assert.strictEqual(db.doc('HANDOFF.md').content, BIG);
    });
  });
});

testGroup('the owner grants the named condense', () => {
  test('owner chooser approve over HTTP lets the hub shorten HANDOFF.md and mints no code', async () => {
    const express = (await import('express')).default;
    const { ApproveThrottle } = await import('../src/approve-throttle.js');
    const { mountChooser } = await import('../src/chooser.js');
    const { createOwnerGate } = await import('../src/owner-session.js');
    const { writeDoc } = await import('../src/tools.js');
    const { actorStore } = await import('../src/persons.js');
    const { prepareWriterRequest, getWriterRequest, _resetWriterApprovalsForTests } = await import('../src/writer-approval.js');
    _resetWriterApprovalsForTests();
    const db = makeStore();
    const mb = {
      transport: 'http',
      authenticated: true,
      sourceBasis: 'login',
      sourceTag: 'hub-bot',
      personId: 'owner',
      ownerId: 'owner',
      clientId: 'mb-client',
      grantId: 'mbgrant00000000000001'
    };
    const prepared = await prepareWriterRequest(db, 'emet_', mb, {
      client: 'owner-client',
      claimed_tag: 'hub-bot',
      tag: 'hub-bot',
      door: 'member',
      reason: REASON,
      correlation_id: 'abc123abc123abc1',
      doc_id: 'HANDOFF.md'
    });
    assert.equal(prepared.status, 'validated');
    assert.equal(prepared.doc_id, 'HANDOFF.md');
    const gate = createOwnerGate({
      checkPassphrase: (input) => input === 'owner-secret-value',
      throttle: new ApproveThrottle()
    });
    const app = express();
    mountChooser(app, { gate, ownerId: 'owner', db: () => db, prefix: 'emet_' });
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const locked = await fetch(`${base}/owner/chooser/writer`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision: 'approve', request_id: prepared.request_id }).toString()
      });
      assert.equal(locked.status, 401);
      const login = await fetch(`${base}/owner/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ passphrase: 'owner-secret-value', next: '/owner/chooser' }).toString()
      });
      assert.equal(login.status, 303);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const page = await fetch(`${base}/owner/chooser`, { headers: { cookie } });
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /Allow hub-bot to shorten HANDOFF.md: shrink the handoff to the current punch list/);
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)[1];
      const decided = await fetch(`${base}/owner/chooser/writer`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({ csrf, decision: 'approve', request_id: prepared.request_id }).toString()
      });
      const body = await decided.text();
      assert.equal(decided.status, 200, body);
      const hubNote = /<p class="note">([^<]*)<\/p>/.exec(body)[1];
      assert.match(hubNote, /Allow hub-bot to shorten HANDOFF.md/);
      assert.doesNotMatch(hubNote, /door|code/i);
      assert.doesNotMatch(body, /Access code/);
      assert.equal(db.collection('invites').docs.length, 0);
      const row = getWriterRequest(prepared.request_id);
      assert.equal(row.status, 'approved');
      assert.equal(row.issued, true);
      assert.equal(row.doc_id, 'HANDOFF.md');
      assert.equal(row.decider, 'owner');
      await withEnv(HUB_ENV, () => withStore(db, async () => {
        await writeDoc('HANDOFF.md', BIG, 'project-host', null, null, { session_id: 's1' });
        const receipt = await actorStore.run(passwordHub, () => writeDoc('HANDOFF.md', SHORT, 'hub-bot', null, null, {
          supersedes: 1,
          reason: REASON,
          session_id: 's-hub',
          condense_approved: true,
          writer_approval_id: prepared.request_id
        }));
        assert.equal(receipt.verified, true);
        assert.equal(receipt.condense.basis, 'writer-approval');
        assert.equal(receipt.condense.writer_approval_id, prepared.request_id);
        assert.equal(db.doc('HANDOFF.md').content, SHORT);
        assert.equal(db.collection('documents_history').docs.find((kept) => kept.doc_id === 'HANDOFF.md').content, BIG);
      }));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

testGroup('a named grant does not widen a client door', () => {
  test('approving a shorten grant for project-host leaves CLIENT_APPROVALS unchanged', async () => {
    const express = (await import('express')).default;
    const { ApproveThrottle } = await import('../src/approve-throttle.js');
    const { mountChooser } = await import('../src/chooser.js');
    const { createOwnerGate } = await import('../src/owner-session.js');
    const { approvalsDeps } = await import('../src/tools.js');
    const { parseApprovals } = await import('../src/attribution.js');
    const { prepareWriterRequest, _resetWriterApprovalsForTests } = await import('../src/writer-approval.js');
    _resetWriterApprovalsForTests();
    const db = makeStore();
    const prepared = await prepareWriterRequest(db, 'emet_', {
      transport: 'http',
      authenticated: true,
      sourceBasis: 'login',
      sourceTag: 'hub-bot',
      personId: 'owner',
      ownerId: 'owner',
      clientId: 'mb-client',
      grantId: 'mbgrant00000000000001'
    }, {
      client: 'client-host-example',
      claimed_tag: 'project-host',
      tag: 'project-host',
      door: 'member',
      reason: 'shrink the handoff to the current punch list',
      correlation_id: 'def456def456def4',
      doc_id: 'HANDOFF.md'
    });
    assert.equal(prepared.status, 'validated');
    const gate = createOwnerGate({
      checkPassphrase: (input) => input === 'owner-secret-value',
      throttle: new ApproveThrottle()
    });
    const app = express();
    mountChooser(app, { gate, deps: approvalsDeps, ownerId: 'owner', db: () => db, prefix: 'emet_' });
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const login = await fetch(`${base}/owner/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ passphrase: 'owner-secret-value', next: '/owner/chooser' }).toString()
      });
      assert.equal(login.status, 303);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const page = await fetch(`${base}/owner/chooser`, { headers: { cookie } });
      const html = await page.text();
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)[1];
      const decided = await withStore(db, () => fetch(`${base}/owner/chooser/writer`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({ csrf, decision: 'approve', request_id: prepared.request_id }).toString()
      }));
      const body = await decided.text();
      assert.equal(decided.status, 200, body);
      const note = /<p class="note">([^<]*)<\/p>/.exec(body)[1];
      assert.match(note, /Allow project-host to shorten HANDOFF.md: shrink the handoff to the current punch list/);
      assert.doesNotMatch(note, /door|code/i);
      assert.doesNotMatch(body, /Listed project-host as its own door/);
      assert.doesNotMatch(body, /access code/i);
      const stored = db.doc('emet/CLIENT_APPROVALS.md');
      const approved = stored ? parseApprovals(stored.content).approved : null;
      assert.ok(!approved || !approved['project-host'], stored && stored.content);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

testGroup('the diagram', () => {
  test('the page and the doc use the checked chart', async () => {
    const { CONDENSE_MERMAID } = await import('../src/condense-statechart.js');
    const { statechartBody } = await import('../src/access-statechart.js');
    const doc = fs.readFileSync(path.join(ROOT, 'docs/condense-approval-statechart.md'), 'utf8');
    const fenced = doc.split('```mermaid\n')[1].split('\n```')[0];
    assert.equal(fenced, CONDENSE_MERMAID);
    assert.match(statechartBody(), /Condensing a document/);
    assert.match(statechartBody(), /EMET-DOC-025/);
    const tlc = fs.readFileSync(path.join(ROOT, 'verification/condense-approval/tlc-output.txt'), 'utf8');
    assert.match(tlc, /115 distinct states found/);
    assert.match(tlc, /No error has been found/);
    assert.match(tlc, /The depth of the complete state graph search is 2/);
  });
});

summary('Owner-approved condense');
