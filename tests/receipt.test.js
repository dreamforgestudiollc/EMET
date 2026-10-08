/**
 * EMET - the write receipt as fixture (E3 + A3 + A4 + A5 + B1 + B2 + C3).
 *
 * The principle, stated once: every accountability field that is MISSING is
 * written as a visible marker, never left absent - absence cannot be queried,
 * "missing" can. A write is never blocked for a missing field: it is flagged.
 * The receipt is the fixture: one shape on both transports, and it says what
 * happened to the write.
 *
 * saveMemory is driven against a fake dbManager that captures the insert
 * params and hands the row back for the aleph read-back, so every assertion
 * here is about what the door DECIDED and what it WROTE, with no store.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { saveMemory, storedExchange } from '../src/tools.js';
import { digest, digestMetadata } from '../src/aleph.js';
import { bandFor } from '../src/layers.js';
import { LAYERS } from '../src/layers.js';


// ---------------------------------------------------------------------------
// Fake store: captures writes, serves the read-back. The row carries id,
// content and sha256 exactly as the insert supplied them, so verifyLayerEntry
// passes on content and on the stored digest column.
// ---------------------------------------------------------------------------
function fakeDb() {
  const writes = [];
  const rows = {};
  let lastId = 100;
  return {
    writes,
    async getConnection() {
      return { async getAsync(_sql, params) { return rows[params[0]] || null; } };
    },
    // 2026-09-27: the door is insertMemory(layer, doc) / readMemory(layer, id) - a
    // document in, an id out - not an INSERT string with positional params.
    async insertMemory(layer, doc) {
      const id = ++lastId;
      writes.push({ layer, doc, id });
      rows[id] = { ...doc, id };
      return id;
    },
    async readMemory(_layer, id) { return rows[id] || null; }
  };
}

const ENV_KEYS = ['EMET_SOURCE_TAG', 'CASCADE_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'CASCADE_SOURCE_TAGS', 'EMET_SIGNING_KEY', 'CASCADE_SIGNING_KEY'];
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try { return await fn(); }
  finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// 2026-09-29 (a decision record): semantic and procedural writes are refused with
// no source. Tests here that are not ABOUT provenance get a fixture pointer on
// those two layers; the provenance tests pass their own metadata and say so.
const FIXTURE_POINTER = { session_id: '2026-09-29_receipt-fixture', exchange_start: 1, exchange_end: 1 };
async function save(layer, metadata, content = 'A durable fact about the system.', env = {}) {
  const md = (['semantic', 'procedural'].includes(layer) && !('derived_from' in metadata))
    ? { ...metadata, derived_from: FIXTURE_POINTER } : metadata;
  return withEnv(env, async () => {
    const db = fakeDb();
    const receipt = await saveMemory(db, content, layer, md);
    const write = db.writes[0];
    // The row is a document now; `params` keeps the old positional view for the
    // assertions below (index -> field), so they read the same as before.
    const d = write.doc;
    const params = [d.timestamp, d.content, d.event, d.context, d.emotional_intensity, d.importance, d.metadata, d.superseded_by, d.valid_until, d.is_live, d.source_session_id, d.source_exchange_start, d.source_exchange_end, d.derived_from_ids, d.sha256, d.metadata_sha256, d.signature, d.prev_sha256, d.chain_sha256];
    return { receipt, write, written: d.metadata, params, row: d };
  });
}

const RECEIPT_ORDER = [
  'layer', 'id', 'timestamp', 'verified', 'sha256', 'digest_stored',
  'metadata_sha256', 'metadata_digest_stored',   // C1 (2026-09-07)
  'signed', 'signature_stored',
  'redacted',
  'provenance', 'provenance_stamped', 'provenance_missing',
  'source', 'source_defaulted', 'source_unregistered', 'source_missing',
  'assertion_origin', 'assertion_origin_missing',
  'importance', 'importance_defaulted',
  'routing', 'relocated_to_custom', 'warnings'
];
const ALWAYS_PRESENT = RECEIPT_ORDER.filter((k) => ![
  'provenance_stamped', 'provenance_missing', 'source_defaulted', 'source_unregistered', 'source_missing',
  'assertion_origin_missing', 'importance_defaulted', 'relocated_to_custom'
].includes(k));

// ===========================================================================
testGroup('A3: source decided in one place', () => {
  test('caller source is kept, no marker', async () => {
    const { receipt, written } = await save('working', { source: 'cli' }, 'x', { EMET_SOURCE_TAG: 'mobile' });
    assert.strictEqual(receipt.source, 'cli');
    assert.strictEqual(receipt.source_defaulted, undefined);
    assert.strictEqual(receipt.source_missing, undefined);
    assert.strictEqual(written.source, 'cli');
    assert.strictEqual(written.source_defaulted, undefined);
  });
  test('EMET_SOURCE_TAG fills an absent source and marks source_defaulted', async () => {
    const { receipt, written } = await save('working', {}, 'x', { EMET_SOURCE_TAG: 'mobile' });
    assert.strictEqual(receipt.source, 'mobile');
    assert.strictEqual(receipt.source_defaulted, true);
    assert.strictEqual(receipt.source_missing, undefined);
    assert.strictEqual(written.source, 'mobile');
    assert.strictEqual(written.source_defaulted, true);
  });
  test('an empty-string source counts as absent', async () => {
    const { receipt } = await save('working', { source: '   ' }, 'x', { EMET_SOURCE_TAG: 'mobile' });
    assert.strictEqual(receipt.source, 'mobile');
    assert.strictEqual(receipt.source_defaulted, true);
  });
  test('no source and no default: source null + source_missing, write NOT blocked', async () => {
    const { receipt, written } = await save('working', {}, 'x', {});
    assert.strictEqual(receipt.source, null);
    assert.strictEqual(receipt.source_missing, true);
    assert.strictEqual(receipt.source_defaulted, undefined);
    assert.strictEqual(receipt.verified, true);
    assert.strictEqual(written.source, null);
    assert.strictEqual(written.source_missing, true);
  });
  test('registry set and source not in it: source_unregistered', async () => {
    const { receipt, written } = await save('working', { source: 'stranger' }, 'x', { EMET_SOURCE_TAGS: 'cli, mobile ,cloud-host' });
    assert.strictEqual(receipt.source, 'stranger');
    assert.strictEqual(receipt.source_unregistered, true);
    assert.strictEqual(written.source_unregistered, true);
  });
  test('registry set and source in it: no marker', async () => {
    const { receipt } = await save('working', { source: 'mobile' }, 'x', { EMET_SOURCE_TAGS: 'cli,mobile' });
    assert.strictEqual(receipt.source_unregistered, undefined);
  });
  test('registry checks the defaulted tag too', async () => {
    const { receipt } = await save('working', {}, 'x', { EMET_SOURCE_TAG: 'odd', EMET_SOURCE_TAGS: 'cli,mobile' });
    assert.strictEqual(receipt.source_defaulted, true);
    assert.strictEqual(receipt.source_unregistered, true);
  });
  test('no registry: the check is skipped', async () => {
    const { receipt } = await save('working', { source: 'anything' }, 'x', {});
    assert.strictEqual(receipt.source_unregistered, undefined);
  });
  test('a caller cannot pre-assert a marker: the door recomputes it', async () => {
    const { receipt, written } = await save('working', { source: 'cli', source_missing: true, source_defaulted: true }, 'x', {});
    assert.strictEqual(receipt.source_missing, undefined);
    assert.strictEqual(receipt.source_defaulted, undefined);
    assert.strictEqual(written.source_missing, undefined);
  });
});

// ===========================================================================
testGroup('A4: importance from the charter band', () => {
  for (const layer of LAYERS) {
    test(`${layer}: absent importance -> band midpoint ${bandFor(layer).midpoint}, marked`, async () => {
      const { receipt, written, params } = await save(layer, {});
      assert.strictEqual(receipt.importance, bandFor(layer).midpoint);
      assert.strictEqual(receipt.importance_defaulted, true);
      assert.strictEqual(written.importance, bandFor(layer).midpoint);
      assert.strictEqual(written.importance_defaulted, true);
      assert.strictEqual(params[5], bandFor(layer).midpoint, 'importance column');
      assert.ok(!receipt.warnings.some((w) => w.startsWith('importance')));
    });
  }
  test('explicit null importance is treated as absent (not the validator\'s 0.7)', async () => {
    const { receipt } = await save('semantic', { importance: null });
    assert.strictEqual(receipt.importance, 0.75);
    assert.strictEqual(receipt.importance_defaulted, true);
  });
  test('importance inside the band: kept, no marker, no warning', async () => {
    const { receipt, params } = await save('semantic', { importance: 0.8 });
    assert.strictEqual(receipt.importance, 0.8);
    assert.strictEqual(receipt.importance_defaulted, undefined);
    assert.strictEqual(params[5], 0.8);
    assert.deepStrictEqual(receipt.warnings.filter((w) => w.startsWith('importance')), []);
  });
  test('importance outside the band: kept, warned, never rejected', async () => {
    const { receipt, params, written } = await save('working', { importance: 0.9 });
    assert.strictEqual(receipt.importance, 0.9);
    assert.strictEqual(params[5], 0.9);
    assert.strictEqual(written.importance, 0.9);
    assert.strictEqual(receipt.importance_defaulted, undefined);
    assert.ok(receipt.warnings.includes('importance 0.9 is outside the working band 0.3–0.6'), JSON.stringify(receipt.warnings));
  });
});

// ===========================================================================
testGroup('A5: provenance policy from the charter', () => {
  const pointer = { session_id: '2026-09-07_receipt-test', exchange_start: 1, exchange_end: 2 };
  // 2026-09-29 (a decision record): these two were "provenance_missing + warning";
  // the ruling made them refusals. Called directly - save() would add a pointer.
  test('semantic without derived_from: REFUSED, nothing written', async () => {
    const db = fakeDb();
    await assert.rejects(() => saveMemory(db, 'A durable fact about the system.', 'semantic', {}), /semantic entries must carry their source/);
    assert.strictEqual(db.writes.length, 0);
  });
  test('procedural without derived_from: REFUSED, nothing written', async () => {
    const db = fakeDb();
    await assert.rejects(() => saveMemory(db, 'how to do it', 'procedural', {}), /procedural entries must carry their source/);
    assert.strictEqual(db.writes.length, 0);
  });
  test('semantic with derived_from: pointer in receipt, no marker, no warning', async () => {
    const { receipt, written } = await save('semantic', { derived_from: pointer });
    assert.ok(receipt.provenance && receipt.provenance.session_id === pointer.session_id);
    assert.strictEqual(receipt.provenance_missing, undefined);
    assert.strictEqual(written.provenance_missing, undefined);
    assert.ok(!receipt.warnings.some((s) => s.includes('derived_from')));
  });
  test('episodic without derived_from: provenance_missing and NO warning', async () => {
    const { receipt, written } = await save('episodic', {});
    assert.strictEqual(receipt.provenance_missing, true);
    assert.strictEqual(written.provenance_missing, true);
    assert.ok(!receipt.warnings.some((s) => s.includes('derived_from')));
  });
  test('meta without derived_from: provenance_missing and NO warning', async () => {
    const { receipt } = await save('meta', {});
    assert.strictEqual(receipt.provenance_missing, true);
    assert.ok(!receipt.warnings.some((s) => s.includes('derived_from')));
  });
  test('working without derived_from: nothing', async () => {
    const { receipt, written } = await save('working', {});
    assert.strictEqual(receipt.provenance_missing, undefined);
    assert.strictEqual(written.provenance_missing, undefined);
    assert.ok(!receipt.warnings.some((s) => s.includes('derived_from')));
  });
  test('identity without derived_from: nothing', async () => {
    const { receipt } = await save('identity', {});
    assert.strictEqual(receipt.provenance_missing, undefined);
  });
});

// ===========================================================================
testGroup('E3: assertion origin marker', () => {
  test('absent -> null + assertion_origin_missing, in receipt and in the written metadata', async () => {
    const { receipt, written } = await save('working', {});
    assert.strictEqual(receipt.assertion_origin, null);
    assert.strictEqual(receipt.assertion_origin_missing, true);
    assert.strictEqual(written.assertion_origin, null);
    assert.strictEqual(written.assertion_origin_missing, true);
  });
  test('explicit null -> null, NO marker (the door never infers)', async () => {
    const { receipt, written } = await save('working', { assertion_origin: null });
    assert.strictEqual(receipt.assertion_origin, null);
    assert.strictEqual(receipt.assertion_origin_missing, undefined);
    assert.strictEqual(written.assertion_origin, null);
    assert.strictEqual(written.assertion_origin_missing, undefined);
  });
  test('given -> kept, no marker', async () => {
    const { receipt, written } = await save('working', { assertion_origin: 'user' });
    assert.strictEqual(receipt.assertion_origin, 'user');
    assert.strictEqual(receipt.assertion_origin_missing, undefined);
    assert.strictEqual(written.assertion_origin, 'user');
  });
});

// ===========================================================================
testGroup('B1: the routing decision is kept', () => {
  test('explicit layer -> routing.method explicit with the analyzer\'s verdict beside it', async () => {
    const { receipt, written } = await save('semantic', {}, 'I feel grateful for this amazing partnership!');
    assert.strictEqual(receipt.layer, 'semantic');
    const r = receipt.routing;
    assert.strictEqual(r.method, 'explicit');
    assert.strictEqual(r.layer, 'semantic');
    assert.ok(LAYERS.includes(r.analyzer_layer), r.analyzer_layer);
    assert.ok(typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1);
    assert.strictEqual(r.signals, undefined);
    assert.deepStrictEqual(written.routing, r);
  });
  test('B5: no layer -> lands in working, routing.method fallback, both routers recorded, receipt warns', async () => {
    const { receipt, written } = await save(null, {}, 'How to configure the server: step one, run the setup script.');
    assert.strictEqual(receipt.layer, 'working');
    const r = receipt.routing;
    assert.strictEqual(r.method, 'fallback');
    assert.strictEqual(r.layer, 'working');
    assert.ok(LAYERS.includes(r.keyword_layer));
    assert.strictEqual(r.keyword_layer, 'procedural'); // database.js determineLayer: "how to" -> procedural
    assert.ok(receipt.warnings.some((w) => /no layer given/.test(w) && /working/.test(w)));
    assert.ok(LAYERS.includes(r.analyzer_layer));
    assert.ok(typeof r.confidence === 'number');
    assert.ok(Array.isArray(r.signals) && r.signals.length <= 8 && r.signals.every((s) => typeof s === 'string'));
    assert.ok(typeof r.technical_density === 'number');
    assert.deepStrictEqual(written.routing, r);
  });
  test('B5: the routers never place an entry - a strong keyword match still lands in working', async () => {
    const { receipt } = await save(null, {}, 'how to do it');
    assert.strictEqual(receipt.layer, 'working');
    assert.strictEqual(receipt.routing.layer, 'working');
    assert.strictEqual(receipt.routing.keyword_layer, 'procedural');
  });
  test('B5: a named layer never warns about fallback and carries no keyword_layer', async () => {
    const { receipt } = await save('procedural', {}, 'how to do it');
    assert.strictEqual(receipt.layer, 'procedural');
    assert.strictEqual(receipt.routing.method, 'explicit');
    assert.strictEqual(receipt.routing.keyword_layer, undefined);
    assert.ok(!receipt.warnings.some((w) => /no layer given/.test(w)));
  });
  test('a caller-supplied routing object is kept as-is', async () => {
    const mine = { method: 'operator', note: 'placed by hand' };
    const { receipt, written } = await save('working', { routing: mine });
    assert.deepStrictEqual(receipt.routing, mine);
    assert.deepStrictEqual(written.routing, mine);
  });
});

// ===========================================================================
testGroup('B2: emotional intensity precedence', () => {
  const emotive = 'I feel so grateful, this is an amazing breakthrough!!!';
  test('caller value wins and is recorded as caller', async () => {
    const { receipt, params } = await save('working', { emotional_intensity: 0.12 }, emotive);
    assert.strictEqual(params[4], 0.12);
    assert.strictEqual(receipt.routing.emotional_intensity_source, 'caller');
  });
  test('absent -> the analyzer\'s figure, recorded as analyzer', async () => {
    const { receipt, params } = await save('working', {}, emotive);
    assert.ok(params[4] > 0.5, `expected the analyzer to score ${emotive} above baseline, got ${params[4]}`);
    assert.ok(params[4] <= 1);
    assert.strictEqual(receipt.routing.emotional_intensity_source, 'analyzer');
  });
  test('explicit null -> treated as absent (analyzer)', async () => {
    const { receipt } = await save('working', { emotional_intensity: null }, emotive);
    assert.strictEqual(receipt.routing.emotional_intensity_source, 'analyzer');
  });
  test('flat content -> the analyzer\'s baseline 0.5, still attributed to the analyzer', async () => {
    const { receipt, params } = await save('working', {}, 'plain note');
    assert.strictEqual(params[4], 0.5);
    assert.strictEqual(receipt.routing.emotional_intensity_source, 'analyzer');
  });
  test('emotional_intensity_source lives inside routing, not as a metadata field', async () => {
    const { written } = await save('working', {}, 'plain note');
    assert.strictEqual(written.emotional_intensity_source, undefined);
    assert.ok(written.custom === undefined || written.custom.emotional_intensity_source === undefined);
  });
});

// ===========================================================================
testGroup('C3: the receipt as fixture', () => {
  test('warnings is always an array - empty on a clean write', async () => {
    const { receipt } = await save('working', { source: 'cli', importance: 0.5, assertion_origin: 'user' }, 'x', { EMET_SOURCE_TAGS: 'cli' });
    assert.ok(Array.isArray(receipt.warnings));
    assert.deepStrictEqual(receipt.warnings, []);
  });
  test('clean write: exactly the always-present keys, in order, no optional markers', async () => {
    const { receipt } = await save('working', { source: 'cli', importance: 0.5, assertion_origin: 'user' }, 'x', { EMET_SOURCE_TAGS: 'cli' });
    assert.deepStrictEqual(Object.keys(receipt), ALWAYS_PRESENT);
  });
  test('fully flagged write: every optional key present, full order matches the spec', async () => {
    // episodic since 2026-09-29: semantic now refuses a write with no source, and this test wants the provenance_missing marker.
    const { receipt } = await save('episodic', { stray_field: 1 }, 'x', { EMET_SOURCE_TAG: 'odd', EMET_SOURCE_TAGS: 'cli' });
    const expected = RECEIPT_ORDER.filter((k) => !['source_missing', 'provenance_stamped'].includes(k));
    assert.deepStrictEqual(Object.keys(receipt), expected);
    assert.deepStrictEqual(receipt.relocated_to_custom, ['stray_field']);
    // The only warning this fixture used to raise was the semantic provenance
    // warning, now a refusal (2026-09-29). `warnings` stays an array either way.
    assert.ok(Array.isArray(receipt.warnings));
  });
  test('missing-source variant orders source_missing where the spec puts it', async () => {
    const { receipt } = await save('episodic', {}, 'x', {});
    const expected = RECEIPT_ORDER.filter((k) => !['source_defaulted', 'source_unregistered', 'relocated_to_custom', 'provenance_stamped'].includes(k));
    assert.deepStrictEqual(Object.keys(receipt), expected);
  });
  test('the receipt values are the store\'s: sha256 matches the content digest and the stored column', async () => {
    const { receipt, params } = await save('working', {}, 'the exact text');
    assert.strictEqual(receipt.sha256, digest('the exact text'));
    assert.strictEqual(params[14], receipt.sha256);
    assert.strictEqual(receipt.digest_stored, true);
    // C1: the metadata digest is the digest of the metadata that was WRITTEN
    // (after every marker), stored as its own column, and read back.
    assert.strictEqual(params[15], receipt.metadata_sha256);
    assert.strictEqual(receipt.metadata_sha256, digestMetadata(params[6]));
    assert.strictEqual(typeof receipt.metadata_digest_stored, 'boolean');
    assert.strictEqual(receipt.verified, true);
    assert.strictEqual(receipt.redacted, 0);
    assert.strictEqual(receipt.signed, 'unsigned');
    assert.strictEqual(receipt.signature_stored, false);
  });
  test('with a signing key the write stores a signature and reports signed true', async () => {
    const { receipt, params } = await save('working', {}, 'signed body', { EMET_SIGNING_KEY: 'unit-test-key' });
    assert.match(params[16], /^[0-9a-f]{64}$/);
    assert.strictEqual(receipt.signature_stored, true);
    assert.strictEqual(receipt.signed, true);
  });
  test('every marker in the receipt is also in the metadata that was written', async () => {
    const { receipt, written } = await save('episodic', {}, 'x', { EMET_SOURCE_TAG: 'odd', EMET_SOURCE_TAGS: 'cli' });
    for (const k of ['provenance_missing', 'source_defaulted', 'source_unregistered', 'assertion_origin_missing', 'importance_defaulted']) {
      assert.strictEqual(receipt[k], true, `receipt.${k}`);
      assert.strictEqual(written[k], true, `written.${k}`);
    }
    assert.strictEqual(written.source, receipt.source);
    assert.strictEqual(written.importance, receipt.importance);
    assert.strictEqual(written.assertion_origin, receipt.assertion_origin);
    assert.deepStrictEqual(written.routing, receipt.routing);
  });
  test('markers never reach custom: they are first-class in the whitelist', async () => {
    const { written } = await save('episodic', {}, 'x', {});
    assert.strictEqual(written.custom, undefined);
  });
});

// ---------------------------------------------------------------------------
// The transcript doors (2026-09-10). Two exchanges saved without timestamps read
// back carrying the save instant with nothing to mark it - the one write path
// that still filled a missing field silently. A fill is now marked.
// ---------------------------------------------------------------------------
testGroup('Transcript exchanges - a defaulted timestamp is marked, never silent', () => {
  const ident = (s) => s || '';
  const NOW = new Date('2026-09-10T18:33:22Z');
  test('an observed timestamp is stored as given and carries no marker', () => {
    const e = storedExchange({ exchange_index: 1, user_message: 'a', assistant_message: 'b', timestamp: 1789060000 }, 0, ident, NOW);
    assert.strictEqual(e.timestamp.getTime(), 1789060000 * 1000);
    assert.strictEqual(e.timestamp_defaulted, undefined);
  });
  for (const [label, ts] of [['absent', undefined], ['null', null], ['zero', 0]]) {
    test(`a ${label} timestamp is filled with the save time AND marked`, () => {
      const e = storedExchange({ exchange_index: 2, user_message: 'a', assistant_message: 'b', timestamp: ts }, 1, ident, NOW);
      assert.strictEqual(e.timestamp.getTime(), NOW.getTime());
      assert.strictEqual(e.timestamp_defaulted, true);
    });
  }
  test('messages still pass through the scrub, and the index defaults to position', () => {
    const e = storedExchange({ user_message: 'u', assistant_message: 'v', timestamp: 1 }, 7, (s) => `[${s}]`, NOW);
    assert.strictEqual(e.user_message, '[u]');
    assert.strictEqual(e.assistant_message, '[v]');
    assert.strictEqual(e.exchange_index, 7);
  });
});

summary('Write Receipt Test Summary');
