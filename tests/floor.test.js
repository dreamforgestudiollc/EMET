/**
 * EMET - floor tests.
 *
 * No database, no credentials. The floor's whole claim is that it cannot be
 * lost, edited, or quietly emptied, so what is worth testing is not its prose
 * but its properties: it is frozen, it reaches the initialize payload in both
 * the ready and the not-yet-set-up states, the compact form is genuinely short,
 * and the vocabulary that had to be rewritten out has not crept back in.
 *
 * That last group is a regression guard rather than a style check. The terms it
 * forbids were borrowed from a third-party framework and removed deliberately
 * (2026-09-07); a test is the only thing that keeps them out of a later edit.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { FLOOR, FLOOR_REASSERTION, FLOOR_SECTIONS, PRECEDENCE, readFloor } from '../src/floor.js';
import { TOOLS } from '../src/tools.js';
import { TOOL_ANNOTATIONS } from '../src/annotations.js';
import { readyInstructions } from '../src/setup.js';





/** Every string anywhere in the floor, flattened. */
function allText(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach(n => allText(n, out)); return out; }
  if (node && typeof node === 'object') { Object.values(node).forEach(n => allText(n, out)); return out; }
  return out;
}

const FLOOR_TEXT = allText(FLOOR).join('\n') + '\n' + FLOOR_REASSERTION.join('\n') + '\n' + PRECEDENCE;

testGroup('The floor is immutable', () => {
  test('FLOOR is frozen', () => assert(Object.isFrozen(FLOOR)));
  test('every section is frozen', () => {
    for (const key of FLOOR_SECTIONS) assert(Object.isFrozen(FLOOR[key]), `${key} is not frozen`);
  });
  test('FLOOR_REASSERTION is frozen', () => assert(Object.isFrozen(FLOOR_REASSERTION)));
  test('a write to a section is refused', () => {
    assert.throws(() => { 'use strict'; FLOOR.persistence = null; }, TypeError);
  });
  test('a write inside a section is refused', () => {
    assert.throws(() => { 'use strict'; FLOOR.persistence.out_of_sight = 'anything'; }, TypeError);
  });
});

