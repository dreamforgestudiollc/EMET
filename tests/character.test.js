/**
 * EMET - character payload tests (2026-09-05).
 *
 * No database. The resolution order and the two forms of the startup
 * instructions are pure, and they are the parts that decide whether a store
 * boots with its voice or without it. The regression that matters most is the
 * last group: a store with no character document must see exactly the text it
 * saw before this existed.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { CHARACTER_DOC_CANDIDATES, characterDocCandidates, readyInstructions, startupListInstructions,
         startupIndicatorInstructions, hostSetupInstructions, EMET_LINE, EMET_LINE_UNANSWERED } from '../src/setup.js';



testGroup('characterDocCandidates - resolution order', () => {
  test('default order is CHARACTER, SOUL, PERSONALITY', () => {
    assert.deepStrictEqual(characterDocCandidates(''), [
      'bootstrap/CHARACTER.md', 'bootstrap/SOUL.md', 'bootstrap/PERSONALITY.md'
    ]);
  });
  test('an explicit override is tried first', () => {
    const c = characterDocCandidates('bootstrap/VOICE.md');
    assert.strictEqual(c[0], 'bootstrap/VOICE.md');
    assert.strictEqual(c.length, 4);
  });
  test('an override that names a default is not listed twice', () => {
    const c = characterDocCandidates('bootstrap/SOUL.md');
    assert.deepStrictEqual(c, ['bootstrap/SOUL.md', 'bootstrap/CHARACTER.md', 'bootstrap/PERSONALITY.md']);
  });
  test('whitespace and non-string overrides are ignored', () => {
    assert.strictEqual(characterDocCandidates('   ').length, 3);
    assert.strictEqual(characterDocCandidates(undefined).length >= 3, true);
    assert.strictEqual(characterDocCandidates(42).length, 3);
  });
  test('the candidate list is frozen', () => {
    assert.throws(() => { CHARACTER_DOC_CANDIDATES.push('x'); });
  });
});

testGroup('readyInstructions - with a character document', () => {
  const withChar = readyInstructions(true);
  test('names character as authoritative on voice for the whole session', () => {
    assert.match(withChar, /`character` is authoritative on voice, tone, register, and length for the WHOLE session/);
  });
  test('scopes the startup guidance to the startup only', () => {
    assert.match(withChar, /STARTUP ONLY/);
  });
  test('the recent_context line is scoped to the greeting, not open-ended', () => {
    assert.match(withChar, /leave recent_context out of the greeting/);
    assert.doesNotMatch(withChar, /say nothing about it/);
  });
  test('still carries the shared core: search first, six layers, session close', () => {
    assert.match(withChar, /search memory first/);
    assert.match(withChar, /use all six/);
    assert.match(withChar, /emet_session_close/);
  });
});

/**
 * THE INSTRUCTIONS ARE TESTED BY WHAT THEY MUST CONTAIN AND IN WHAT ORDER - not
 * by their sentences. Until 2026-09-27 this group pinned three clauses verbatim
 * (opening, greeting guidance, core) and measured every addition against them;
 * it broke on the 9/26-27 builds and would break on every rewording after. The owner
 * ruled (code audit 4.2, 9/27 evening): assert contents and order, stop pinning
 * prose. Each marker below is a step a startup must not lose; a rewrite that
 * drops or reorders one is a regression, a rewrite that rewords one is not.
 */
