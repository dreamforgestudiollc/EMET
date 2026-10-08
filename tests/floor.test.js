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
    assert.throws(() => { 'use strict'; FLOOR.neurodivergent_support = null; }, TypeError);
  });
  test('a write inside a section is refused', () => {
    assert.throws(() => { 'use strict'; FLOOR.neurodivergent_support.never_moralise = 'anything'; }, TypeError);
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
    for (const key of ['voice', 'engagement', 'reading_people', 'neurodivergent_support']) {
      assert(FLOOR_SECTIONS.includes(key), `missing ${key}`);
    }
  });
  test('PRECEDENCE states that modifiers may not remove anything', () => {
    assert(/no modifier removes anything/i.test(PRECEDENCE));
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
    for (const needle of ['burnout', 'masking', 'validation before restructuring', 'presence before prescription']) {
      assert(text.includes(needle), `compact form drops: ${needle}`);
    }
  });
});

testGroup('readFloor', () => {
  test('full form by default', () => {
    const r = readFloor();
    assert.strictEqual(r.form, 'full');
    assert.deepStrictEqual(r.sections, FLOOR_SECTIONS);
    assert.strictEqual(r.floor, FLOOR);
    assert.strictEqual(r.precedence, PRECEDENCE);
  });
  test('no arguments at all is the same as an empty object', () => {
    assert.strictEqual(readFloor().form, readFloor({}).form);
  });
  test('null argument does not throw', () => assert.strictEqual(readFloor(null).form, 'full'));
  test('compact form returns the short list', () => {
    const r = readFloor({ compact: true });
    assert.strictEqual(r.form, 'compact');
    assert.strictEqual(r.floor, FLOOR_REASSERTION);
  });
  test('compact form says what it is not', () => {
    assert(/not a mechanism that enforces it/i.test(readFloor({ compact: true }).note));
  });
  test('a named section returns only that section', () => {
    const r = readFloor({ section: 'neurodivergent_support' });
    assert.strictEqual(r.form, 'section');
    assert.strictEqual(r.floor, FLOOR.neurodivergent_support);
  });
  test('an unknown section reports the valid names rather than throwing', () => {
    const r = readFloor({ section: 'nope' });
    assert(r.error);
    assert.deepStrictEqual(r.sections, FLOOR_SECTIONS);
  });
  test('a prototype key is not treated as a section', () => {
    assert(readFloor({ section: 'constructor' }).error, 'constructor was accepted as a section');
  });
  test('read-only: calling it twice returns identical content', () => {
    assert.deepStrictEqual(readFloor(), readFloor());
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
  test('emet_floor takes compact and section', () => {
    const props = tool.inputSchema.properties;
    assert(props.compact && props.section);
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
  test('reading people still carries the masking limit', () => {
    assert(/masking/i.test(FLOOR.reading_people.beliefs_show_in_action));
    assert(/basic survival/i.test(FLOOR.reading_people.beliefs_show_in_action));
  });
  test('neurodivergent support still refuses to moralise the flare', () => {
    assert(/never moralise the flare/i.test(FLOOR.neurodivergent_support.never_moralise));
  });
  test('burnout is still distinguished from depression', () => {
    assert(/burnout is not depression/i.test(FLOOR.neurodivergent_support.burnout_is_not_depression));
  });
});

testGroup('Honesty about what the floor does not do', () => {
  test('the module states that it raises integrity, not compliance', () => {
    // The claim lives in the file header where a reader of the source meets it
    // first; the tool description carries the same limit for the host.
    const tool = TOOLS.find(t => t.name === 'emet_floor');
    assert(/re-reading is not the same as being bound by it/i.test(tool.description));
  });
  test('the compact form does not claim to enforce anything', () => {
    assert(!/ensures|guarantees|enforces the/i.test(readFloor({ compact: true }).note));
  });
});

summary('FLOOR TEST SUMMARY');
