/**
 * EMET - template conformance tests (STANDARD 9, 9a; built 2026-09-11).
 *
 * No database. Every check is a pure function over text, which is the reason
 * conformance.js was written that way: the failures these prevent are failures
 * of FORM, and a form check that can only be exercised against a live store is
 * a form check nobody runs.
 *
 * The carry-forward case is built from the real shape of the incident it exists
 * for - two rows present on one revision of a board and absent, undispositioned,
 * from the next.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseSections, parseTemplate, countPlaceholders, templateFor, extraMappings,
  isGovernedByShippedCopy, loadShipped, clearShippedCache, checkRecord,
  validateDocument, buildAcceptance, isOpenNonconformance, isAcceptedNonconformance,
  STATUS, VERDICT
} from '../src/conformance.js';


// --- fixtures -------------------------------------------------------------

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-conformance-'));

const TPL_IN_FORCE = `# TEMPLATE - BOARD

**Template control:** id \`templates/BOARD.md\` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-09-11 · a decision record · owner: EMET (base)

## §0 RECORD CONTROL AND COUNTS
- Template: \`templates/BOARD.md\` rev __

| Half-state | Open | Closed this revision |
|---|---|---|
| __ | __ | __ |

## §1 HALF-STATE
| Id | What |
|---|---|

## §3 OPEN BOARD
| Id | Item |
|---|---|

## §4 CLOSED THIS REVISION
| Id | Item |
|---|---|
`;

const TPL_DRAFT = TPL_IN_FORCE
  .replace('id `templates/BOARD.md`', 'id `templates/SEED.md`')
  .replace('status: IN FORCE · approved: user · 2026-09-11 · a decision record', 'status: DRAFT, not in force');

fs.writeFileSync(path.join(DIR, 'BOARD.md'), TPL_IN_FORCE, 'utf8');
fs.writeFileSync(path.join(DIR, 'SEED.md'), TPL_DRAFT, 'utf8');

/** A record that passes every check. */
const GOOD = `# BOARD

## §0 RECORD CONTROL AND COUNTS
- Template: \`templates/BOARD.md\` rev 10

| Half-state | Open | Closed this revision |
|---|---|---|
| 1 | 4 | 1 |

## §1 HALF-STATE
| Id | What |
|---|---|
| B-058 | transcript timestamp marker |

## §3 OPEN BOARD
| Id | Item |
|---|---|
| B-031 | Contoso Health |
| B-032 | Northwind Systems |

## §4 CLOSED THIS REVISION
| Id | Item |
|---|---|
| B-012 | template validation |
`;

const opts = { dir: DIR };
const template = () => { clearShippedCache(); return loadShipped('templates/BOARD.md', { dir: DIR, cache: false }); };

// --- parsing --------------------------------------------------------------

testGroup('parsing - a template is its own specification', () => {
  const t = template();
  test('the required sections come from the template headings', () =>
    assert.deepStrictEqual(t.required_sections.map((s) => s.num), ['0', '1', '3', '4']));
  test('a section title is kept whole', () =>
    assert.strictEqual(t.required_sections[1].title, 'HALF-STATE'));
  test('status is read from the control line', () => assert.strictEqual(t.status, STATUS.IN_FORCE));
  test('the approval is read from the control line', () =>
    assert.ok(/user/.test(t.approved), `approved was ${JSON.stringify(t.approved)}`));
  test('the template id is read from the control line', () =>
    assert.strictEqual(t.template_id, 'templates/BOARD.md'));
  test('a DRAFT template reports DRAFT', () =>
    assert.strictEqual(loadShipped('templates/SEED.md', { dir: DIR, cache: false }).status, STATUS.DRAFT));
  test('a heading that is not a section number is not a required section', () => {
    const parsed = parseTemplate('## HOW TO FILL\ntext\n\n## §1 REAL\nbody\n');
    assert.deepStrictEqual(parsed.required_sections.map((s) => s.num), ['1']);
  });
  test('a body is captured up to the next section', () => {
    const s = parseSections('## §1 A\nalpha\n\n## §2 B\nbeta\n');
    assert.strictEqual(s[0].body, 'alpha');
    assert.strictEqual(s[1].body, 'beta');
  });
});