testGroup('readyInstructions - both forms carry the steps, in the charter order', () => {
  // [label, regex the text must match]; order is the order of this list.
  const STEPS = [
    ['opening - adopt identity, not a document to quote', /assistant described in `identity`[\s\S]*?not (a document|documents) to quote/],
    ['the two indicators - EMET\'s line, then the identity phrase', /`emet_line`[\s\S]*?identity or verification phrase/],
    ['who is served, by name', /`user` is who you are serving/],
    ['recent_context is startup context, not a topic', /`recent_context` is where things were left/],
    ['greeting guidance - do not recite the payload or the counts', /do not recite[\s\S]*?layer counts/],
    ['host setup - install notes, session id, source tag', /`install_notes`[\s\S]*session id[\s\S]*source/],
    ['the startup list - board and handoff, named items, parked, lessons', /name the user\'s items[\s\S]*parked[\s\S]*lessons_pending/],
    ['never a question alone', /Never open with a question alone/],
    ['core - search first', /search memory first/],
    ['core - close per protocol', /session_close_protocol[\s\S]*emet_session_close/],
    ['core - thanks is not a session end', /not a session end/]
  ];
  for (const hasCharacter of [false, true]) {
    const text = readyInstructions(hasCharacter);
    const form = hasCharacter ? 'with character' : 'without character';
    let last = -1;
    for (const [label, re] of STEPS) {
      test(`${form}: carries ${label}`, () => {
        const m = re.exec(text);
        assert(m, `${form}: missing - ${label}`);
        assert(m.index > last, `${form}: out of order - ${label}`);
        last = m.index;
      });
    }
  }
  test('undefined is treated as no character', () =>
    assert.strictEqual(readyInstructions(undefined), readyInstructions(false)));
  test('the two forms differ', () => assert.notStrictEqual(readyInstructions(true), readyInstructions(false)));
  test('the with-character form names the character as authoritative on voice and the floor as not overridable', () => {
    const t = readyInstructions(true);
    assert.match(t, /`character` is authoritative on voice/);
    assert.match(t, /`character` does not override/);
  });
  test('the without-character form points at the floor as the whole standing description', () => {
    assert.match(readyInstructions(false), /`floor`[\s\S]*whole standing description/);
  });
});

/**
 * THE STARTUP LIST (2026-09-10). The failure this guards: two consecutive
 * startups opened with "where do you want to start?" and named nothing, and the
 * server's own instructions ended at "leave it out" - the out-of-sight failure
 * one level down. Each clause below is one the user named or the charter
 * requires; a rewrite that drops one is a regression, not a style change.
 */
testGroup('The startup list - user items named before any question', () => {
  const list = startupListInstructions();
  for (const [label, re] of [
    ['half-finished work', /half-finished/],
    ['dated items in the next seven days', /next seven days/],
    ['open items with their next action', /every open item they own, with its next action/],
    ['last session\'s undecided items', /left undecided last session/],
    ['parked items, under a heading of their own', /under a heading of its own, name every item the user has parked/],
    ['what brings each parked item back', /one short line each\s+with what brings it back/],
    ['parked items never pressed', /ask nothing of it, and do not press it/],
    ['a count never replaces the names', /count is your check, never a substitute for the names/],
    ['never a bare question', /Never open with a question alone/],
    ['calendar only where the host has one', /calendar if this host has one connected/],
    ['no invented list when the documents are absent', /say so once rather than inventing a list/],
  ]) {
    test(`names ${label}`, () => assert.match(list, re));
  }
  // 2026-09-23 (a decision record): parked items were excluded until this date.
  // For a neurodivergent user, excluded is forgotten; the exclusion must not come back.
  test('parked items are no longer left out', () => {
    assert.doesNotMatch(list, /[Ll]eave out items the user has parked/);
    assert.doesNotMatch(list, /parked items excluded/);
  });
  test('both forms carry the list', () => {
    assert(readyInstructions(true).includes(list), 'character form lacks the list');
    assert(readyInstructions(false).includes(list), 'no-character form lacks the list');
  });
  test('the list comes after the greeting guidance and before the core', () => {
    for (const text of [readyInstructions(true), readyInstructions(false)]) {
      assert(text.indexOf('recent_context') < text.indexOf(list), 'list precedes greeting');
      assert(text.indexOf(list) < text.indexOf('search memory first'), 'list follows core');
    }
  });
  test('no form still ends the greeting at a bare "leave it out"', () => {
    for (const text of [readyInstructions(true), readyInstructions(false)]) {
      assert.doesNotMatch(text, /leave it out of the greeting/);
    }
  });
  test('the document names follow the same settings emet_session_close checks', () => {
    const saved = [process.env.EMET_HANDOFF_DOC, process.env.EMET_STATE_DOC];
    try {
      process.env.EMET_HANDOFF_DOC = 'notes/HANDOVER.md';
      process.env.EMET_STATE_DOC = 'notes/BOARD.md';
      const renamed = startupListInstructions();
      assert(renamed.includes('`notes/HANDOVER.md`') && renamed.includes('`notes/BOARD.md`'), renamed);
    } finally {
      if (saved[0] === undefined) delete process.env.EMET_HANDOFF_DOC; else process.env.EMET_HANDOFF_DOC = saved[0];
      if (saved[1] === undefined) delete process.env.EMET_STATE_DOC; else process.env.EMET_STATE_DOC = saved[1];
    }
    assert(startupListInstructions().includes('`' + (saved[0] ?? 'HANDOFF.md') + '`'), 'handoff name not restored');
  });
});

/**
 * THE TWO INDICATORS (2026-09-11, a decision record; charter section 6).
 *
 * EMET's line claims exactly two things - the record stands, and it is
 * connected - and never a third. The user's identity phrase comes second
 * and does the animating. The failure line is the one this server can never
 * deliver itself, which is precisely why it has to be written down somewhere a
 * host can carry it.
 */
testGroup('The two indicators - what a session opens with', () => {
  test("EMET's line claims truth and connection", () =>
    assert.strictEqual(EMET_LINE, 'Truth stands. Memory connected.'));
  test('the failure line names the missing aleph', () =>
    assert.match(EMET_LINE_UNANSWERED, /aleph is missing/));
  test("neither line claims life - the user's name does the animating", () => {
    assert(!/\balive\b|\bliving\b|\blife\b/i.test(EMET_LINE), EMET_LINE);
    assert(!/\bdead\b|\bdied\b/i.test(EMET_LINE_UNANSWERED), EMET_LINE_UNANSWERED);
  });

  const ind = startupIndicatorInstructions();
  for (const [label, re] of [
    ["EMET's line first, on its own", /before anything else/],
    ['exactly as given, not paraphrased', /exactly as given/],
    ["the user's phrase second", /identity or verification phrase/],
    ['the phrase is never reworded or skipped', /never paraphrased or skipped/],
    ['the failure line is not spoken while connected', /never speak that line while connected/]
  ]) {
    test(`names ${label}`, () => assert.match(ind, re));
  }

  test('both forms of the instructions carry the indicators', () => {
    assert(readyInstructions(true).includes(ind), 'character form lacks the indicators');
    assert(readyInstructions(false).includes(ind), 'no-character form lacks the indicators');
  });
  test("the indicators come before the startup list in both forms", () => {
    for (const form of [readyInstructions(true), readyInstructions(false)]) {
      assert(form.indexOf(ind) < form.indexOf(startupListInstructions()),
        'the items would be named before the line that says the record is connected');
    }
  });
});

summary('Character Payload Test Summary');
