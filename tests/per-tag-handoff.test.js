/**
 * Per-tag handoffs. Each rule is asserted on the production check.
 * The flag defaults to off. These tests set it for the assertion they name.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from '../src/validation.js';
import { refuseBotMainRecord } from '../src/tools.js';
import { actorStore } from '../src/persons.js';
import {
  authorizeHandoffWrite, seedOpeners, decideRowWrite, buildView, stampWithoutAsOf,
  tagHandoffMode, handoffAgingDays, staleOpenHours
} from '../src/per-tag-handoff.js';
import { assessContinuityCurrency, continuityCurrencyBlockEnabled } from '../src/continuity-currency.js';
import { DEFAULT_STALENESS_DAYS } from '../src/pages.js';
import {
  perTagInitial, perTagHandoffStep, perTagInvariant, stampCounterSteps
} from '../src/per-tag-handoff-statechart.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = 'hub-tag';
const WRITER = 'writer-tag';

function withEnv(extra, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(extra)) {
    prev[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function codeOf(fn) {
  try { fn(); } catch (error) {
    assert.ok(error instanceof ValidationError, error && error.message);
    return error.emetCode;
  }
  assert.fail('expected a refusal');
}

function board() {
  return [
    '## §1 HALF-STATE',
    '| Id | State | Next action |',
    '| --- | --- | --- |',
    '| B-010 | open | wait |',
    '## §3 OPEN BOARD',
    '| Id | Status | Next action |',
    '| --- | --- | --- |'
  ].join('\n');
}

function handoff(row, state, next, tag) {
  return {
    doc_id: `HANDOFF/${tag}.md`,
    tag,
    version: 1,
    updated_at: '2026-11-03T00:00:00.000Z',
    content: [
      '## §1 OVERALL PICTURE',
      '| Row | State | Next step |',
      '| --- | --- | --- |',
      `| ${row} | ${state} | ${next} |`,
      'Close verification: episodic 3'
    ].join('\n')
  };
}

testGroup('name', () => {
  test('HANDOFF/<tag>.md is accepted for its own credential, and handoffs/<tag>.md is not used', () => {
    const own = authorizeHandoffWrite({
      docId: `HANDOFF/${WRITER}.md`, mode: 'enforce', credentialTag: WRITER, registered: true, ownerPerson: 'owner'
    });
    assert.strictEqual(own.tag, WRITER);
    assert.strictEqual(own.person, 'owner');
    assert.strictEqual(codeOf(() => authorizeHandoffWrite({
      docId: `handoffs/${WRITER}.md`, mode: 'enforce', credentialTag: WRITER, registered: true
    })), 'EMET-DOC-084');
  });
});

testGroup('gap', () => {
  test('a registered non-bot write of HANDOFF.md or another bot handoff is refused in enforce', () => {
    withEnv({
      EMET_TAG_HANDOFFS: 'enforce',
      EMET_HUB_TAG: HUB,
      EMET_SOURCE_TAGS: `${HUB},${WRITER},notebook`,
      EMET_RECORD_DOCS: `bots/${WRITER}/HANDOFF.md`
    }, () => {
      assert.strictEqual(tagHandoffMode(), 'enforce');
      assert.throws(() => refuseBotMainRecord('HANDOFF.md', 'notebook', 'write_doc'), /hub handoff/);
      assert.throws(() => refuseBotMainRecord(`bots/${WRITER}/HANDOFF.md`, 'notebook', 'write_doc'), /handoff/);
    });
  });

  test('the same write is kept when the flag is off, which is the gap', () => {
    withEnv({ EMET_TAG_HANDOFFS: 'off', EMET_SOURCE_TAGS: `${HUB},notebook`, EMET_HUB_TAG: HUB }, () => {
      assert.doesNotThrow(() => refuseBotMainRecord('HANDOFF.md', 'notebook', 'write_doc'));
      assert.doesNotThrow(() => refuseBotMainRecord(`bots/${WRITER}/HANDOFF.md`, 'notebook', 'write_doc'));
    });
  });

  test('enforce refuses another tag folder, and warn keeps a warning', () => {
    assert.strictEqual(codeOf(() => authorizeHandoffWrite({
      docId: `bots/${WRITER}/HANDOFF.md`, mode: 'enforce', credentialTag: 'notebook', isHub: false, registered: true
    })), 'EMET-DOC-084');
    const warned = authorizeHandoffWrite({
      docId: 'HANDOFF.md', mode: 'warn', credentialTag: 'notebook', isHub: false, registered: true
    });
    assert.ok(warned.warning);
  });
});

testGroup('claimed-only', () => {
  test('a claimed-only tag is refused on HANDOFF/ before any kill date', () => {
    withEnv({ EMET_TAG_HANDOFFS: 'warn', EMET_HUB_TAG: HUB, EMET_CLAIMED_TAG_KILL_DATE: '2026-12-15' }, () => {
      const actor = { transport: 'http', sourceTag: HUB, sourceBasis: 'declared', declaredTag: WRITER, door: 'member' };
      actorStore.run(actor, () => {
        assert.strictEqual(codeOf(() => refuseBotMainRecord(`HANDOFF/${WRITER}.md`, WRITER, 'write_doc')), 'EMET-DOC-087');
      });
    });
  });
});

testGroup('rows', () => {
  test('a foreign row patch is refused, an own row patch is accepted, and the hub needs a marked conflict', () => {
    const openers = { 'B-010': { opener_tag: WRITER, opened_at: '2026-11-01T00:00:00.000Z', opened_in_version: 2 } };
    assert.strictEqual(codeOf(() => decideRowWrite({
      mode: 'enforce', writer: 'notebook', hub: HUB, openers, changed: ['B-010'], conflicts: []
    })), 'EMET-DOC-085');
    const own = decideRowWrite({
      mode: 'enforce', writer: WRITER, hub: HUB, openers, changed: ['B-010'], conflicts: []
    });
    assert.deepStrictEqual(own.warnings, []);
    assert.strictEqual(codeOf(() => decideRowWrite({
      mode: 'enforce', writer: HUB, hub: HUB, openers, changed: ['B-010'], conflicts: []
    })), 'EMET-DOC-085');
    const stamp = { as_of: '2026-11-10T15:00:00.000Z', view_sha256: 'ab'.repeat(32) };
    const resolved = decideRowWrite({
      mode: 'enforce', writer: HUB, hub: HUB, openers, changed: ['B-010'], conflicts: ['B-010'],
      resolve: { row_id: 'B-010', handoff_view: stamp }, currentStamp: stamp
    });
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(codeOf(() => decideRowWrite({
      mode: 'enforce', writer: HUB, hub: HUB, openers, changed: ['B-010'], conflicts: ['B-010'],
      resolve: { row_id: 'B-010', handoff_view: { view_sha256: stamp.view_sha256 } }, currentStamp: stamp
    })), 'EMET-DOC-085');
  });

  test('rows already on the board when the flag turns on belong to the hub', () => {
    const seeded = seedOpeners(board(), null, HUB, '2026-11-10T15:00:00.000Z', 4);
    assert.strictEqual(seeded['B-010'].opener_tag, HUB);
    assert.strictEqual(seeded['B-010'].opened_in_version, 4);
    const kept = seedOpeners(board(), seeded, 'other', '2026-11-11T00:00:00.000Z', 5);
    assert.strictEqual(kept['B-010'].opener_tag, HUB);
  });

  test('a bot tag is not refused on STATE.md when the flag is on, and is still refused on HANDOFF.md', () => {
    withEnv({
      EMET_TAG_HANDOFFS: 'enforce',
      EMET_HUB_TAG: HUB,
      EMET_SOURCE_TAGS: `${HUB},${WRITER}`,
      EMET_RECORD_DOCS: `bots/${WRITER}/HANDOFF.md`
    }, () => {
      assert.doesNotThrow(() => refuseBotMainRecord('STATE.md', WRITER, 'patch_doc'));
      assert.throws(() => refuseBotMainRecord('HANDOFF.md', WRITER, 'write_doc'), /bot tag/);
    });
  });
});

testGroup('hub handoff', () => {
  test('only the hub writes HANDOFF.md', () => {
    assert.strictEqual(codeOf(() => authorizeHandoffWrite({
      docId: 'HANDOFF.md', mode: 'enforce', credentialTag: WRITER, isHub: false, isBot: false, registered: true
    })), 'EMET-DOC-084');
    const hub = authorizeHandoffWrite({
      docId: 'HANDOFF.md', mode: 'enforce', credentialTag: HUB, isHub: true, registered: true
    });
    assert.strictEqual(hub.ok, true);
  });
});

testGroup('continuity stays warn-only', () => {
  test('an open session episodic is not a pointer, the in-progress line shows, and stale-open is 24 hours', () => {
    const handoffDoc = {
      doc_id: `HANDOFF/${WRITER}.md`, version: 1, updated_at: '2026-11-10T12:00:00.000Z',
      content: 'Close verification: episodic 9\n'
    };
    const entry = { id: 9, timestamp: '2026-11-10T12:00:00.000Z', content: 'handoff work on the board', tags: ['material'], metadata: { source: WRITER } };
    const open = assessContinuityCurrency({
      handoff: handoffDoc, entries: [entry], sessions: [{ episodic_id: 9, closed: false }],
      openEpisodicIds: new Set([9])
    });
    assert.strictEqual(open.handoff.claim_basis, 'open_session');
    assert.strictEqual(open.handoff.cited_episodic_id, null);
    assert.strictEqual(open.status, 'current');
    assert.strictEqual(open.does_not_block, true);
    assert.strictEqual(open.block_enabled, false);
    const asOf = '2026-11-10T15:00:00.000Z';
    const fresh = buildView({
      inputs: [handoff('B-010', 'open', 'wait', WRITER)],
      board: { doc_id: 'STATE.md', version: 4, content: board() },
      as_of: asOf,
      person: 'owner',
      open_sessions: [{ tag: WRITER, since: '2026-11-10T14:00:00.000Z', material: true, closed: false }]
    });
    assert.match(fresh.text, new RegExp(`in progress by ${WRITER} since`));
    assert.doesNotMatch(fresh.text, /stale-open/);
    const stale = buildView({
      inputs: [handoff('B-010', 'open', 'wait', WRITER)],
      board: { doc_id: 'STATE.md', version: 4, content: board() },
      as_of: asOf,
      person: 'owner',
      open_sessions: [{ tag: WRITER, since: '2026-11-09T14:00:00.000Z', material: true, closed: false }],
      stale_open_hours: 24
    });
    assert.match(stale.text, /stale-open/);
    assert.strictEqual(staleOpenHours(), 24);
    assert.strictEqual(continuityCurrencyBlockEnabled(), false);
    withEnv({ EMET_CONTINUITY_CURRENCY_BLOCK: '1', EMET_TAG_HANDOFFS: 'enforce' }, () => {
      assert.strictEqual(continuityCurrencyBlockEnabled(), false);
    });
  });
});

testGroup('view stamp', () => {
  test('the same stamp rebuilds the same bytes, and a stamp without as_of is flagged', () => {
    const args = {
      inputs: [handoff('B-010', 'open', 'wait', WRITER), handoff('B-010', 'done', 'close', HUB)],
      board: { doc_id: 'STATE.md', version: 4, content: board() },
      as_of: '2026-11-10T15:00:00.000Z',
      person: 'owner',
      registry: [HUB, WRITER]
    };
    const a = buildView(args);
    const b = buildView(args);
    assert.strictEqual(a.text, b.text);
    assert.strictEqual(a.stamp.view_sha256, b.stamp.view_sha256);
    assert.strictEqual(a.stamp.as_of, args.as_of);
    assert.ok(a.conflicts.includes('B-010'));
    const flagged = buildView({ ...args, as_of: null });
    assert.strictEqual(flagged.reproducible, false);
    assert.strictEqual(flagged.stamp, null);
    assert.strictEqual(stampWithoutAsOf({ inputs: a.stamp.inputs, board: a.stamp.board, view_sha256: a.stamp.view_sha256 }).ok, false);
    const counter = stampCounterSteps(buildView);
    assert.strictEqual(counter.first.text, counter.again.text);
    assert.match(counter.aged.text, /class: aging/);
    assert.ok(!counter.versionsOnly.as_of);
  });
});

testGroup('aging', () => {
  test('a handoff line ages after 7 days by updated_at, and pages stay at 30', () => {
    const aged = buildView({
      inputs: [handoff('B-010', 'open', 'wait', WRITER)],
      board: { doc_id: 'STATE.md', version: 4, content: board() },
      as_of: '2026-11-11T00:00:00.000Z',
      person: 'owner',
      aging_days: 7
    });
    assert.match(aged.text, /class: aging/);
    const current = buildView({
      inputs: [{ ...handoff('B-010', 'open', 'wait', WRITER), updated_at: '2026-11-10T00:00:00.000Z' }],
      board: { doc_id: 'STATE.md', version: 4, content: board() },
      as_of: '2026-11-11T00:00:00.000Z',
      person: 'owner',
      aging_days: 7
    });
    assert.match(current.text, /class: current/);
    assert.strictEqual(handoffAgingDays(), 7);
    assert.strictEqual(DEFAULT_STALENESS_DAYS, 30);
  });
});

testGroup('person segment', () => {
  test('the short form resolves to the owner person, a two-segment id is refused, and a tag equal to a person id is refused', () => {
    const short = authorizeHandoffWrite({
      docId: `HANDOFF/${WRITER}.md`, mode: 'enforce', credentialTag: WRITER, registered: true, ownerPerson: 'owner', personIds: ['owner']
    });
    assert.strictEqual(short.person, 'owner');
    assert.strictEqual(short.storedId, `HANDOFF/${WRITER}.md`);
    assert.strictEqual(codeOf(() => authorizeHandoffWrite({
      docId: `HANDOFF/other/${WRITER}.md`, mode: 'enforce', credentialTag: WRITER, registered: true, ownerPerson: 'owner'
    })), 'EMET-DOC-086');
    assert.strictEqual(codeOf(() => authorizeHandoffWrite({
      docId: 'HANDOFF/owner.md', mode: 'enforce', credentialTag: 'owner', registered: true, ownerPerson: 'owner', personIds: ['owner']
    })), 'EMET-DOC-086');
  });
});

testGroup('docs pin', () => {
  test('a variable or tool named for this flag is in the README, the example, and server.json', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const server = fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8');
    for (const name of ['EMET_TAG_HANDOFFS', 'EMET_HUB_TAG', 'EMET_HANDOFF_AGING_DAYS', 'EMET_STALE_OPEN_HOURS']) {
      assert.ok(readme.includes(name), name);
      assert.ok(example.includes(name), name);
      assert.ok(server.includes(name), name);
    }
    for (const tool of ['emet_initialize', 'emet_session_close', 'write_doc', 'patch_doc', 'emet_page', 'emet_page_lint']) {
      assert.ok(readme.includes(tool), tool);
    }
  });
});

testGroup('chart', () => {
  test('the chart steps hold, and the versions-only counter-check does not rebuild aging', () => {
    let state = perTagInitial();
    assert.strictEqual(state.rowOwner, 'hub');
    state = perTagHandoffStep(state, { type: 'foreign_row' });
    assert.strictEqual(state.place, 'foreignRefused');
    assert.strictEqual(state.rowOwner, 'hub');
    assert.ok(perTagInvariant(state));
    state = perTagInitial();
    state = perTagHandoffStep(state, { type: 'open_row' });
    state = perTagHandoffStep(state, { type: 'patch_own' });
    assert.strictEqual(state.place, 'ownRow');
    assert.strictEqual(state.rowOwner, 'writer');
    state = perTagHandoffStep(perTagHandoffStep(perTagInitial(), { type: 'open_row' }), { type: 'resolve_unmarked' });
    assert.strictEqual(state.place, 'hubRefused');
    assert.strictEqual(perTagHandoffStep(perTagInitial(), { type: 'resolve' }), null);
    const marked = perTagHandoffStep(perTagHandoffStep(perTagInitial(), { type: 'open_row' }), { type: 'mark_conflict' });
    const resolved = perTagHandoffStep(marked, { type: 'resolve' });
    assert.strictEqual(resolved.place, 'resolved');
    assert.strictEqual(resolved.conflict, true);
    assert.ok(perTagInvariant(resolved));
    const progress = perTagHandoffStep(perTagInitial(), { type: 'show_progress' });
    const stale = perTagHandoffStep(progress, { type: 'tick_open' });
    assert.strictEqual(stale.place, 'staleOpen');
    assert.strictEqual(stale.blocked, false);
    const counter = stampCounterSteps(buildView);
    assert.notStrictEqual(counter.first.text, counter.aged.text);
    assert.ok(counter.aged.text.includes('aging'));
  });
});

summary('per-tag handoffs');
