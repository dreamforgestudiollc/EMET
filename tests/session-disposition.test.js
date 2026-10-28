/**
 * Session disposition: a records/ batch notes an overdue session or a
 * superseded transcript. It does not close the session and it does not
 * invent an emet_session_close receipt.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
delete process.env.EMET_SOURCE_TAGS;
delete process.env.EMET_TEMPLATE_MAP;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-28T16:00:00.000Z');
const BATCH = 'records/example-batch.md';
const INSERTED = '6ae1df09c4da08b2cadc1fb4';
const OCT26 = '2026-10-28_mb-main-chat-backfill-2026-10-26';
const OCT26_PART = `${OCT26}_verbatim_part1`;
const OPEN_PARTS = [OCT26_PART];
const EXAMPLE_OVERDUE = '2026-09-30_example-session';

const {
  SESSION_DISPOSITION_TEMPLATE, loadShipped, clearShippedCache, templateFor,
  isGovernedByShippedCopy, extraMappings, validateDocument, checkRecord,
  parseDispositionRows, VERDICT, STATUS
} = await import('../src/conformance.js');
const { validateDoc } = await import('../src/tools.js');
const { checkpointDecision, checkpointStatus, readDispositionCoverage } = await import('../src/checkpoint.js');
const { makeStore, withStore } = await import('./memstore.js');
const { checkReceipts } = await import('../src/session.js');

console.log('\n=== session disposition ===');

function at(msAgo) {
  return new Date(NOW.getTime() - msAgo);
}

function batchText() {
  return [
    '# SESSION DISPOSITION',
    '',
    '## §0 RECORD CONTROL',
    '- Template: `templates/SESSIONDISPOSITION.md` rev 1 · Record revision: the store\'s version governs',
    '- Session id: 2026-10-28_session-disposition · Source tag: grok-project · Written (local): 2026-10-28 11:45 ET',
    '- Scope: example batch for the mapper',
    '- Rows: 4',
    '',
    '## §1 DISPOSITION',
    '| session_id | opened_at | last_saved_at | disposition | reason | evidence | carried_forward_to | inserted_id |',
    '|---|---|---|---|---|---|---|---|',
    `| ${EXAMPLE_OVERDUE} | 2026-09-30T11:03:13.967Z | None — no live transcript save in this example. | ABANDONED_NO_TRANSCRIPT | Checkpoint overdue as of 2026-10-28 and no live transcript save. No transcript will be reconstructed and no receipt is written. The session row stays. | example inventory; last_saved_at is null. | None — no successor session. | None — this row dispositions the session, not one transcript document. |`,
    `| ${OCT26} | None — this row dispositions the early save_transcript, not the session open. | None — the live Oct 26 backfill is the verbatim part, not this inserted id. | SUPERSEDED_BY_LATER_SESSION | Early save_transcript is a SUPERSEDED duplicate of the verbatim_part1 append path. The transcript row is retained and is not deleted. | inserted_id ${INSERTED} has 8 exchanges. | ${OCT26_PART} | ${INSERTED} |`,
    `| ${OCT26} | None — not an overdue-inventory timestamp. This row records the open session. | None — this row does not invent a save time. | RETAINED_OPEN_CRITICAL | This open backfill still needs a formal emet_session_close. The session row stays. | Coverage note. Do not invent a close or a receipt. | None — formal close is still owed on this session. | None — this row dispositions the session, not one transcript document. |`,
    `| ${OCT26_PART} | None — not an overdue-inventory timestamp. | None — this row does not invent a save time. | RETAINED_OPEN_CRITICAL | This open backfill still needs a formal emet_session_close. Do not invent a close or a receipt. | Coverage note. | None — formal close is still owed on this session. | None — this row dispositions the session, not one transcript document. |`,
    '',
    '## §2 LIMITS',
    'This record does not write an emet_session_close receipt and does not delete the transcript.',
    '',
    '## §3 SUPERSESSION',
    'None — no subject left this revision.',
    ''
  ].join('\n');
}

function conformingDoc(content, extra = {}) {
  return {
    doc_id: BATCH,
    content,
    version: 1,
    retired: false,
    updated_at: NOW,
    conformance: { verdict: 'conforms', template: SESSION_DISPOSITION_TEMPLATE },
    ...extra
  };
}

clearShippedCache();

testGroup('the template is in force and mapped', () => {
  test('SESSIONDISPOSITION ships IN FORCE with approval and is under the shipped-copy lock', () => {
    const t = loadShipped(SESSION_DISPOSITION_TEMPLATE, { cache: false });
    assert.ok(t);
    assert.strictEqual(t.status, STATUS.IN_FORCE);
    assert.ok(/user/.test(t.approved));
    assert.ok(t.required_sections.length >= 4);
    assert.strictEqual(isGovernedByShippedCopy(SESSION_DISPOSITION_TEMPLATE), true);
  });

  test('records/ maps to the template and the map cannot redirect it', () => {
    assert.strictEqual(templateFor(BATCH), SESSION_DISPOSITION_TEMPLATE);
    assert.strictEqual(templateFor('records/one-session.md'), SESSION_DISPOSITION_TEMPLATE);
    const { added, refused } = extraMappings(`records/=templates/SEED.md`);
    assert.strictEqual(added['records/'], undefined);
    assert.ok(refused.some((r) => /L3/.test(r)));
  });

  test('the template example marks the duplicate transcript and the open backfill', () => {
    const text = fs.readFileSync(path.join(ROOT, 'templates/SESSIONDISPOSITION.md'), 'utf8');
    assert.ok(text.includes(INSERTED));
    assert.ok(text.includes('SUPERSEDED'));
    assert.ok(text.includes('duplicate'));
    assert.ok(text.includes('grok-bot-vm-453484571 Wed Oct 28 07:38:40 EDT 2026'));
    assert.ok(text.includes('no local shell MCP'));
    assert.ok(text.includes(OCT26_PART));
    assert.ok(text.includes('emet_transcript_append'));
    assert.ok(text.includes('31-exchange'));
    assert.ok(text.includes('8:40'));
    assert.ok(text.includes('hidden wakes'));
    assert.ok(text.includes('Do not invent'));
  });
});

testGroup('validate_doc on the template', () => {
  const good = batchText();

  test('the batch conforms, and validate_doc reports conforms without writing', async () => {
    const door = validateDocument(BATCH, good, null);
    assert.strictEqual(door.verdict, VERDICT.CONFORMS, JSON.stringify(door.failures));
    assert.strictEqual(door.template, SESSION_DISPOSITION_TEMPLATE);
    const freestanding = await validateDoc({ content: good, template_id: SESSION_DISPOSITION_TEMPLATE, doc_id: BATCH });
    assert.strictEqual(freestanding.verdict, VERDICT.CONFORMS, JSON.stringify(freestanding.failures));
    assert.strictEqual(freestanding.stored, false);
  });

  test('a short reason, a bad disposition, and a dropped subject fail', () => {
    const template = loadShipped(SESSION_DISPOSITION_TEMPLATE, { cache: false });
    const short = good.replace(
      'Checkpoint overdue as of 2026-10-28 and no live transcript save. No transcript will be reconstructed and no receipt is written. The session row stays.',
      'too short'
    );
    assert.ok(checkRecord(short, template, { doc_id: BATCH }).failures.some((f) => /reason is shorter than 10/.test(f)));
    const bad = good.replace('ABANDONED_NO_TRANSCRIPT', 'DELETED');
    assert.ok(checkRecord(bad, template, { doc_id: BATCH }).failures.some((f) => /DELETED/.test(f)));
    const firstId = EXAMPLE_OVERDUE;
    const dropped = good.replace(new RegExp(`\\| ${firstId} \\|[^\\n]+\\n`), '');
    const again = checkRecord(dropped, template, { previous: good });
    assert.ok(again.failures.some((f) => /no disposition/.test(f) && f.includes(firstId)), JSON.stringify(again.failures));
  });

  test('an inserted_id that is not superseded fails, and a scoped none is not a transcript id', () => {
    const template = loadShipped(SESSION_DISPOSITION_TEMPLATE, { cache: false });
    const flipped = good.replace(
      `| ${OCT26} | None — this row dispositions the early save_transcript, not the session open. | None — the live Oct 26 backfill is the verbatim part, not this inserted id. | SUPERSEDED_BY_LATER_SESSION |`,
      `| ${OCT26} | None — this row dispositions the early save_transcript, not the session open. | None — the live Oct 26 backfill is the verbatim part, not this inserted id. | ABANDONED_NO_TRANSCRIPT |`
    );
    const failures = checkRecord(flipped, template, { doc_id: BATCH }).failures;
    assert.ok(failures.some((f) => /SUPERSEDED_BY_LATER_SESSION/.test(f)), JSON.stringify(failures));
  });
});

testGroup('the batch keeps the example rows and the coverage note', () => {
  const text = batchText();
  const rows = parseDispositionRows(text);

  test('the example session, the duplicate, and the open part are present', () => {
    const ids = new Set(rows.map((r) => r.session_id));
    assert.ok(ids.has(EXAMPLE_OVERDUE));
    assert.ok(ids.has(OCT26));
    for (const id of OPEN_PARTS) assert.ok(ids.has(id), id);
    assert.strictEqual(rows.length, 4);
  });

  test('the early save_transcript stays SUPERSEDED and is not a session close', () => {
    const dup = rows.find((r) => r.inserted_id === INSERTED);
    assert.ok(dup, 'missing inserted_id row');
    assert.strictEqual(dup.session_id, OCT26);
    assert.strictEqual(dup.disposition, 'SUPERSEDED_BY_LATER_SESSION');
    assert.strictEqual(dup.carried_forward_to, OCT26_PART);
    assert.ok(/not deleted/i.test(dup.reason));
    const sessionRow = rows.find((r) => r.session_id === OCT26 && !r.inserted_id);
    assert.strictEqual(sessionRow.disposition, 'RETAINED_OPEN_CRITICAL');
  });

  test('the open part still needs a formal close', () => {
    assert.ok(/do not invent/i.test(text));
    for (const id of OPEN_PARTS) {
      const row = rows.find((r) => r.session_id === id);
      assert.ok(row, id);
      assert.strictEqual(row.disposition, 'RETAINED_OPEN_CRITICAL');
      assert.strictEqual(row.inserted_id, null);
    }
    const base = rows.find((r) => r.session_id === OCT26 && !r.inserted_id);
    assert.strictEqual(base.disposition, 'RETAINED_OPEN_CRITICAL');
  });
});

testGroup('checkpoint recognizes a session-level disposition', () => {
  test('a covered session is not due, and a transcript-only SUPERSEDED row does not cover one', async () => {
    const db = makeStore();
    const stale = EXAMPLE_OVERDUE;
    db.collection('emet_sessions').docs.push(
      { _id: stale, opened: true, closed: false, opened_at: at(10 * DAY) },
      { _id: OCT26, opened: true, closed: false, opened_at: at(10 * DAY) },
      { _id: 'still-open', opened: true, closed: false, opened_at: at(10 * DAY) }
    );
    db.collection('documents').docs.push(conformingDoc(batchText()));
    const cp = await checkpointStatus(db, NOW);
    const ids = (cp.sessions || []).map((s) => s.session_id);
    assert.ok(!ids.includes(stale), JSON.stringify(ids));
    assert.ok(!ids.includes(OCT26));
    assert.ok(ids.includes('still-open'));
    const covered = (cp.dispositioned || []).find((s) => s.session_id === OCT26);
    assert.strictEqual(covered.disposition, 'RETAINED_OPEN_CRITICAL');
    assert.notStrictEqual(covered.disposition, 'SUPERSEDED_BY_LATER_SESSION');
    const onlyTranscript = makeStore();
    // A record that contains only the inserted_id row must not clear the session.
    const one = [
      '# x',
      '## §0 RECORD CONTROL',
      '- Template: `templates/SESSIONDISPOSITION.md` rev 1 · Record revision: the store\'s version governs',
      '- Session id: 2026-10-28_session-disposition · Source tag: grok-project · Written (local): 2026-10-28 11:45 ET',
      '- Scope: transcript duplicate only',
      '- Rows: 1',
      '## §1 DISPOSITION',
      '| session_id | opened_at | last_saved_at | disposition | reason | evidence | carried_forward_to | inserted_id |',
      '|---|---|---|---|---|---|---|---|',
      batchText().split('\n').find((line) => line.includes(INSERTED)),
      '## §2 LIMITS',
      'This record does not write an emet_session_close receipt and does not delete the transcript.',
      '## §3 SUPERSESSION',
      'None — no subject left this revision.'
    ].join('\n');
    onlyTranscript.collection('emet_sessions').docs.push(
      { _id: OCT26, opened: true, closed: false, opened_at: at(10 * DAY) }
    );
    onlyTranscript.collection('documents').docs.push(conformingDoc(one, { doc_id: 'records/transcript-only.md' }));
    const bare = await checkpointStatus(onlyTranscript, NOW);
    assert.strictEqual(bare.due, true);
    assert.strictEqual(bare.sessions[0].session_id, OCT26);
  });

  test('a nonconforming or retired record does not clear the overdue session', async () => {
    const db = makeStore();
    db.collection('emet_sessions').docs.push(
      { _id: EXAMPLE_OVERDUE, opened: true, closed: false, opened_at: at(10 * DAY) }
    );
    db.collection('documents').docs.push(conformingDoc(batchText(), {
      conformance: { verdict: 'nonconforming', template: SESSION_DISPOSITION_TEMPLATE, accepted: { reason: 'kept for the record of the marker', covers_version: 1 } }
    }));
    assert.strictEqual((await checkpointStatus(db, NOW)).due, true);
    db.collection('documents').docs[0].conformance = { verdict: 'conforms', template: SESSION_DISPOSITION_TEMPLATE };
    db.collection('documents').docs[0].retired = true;
    assert.strictEqual((await checkpointStatus(db, NOW)).due, true);
  });

  test('the later conforming record wins', async () => {
    const db = makeStore();
    db.collection('emet_sessions').docs.push(
      { _id: OCT26, opened: true, closed: false, opened_at: at(10 * DAY) }
    );
    const earlier = conformingDoc(batchText(), { updated_at: at(DAY), version: 1, doc_id: 'records/earlier.md' });
    const laterLine = batchText().split('\n').find((line) => line.startsWith(`| ${OCT26} |`) && line.includes('RETAINED_OPEN_CRITICAL'));
    const fixedLine = laterLine
      .replace('RETAINED_OPEN_CRITICAL', 'CARRIED_FORWARD')
      .replace('None — formal close is still owed on this session.', 'records/later-session.md');
    const laterBody = batchText().replace(laterLine, fixedLine);
    db.collection('documents').docs.push(earlier, conformingDoc(laterBody, {
      doc_id: 'records/later.md', updated_at: NOW, version: 2
    }));
    const map = await readDispositionCoverage(db);
    assert.strictEqual(map.get(OCT26).disposition, 'CARRIED_FORWARD');
    assert.strictEqual(map.get(OCT26).doc_id, 'records/later.md');
  });

  test('pure decision: no cover leaves the fresh shape unchanged', () => {
    const fresh = checkpointDecision([{ session_id: 's', opened: true, opened_at: at(1000), last_saved_at: at(1000) }], NOW);
    assert.deepStrictEqual(fresh, { due: false, save_with: ['emet_transcript_append', 'save_transcript'] });
  });
});

testGroup('emet_session_close stays receipt-strict', () => {
  test('checkReceipts still reports missing receipts', () => {
    const r = checkReceipts(undefined, {
      documents: [], episodic: null, transcript: { present: false }, handoff_doc: 'HANDOFF.md'
    });
    assert.strictEqual(r.supplied, false);
    assert.ok(r.problems[0].includes('receipts not supplied'));
  });

  test('a disposition in the store does not make a close complete', async () => {
    const { sessionClose } = await import('../src/session.js');
    const db = makeStore();
    await withStore(db, async () => {
      db.collection('documents').docs.push(conformingDoc(batchText()));
      db.collection('emet_sessions').docs.push(
        { _id: OCT26, opened: true, closed: false, opened_at: at(2 * DAY) }
      );
      const closed = await sessionClose({ session_id: OCT26 });
      assert.notStrictEqual(closed.state, 'complete');
      assert.strictEqual(closed.checked.receipts_supplied, false);
      assert.ok(closed.checked.receipt_problems.some((p) => /receipt/i.test(p)));
      const row = db.collection('emet_sessions').docs.find((d) => d._id === OCT26);
      assert.notStrictEqual(row.closed, true);
    });
  });
});

testGroup('revert: dropping the cover lists the session as due', () => {
  test('a mutant that skips the disposition line marks a covered session due', async () => {
    const row = { session_id: 'old', opened: true, opened_at: at(3 * DAY), last_saved_at: at(3 * DAY) };
    const covered = new Map([['old', { disposition: 'ABANDONED_NO_TRANSCRIPT', doc_id: BATCH, version: 1 }]]);
    assert.strictEqual(checkpointDecision([row], NOW, covered).due, false);
    const dir = path.join(ROOT, 'tests/.mutants');
    await fs.promises.mkdir(dir, { recursive: true });
    const src = fs.readFileSync(path.join(ROOT, 'src/checkpoint.js'), 'utf8');
    const out = src.replace(
      '    if (cover) { dispositioned.push(cover); continue; } // disposition-cover',
      '    if (false) { dispositioned.push(cover); continue; } // disposition-cover'
    ).replaceAll("from './", "from '../../src/");
    const file = path.join(dir, 'disposition-cover.mjs');
    await fs.promises.writeFile(file, out);
    const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
    assert.strictEqual(mod.checkpointDecision([row], NOW, covered).due, true);
  });
});

summary('session disposition');
