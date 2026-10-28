/**
 * R3: the door's grant_id is what a write and a refusal record.
 * A caller field cannot replace it. A claimed source tag, with no grant,
 * warns until Alex's kill date and is refused on that date.
 * A shared source tag is not a grant. The receipt is where that shows.
 * At thatcommit the row and the error log already stored the token family.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert/strict';
import { actorStore, httpToolActor } from '../src/persons.js';
import { makeStore, withStore, layerHonouringDb, withEnv, memDb } from './memstore.js';
import { MongoOAuthProvider, MEMBER_GRANT } from '../src/oauth-provider.js';
import { useMemoryErrorLog, flushErrorLog } from '../src/error-log.js';
import { labRow } from '../src/session-graph.js';
import { dispatchTool, setStatusSeatForTests } from '../src/dispatch.js';
import { ValidationError } from '../src/validation.js';
import {
  PROPOSED_CLAIMED_TAG_KILL_DATE,
  claimedTagKillDate,
  claimedTagKillReached,
  claimedTagTraffic,
  _resetClaimedTagForTests
} from '../src/claimed-tag.js';

const log = useMemoryErrorLog();
const ONBOARDING = 'keyed link, then owner sign-in, then assign tag, then initialize';
const INTAKE_GRANT = 'intake-door-grant-728x';
const DOOR_GRANT = 'fam-r3-stamp';

const door = {
  transport: 'http', personId: 'ada', clientId: 'login-ada',
  grantId: DOOR_GRANT, door: 'member', sourceTag: 'laptop',
  authenticated: true, scopes: ['emet']
};
const claimed = {
  transport: 'http', personId: 'visitor', clientId: 'login-claim',
  grantId: null, door: null, sourceTag: null,
  declaredTag: 'claimed-host', sourceBasis: 'declared',
  authenticated: true, scopes: ['emet']
};
const intake = {
  transport: 'http', personId: 'intake', clientId: 'intake-login',
  grantId: INTAKE_GRANT, door: 'member', sourceTag: 'hub-bot',
  authenticated: true, scopes: ['emet']
};

const SPOOF = {
  source: 'hub-bot',
  grant_id: 'spoofed-grant-id',
  door: 'owner',
  custom: { grant_id: 'spoofed-grant-id', door: 'owner' }
};

function bodyOf(res) {
  return JSON.parse(res.content[0].text);
}

async function asDoor(fn) {
  return actorStore.run(door, fn);
}

testGroup('the kill date is Alex\'s setting', () => {
  test('the proposed date is 2026-12-15 UTC, and an unset env uses it', () => {
    assert.strictEqual(PROPOSED_CLAIMED_TAG_KILL_DATE, '2026-12-15');
    withEnv({ EMET_CLAIMED_TAG_KILL_DATE: undefined, CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, () => {
      assert.strictEqual(claimedTagKillDate(), '2026-12-15');
    });
  });
  test('EMET_CLAIMED_TAG_KILL_DATE wins, CASCADE_ is the fallback, and a bad value does not', () => {
    withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2027-01-02', CASCADE_CLAIMED_TAG_KILL_DATE: '2027-03-03' }, () => {
      assert.strictEqual(claimedTagKillDate(), '2027-01-02');
    });
    withEnv({ EMET_CLAIMED_TAG_KILL_DATE: undefined, CASCADE_CLAIMED_TAG_KILL_DATE: '2027-03-03' }, () => {
      assert.strictEqual(claimedTagKillDate(), '2027-03-03');
    });
    withEnv({ EMET_CLAIMED_TAG_KILL_DATE: ' 2026-12-15 ', CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, () => {
      assert.strictEqual(claimedTagKillDate(), '2026-12-15');
    });
    withEnv({ EMET_CLAIMED_TAG_KILL_DATE: 'tomorrow', CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, () => {
      assert.strictEqual(claimedTagKillDate(), PROPOSED_CLAIMED_TAG_KILL_DATE);
    });
  });
  test('the path is open before the date and closed on that date', () => {
    assert.strictEqual(claimedTagKillReached(new Date('2026-12-14T23:00:00Z'), '2026-12-15'), false);
    assert.strictEqual(claimedTagKillReached(new Date('2026-12-15T00:30:00Z'), '2026-12-15'), true);
    assert.strictEqual(claimedTagKillReached(new Date('2026-12-16T00:00:00Z'), '2026-12-15'), true);
  });
});

testGroup('every write receipt carries the door grant, and a spoof does not', () => {
  test('save_to_layer, a consolidation, a correction, and a supersession', async () => {
    const { saveMemory, reviseMemory } = await import('../src/tools.js');
    const db = layerHonouringDb();
    const saved = await asDoor(() => saveMemory(db, 'A working note under this door.', 'working', { ...SPOOF }));
    assert.strictEqual(saved.grant_id, DOOR_GRANT);
    assert.strictEqual(saved.claimed_tag_warning, undefined);
    const row = db.row('working', saved.id);
    assert.strictEqual(row.metadata.grant_id, DOOR_GRANT);
    assert.strictEqual(row.metadata.door, 'member');
    assert.ok(!row.metadata.custom || !('grant_id' in row.metadata.custom));
    assert.notStrictEqual(row.metadata.grant_id, 'spoofed-grant-id');

    const consolidated = await asDoor(() => saveMemory(db, 'Consolidated from the working note.', 'semantic', {
      ...SPOOF,
      assertion_origin: 'consolidated',
      derived_from: { entries: [saved.id] }
    }));
    assert.strictEqual(consolidated.grant_id, DOOR_GRANT);
    assert.strictEqual(db.row('semantic', consolidated.id).metadata.grant_id, DOOR_GRANT);
    assert.deepStrictEqual(db.row('semantic', consolidated.id).derived_from_ids, [saved.id]);

    const parent = await asDoor(() => saveMemory(db, 'Episode 700, items one and two.', 'episodic', { source: 'laptop' }));
    const child = await asDoor(() => saveMemory(db, 'Corrects episode 700, item two.', 'episodic', {
      ...SPOOF, corrects: parent.id
    }));
    assert.strictEqual(child.grant_id, DOOR_GRANT);
    const marked = db.row('episodic', parent.id);
    assert.strictEqual(marked.corrected_grant_id, DOOR_GRANT);
    assert.strictEqual(marked.metadata.corrected_grant_id, DOOR_GRANT);
    assert.notStrictEqual(marked.content, 'Corrects episode 700, item two.');

    const fact = await asDoor(() => saveMemory(db, 'The fact before the revision.', 'semantic', {
      source: 'laptop', derived_from: { entries: [saved.id] }
    }));
    const revised = await asDoor(() => reviseMemory(db, 'semantic', fact.id, 'The fact after the revision.', { ...SPOOF }));
    assert.strictEqual(revised.grant_id, DOOR_GRANT);
    assert.strictEqual(db.row('semantic', fact.id).superseded_grant_id, DOOR_GRANT);
    assert.strictEqual(db.row('semantic', fact.id).metadata.superseded_grant_id, DOOR_GRANT);
    assert.strictEqual(db.row('semantic', revised.id).metadata.grant_id, DOOR_GRANT);
  });

  test('write_doc, patch_doc, a drop, a staging doc, retire_doc, and accept_nonconformance', async () => {
    const { writeDoc, patchDoc, retireDoc, acceptNonconformance } = await import('../src/tools.js');
    const store = makeStore();
    await withStore(store, async () => {
      const written = await asDoor(() => writeDoc('threads/r3-grant.md', '# Grant\n\nbody\n', 'spoof-source'));
      assert.strictEqual(written.grant_id, DOOR_GRANT);
      assert.strictEqual(store.doc('threads/r3-grant.md').grant_id, DOOR_GRANT);
      assert.strictEqual(store.doc('threads/r3-grant.md').door, 'member');
      assert.strictEqual(store.doc('threads/r3-grant.md').updated_by, 'spoof-source');

      const patched = await asDoor(() => patchDoc(
        'threads/r3-grant.md', 'body', 'revised body', 'spoof-source', null, null,
        { reason: 'stamp the patch with the door grant' }
      ));
      assert.strictEqual(patched.grant_id, DOOR_GRANT);
      assert.strictEqual(store.doc('threads/r3-grant.md').grant_id, DOOR_GRANT);

      const drop = await asDoor(() => writeDoc('drops/r3-stamp.md', 'a drop under this door\n', 'spoof-source'));
      assert.strictEqual(drop.grant_id, DOOR_GRANT);
      assert.strictEqual(store.doc('drops/r3-stamp.md').grant_id, DOOR_GRANT);

      const staging = await asDoor(() => writeDoc('staging/r3-note.md', '# Staging\n\na note\n', 'spoof-source'));
      assert.strictEqual(staging.grant_id, DOOR_GRANT);
      assert.strictEqual(store.doc('staging/r3-note.md').grant_id, DOOR_GRANT);

      const retired = await asDoor(() => retireDoc('drops/r3-stamp.md', 'filed into the working note', 'spoof-source'));
      assert.strictEqual(retired.grant_id, DOOR_GRANT);
      assert.strictEqual(store.doc('drops/r3-stamp.md').retired_grant_id, DOOR_GRANT);
      assert.strictEqual(store.doc('drops/r3-stamp.md').content, 'a drop under this door\n');

      store.col('documents').docs.push({
        doc_id: 'threads/r3-nc.md', version: 1, content: 'missing the required heading\n',
        sha256: 'abc', updated_by: 'laptop',
        conformance: { verdict: 'nonconforming', failures: ['missing heading'] }
      });
      const accepted = await asDoor(() => acceptNonconformance(
        'threads/r3-nc.md', 'accepted for this revision only', 'spoof-source'
      ));
      assert.strictEqual(accepted.grant_id, DOOR_GRANT);
      assert.strictEqual(store.doc('threads/r3-nc.md').conformance.accepted.grant_id, DOOR_GRANT);
    });
  });

  test('save_transcript, emet_transcript_append, and revise_transcript', async () => {
    const { saveTranscript, transcriptAppend, reviseTranscript } = await import('../src/tools.js');
    const store = makeStore();
    const exchange = { user_message: 'hello from the door', assistant_message: 'a reply with no machine line' };
    await withStore(store, async () => {
      const saved = await asDoor(() => saveTranscript('2026-10-27_r3', 1_700_000_000, null, [exchange], 'spoof-channel'));
      assert.strictEqual(saved.grant_id, DOOR_GRANT);
      assert.strictEqual(store.transcripts().find((d) => d.session_id === '2026-10-27_r3').exchanges[0].grant_id, DOOR_GRANT);
      assert.strictEqual(store.transcripts().find((d) => d.session_id === '2026-10-27_r3').exchanges[0].door, 'member');

      const appended = await asDoor(() => transcriptAppend({
        session_id: '2026-10-27_r3_append',
        user_message: 'second session',
        assistant_message: 'still no machine line',
        channel: 'spoof-channel'
      }));
      assert.strictEqual(appended.grant_id, DOOR_GRANT);
      assert.strictEqual(store.transcripts().find((d) => d.session_id === '2026-10-27_r3_append').exchanges[0].grant_id, DOOR_GRANT);

      const revised = await asDoor(() => reviseTranscript(
        '2026-10-27_r3',
        [{ user_message: 'hello corrected', assistant_message: 'reply corrected' }],
        'the first exchange paired the wrong reply',
        null, null, 'spoof-channel'
      ));
      assert.strictEqual(revised.grant_id, DOOR_GRANT);
      const parent = store.transcripts().find((d) => d.session_id === '2026-10-27_r3' && d.superseded_by);
      const child = store.transcripts().find((d) => d.session_id === '2026-10-27_r3' && d.revision === 2);
      assert.strictEqual(parent.superseded_grant_id, DOOR_GRANT);
      assert.strictEqual(child.exchanges[0].grant_id, DOOR_GRANT);
    });
  });

  test('a session-graph lab row takes the actor grant, not the argument', () => {
    const row = labRow('save_to_layer', {
      content: 'weekly intake',
      metadata: { source: 'hub-bot', grant_id: 'spoofed-grant-id' }
    }, { base: '2026-10-27_intake', highest: 1, decision: { verdict: 'ok', next: 'append' } }, new Date(), intake);
    assert.strictEqual(row.grant_id, INTAKE_GRANT);
    assert.strictEqual(row.door, 'member');
    assert.notStrictEqual(row.grant_id, 'spoofed-grant-id');
  });
});

testGroup('a missing grant is unknown on a refusal, and a present grant is kept', () => {
  test('recordError stores unknown when the door has no grant, and the door grant when it has one', async () => {
    const { recordError } = await import('../src/error-log.js');
    await actorStore.run({ transport: 'http', personId: 'ada', clientId: 'c1', grantId: null, door: null }, () =>
      recordError({ emet_code: 'EMET-VAL-018', class_code: 'VALIDATION_ERROR', tool: 'save_to_layer', correlation_id: 'aaaaaaaaaaaaaaaa' }));
    await actorStore.run(door, () =>
      recordError({ emet_code: 'EMET-VAL-018', class_code: 'VALIDATION_ERROR', tool: 'save_to_layer', correlation_id: 'bbbbbbbbbbbbbbbb' }));
    await flushErrorLog();
    const missing = log.entries.find((row) => row.correlation_id === 'aaaaaaaaaaaaaaaa');
    const kept = log.entries.find((row) => row.correlation_id === 'bbbbbbbbbbbbbbbb');
    assert.strictEqual(missing.grant_id, 'unknown');
    assert.strictEqual(missing.transport, 'http');
    assert.strictEqual(kept.grant_id, DOOR_GRANT);
    assert.strictEqual(kept.door, 'member');
  });
});

testGroup('claimed-tag writes warn, then refuse on the kill date', () => {
  test('before the date the write is kept, the receipt warns, and the counter moves', async () => {
    _resetClaimedTagForTests();
    const { saveMemory } = await import('../src/tools.js');
    const db = layerHonouringDb();
    const { saved, traffic } = await withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2099-01-01', CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, async () => {
      const saved = await actorStore.run(claimed, () => saveMemory(db, 'A claimed working note.', 'working', { source: 'claimed-host', grant_id: 'spoofed-grant-id' }));
      return { saved, traffic: claimedTagTraffic() };
    });
    assert.strictEqual(saved.grant_id, null);
    const warning = saved.warnings.find((w) => /Claimed source tag only/.test(w));
    assert.ok(warning, 'receipt warnings name the claimed-tag path');
    assert.match(warning, /2099-01-01/);
    assert.match(warning, /keyed link, then owner sign-in, then assign tag, then initialize/);
    assert.strictEqual(db.row('working', saved.id).metadata.grant_id, null);
    assert.strictEqual(db.row('working', saved.id).metadata.claimed_tag, true);
    assert.notStrictEqual(db.row('working', saved.id).metadata.grant_id, 'spoofed-grant-id');
    assert.strictEqual(traffic.count, 1);
    assert.strictEqual(traffic.mode, 'warn');
    assert.strictEqual(traffic.kill_date, '2099-01-01');
    assert.strictEqual(traffic.callers[0].caller, 'claimed-host');
  });

  test('on and after the date a claimed drop is refused, nothing is written, and the log says unknown', async () => {
    _resetClaimedTagForTests();
    const store = makeStore();
    setStatusSeatForTests(async () => ({ gems_available: [], gems_active: [] }));
    try {
      const refused = await withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2020-01-01' }, () => withStore(store, () =>
        actorStore.run(claimed, () => dispatchTool('write_doc', {
          doc_id: 'drops/claimed-kill.md',
          content: 'this claimed drop is past the kill date\n',
          source: 'claimed-host',
          grant_id: 'spoofed-grant-id'
        }, { dbManager: store, logger: null }))));
      const body = bodyOf(refused);
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.emet_code, 'EMET-AUTH-040');
      assert.match(body.error.correlation_id, /^[0-9a-f]{16}$/);
      assert.match(body.error.message, /2020-01-01/);
      assert.match(body.error.message, new RegExp(ONBOARDING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(body.error.message, /Nothing was written/);
      assert.strictEqual(store.doc('drops/claimed-kill.md'), undefined);
      assert.strictEqual(store.col('documents_history').docs.length, 0);
      await flushErrorLog();
      const entry = log.entries.find((row) => row.correlation_id === body.error.correlation_id);
      assert.ok(entry, 'refusal logged');
      assert.strictEqual(entry.emet_code, 'EMET-AUTH-040');
      assert.strictEqual(entry.grant_id, 'unknown');
      assert.strictEqual(entry.tool, 'write_doc');
      const traffic = withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2020-01-01' }, () => claimedTagTraffic());
      assert.strictEqual(traffic.mode, 'refuse');
      assert.strictEqual(traffic.count, 1);

      const allowed = await withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2020-01-01' }, () => withStore(store, () =>
        actorStore.run(door, () => dispatchTool('write_doc', {
          doc_id: 'drops/real-grant.md',
          content: 'a granted drop after the kill date\n',
          source: 'spoof-source',
          grant_id: 'spoofed-grant-id'
        }, { dbManager: store, logger: null }))));
      const ok = bodyOf(allowed);
      assert.strictEqual(ok.success, true);
      assert.strictEqual(ok.data.grant_id, DOOR_GRANT);
      assert.strictEqual(ok.data.claimed_tag_warning, undefined);
      assert.strictEqual(store.doc('drops/real-grant.md').grant_id, DOOR_GRANT);

      const local = await withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2020-01-01' }, () => withStore(store, () =>
        dispatchTool('write_doc', {
          doc_id: 'drops/stdio-after.md',
          content: 'stdio is not the claimed-tag path\n',
          source: 'laptop'
        }, { dbManager: store, logger: null })));
      const stdio = bodyOf(local);
      assert.strictEqual(stdio.success, true);
      assert.strictEqual(stdio.data.grant_id, null);
      assert.strictEqual(store.doc('drops/stdio-after.md').door, 'stdio');
      assert.strictEqual(stdio.data.claimed_tag_warning, undefined);
    } finally {
      setStatusSeatForTests(null);
    }
  });

  test('emet_status reports the remaining claimed-tag traffic and the kill date', async () => {
    _resetClaimedTagForTests();
    const { saveMemory } = await import('../src/tools.js');
    const db = layerHonouringDb();
    await withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2099-06-01', CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, () =>
      actorStore.run(claimed, () => saveMemory(db, 'Counted claimed note.', 'working', { source: 'claimed-host' })));
    setStatusSeatForTests(async () => ({ gems_available: [], gems_active: [] }));
    try {
      const store = makeStore();
      const counted = await withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2099-06-01', CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, () =>
        withStore(store, () => dispatchTool('emet_status', {}, { dbManager: store, logger: null })));
      const countedData = bodyOf(counted).data;
      assert.strictEqual(countedData.claimed_tag_traffic.kill_date, '2099-06-01');
      assert.strictEqual(countedData.claimed_tag_traffic.kill_date_source, 'env');
      assert.strictEqual(countedData.claimed_tag_traffic.since_process_start, true);
      assert.strictEqual(countedData.claimed_tag_traffic.mode, 'warn');
      assert.ok(countedData.claimed_tag_traffic.count >= 1);
      const fresh = makeStore();
      const res = await withEnv({ EMET_CLAIMED_TAG_KILL_DATE: undefined, CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, () =>
        withStore(fresh, () => dispatchTool('emet_status', {}, { dbManager: fresh, logger: null })));
      const data = bodyOf(res).data;
      assert.strictEqual(data.claimed_tag_traffic.kill_date, '2026-12-15');
      assert.strictEqual(data.claimed_tag_traffic.proposed_kill_date, '2026-12-15');
      assert.strictEqual(data.claimed_tag_traffic.kill_date_source, 'default');
      assert.strictEqual(data.claimed_tag_traffic.kill_date_invalid, false);
      assert.strictEqual(data.claimed_tag_traffic.since_process_start, true);
      assert.strictEqual(data.claimed_tag_traffic.mode, claimedTagKillReached() ? 'refuse' : 'warn');
    } finally {
      setStatusSeatForTests(null);
    }
  });
});

testGroup('a malformed kill date is visible and does not move the date', () => {
  test('emet_status reports invalid_env, and the warning fires once per distinct text', () => {
    _resetClaimedTagForTests();
    const errors = [];
    const orig = console.error;
    console.error = (...args) => { errors.push(args.join(' ')); };
    try {
      withEnv({ EMET_CLAIMED_TAG_KILL_DATE: 'tomorrow', CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, () => {
        const first = claimedTagTraffic();
        const second = claimedTagTraffic();
        assert.strictEqual(first.kill_date, PROPOSED_CLAIMED_TAG_KILL_DATE);
        assert.strictEqual(second.kill_date, PROPOSED_CLAIMED_TAG_KILL_DATE);
        assert.strictEqual(first.kill_date_source, 'invalid_env');
        assert.strictEqual(first.kill_date_invalid, true);
        assert.strictEqual(first.kill_date_raw, 'tomorrow');
        assert.strictEqual(first.since_process_start, true);
      });
      withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2027-04-04', CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, () => {
        const set = claimedTagTraffic();
        assert.strictEqual(set.kill_date, '2027-04-04');
        assert.strictEqual(set.kill_date_source, 'env');
        assert.strictEqual(set.kill_date_invalid, false);
        assert.strictEqual(set.kill_date_raw, '2027-04-04');
      });
    } finally {
      console.error = orig;
    }
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /tomorrow/);
    assert.match(errors[0], /2026-12-15/);
  });
});

testGroup('after the kill date every guarded tool refuses, and a credential still writes', () => {
  test('save_to_layer, write_doc, patch_doc, retire_doc, accept_nonconformance, save_transcript, emet_transcript_append, and revise_transcript', async () => {
    _resetClaimedTagForTests();
    const {
      saveMemory, writeDoc, patchDoc, retireDoc, acceptNonconformance,
      saveTranscript, transcriptAppend, reviseTranscript
    } = await import('../src/tools.js');
    const store = makeStore();
    store.col('documents').docs.push(
      { doc_id: 'threads/kill-patch.md', version: 1, content: 'alpha line\n', sha256: 'a'.repeat(64), updated_by: 'laptop' },
      { doc_id: 'drops/kill-retire.md', version: 1, content: 'a drop to retire\n', sha256: 'b'.repeat(64), updated_by: 'laptop' },
      {
        doc_id: 'threads/kill-nc.md', version: 1, content: 'missing the required heading\n',
        sha256: 'c'.repeat(64), updated_by: 'laptop',
        conformance: { verdict: 'nonconforming', failures: ['missing heading'] }
      }
    );
    store.col('transcripts').docs.push({
      _id: 'parent-rev',
      session_id: '2026-10-27_killrev',
      channel: 'claimed-host',
      exchange_count: 1,
      revision: 1,
      exchanges: [{ exchange_index: 0, user_message: 'hello', assistant_message: 'reply' }]
    });
    const layers = layerHonouringDb();
    const exchange = { user_message: 'a claimed turn', assistant_message: 'a claimed reply' };
    const refused = async (label, fn, untouched) => {
      let err = null;
      try { await fn(); } catch (e) { err = e; }
      assert.ok(err, `${label} was not refused`);
      assert.strictEqual(err.emetCode, 'EMET-AUTH-040', `${label}: ${err.emetCode || ''} ${err.message}`);
      assert.match(err.message, /Nothing was written/);
      untouched();
    };
    await withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2020-01-01', CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, () =>
      withStore(store, () => actorStore.run(claimed, async () => {
        const cases = [
          ['save_to_layer', () => saveMemory(layers, 'claimed after the kill date', 'working', { source: 'claimed-host' }),
            () => assert.strictEqual(layers.writes.length, 0)],
          ['write_doc', () => writeDoc('drops/kill-new.md', 'claimed drop after the kill date\n', 'claimed-host'),
            () => assert.strictEqual(store.doc('drops/kill-new.md'), undefined)],
          ['patch_doc', () => patchDoc('threads/kill-patch.md', 'alpha line', 'beta line', 'claimed-host', null, null, { reason: 'claimed patch after the kill date' }),
            () => assert.strictEqual(store.doc('threads/kill-patch.md').content, 'alpha line\n')],
          ['retire_doc', () => retireDoc('drops/kill-retire.md', 'filed after the kill date', 'claimed-host'),
            () => assert.notStrictEqual(store.doc('drops/kill-retire.md').retired, true)],
          ['accept_nonconformance', () => acceptNonconformance('threads/kill-nc.md', 'accepted after the kill date', 'claimed-host'),
            () => assert.ok(!(store.doc('threads/kill-nc.md').conformance || {}).accepted)],
          ['save_transcript', () => saveTranscript('2026-10-27_killsave', 1_700_000_000, null, [exchange], 'claimed-host'),
            () => assert.strictEqual(store.transcripts().some((d) => d.session_id === '2026-10-27_killsave'), false)],
          ['emet_transcript_append', () => transcriptAppend({
            session_id: '2026-10-27_killappend', user_message: 'u', assistant_message: 'a', channel: 'claimed-host'
          }), () => assert.strictEqual(store.transcripts().some((d) => d.session_id === '2026-10-27_killappend'), false)],
          ['revise_transcript', () => reviseTranscript(
            '2026-10-27_killrev',
            [{ user_message: 'hello corrected', assistant_message: 'reply corrected' }],
            'the pairing was wrong on this part',
            null, null, 'claimed-host'
          ), () => {
            assert.strictEqual(store.transcripts().length, 1);
            assert.ok(!store.transcripts()[0].superseded_by);
          }]
        ];
        for (const [label, fn, untouched] of cases) await refused(label, fn, untouched);
      })));
  });

  test('a bound login and a sub-key still write, with no claimed-tag warning', async () => {
    // grantId is absent on purpose. isClaimedTagOnly is also false when a
    // grant is present, so a granted write would stay green if 'bound' or
    // 'subkey' were added to the claimed set. These two have no grant.
    const { saveMemory } = await import('../src/tools.js');
    const bound = {
      transport: 'http', personId: 'ada', clientId: 'login-bound',
      grantId: null, door: 'member', sourceTag: 'laptop',
      authenticated: true, scopes: ['emet']
    };
    const subkey = {
      transport: 'http', personId: 'alex', clientId: 'subkey-client',
      grantId: null, door: 'member', sourceTag: 'laptop',
      sourceBasis: 'subkey', effectiveTag: 'intake-bot', subkeyId: 'key-intake-1',
      authenticated: true, scopes: ['emet']
    };
    const db = layerHonouringDb();
    await withEnv({ EMET_CLAIMED_TAG_KILL_DATE: '2020-01-01', CASCADE_CLAIMED_TAG_KILL_DATE: undefined }, async () => {
      const boundSaved = await actorStore.run(bound, () => saveMemory(
        db, 'Bound login after the kill date.', 'working', { source: 'hub-bot' }
      ));
      assert.strictEqual(boundSaved.source, 'laptop');
      assert.ok(!boundSaved.warnings.some((w) => /Claimed source tag only/.test(w)));
      assert.ok(!db.row('working', boundSaved.id).metadata.claimed_tag);
      const subSaved = await actorStore.run(subkey, () => saveMemory(
        db, 'Sub-key after the kill date.', 'working', { source: 'ignored-caller' }
      ));
      assert.strictEqual(subSaved.source, 'intake-bot');
      assert.strictEqual(db.row('working', subSaved.id).metadata.source_basis, 'subkey');
      assert.ok(!subSaved.warnings.some((w) => /Claimed source tag only/.test(w)));
      assert.ok(!db.row('working', subSaved.id).metadata.claimed_tag);
    });
  });
});

testGroup('the receipt names the token family when the source tag is shared', () => {
  // Option B (Tester R1). At thatcommit saveMemory already wrote metadata.grant_id
  // from writerStamp, and recordError already stored actor.grantId. A test
  // that injects an actor with grantId preset, then asserts the row and the
  // error log, passes on that base. It fails there only because the receipt
  // omitted grant_id. Episodic ref 728 and the 729 refusal stored the shared
  // hub-bot label as a grant because that label was what an
  // earlier door had put on the actor, before the family stamp. This test
  // does not recreate that door. It resolves a verified token
  // (verifyAccessToken → httpToolActor) whose source tag is the shared label
  // and whose grant is the token family, then locks the receipt.
  test('verifyAccessToken resolves the family, and the receipt shows that id', async () => {
    const { saveMemory, handleError } = await import('../src/tools.js');
    const tokenDb = memDb();
    const provider = new MongoOAuthProvider(() => tokenDb, {
      passphrase: 'p', issuerUrl: 'https://emet.example', fetch: async () => ({ ok: false, status: 404 })
    });
    const issued = await provider._issueTokens(
      'intake-login', ['emet'], null, 'intake', MEMBER_GRANT, INTAKE_GRANT, 'hub-bot'
    );
    const verified = await provider.verifyAccessToken(issued.access_token);
    assert.strictEqual(verified.extra.sourceTag, 'hub-bot');
    assert.strictEqual(verified.extra.grantId, INTAKE_GRANT);
    assert.notStrictEqual(verified.extra.grantId, verified.extra.sourceTag);
    const actor = httpToolActor({ authInfo: verified });
    assert.strictEqual(actor.grantId, INTAKE_GRANT);
    assert.strictEqual(actor.sourceTag, 'hub-bot');
    assert.strictEqual(actor.door, 'member');
    const db = layerHonouringDb();
    const saved = await actorStore.run(actor, () => saveMemory(
      db,
      'Weekly intake. The source tag is shared. The grant is the token family.',
      'episodic',
      { source: 'hub-bot', grant_id: 'hub-bot', door: 'owner', custom: { grant_id: 'hub-bot' } }
    ));
    assert.strictEqual(saved.grant_id, INTAKE_GRANT);
    assert.strictEqual(saved.source, 'hub-bot');
    const row = db.row('episodic', saved.id);
    assert.strictEqual(row.metadata.grant_id, INTAKE_GRANT);
    assert.strictEqual(row.metadata.door, 'member');
    assert.notStrictEqual(row.metadata.grant_id, 'hub-bot');

    const res = await actorStore.run(actor, () => handleError(
      new ValidationError('source', 'HTTP attribution preflight was refused', { code: 'EMET-AUTH-039' }),
      'save_to_layer'
    ));
    const body = bodyOf(res);
    assert.strictEqual(body.error.emet_code, 'EMET-AUTH-039');
    await flushErrorLog();
    const entry = log.entries.find((row) => row.correlation_id === body.error.correlation_id);
    assert.ok(entry);
    assert.strictEqual(entry.grant_id, INTAKE_GRANT);
    assert.notStrictEqual(entry.grant_id, 'hub-bot');
  });
});

summary('R3 grant stamp');
