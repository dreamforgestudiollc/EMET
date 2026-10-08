/**
 * EMET - layer charter and layer-health tests.
 *
 * The regression these guard against is not a crash. It is a layer quietly
 * having no definition, which is how one of them went unused for a year without
 * failing anything. A charter that is missing a field is a layer nobody can
 * route to, so the completeness of the charter is itself the assertion.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  LAYER_CHARTER, LAYER_SUMMARY, LAYERS, LAYER_ALIASES, FALLBACK_LAYER,
  resolveLayer, bandFor, policyFor, assessLayerHealth
} from '../src/layers.js';
import { VALID_LAYERS } from '../src/validation.js';
import {
  LAYER_ALIASES as ANALYZER_ALIASES,
  VALID_LAYERS as ANALYZER_LAYERS
} from '../src/content_analyzer.js';

const LAYERS_SOURCE = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'layers.js'), 'utf8');





const FIELDS = ['importance', 'holds', 'does_not_hold', 'write_when', 'read_when', 'neglect_symptom'];

testGroup('Every layer is defined, and defined completely', () => {
  test('all six layers have a charter', () => assert.strictEqual(LAYERS.length, 6));
  test('the charter covers exactly the layers the server accepts', () => {
    assert.deepStrictEqual([...LAYERS].sort(), [...VALID_LAYERS].sort());
  });
  test('every layer answers all six charter questions', () => {
    for (const layer of LAYERS) {
      for (const field of FIELDS) {
        const value = LAYER_CHARTER[layer][field];
        assert(typeof value === 'string' && value.length > 0, `${layer}.${field} is empty`);
      }
    }
  });
  test('every layer says what does NOT belong in it', () => {
    for (const layer of LAYERS) assert(LAYER_CHARTER[layer].does_not_hold.length > 20, layer);
  });
  test('every layer has a one-line summary', () => {
    for (const layer of LAYERS) assert(typeof LAYER_SUMMARY[layer] === 'string' && LAYER_SUMMARY[layer].length > 0, layer);
  });
  test('the charter is frozen', () => assert(Object.isFrozen(LAYER_CHARTER)));
});

// ---------------------------------------------------------------------------
// The vocabulary (C2, 2026-09-07): each charter entry carries the numeric twin
// of its prose, and every other module derives its layer facts from here.
// ---------------------------------------------------------------------------
testGroup('The charter carries the machine-readable twin of its prose', () => {
  test('every layer has an importance_range consistent with its prose band', () => {
    for (const layer of LAYERS) {
      const entry = LAYER_CHARTER[layer];
      assert(Array.isArray(entry.importance_range) && entry.importance_range.length === 2, `${layer}.importance_range`);
      const [min, max] = entry.importance_range;
      assert(typeof min === 'number' && typeof max === 'number' && min < max, `${layer}: ${min}..${max}`);
      const m = entry.importance.match(/^(\d\.\d+)\s*-\s*(\d\.\d+)$/);
      assert(m, `${layer}.importance prose '${entry.importance}' is not a band`);
      assert.strictEqual(min, Number(m[1]), `${layer}: min disagrees with prose`);
      assert.strictEqual(max, Number(m[2]), `${layer}: max disagrees with prose`);
    }
  });
  test('every layer states revisable, provenance and aliases', () => {
    for (const layer of LAYERS) {
      const entry = LAYER_CHARTER[layer];
      assert([true, false, 'with care'].includes(entry.revisable), `${layer}.revisable = ${entry.revisable}`);
      assert(['required', 'encouraged', 'n/a'].includes(entry.provenance), `${layer}.provenance = ${entry.provenance}`);
      assert(Array.isArray(entry.aliases) && entry.aliases.length > 0, `${layer}.aliases`);
    }
  });
  test('episodic is the layer that cannot be revised; identity only with care', () => {
    assert.strictEqual(LAYER_CHARTER.episodic.revisable, false);
    assert.strictEqual(LAYER_CHARTER.identity.revisable, 'with care');
    for (const layer of ['semantic', 'procedural', 'meta', 'working']) assert.strictEqual(LAYER_CHARTER[layer].revisable, true, layer);
  });
  test('provenance is required where the layer asserts things', () => {
    assert.strictEqual(LAYER_CHARTER.semantic.provenance, 'required');
    assert.strictEqual(LAYER_CHARTER.procedural.provenance, 'required');
    assert.strictEqual(LAYER_CHARTER.episodic.provenance, 'encouraged');
    assert.strictEqual(LAYER_CHARTER.meta.provenance, 'encouraged');
    assert.strictEqual(LAYER_CHARTER.identity.provenance, 'n/a');
    assert.strictEqual(LAYER_CHARTER.working.provenance, 'n/a');
  });
  test('no alias is claimed by two layers, and no alias is itself a layer name', () => {
    const seen = new Map();
    for (const layer of LAYERS) {
      for (const alias of LAYER_CHARTER[layer].aliases) {
        assert(!LAYERS.includes(alias), `${alias} is a layer name`);
        assert(!seen.has(alias), `${alias} claimed by ${seen.get(alias)} and ${layer}`);
        seen.set(alias, layer);
      }
    }
  });
  test('every layer but identity states an expected_share, read by assessLayerHealth', () => {
    for (const layer of LAYERS) {
      if (layer === 'identity') { assert.strictEqual(LAYER_CHARTER.identity.expected_share, undefined); continue; }
      const s = LAYER_CHARTER[layer].expected_share;
      assert(typeof s === 'number' && s > 0 && s < 1, `${layer}.expected_share = ${s}`);
    }
    const JUNE = { identity: 14, semantic: 75, episodic: 234, procedural: 185, meta: 10, working: 38 };
    const meta = assessLayerHealth(JUNE).underused.find(u => u.layer === 'meta');
    assert.strictEqual(meta.expected_share_at_least, LAYER_CHARTER.meta.expected_share);
  });
  test('FALLBACK_LAYER is working', () => assert.strictEqual(FALLBACK_LAYER, 'working'));
});

testGroup('bandFor and policyFor are pure readers of the charter', () => {
  test('bandFor returns min, max and the arithmetic midpoint', () => {
    const midpoints = {
      identity: { min: 0.9, max: 1.0, midpoint: 0.95 },
      semantic: { min: 0.6, max: 0.9, midpoint: 0.75 },
      episodic: { min: 0.4, max: 0.7, midpoint: 0.55 },
      procedural: { min: 0.5, max: 0.8, midpoint: 0.65 },
      meta: { min: 0.6, max: 0.9, midpoint: 0.75 },
      working: { min: 0.3, max: 0.6, midpoint: 0.45 }
    };
    for (const layer of LAYERS) assert.deepStrictEqual(bandFor(layer), midpoints[layer], layer);
  });
  test('bandFor throws a plain Error for an unknown layer', () => {
    assert.throws(() => bandFor('nope'), (e) => e instanceof Error && e.constructor === Error && /nope/.test(e.message));
  });
  test('policyFor on each layer mirrors its charter entry and names the fallback', () => {
    for (const layer of LAYERS) {
      const p = policyFor(layer);
      assert.deepStrictEqual(p, {
        revisable: LAYER_CHARTER[layer].revisable,
        provenance: LAYER_CHARTER[layer].provenance,
        fallback_layer: 'working',
        aliases: LAYER_CHARTER[layer].aliases
      });
    }
  });
  test('policyFor returns a copy of aliases - the charter cannot be edited through it', () => {
    const p = policyFor('identity');
    p.aliases.push('impostor');
    assert(!LAYER_CHARTER.identity.aliases.includes('impostor'));
  });
  test('policyFor throws a plain Error for an unknown layer', () => {
    assert.throws(() => policyFor('nope'), (e) => e instanceof Error && e.constructor === Error);
  });
});

testGroup('resolveLayer accepts layers and aliases, case-insensitively', () => {
  test("resolveLayer('core') === 'identity'", () => assert.strictEqual(resolveLayer('core'), 'identity'));
  test("resolveLayer('EPISODIC') === 'episodic'", () => assert.strictEqual(resolveLayer('EPISODIC'), 'episodic'));
  test("resolveLayer('nope') === null", () => assert.strictEqual(resolveLayer('nope'), null));
  test('resolveLayer tolerates whitespace and mixed case on aliases', () => assert.strictEqual(resolveLayer('  How-To '), 'procedural'));
  test('resolveLayer returns null for a non-string', () => {
    assert.strictEqual(resolveLayer(null), null);
    assert.strictEqual(resolveLayer(42), null);
  });
  test('every alias in the charter resolves to its own layer', () => {
    for (const layer of LAYERS) for (const alias of LAYER_CHARTER[layer].aliases) assert.strictEqual(resolveLayer(alias), layer, alias);
  });
});

testGroup('One layer list: content_analyzer derives its constants from the charter (B6)', () => {
  test('content_analyzer LAYER_ALIASES equals the charter-derived map', () => {
    assert.deepStrictEqual({ ...ANALYZER_ALIASES }, { ...LAYER_ALIASES });
  });
  test('content_analyzer VALID_LAYERS equals LAYERS', () => {
    assert.deepStrictEqual([...ANALYZER_LAYERS], [...LAYERS]);
  });
  test('the charter alias map is frozen', () => assert(Object.isFrozen(LAYER_ALIASES)));
});

testGroup('layers.js describes the store and never touches it', () => {
  test('layers.js does not import the mongodb package', () => {
    assert(!/from\s+['"]mongodb['"]/.test(LAYERS_SOURCE));
    assert(!/import\s*\(\s*['"]mongodb['"]/.test(LAYERS_SOURCE));
  });
  test('layers.js does not import ./database.js', () => {
    assert(!/['"]\.\/database\.js['"]/.test(LAYERS_SOURCE));
  });
});

testGroup('assessLayerHealth stays quiet when it should', () => {
  test('says nothing about a store too new to have a pattern', () => {
    const r = assessLayerHealth({ identity: 1, semantic: 2, episodic: 3, procedural: 1, meta: 1, working: 1 });
    assert.strictEqual(r.assessed, false);
  });
  test('flags nothing when every layer is in use', () => {
    const r = assessLayerHealth({ identity: 16, semantic: 234, episodic: 457, procedural: 255, meta: 63, working: 49 });
    assert.strictEqual(r.assessed, true);
    assert.strictEqual(r.underused.length, 0);
  });
  test('does not flag identity for being small - it is meant to be', () => {
    const r = assessLayerHealth({ identity: 2, semantic: 234, episodic: 457, procedural: 255, meta: 63, working: 49 });
    assert.strictEqual(r.underused.filter(u => u.layer === 'identity').length, 0);
  });
});

testGroup('assessLayerHealth catches the failure it was written for', () => {
  // The real shape of the store on 2026-06-01, when meta had been effectively
  // dormant for a year. This is the case the check exists to have caught.
  const JUNE = { identity: 14, semantic: 75, episodic: 234, procedural: 185, meta: 10, working: 38 };

  test('flags meta as underused', () => {
    const flagged = assessLayerHealth(JUNE).underused.map(u => u.layer);
    assert(flagged.includes('meta'), `flagged: ${flagged.join(', ') || 'nothing'}`);
  });
  test('reports the actual count rather than a bare warning', () => {
    const meta = assessLayerHealth(JUNE).underused.find(u => u.layer === 'meta');
    assert.strictEqual(meta.entries, 10);
  });
  test('explains what the layer is for', () => {
    const meta = assessLayerHealth(JUNE).underused.find(u => u.layer === 'meta');
    assert(meta.what_it_is_for.length > 0);
    assert(meta.how_to_tell.length > 0);
  });
  test('tells the model to route rather than to backfill', () => {
    const meta = assessLayerHealth(JUNE).underused.find(u => u.layer === 'meta');
    assert(/do not backfill/i.test(meta.instruction));
  });
  test('flags a layer that has stopped being written to', () => {
    const totals = { identity: 16, semantic: 234, episodic: 457, procedural: 255, meta: 63, working: 49 };
    const recent = { identity: 0, semantic: 40, episodic: 80, procedural: 10, meta: 30, working: 0 };
    const flagged = assessLayerHealth(totals, recent).underused.map(u => u.layer);
    assert(flagged.includes('working'));
  });
});

summary('LAYER TEST SUMMARY');
