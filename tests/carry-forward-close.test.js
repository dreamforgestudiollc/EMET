/**
 * Carry-forward close. A later session can advance HANDOFF and
 * STATE. The receipt close stays blocked and is not counted. carry_forward
 * cites the current session disposition and those later versions. Transcripts
 * stay. A guest door and a declared source are not authority.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { SESSION_DISPOSITION_TEMPLATE } from '../src/conformance.js';
import {
  hasCarryForward,
  parseCarryForward,
  carryForwardAuthority,
  supersededStrikeSkipped,
  foreignContinuityProblems,
  assessCitations,
  runCarryForwardClose,
  CARRY_FORWARD_DISPOSITIONS
} from '../src/carry-forward-close.js';

const SESSION = '2026-11-03_carry-forward-example';
const LATER = '2026-11-03_later-session';

function dispositionText(sessionId, disposition) {
  return [
    '# SESSION DISPOSITION',
    '',
    '## §1 DISPOSITION',
    '| session_id | opened_at | last_saved_at | disposition | reason | evidence | carried_forward_to | inserted_id |',
    '|---|---|---|---|---|---|---|---|',
    `| ${sessionId} | 2026-10-01T00:00:00.000Z | 2026-10-01T01:00:00.000Z | ${disposition} | Later session advanced the handoff and the board. | HANDOFF.md v2 and STATE.md v4 were written by a later session. | ${LATER} | None — this row dispositions the session, not one transcript document. |`,
    ''
  ].join('\n');
}

function memDb({ session, docs }) {
  const byId = new Map(docs.map((doc) => [doc.doc_id, doc]));
  return {
    collection(name) {
      return {
        async findOne(query) {
          if (String(name).endsWith('sessions')) {
            return session && query && query._id === session._id ? session : null;
          }
          if (query && query.doc_id) return byId.get(query.doc_id) || null;
          return null;
        },
        find() {
          return {
            async toArray() {
              if (name === 'documents') return docs.filter((doc) => doc.retired !== true);
              return [];
            }
          };
        }
      };
    }
  };
}

testGroup('carry-forward close', () => {
  test('hasCarryForward ignores an omitted or null argument', () => {
    assert.strictEqual(hasCarryForward({}), false);
    assert.strictEqual(hasCarryForward({ carry_forward: null }), false);
    assert.strictEqual(hasCarryForward({ carry_forward: { disposition_doc: 'records/x.md' } }), true);
    assert.deepStrictEqual(CARRY_FORWARD_DISPOSITIONS, ['CARRIED_FORWARD', 'SUPERSEDED_BY_LATER_SESSION', 'ABANDONED_NO_TRANSCRIPT']);
  });

  test('parseCarryForward accepts an object or JSON text', () => {
    const value = { disposition_doc: 'records/one.md', disposition_version: 1, citations: [] };
    assert.deepStrictEqual(parseCarryForward(value).value, value);
    assert.deepStrictEqual(parseCarryForward(JSON.stringify(value)).value, value);
    assert.match(parseCarryForward('not-json').problem, /must be an object/);
  });

  test('a guest door and a declared source are not authority', () => {
    const guest = carryForwardAuthority({ transport: 'http', door: 'guest', sourceBasis: 'login', sourceTag: 'owner', personId: 'owner', ownerId: 'owner' });
    assert.strictEqual(guest.ok, false);
    assert.match(guest.reason, /guest door/);
    const declared = carryForwardAuthority({ transport: 'http', door: 'member', sourceBasis: 'declared', sourceTag: 'hub-bot', personId: 'owner', ownerId: 'owner' });
    assert.strictEqual(declared.ok, false);
    assert.match(declared.reason, /declared source/);
    const stdio = carryForwardAuthority(null);
    assert.deepStrictEqual(stdio, { ok: true, basis: 'owner' });
  });

  test('a later-session handoff mismatch is not a counted strike', () => {
    const writers = new Map([['HANDOFF.md', LATER]]);
    const problems = ['handoff: receipt says v1, store holds v2'];
    assert.strictEqual(supersededStrikeSkipped(problems, { writers, handoffDoc: 'HANDOFF.md', sessionBase: SESSION }), true);
    assert.strictEqual(supersededStrikeSkipped(['transcript was never saved'], { writers, handoffDoc: 'HANDOFF.md', sessionBase: SESSION }), false);
    const foreign = foreignContinuityProblems({
      receipts: { handoff_version: 2, board_doc: 'STATE.md', board_version: 4 },
      writers: new Map([['HANDOFF.md', LATER], ['STATE.md', LATER]]),
      handoffDoc: 'HANDOFF.md',
      sessionBase: SESSION,
      documents: [
        { doc_id: 'HANDOFF.md', exists: true, version: 2 },
        { doc_id: 'STATE.md', exists: true, version: 4 }
      ]
    });
    assert.ok(foreign.some((line) => line.includes('cite it with carry_forward')));
  });

  test('a citation written in this session is refused', () => {
    const problems = assessCitations(
      [{ doc_id: 'HANDOFF.md', version: 2 }],
      [{ doc_id: 'HANDOFF.md', exists: true, version: 2, session_id: SESSION, updated_at: '2026-11-01T00:00:00.000Z' }],
      { requiredIds: ['HANDOFF.md'], sessionBase: SESSION, anchorMs: Date.parse('2026-10-01T00:00:00.000Z') }
    );
    assert.ok(problems.some((line) => line.includes('use a normal receipt close')));
  });

  test('a conforming carry-forward closes and keeps the transcript', async () => {
    const doc = {
      doc_id: 'records/2026-11-03-carry-forward-example.md',
      content: dispositionText(SESSION, 'CARRIED_FORWARD'),
      version: 2,
      retired: false,
      updated_at: '2026-11-02T00:00:00.000Z',
      conformance: { verdict: 'conforms', template: SESSION_DISPOSITION_TEMPLATE }
    };
    const later = (id) => ({
      doc_id: id,
      version: id === 'HANDOFF.md' ? 3 : 5,
      retired: false,
      updated_at: '2026-11-02T00:00:00.000Z',
      session_id: LATER
    });
    const db = memDb({
      session: { _id: SESSION, opened: true, closed: false, opened_at: '2026-10-01T00:00:00.000Z' },
      docs: [doc, later('HANDOFF.md'), later('STATE.md')]
    });
    const result = await runCarryForwardClose(db, {
      session_id: SESSION,
      carry_forward: {
        disposition_doc: doc.doc_id,
        disposition_version: 2,
        citations: [
          { doc_id: 'HANDOFF.md', version: 3 },
          { doc_id: 'STATE.md', version: 5 }
        ]
      }
    });
    assert.strictEqual(result.state, 'complete', JSON.stringify(result.missing));
    assert.strictEqual(result.carry_forward.closed, true);
    assert.strictEqual(result.carry_forward.transcripts_deleted, false);
    assert.strictEqual(result.close_attempts.counted, false);
    assert.ok(result.speak.some((line) => line.includes('Transcript: retained')));
  });

  test('RETAINED_OPEN_CRITICAL stays open', async () => {
    const doc = {
      doc_id: 'records/2026-11-03-retained.md',
      content: dispositionText(SESSION, 'RETAINED_OPEN_CRITICAL'),
      version: 1,
      retired: false,
      updated_at: '2026-11-02T00:00:00.000Z',
      conformance: { verdict: 'conforms', template: SESSION_DISPOSITION_TEMPLATE }
    };
    const db = memDb({
      session: { _id: SESSION, opened: true, opened_at: '2026-10-01T00:00:00.000Z' },
      docs: [doc]
    });
    const result = await runCarryForwardClose(db, {
      session_id: SESSION,
      carry_forward: { disposition_doc: doc.doc_id, disposition_version: 1, citations: [] }
    });
    assert.strictEqual(result.state, 'refused');
    assert.strictEqual(result.close_attempts.counted, false);
    assert.ok(result.missing.some((line) => line.includes('RETAINED_OPEN_CRITICAL')), result.missing.join('; '));
    assert.strictEqual(result.carry_forward.transcripts_deleted, false);
  });
});

summary('CARRY-FORWARD CLOSE');