testGroup('Shape', () => {
  test('every declared section exists on FLOOR', () => {
    for (const key of FLOOR_SECTIONS) assert(FLOOR[key], `missing section ${key}`);
  });
  test('every section has a title', () => {
    for (const key of FLOOR_SECTIONS) assert(typeof FLOOR[key].title === 'string' && FLOOR[key].title.length > 0, key);
  });
  test('every value in every section is a non-empty string', () => {
    for (const key of FLOOR_SECTIONS) {
      for (const [field, value] of Object.entries(FLOOR[key])) {
        assert.strictEqual(typeof value, 'string', `${key}.${field} is not a string`);
        assert(value.trim().length > 0, `${key}.${field} is empty`);
      }
    }
  });
  test('the protective sections are all present', () => {
    for (const key of ['voice', 'engagement', 'persistence', 'corpus_discipline']) {
      assert(FLOOR_SECTIONS.includes(key), `missing ${key}`);
    }
  });
  test('neurodivergent engagement is not a core section', () => {
    assert(!FLOOR_SECTIONS.includes('reading_people'));
    assert(!FLOOR_SECTIONS.includes('neurodivergent_support'));
    assert(!/rejection sensitivity/i.test(FLOOR_TEXT));
    assert(!/peer-reviewed/i.test(FLOOR_TEXT));
    assert(!/burnout is not depression/i.test(FLOOR_TEXT));
  });
  test('persistence names items and does not frame it as a neurodivergent method', () => {
    assert(/named_items/.test(FLOOR.persistence.out_of_sight));
    assert(!/neurodivergent/i.test(FLOOR.persistence.out_of_sight));
  });
  test('general epistemic honesty stays, and the wellbeing corpus lines do not', () => {
    assert(/established, emerging, or anecdote/i.test(FLOOR.voice.epistemic_honesty));
    assert(FLOOR.corpus_discipline.judgment_gated);
    assert(FLOOR.corpus_discipline.lived_data_wins);
    assert(!('presence_first' in FLOOR.corpus_discipline));
    assert(!('wellbeing_wins' in FLOOR.corpus_discipline));
  });
  test('PRECEDENCE states that modifiers may not remove anything, and a GEM ranks below', () => {
    assert(/no modifier removes anything/i.test(PRECEDENCE));
    assert(/active GEM ranks below the floor and below the user's current word/i.test(PRECEDENCE));
  });
});

testGroup('The compact form is genuinely compact', () => {
  test('between five and fifteen lines', () => {
    assert(FLOOR_REASSERTION.length >= 5 && FLOOR_REASSERTION.length <= 15, `${FLOOR_REASSERTION.length} lines`);
  });
  test('every line is one sentence-ish, under 140 characters', () => {
    for (const line of FLOOR_REASSERTION) assert(line.length <= 140, `too long (${line.length}): ${line}`);
  });
  test('materially shorter than the full floor', () => {
    assert(FLOOR_REASSERTION.join(' ').length * 5 < FLOOR_TEXT.length, 'compact form is not much shorter');
  });
  test('it carries the load-bearing protections, not just style', () => {
    const text = FLOOR_REASSERTION.join(' ').toLowerCase();
    for (const needle of ['answer the question asked', 'never extend a caution', 'no flattery', 'out of sight', 'established, emerging, or anecdote']) {
      assert(text.includes(needle), `compact form drops: ${needle}`);
    }
    assert(!text.includes('burnout'));
    assert(!text.includes('masking'));
  });
});

testGroup('readFloor', () => {
  test('full form by default', async () => {
    const r = await readFloor();
    assert.strictEqual(r.form, 'full');
    assert.deepStrictEqual(r.sections, FLOOR_SECTIONS);
    assert.strictEqual(r.floor, FLOOR);
    assert.strictEqual(r.precedence, PRECEDENCE);
  });
  test('no arguments at all is the same as an empty object', async () => {
    assert.strictEqual((await readFloor()).form, (await readFloor({})).form);
  });
  test('null argument does not throw', async () => assert.strictEqual((await readFloor(null)).form, 'full'));
  test('compact form returns the short list', async () => {
    const r = await readFloor({ compact: true });
    assert.strictEqual(r.form, 'compact');
    assert.strictEqual(r.floor, FLOOR_REASSERTION);
  });
  test('compact form says what it is not', async () => {
    assert(/not a mechanism that enforces it/i.test((await readFloor({ compact: true })).note));
  });
  test('a named section returns only that section', async () => {
    const r = await readFloor({ section: 'persistence' });
    assert.strictEqual(r.form, 'section');
    assert.strictEqual(r.floor, FLOOR.persistence);
  });
  test('an unknown section reports the valid names rather than throwing', async () => {
    const r = await readFloor({ section: 'nope' });
    assert(r.error);
    assert.deepStrictEqual(r.sections, FLOOR_SECTIONS);
  });
  test('a prototype key is not treated as a section', async () => {
    assert((await readFloor({ section: 'constructor' })).error, 'constructor was accepted as a section');
  });
  test('read-only: calling it twice returns identical content', async () => {
    assert.deepStrictEqual(await readFloor(), await readFloor());
  });
  test('gem reads Neurendipity without turning it on', async () => {
    const r = await readFloor({ gem: 'neurendipity' });
    assert.strictEqual(r.form, 'gem');
    assert.strictEqual(r.gem, 'neurendipity');
    assert.strictEqual(r.active, false);
    assert(/masking/i.test(r.floor.reading_people.lines.beliefs_show_in_action));
    assert(/burnout is not depression/i.test(r.floor.neurodivergent_support.lines.burnout_is_not_depression));
    assert(/rejection sensitivity/i.test(r.floor.neurodivergent_support.lines.rejection_sensitivity));
    assert(/peer-reviewed/i.test(r.floor.neurodivergent_support.lines.epistemic_honesty));
    assert(/does not repeat that procedure/i.test(r.floor.neurodivergent_support.lines.out_of_sight));
    assert(!/named_items/.test(r.floor.neurodivergent_support.lines.out_of_sight));
    assert(r.floor.corpus_wellbeing.lines.presence_first);
    assert(r.floor.corpus_wellbeing.lines.wellbeing_wins);
    assert(/guides\/NEURODIVERGENT_SUPPORT\.md/.test(r.floor.neurodivergent_support.lines.guide));
    const again = await readFloor({ gem: 'neurendipity' });
    assert.strictEqual(again.active, false);
  });
  test('gem compact returns the neurodivergent reassertion, not the core list', async () => {
    const r = await readFloor({ gem: 'neurendipity', compact: true });
    assert.strictEqual(r.active, false);
    const text = r.floor.join(' ').toLowerCase();
    assert(text.includes('burnout'));
    assert(text.includes('masking'));
    assert(text.includes('peer-reviewed'));
    assert(!text.includes('answer the question asked'));
  });
  test('an unknown GEM is an error, not a throw', async () => {
    const r = await readFloor({ gem: 'no-such-gem' });
    assert(r.error);
    assert.strictEqual(r.form, 'gem');
  });
  test('a GEM id that is not an id is refused', async () => {
    assert((await readFloor({ gem: '../floor' })).error);
    assert((await readFloor({ gem: 'Constructor' })).error);
  });
});

testGroup('It reaches the host', () => {
  const tool = TOOLS.find(t => t.name === 'emet_floor');
  test('emet_floor is declared', () => assert(tool, 'emet_floor missing from TOOLS'));
  test('emet_floor is annotated read-only', () => {
    assert(TOOL_ANNOTATIONS.emet_floor, 'no annotation');
    assert.strictEqual(TOOL_ANNOTATIONS.emet_floor.readOnlyHint, true);
    assert.strictEqual(TOOL_ANNOTATIONS.emet_floor.destructiveHint, false);
  });
  test('emet_floor takes compact, section, and gem', () => {
    const props = tool.inputSchema.properties;
    assert(props.compact && props.section && props.gem);
    assert(!tool.inputSchema.required, 'no argument should be required');
  });
  test('the description does not promise compliance', () => {
    assert(/not the same as being bound by it/i.test(tool.description));
  });
});

testGroup('The startup instructions place the floor above the character document', () => {
  test('with a character document, the floor is named as the exception', () => {
    const text = readyInstructions(true);
    assert(text.includes('`floor`'), 'floor not mentioned');
    assert(/does not override it/i.test(text), 'precedence not stated');
  });
  test('with a character document, the reassertion is offered for long sessions', () => {
    assert(/floor_reassertion/.test(readyInstructions(true)));
  });
  test('without a character document, the floor is the whole description', () => {
    const text = readyInstructions(false);
    assert(text.includes('`floor`'), 'floor not mentioned');
    assert(/no character document/i.test(text));
  });
  test('neither form tells the model the floor is optional', () => {
    for (const text of [readyInstructions(true), readyInstructions(false)]) {
      assert(!/floor.{0,40}\boptional\b/i.test(text));
    }
  });
});

testGroup('Borrowed vocabulary stays out (regression guard, 2026-09-07)', () => {
  // Removed deliberately: these are a third-party framework's coined terms, and
  // the ideas they carried are stated in plain language instead. See the floor
  // draft's separation ledger. A rewrite that reintroduces one is a regression.
  const FORBIDDEN = [
    'emotional debt',
    'scar tissue',
    'vantage point',
    'vantage-point',
    'press release',
    'behavioral magnetics',
    'behavioural magnetics',
    'active stillness',
    'conditions for completion'
  ];
  for (const term of FORBIDDEN) {
    test(`the floor does not contain "${term}"`, () => {
      assert(!FLOOR_TEXT.toLowerCase().includes(term), `"${term}" is back in the floor`);
    });
  }
  test('the core floor does not carry the moved neurodivergent lines', () => {
    assert(!/basic survival/i.test(FLOOR_TEXT));
    assert(!/never moralise the flare/i.test(FLOOR_TEXT));
  });
});

testGroup('Honesty about what the floor does not do', () => {
  test('the module states that it raises integrity, not compliance', () => {
    // The claim lives in the file header where a reader of the source meets it
    // first; the tool description carries the same limit for the host.
    const tool = TOOLS.find(t => t.name === 'emet_floor');
    assert(/re-reading is not the same as being bound by it/i.test(tool.description));
  });
  test('the compact form does not claim to enforce anything', async () => {
    assert(!/ensures|guarantees|enforces the/i.test((await readFloor({ compact: true })).note));
  });
});

testGroup('Engagement: goal_check and no_rapport_mirroring (Tester review of #39)', () => {
  test('both keys exist under engagement', () => {
    assert.strictEqual(typeof FLOOR.engagement.goal_check, 'string');
    assert.strictEqual(typeof FLOOR.engagement.no_rapport_mirroring, 'string');
  });
  test('the floor text contains "earned by substance"', () => {
    assert(FLOOR_TEXT.includes('earned by substance'));
    assert(FLOOR.engagement.no_rapport_mirroring.includes('Agreement is earned by substance.'));
    assert(FLOOR.engagement.acknowledge.includes('when it is earned by substance, stated as a specific reason, not as praise.'));
  });
  test('no_rapport_mirroring wording: manipulation named, accurate quoting allowed, praise scoped to effect', () => {
    const t = FLOOR.engagement.no_rapport_mirroring;
    assert(t.includes("Do not echo the person's words back, flatter, or agree as a way to build rapport or seem attuned; that is manipulation."));
    assert(t.includes('Quoting them for accuracy is fine.'));
    assert(t.includes('no emotional padding, no praise or rapport-building language used for effect'));
  });
  test('goal_check asks for the goal in your own words and defers to their_own_plan', () => {
    const t = FLOOR.engagement.goal_check;
    assert(/in your own words/.test(t) && /confirm/.test(t) && /their_own_plan/.test(t));
  });
  test('FLOOR_REASSERTION includes the no-mirroring line', () => {
    assert(FLOOR_REASSERTION.includes('Do not mirror their words or agree to build rapport. Agreement is earned by substance.'));
  });
});

summary('FLOOR TEST SUMMARY');
