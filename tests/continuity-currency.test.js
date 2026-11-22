/**
 * Continuity currency when per-tag handoffs are on.
 * Pre-attribution rows are listed and do not warn. A later untagged row warns.
 * The block flag is not applied. Fixtures are generic.
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, testGroup, summary } from './harness.js';
import { makeStore, withStore, withEnv } from './memstore.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
for (const key of ['EMET_CONTINUITY_CURRENCY', 'CASCADE_CONTINUITY_CURRENCY', 'EMET_CONTINUITY_CURRENCY_BLOCK', 'EMET_TAG_HANDOFFS', 'EMET_HUB_TAG', 'EMET_SOURCE_TAGS']) {
  delete process.env[key];
}

const {
  assessContinuityCurrency, PREFERRED_TAGS, continuityCurrencyEnabled, continuityCurrencyBlockEnabled,
  loadContinuityCurrency, splitUnattributedMaterial, TAG_ATTRIBUTION_BEGAN, LEGACY_PRE_ATTRIBUTION, LEGACY_CUTOFF_BASIS
} = await import('../src/continuity-currency.js');

const HUB = 'hub-tag';
const BOT = 'writer-tag';
const CITED = 21;

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
function seconds(iso) {
  return Date.parse(iso) / 1000;
}
function sortedIds(ids) {
  return [...ids].filter((id) => id != null).sort((a, b) => a - b);
}
function handoffText(episodic) {
  return [
    '# HANDOFF',
    '',
    '## §6 CLOSE VERIFICATION',
    '| Artifact | Done | Evidence |',
    '|---|---|---|',
    `| Session record in memory | Y | episodic ${episodic} |`,
    '| This handoff | Y | v2 — written last, one write |',
    ''
  ].join('\n');
}
function ep(id, content, extra = {}) {
  const row = {
    id,
    timestamp: extra.timestamp,
    content,
    importance: 0.55,
    metadata: {
      tags: ['handoff'],
      ...(extra.source != null ? { source: extra.source } : {}),
      ...(extra.layer_tip != null ? { layer_tip: extra.layer_tip } : {})
    },
    superseded_by: null,
    is_live: true
  };
  if (extra.dropId) delete row.id;
  return row;
}
function currentEntries(extra = []) {
  return [
    ep(10, 'A material row with no source, before the cutoff.', { timestamp: seconds('2026-04-19T21:55:00.000Z') }),
    ep(11, 'A material row with an unregistered source, before the cutoff.', {
      timestamp: seconds('2026-07-29T11:32:00.000Z'),
      source: 'guest-host'
    }),
    ep(20, 'Hub session cited by the current handoff.', {
      timestamp: seconds('2026-11-18T12:00:00.000Z'),
      source: HUB
    }),
    ep(CITED, 'Writer session cited by the current handoff.', {
      timestamp: seconds('2026-11-18T12:05:00.000Z'),
      source: BOT
    }),
    ...extra
  ];
}
function plant(store, entries) {
  const hubBody = handoffText(CITED);
  const botBody = handoffText(CITED);
  store.collection('documents').docs.push(
    { doc_id: 'HANDOFF.md', version: 2, sha256: sha(hubBody), updated_at: '2026-11-18T12:05:00.000Z', content: hubBody },
    { doc_id: `HANDOFF/${BOT}.md`, version: 1, sha256: sha(botBody), updated_at: '2026-11-18T12:05:00.000Z', content: botBody }
  );
  for (const entry of entries) store.collection('emet_episodic').docs.push({ ...entry });
}
async function currencyOf(entries, tags = [HUB, BOT]) {
  const store = makeStore();
  plant(store, entries);
  return withEnv({
    EMET_TAG_HANDOFFS: 'enforce',
    EMET_HUB_TAG: HUB,
    EMET_SOURCE_TAGS: tags.join(','),
    EMET_CONTINUITY_CURRENCY: '1',
    EMET_CONTINUITY_CURRENCY_BLOCK: '1'
  }, () => withStore(store, () => loadContinuityCurrency(store)));
}

console.log('\n=== continuity currency ===');

testGroup('the gate stays off and does not block', () => {
  test('the flag is off unless it is the digit 1, and the block is not applied', () => {
    assert.strictEqual(continuityCurrencyEnabled(), false);
    assert.strictEqual(continuityCurrencyBlockEnabled(), false);
    withEnv({ EMET_CONTINUITY_CURRENCY: '1' }, () => {
      assert.strictEqual(continuityCurrencyEnabled(), true);
    });
    withEnv({ EMET_CONTINUITY_CURRENCY_BLOCK: '1', EMET_TAG_HANDOFFS: 'enforce' }, () => {
      assert.strictEqual(continuityCurrencyBlockEnabled(), false);
    });
    assert.ok(PREFERRED_TAGS.includes('material'));
    const open = assessContinuityCurrency({
      handoff: { doc_id: 'HANDOFF.md', version: 1, content: 'Close verification: episodic 9\n', updated_at: '2026-11-10T12:00:00.000Z' },
      entries: [{ id: 9, timestamp: '2026-11-10T12:00:00.000Z', content: 'handoff work on the board', metadata: { tags: ['material'] } }],
      sessions: [{ episodic_id: 9, closed: false }],
      openEpisodicIds: new Set([9])
    });
    assert.strictEqual(open.does_not_block, true);
    assert.strictEqual(open.block_enabled, false);
  });
});

testGroup('legacy pre-attribution', () => {
  test('rows before the cutoff are listed and do not warn', async () => {
    const gate = await currencyOf(currentEntries());
    assert.strictEqual(gate.overall_status, 'current');
    assert.strictEqual(gate.legacy_pre_attribution.reading, LEGACY_PRE_ATTRIBUTION);
    assert.strictEqual(gate.legacy_pre_attribution.reading, 'legacy (pre-attribution)');
    assert.strictEqual(gate.legacy_pre_attribution.count, 2);
    assert.deepStrictEqual(sortedIds(gate.legacy_pre_attribution.ids), [10, 11]);
    assert.strictEqual(gate.legacy_pre_attribution.cutoff, TAG_ATTRIBUTION_BEGAN);
    assert.strictEqual(gate.legacy_pre_attribution.cutoff, '2026-09-27T00:00:00.000Z');
    assert.strictEqual(gate.legacy_pre_attribution.cutoff_basis, LEGACY_CUTOFF_BASIS);
    assert.strictEqual(gate.legacy_pre_attribution.cutoff_basis, 'after_last_unsourced_episodic');
    assert.deepStrictEqual(gate.noted_legacy.rows, []);
    assert.strictEqual(gate.does_not_block, true);
    assert.strictEqual(gate.block_enabled, false);
  });

  test('a new untagged row still warns', async () => {
    const gate = await currencyOf(currentEntries([
      ep(12, 'Untagged session after the cutoff.', { timestamp: seconds('2026-10-02T15:00:00.000Z') }),
      ep(14, 'Untagged session at the cutoff instant.', { timestamp: seconds(TAG_ATTRIBUTION_BEGAN) })
    ]));
    assert.strictEqual(gate.overall_status, 'warn');
    assert.deepStrictEqual(sortedIds(gate.unattributed_material), [12, 14]);
    assert.deepStrictEqual(sortedIds(gate.legacy_pre_attribution.ids), [10, 11]);
    assert.strictEqual(gate.does_not_block, true);
  });

  test('an unregistered source after the cutoff still warns', async () => {
    const gate = await currencyOf(currentEntries([
      ep(13, 'Unregistered source after the cutoff.', {
        timestamp: seconds('2026-10-03T15:00:00.000Z'),
        source: 'guest-host'
      })
    ]));
    assert.strictEqual(gate.overall_status, 'warn');
    assert.deepStrictEqual(sortedIds(gate.unattributed_material), [13]);
  });

  test('a missing id after the cutoff still warns, and a missing id before it does not', async () => {
    const late = ep(1, 'Material row with no id after the cutoff.', {
      timestamp: seconds('2026-10-04T12:00:00.000Z'),
      layer_tip: 8,
      dropId: true
    });
    const early = ep(1, 'Material row with no id before the cutoff.', {
      timestamp: seconds('2026-07-16T12:00:00.000Z'),
      layer_tip: 7,
      dropId: true
    });
    const gate = await currencyOf(currentEntries([late, early]));
    assert.strictEqual(gate.overall_status, 'warn');
    assert.deepStrictEqual(gate.unattributed_material, []);
    assert.ok(!gate.legacy_pre_attribution.ids.includes(null));
    assert.deepStrictEqual(sortedIds(gate.legacy_pre_attribution.ids), [10, 11]);
  });

  test('a missing or unreadable timestamp still warns', async () => {
    const missing = await currencyOf(currentEntries([
      ep(15, 'Untagged material row with no timestamp.', { timestamp: null })
    ]));
    assert.deepStrictEqual(sortedIds(missing.unattributed_material), [15]);
    const garbage = await currencyOf(currentEntries([
      ep(16, 'Untagged material row with a timestamp that does not parse.', { timestamp: 'not-a-time' })
    ]));
    assert.deepStrictEqual(sortedIds(garbage.unattributed_material), [16]);
    assert.strictEqual(garbage.overall_status, 'warn');
  });

  test('a no_handoff tag with only pre-cutoff material stays out of the overall status', async () => {
    const idle = 'idle-tag';
    const old = 'old-tag';
    const gate = await currencyOf(currentEntries([
      ep(9, 'Registered tag whose only material row is before the cutoff.', {
        timestamp: seconds('2026-07-01T12:00:00.000Z'),
        source: old
      })
    ]), [HUB, BOT, idle, old]);
    assert.strictEqual(gate.overall_status, 'current');
    assert.strictEqual(gate.per_tag.find((row) => row.tag === idle).status, 'no_handoff');
    assert.strictEqual(gate.per_tag.find((row) => row.tag === old).status, 'no_handoff');
  });

  test('a no_handoff tag with material rows after the cutoff still counts', async () => {
    const writer = 'field-tag';
    const gate = await currencyOf(currentEntries([
      ep(17, 'Registered tag wrote material work after the cutoff and has no handoff.', {
        timestamp: seconds('2026-10-05T12:00:00.000Z'),
        source: writer
      })
    ]), [HUB, BOT, writer]);
    assert.strictEqual(gate.overall_status, 'no_handoff');
    assert.strictEqual(gate.per_tag.find((row) => row.tag === writer).status, 'no_handoff');
  });

  test('splitUnattributedMaterial keeps the cutoff and does not rewrite the row', () => {
    const row = { id: 4, timestamp: seconds('2026-01-01T00:00:00.000Z'), content: 'old', metadata: { tags: ['handoff'] } };
    const split = splitUnattributedMaterial([row], Date.parse('2026-11-18T00:00:00.000Z'));
    assert.deepStrictEqual(split.legacy, [4]);
    assert.deepStrictEqual(split.unattributed, []);
    assert.strictEqual(row.metadata.tags[0], 'handoff');
  });
});

summary('continuity currency');