testGroup('placeholders', () => {
  test('a bare run of underscores is a placeholder', () => assert.strictEqual(countPlaceholders('rev __ here'), 1));
  test('two placeholders count as two', () => assert.strictEqual(countPlaceholders('| __ | __ |'), 2));
  test('snake__case is not a placeholder', () => assert.strictEqual(countPlaceholders('some__name'), 0));
  test('a filled record has none', () => assert.strictEqual(countPlaceholders(GOOD), 0));
});

// --- the checks -----------------------------------------------------------

testGroup('checkRecord - a conforming record', () => {
  const r = checkRecord(GOOD, template());
  test('passes with no failures', () => assert.deepStrictEqual(r.failures, []));
});

testGroup('checkRecord - each failure, one at a time', () => {
  test('a missing required section fails, and names it', () => {
    const r = checkRecord(GOOD.replace(/## §4 CLOSED THIS REVISION[\s\S]*$/, ''), template());
    assert.ok(r.failures.some((f) => /§4/.test(f)), JSON.stringify(r.failures));
  });
  test('an empty required section fails', () => {
    // The whole body goes, not just the row: a table header with no rows under
    // it is not "empty" by this check, and saying so plainly is better than
    // pretending otherwise. Completion rule 2 - "None" is valid, a blank is not -
    // turns on whether a stated scope is honest, which a machine cannot judge.
    const r = checkRecord(GOOD.replace(/## §1 HALF-STATE[\s\S]*?(?=## §3)/, '## §1 HALF-STATE\n\n'), template());
    assert.ok(r.failures.some((f) => /§1.*empty/.test(f)), JSON.stringify(r.failures));
  });
  test('a surviving placeholder fails', () => {
    const r = checkRecord(GOOD.replace('rev 10', 'rev __'), template());
    assert.ok(r.failures.some((f) => /placeholder/.test(f)), JSON.stringify(r.failures));
  });
  test('NOT COMPLETED without a reason fails', () => {
    const r = checkRecord(GOOD.replace('| B-012 | template validation |', '| B-012 | NOT COMPLETED |'), template());
    assert.ok(r.failures.some((f) => /states no reason/.test(f)), JSON.stringify(r.failures));
  });
  test('NOT COMPLETED WITH a reason passes', () => {
    const r = checkRecord(GOOD.replace('| B-012 | template validation |', '| B-012 | NOT COMPLETED - the seed scan needs a machine |'), template());
    assert.ok(!r.failures.some((f) => /states no reason/.test(f)), JSON.stringify(r.failures));
  });
  test('a record with no §0 control block fails', () => {
    const r = checkRecord(GOOD.replace(/## §0[\s\S]*?(?=## §1)/, ''), template());
    assert.ok(r.failures.some((f) => /control block missing/.test(f)), JSON.stringify(r.failures));
  });
  test('a retitled section is a WARNING, never a failure', () => {
    // Matching on the section number and the first word means "OPEN BOARD" ->
    // "OPEN" passes silently, by design. A different first word is the case
    // worth telling someone about, and it still must not fail the record.
    const r = checkRecord(GOOD.replace('## §3 OPEN BOARD', '## §3 CURRENT WORK'), template());
    assert.deepStrictEqual(r.failures, []);
    assert.ok(r.warnings.some((w) => /§3/.test(w)), JSON.stringify(r.warnings));
  });
  test('a section shortened to the same first word passes with no warning', () => {
    const r = checkRecord(GOOD.replace('## §3 OPEN BOARD', '## §3 OPEN'), template());
    assert.deepStrictEqual(r.failures, []);
    assert.ok(!r.warnings.some((w) => /§3/.test(w)), JSON.stringify(r.warnings));
  });
});

testGroup("checkRecord - the board's own check: counts match rows", () => {
  test('a count that disagrees with its rows fails', () => {
    const r = checkRecord(GOOD.replace('| 1 | 4 | 1 |', '| 3 | 4 | 1 |'), template());
    assert.ok(r.failures.some((f) => /Half-state 3/.test(f)), JSON.stringify(r.failures));
  });
  test('a count that agrees passes', () => {
    const r = checkRecord(GOOD, template());
    assert.ok(!r.failures.some((f) => /Half-state/.test(f)), JSON.stringify(r.failures));
  });
});

testGroup('carry-forward - the check that would have caught the dropped rows', () => {
  // The real shape: two rows present on one revision, gone from the next with
  // nobody having decided they should go. Reference install, September 2026.
  const NEXT_DROPPED = GOOD
    .replace('| B-031 | Contoso Health |\n', '')
    .replace('| B-032 | Northwind Systems |\n', '');
  const NEXT_DISPOSITIONED = GOOD
    .replace('| B-031 | Contoso Health |\n| B-032 | Northwind Systems |\n', '')
    .replace('| B-012 | template validation |',
      '| B-012 | template validation |\n| B-031 | Contoso Health | PARKED by user |\n| B-032 | Northwind Systems | PARKED by user |');

  test('two rows dropped without a disposition fails, naming both', () => {
    const r = checkRecord(NEXT_DROPPED, template(), { previous: GOOD });
    const f = r.failures.find((x) => /no disposition/.test(x));
    assert.ok(f, JSON.stringify(r.failures));
    assert.ok(f.includes('B-031') && f.includes('B-032'), f);
  });
  test('the same rows moved to §4 with a disposition pass', () => {
    const r = checkRecord(NEXT_DISPOSITIONED, template(), { previous: GOOD });
    assert.ok(!r.failures.some((x) => /no disposition/.test(x)), JSON.stringify(r.failures));
  });
  test('rows carried unchanged pass', () => {
    const r = checkRecord(GOOD, template(), { previous: GOOD });
    assert.ok(!r.failures.some((x) => /no disposition/.test(x)), JSON.stringify(r.failures));
  });
  test('with no previous revision the check does not fire', () => {
    const r = checkRecord(NEXT_DROPPED, template(), { previous: null });
    assert.ok(!r.failures.some((x) => /no disposition/.test(x)), JSON.stringify(r.failures));
  });
});

// --- the map (L3) ---------------------------------------------------------

testGroup('the map - which documents are templated', () => {
  test('the board maps by its configured id', () => assert.strictEqual(templateFor('STATE.md'), 'templates/BOARD.md'));
  test('the handoff maps by its configured id', () => assert.strictEqual(templateFor('HANDOFF.md'), 'templates/HANDOFF.md'));
  test('a seed maps by prefix', () => assert.strictEqual(templateFor('seeds/anything.md'), 'templates/SEED.md'));
  test('a thread maps by prefix', () => assert.strictEqual(templateFor('threads/x.md'), 'templates/THREAD.md'));
  test('an unrelated document maps to nothing', () => assert.strictEqual(templateFor('private/scratch.md'), null));
  test('L3 - a setting may ADD a mapping', () => {
    const { added, refused } = extraMappings('notes/=templates/THREAD.md');
    assert.strictEqual(added['notes/'], 'templates/THREAD.md');
    assert.deepStrictEqual(refused, []);
  });
  test('L3 - a setting may NOT redirect a base mapping, and the attempt is reported', () => {
    const { added, refused } = extraMappings('STATE.md=templates/SEED.md');
    assert.strictEqual(added['STATE.md'], undefined);
    assert.ok(refused.length === 1 && /L3/.test(refused[0]), JSON.stringify(refused));
  });
  test('base templates and the charter are governed by the shipped copy', () => {
    assert.strictEqual(isGovernedByShippedCopy('CHARTER.md'), true);
    assert.strictEqual(isGovernedByShippedCopy('templates/BOARD.md'), true);
    assert.strictEqual(isGovernedByShippedCopy('threads/x.md'), false);
  });
});

// --- the door -------------------------------------------------------------

testGroup('validateDocument - gating, and the door that never rejects', () => {
  test('an unmapped document is untemplated, not a failure', () => {
    const r = validateDocument('private/scratch.md', 'anything at all', null, opts);
    assert.strictEqual(r.verdict, VERDICT.UNTEMPLATED);
    assert.deepStrictEqual(r.failures, []);
  });
  test('a conforming board conforms', () => {
    clearShippedCache();
    assert.strictEqual(validateDocument('STATE.md', GOOD, null, opts).verdict, VERDICT.CONFORMS);
  });
  test('a nonconforming board is MARKED, and the failures are named', () => {
    clearShippedCache();
    const r = validateDocument('STATE.md', GOOD.replace('rev 10', 'rev __'), null, opts);
    assert.strictEqual(r.verdict, VERDICT.NONCONFORMING);
    assert.ok(r.failures.length >= 1, JSON.stringify(r));
  });
  test('a template that is not IN FORCE gates: records are checked but not marked', () => {
    clearShippedCache();
    const r = validateDocument('seeds/whatever.md', 'no sections here at all', null, opts);
    assert.strictEqual(r.verdict, VERDICT.UNGATED);
    assert.deepStrictEqual(r.failures, []);
  });
  test('a missing template in the release is ungated, and says so', () => {
    clearShippedCache();
    const r = validateDocument('threads/x.md', 'anything', null, opts);
    assert.strictEqual(r.verdict, VERDICT.UNGATED);
    assert.ok(r.warnings.some((w) => /not present in this release/.test(w)), JSON.stringify(r.warnings));
  });
  test('IT NEVER THROWS - not on null content, not on nonsense', () => {
    clearShippedCache();
    assert.doesNotThrow(() => validateDocument('STATE.md', null, null, opts));
    assert.doesNotThrow(() => validateDocument(null, null, null, opts));
    assert.doesNotThrow(() => validateDocument('STATE.md', GOOD, 12345, opts));
  });
  test('content that is not a string is marked, not thrown - the write still lands', () => {
    clearShippedCache();
    const r = validateDocument('STATE.md', { not: 'a string' }, null, opts);
    assert.strictEqual(r.verdict, VERDICT.NONCONFORMING);
    assert.ok(r.failures.length > 0, 'nonsense content should be marked, not silently passed');
  });
  test('a fault inside the checker surfaces as a warning and never as a failure', () => {
    // A template directory that does not exist is the cheapest real fault: the
    // check cannot run, and the document must still be storable.
    const r = validateDocument('STATE.md', GOOD, null, { dir: path.join(DIR, 'no-such-dir') });
    assert.deepStrictEqual(r.failures, []);
    assert.ok(r.warnings.length > 0, JSON.stringify(r));
  });
});

testGroup('L1 - the shipped copy governs the base templates', () => {
  test('a store copy identical to the shipped copy conforms', () => {
    clearShippedCache();
    const r = validateDocument('templates/BOARD.md', TPL_IN_FORCE, null, opts);
    assert.strictEqual(r.verdict, VERDICT.CONFORMS);
  });
  test('a store copy that DIFFERS is marked, and the shipped copy still governs', () => {
    clearShippedCache();
    const weakened = TPL_IN_FORCE.replace('## §4 CLOSED THIS REVISION', '## §4 OPTIONAL');
    const r = validateDocument('templates/BOARD.md', weakened, null, opts);
    assert.strictEqual(r.verdict, VERDICT.NONCONFORMING);
    assert.ok(r.failures.some((f) => /differs from the copy shipped/.test(f)), JSON.stringify(r.failures));
  });
  test('flipping the store copy to DRAFT does not switch validation off', () => {
    clearShippedCache();
    const flipped = TPL_IN_FORCE.replace('status: IN FORCE', 'status: DRAFT');
    assert.strictEqual(validateDocument('templates/BOARD.md', flipped, null, opts).verdict, VERDICT.NONCONFORMING);
    // and the board is still checked against the SHIPPED template
    assert.strictEqual(validateDocument('STATE.md', GOOD, null, opts).verdict, VERDICT.CONFORMS);
  });
});

testGroup('L4 - a declared template adds, it never replaces', () => {
  test('declaring a different template is a warning and both are checked', () => {
    clearShippedCache();
    const declaring = GOOD.replace('- Template: `templates/BOARD.md` rev 10', '- Template: `templates/SEED.md` rev 6');
    const r = validateDocument('STATE.md', declaring, null, opts);
    assert.ok(r.warnings.some((w) => /L4/.test(w)), JSON.stringify(r.warnings));
    // the mapped template still governs: the record is still a board
    assert.strictEqual(r.template, 'templates/BOARD.md');
  });
});

testGroup('L6 - an acceptance covers one revision', () => {
  const marker = { verdict: VERDICT.NONCONFORMING, failures: ['something'], warnings: [] };
  test('a reason shorter than ten characters is refused', () =>
    assert.throws(() => buildAcceptance({ reason: 'too short' })));
  test('a real reason builds an acceptance bound to a version', () => {
    const a = buildAcceptance({ reason: 'legacy record, predates the template', by: 'cloud-host', version: 7 });
    assert.strictEqual(a.covers_version, 7);
    assert.ok(a.accepted_at);
  });
  test('an unaccepted nonconformance is OPEN', () =>
    assert.strictEqual(isOpenNonconformance(marker, 7), true));
  test('accepted FOR THIS revision is not open, and is counted as accepted', () => {
    const m = { ...marker, accepted: buildAcceptance({ reason: 'accepted for this revision', version: 7 }) };
    assert.strictEqual(isOpenNonconformance(m, 7), false);
    assert.strictEqual(isAcceptedNonconformance(m, 7), true);
  });
  test('THE LOCK: the acceptance does not carry to the next revision', () => {
    const m = { ...marker, accepted: buildAcceptance({ reason: 'accepted for revision seven', version: 7 }) };
    assert.strictEqual(isOpenNonconformance(m, 8), true);
    assert.strictEqual(isAcceptedNonconformance(m, 8), false);
  });
  test('a conforming document has nothing open to accept', () =>
    assert.strictEqual(isOpenNonconformance({ verdict: VERDICT.CONFORMS }, 1), false));
});

testGroup('the real shipped set - what actually ships with this release', () => {
  clearShippedCache();
  const SHIPPED = ['templates/BOARD.md', 'templates/HANDOFF.md', 'templates/SEED.md',
    'templates/THREAD.md', 'templates/STAGING.md', 'templates/PROCEDURE.md', 'templates/STANDARD.md'];
  for (const id of SHIPPED) {
    test(`${id} ships, is IN FORCE, and carries its approval`, () => {
      const t = loadShipped(id, { cache: false });
      assert.ok(t, `${id} is not in the release`);
      assert.strictEqual(t.status, STATUS.IN_FORCE, `${id} status is ${t.status}`);
      assert.ok(t.approved && /user/.test(t.approved), `${id} approved: ${t.approved}`);
    });
  }
  test('every base template declares at least one required section', () => {
    for (const id of SHIPPED) {
      const t = loadShipped(id, { cache: false });
      if (id === 'templates/STANDARD.md') continue; // the standard governs; it is not filled from
      assert.ok(t.required_sections.length > 0, `${id} declares no sections`);
    }
  });
});

// --- Validator false positives ----------------------------------------------
// Two false positives found on the validator's first day, by running it against
// the reference install's own board. Both made it NOISY, never permissive, and
// the fixtures below are built from the real shape of each so that a later
// "simplification" of either check fails here rather than in a live record.

const PREV_BOARD = `# BOARD

## §0 RECORD CONTROL AND COUNTS
- Template: \`templates/BOARD.md\` rev 10

| Half-state | Open | Closed this revision |
|---|---|---|
| 0 | 2 | 2 |

## §1 HALF-STATE
| Id | What |
|---|---|
| - | none |

## §3 OPEN BOARD
| Id | Item |
|---|---|
| B-002 | Build block. Carries the work closed under B-012 and B-050 |
| B-099 | Still open next revision |

## §4 CLOSED THIS REVISION
| Id | Item |
|---|---|
| B-012 | Validation v1 |
| B-050 | EMET's line |
`;

/** The next revision. Two rows were closed LAST revision and are gone,
 *  correctly. They survive only inside another row's prose on the previous one. */
const NEXT_BOARD = PREV_BOARD
  .replace('| B-002 | Build block. Carries the work closed under B-012 and B-050 |', '| B-002 | Build block, continuing |')
  .replace('| B-012 | Validation v1 |\n| B-050 | EMET\'s line |\n', '| - | none |\n');

testGroup('False positive (1) - carry-forward reads the id column, not the section body', () => {
  clearShippedCache();
  const BOARD = loadShipped('templates/BOARD.md', { dir: DIR, cache: false });
  const carry = (r) => (r.failures.find((f) => /no disposition/.test(f)) || null);

  test('an id named only in another row\'s prose is not a row, and is not reported dropped', () => {
    const r = checkRecord(NEXT_BOARD, BOARD, { previous: PREV_BOARD, doc_id: 'STATE.md' });
    assert.strictEqual(carry(r), null, `reported: ${carry(r)}`);
  });

  test('THE CHECK STILL BITES: a real row leaving the board undispositioned fails', () => {
    const dropped = NEXT_BOARD.replace('| B-099 | Still open next revision |\n', '');
    const r = checkRecord(dropped, BOARD, { previous: PREV_BOARD, doc_id: 'STATE.md' });
    assert.ok(carry(r), 'a genuinely dropped row was not reported');
    assert.ok(/B-099/.test(carry(r)), `named the wrong row: ${carry(r)}`);
  });

  test('a row dispositioned in §4 of the new revision is not reported dropped', () => {
    const closed = NEXT_BOARD.replace('| - | none |\n\n## §3', '| - | none |\n\n## §3')
      .replace(/(## §4 CLOSED THIS REVISION\n\| Id \| Item \|\n\|---\|---\|\n)\| - \| none \|/, '$1| B-099 | Done |');
    const r = checkRecord(closed.replace('| B-099 | Still open next revision |\n', ''), BOARD,
      { previous: PREV_BOARD, doc_id: 'STATE.md' });
    assert.strictEqual(carry(r), null, `reported: ${carry(r)}`);
  });
});

testGroup('False positive (2) - the control-line id token is bounded', () => {
  clearShippedCache();

  test('a filename containing the letters "id" is not read as a declared template', () => {
    const withMention = PREV_BOARD.replace('- Template: `templates/BOARD.md` rev 10',
      '- Template: `templates/BOARD.md` rev 10 · open markers: `staging/validation-pricing-notes.md` v9 (9)');
    const r = validateDocument('STATE.md', withMention, null, { dir: DIR });
    const l4 = r.warnings.find((w) => /record declares/.test(w));
    assert.strictEqual(l4, undefined, `spurious L4 warning: ${l4}`);
  });

  test('an explicit `id` field is still read', () => {
    const declared = PREV_BOARD.replace('- Template: `templates/BOARD.md` rev 10',
      '- Record control: id `templates/SEED.md`');
    const r = validateDocument('STATE.md', declared, null, { dir: DIR });
    assert.ok(r.warnings.some((w) => /record declares templates\/SEED\.md/.test(w)),
      `L4 warning missing: ${JSON.stringify(r.warnings)}`);
  });

  test('a `doc_id:` field is still read - `_` is a word character, so \\b would refuse it', () => {
    const declared = PREV_BOARD.replace('- Template: `templates/BOARD.md` rev 10',
      '- Record control: doc_id: `templates/SEED.md`');
    const r = validateDocument('STATE.md', declared, null, { dir: DIR });
    assert.ok(r.warnings.some((w) => /record declares templates\/SEED\.md/.test(w)),
      `L4 warning missing: ${JSON.stringify(r.warnings)}`);
  });

  test('the record control block is still found when it declares a template', () => {
    const r = checkRecord(PREV_BOARD, loadShipped('templates/BOARD.md', { dir: DIR, cache: false }),
      { previous: null, doc_id: 'STATE.md' });
    assert.ok(!r.failures.some((f) => /record control block names no template/.test(f)),
      `control block not recognised: ${JSON.stringify(r.failures)}`);
  });
});

testGroup('Record control may be front matter - a seed cannot carry a §0 heading', () => {
  const SEED_TPL = parseTemplate(`# TEMPLATE - SEED

**Template control:** id \`templates/SEED.md\` · status: IN FORCE · owner: EMET (base)

## §1 THE IDEA
What it is, and why now is the wrong time.
`, { doc_id: 'templates/SEED.md' });

  const SEED_OK = `---
template: templates/SEED.md rev 7
trigger:
  - kind: DATE
    test: 2026-10-01
status: DORMANT
---

## §1 THE IDEA
A thing worth doing, later.
`;

  test('front matter naming the template satisfies record control', () => {
    const r = checkRecord(SEED_OK, SEED_TPL, { doc_id: 'seeds/x.md' });
    assert.ok(!r.failures.some((f) => /record control/.test(f)),
      `front matter was not accepted: ${JSON.stringify(r.failures)}`);
  });

  test('THE CHECK STILL BITES: neither a §0 nor front matter still fails', () => {
    const r = checkRecord('## §1 THE IDEA\nA thing.\n', SEED_TPL, { doc_id: 'seeds/x.md' });
    assert.ok(r.failures.some((f) => /record control block missing/.test(f)),
      `a record with no control block at all passed: ${JSON.stringify(r.failures)}`);
  });

  test('front matter that names no template still fails', () => {
    const noTpl = SEED_OK.replace('template: templates/SEED.md rev 7', 'planted: 2026-09-13');
    const r = checkRecord(noTpl, SEED_TPL, { doc_id: 'seeds/x.md' });
    assert.ok(r.failures.some((f) => /names no template id/.test(f)),
      `front matter naming no template passed: ${JSON.stringify(r.failures)}`);
  });

  test('front matter must OPEN the file - a block below prose is body text, not record control', () => {
    const r = checkRecord('Some prose first.\n\n' + SEED_OK, SEED_TPL, { doc_id: 'seeds/x.md' });
    assert.ok(r.failures.some((f) => /record control block missing/.test(f)),
      `front matter sitting below prose was accepted: ${JSON.stringify(r.failures)}`);
  });

  test('the §0 path is unchanged for templates that use one', () => {
    const withZero = '## §0 RECORD CONTROL\n- Template: `templates/BOARD.md` rev 10\n\n## §1 THE IDEA\nA thing.\n';
    const r = checkRecord(withZero, SEED_TPL, { doc_id: 'seeds/x.md' });
    assert.ok(!r.failures.some((f) => /record control/.test(f)),
      `the §0 path regressed: ${JSON.stringify(r.failures)}`);
  });
});

try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* fixtures are temporary */ }

summary('Template Conformance Test Summary');
