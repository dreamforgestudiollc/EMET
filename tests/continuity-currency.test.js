/**
 * Continuity-currency (tip-lag) gate.
 * A material lag warns. A documented no-op, a current citation, and a newer
 * scratch or diagnosis-only episodic do not. Initialize does not write
 * HANDOFF or STATE. The flag off shows no warning. The block flag does not block.
 * In-memory store, real initialize. No database.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';
import { makeStore, withStore, withEnv } from './memstore.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
for (const key of ['EMET_CONTINUITY_CURRENCY', 'CASCADE_CONTINUITY_CURRENCY', 'EMET_CONTINUITY_CURRENCY_BLOCK', 'CASCADE_CONTINUITY_CURRENCY_BLOCK', 'EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS']) {
  delete process.env[key];
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { initialize, setupComplete } = await import('../src/setup.js');
const { sessionOpen } = await import('../src/tools.js');
const {
  assessContinuityCurrency, PREFERRED_TAGS, continuityCurrencyEnabled, continuityCurrencyBlockEnabled,
  loadContinuityCurrency, TAG_ATTRIBUTION_BEGAN, LEGACY_PRE_ATTRIBUTION, LEGACY_CUTOFF_BASIS
} = await import('../src/continuity-currency.js');
const {
  CONTINUITY_CURRENCY_MERMAID, continuityCurrencyStep, continuityCurrencyInvariant
} = await import('../src/continuity-currency-statechart.js');

const UPDATED = '2026-11-06T14:05:00.000Z';
const T789 = Date.parse('2026-11-06T14:00:00.000Z') / 1000;
const T790 = Date.parse('2026-11-06T15:00:00.000Z') / 1000;
const T791 = Date.parse('2026-11-06T15:30:00.000Z') / 1000;
const T792 = Date.parse('2026-11-06T16:00:00.000Z') / 1000;
const ANSWERS = {
  assistant_name: 'Ada',
  assistant_character: 'Plain and careful.',
  user_name: 'Sam Example',
  user_context: 'Testing continuity currency.',
  more_than_one_bot: 'no'
};

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function handoffText({ version = 317, episodic = 789, extra = '', top = '' } = {}) {
  return [
    '# HANDOFF',
    '',
    '## §0 RECORD CONTROL',
    `- Handoff revision: v${version}`,
    ...(top ? ['', top] : []),
    '',
    '## §6 CLOSE VERIFICATION',
    '| Artifact | Done | Evidence |',
    '|---|---|---|',
    `| Session record in memory | Y | episodic ${episodic} |`,
    `| This handoff | Y | v${version} — written last, one write |`,
    '',
    extra
  ].join('\n');
}

function ep(id, tags, content, extra = {}) {
  return {
    id,
    timestamp: extra.timestamp,
    content,
    importance: extra.importance ?? 0.55,
    metadata: {
      tags,
      ...(extra.source != null ? { source: extra.source } : {}),
      ...(extra.degree ? { importance_degree: extra.degree } : {}),
      ...(extra.bucket ? { importance_bucket: extra.bucket } : {}),
      ...(extra.kind ? { kind: extra.kind } : {}),
      ...(extra.layer_tip != null ? { layer_tip: extra.layer_tip } : {})
    },
    superseded_by: extra.superseded_by ?? null,
    is_live: extra.is_live !== false,
    ...(extra.valid_until != null ? { valid_until: extra.valid_until } : {})
  };
}

const lagText = handoffText();
const LAG_SHA = sha(lagText);

function lagEntries() {
  return [
    ep(789, ['handoff'], 'Session record. HANDOFF v317 closed complete.', { timestamp: T789 }),
    ep(790, ['material', 'decision'], 'Owner decision: stale HANDOFF must not leave the next session on the old board.', { timestamp: T790 }),
    ep(791, ['deploy'], 'Deploy note written after the handoff closed.', { timestamp: T791 })
  ];
}

function handoffDoc(content, extra = {}) {
  return {
    doc_id: 'HANDOFF.md',
    version: extra.version ?? 317,
    sha256: extra.sha256 === undefined ? sha(content) : extra.sha256,
    updated_at: extra.updated_at === undefined ? UPDATED : extra.updated_at,
    content
  };
}

async function setUpStore() {
  const store = makeStore();
  await withStore(store, () => setupComplete({ ...ANSWERS, source_tag: 'example-host' }));
  return store;
}

function plant(store, { content = lagText, entries = lagEntries(), sessions = [], version = 317, updated_at = UPDATED, sha256 = null } = {}) {
  const body = content;
  store.collection('documents').docs.push({
    doc_id: 'HANDOFF.md',
    version,
    sha256: sha256 || sha(body),
    updated_at,
    content: body
  });
  for (const entry of entries) store.collection('emet_episodic').docs.push({ ...entry });
  for (const row of sessions) store.collection('emet_sessions').docs.push({ ...row });
}

function docOf(store, id) {
  const col = store.cols.get('documents');
  return col ? col.docs.find((row) => row.doc_id === id) : null;
}

async function boot(store, env = {}) {
  return withEnv({ EMET_CONTINUITY_CURRENCY: '1', ...env }, () => withStore(store, () => initialize({ page: 'all' })));
}

console.log('\n=== continuity currency (tip-lag) ===');

testGroup('pure comparison', () => {
  test('790-class material lag warns with enough to rewrite', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(lagText, { sha256: LAG_SHA }),
      entries: lagEntries()
    });
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.does_not_block, true);
    assert.strictEqual(gate.block_enabled, false);
    assert.strictEqual(gate.gate, 'continuity-currency');
    assert.strictEqual(gate.handoff.version, 317);
    assert.strictEqual(gate.handoff.sha256, LAG_SHA);
    assert.strictEqual(gate.handoff.updated_at, UPDATED);
    assert.strictEqual(gate.handoff.cited_episodic_id, 789);
    assert.strictEqual(gate.handoff.claim_basis, 'close_receipt');
    assert.strictEqual(gate.material_tip.id, 791);
    assert.strictEqual(gate.material_tip.timestamp, '2026-11-06T15:30:00.000Z');
    assert.deepStrictEqual(gate.matching_tags, ['material', 'decision', 'deploy']);
    assert.strictEqual(gate.lag_span.newer_material_count, 2);
    assert.strictEqual(gate.lag_span.cited_episodic_id, 789);
    assert.strictEqual(gate.lag_span.material_tip_id, 791);
    assert.deepStrictEqual(gate.newer_material.map((row) => row.id), [791, 790]);
    assert.ok(gate.newer_material.every((row) => row.summary.length > 0 && !row.summary.includes('\n')));
    assert.match(gate.recommended_host_action, /Rewrite HANDOFF\.md whole with supersedes set to 317/);
    assert.match(gate.recommended_host_action, new RegExp(LAG_SHA));
    assert.match(gate.recommended_host_action, new RegExp('episodic ' + '791'));
    assert.match(gate.recommended_host_action, /does not rewrite HANDOFF or STATE/);
    assert.strictEqual(gate.block_eligible, true);
  });

  test('a documented no-op with no newer material tip does not warn', () => {
    const content = handoffText({
      top: 'Documented no-op. version v317, sha256 abc, tip episodic ' + '789' + ', reason: no newer material tip.'
    });
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content),
      entries: [
        ep(789, ['handoff'], 'Session record cited by the no-op.', { timestamp: T789 }),
        ep(792, ['scratch'], 'Scratch left after the wrap.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.status, 'no_op');
    assert.strictEqual(gate.documented_no_op, true);
    assert.notStrictEqual(gate.status, 'warn');
    assert.strictEqual(gate.does_not_block, true);
    assert.strictEqual(gate.material_tip.id, 789);
  });

  test('a current citation of the live material tip does not warn', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 791 })),
      entries: [
        ...lagEntries(),
        ep(792, ['scratch'], 'Scratch after the cited tip.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.handoff.cited_episodic_id, 791);
    assert.strictEqual(gate.material_tip.id, 791);
    assert.strictEqual(gate.does_not_block, true);
  });

  test('a newer scratch or diagnosis-only episodic does not warn', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(lagText, { sha256: LAG_SHA }),
      entries: [
        ep(789, ['handoff'], 'Session record.', { timestamp: T789 }),
        ep(792, ['scratch'], 'Working scratch, not a board change.', { timestamp: T792 }),
        ep(793, ['diagnosis'], 'Nightly transcript flag only. The chat was not read.', { timestamp: T792 + 10 }),
        ep(794, ['transcript-flag'], 'Transcript flag only, no project effect.', { timestamp: T792 + 20 })
      ]
    });
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.material_tip.id, 789);
    assert.strictEqual(gate.does_not_block, true);
  });

  test('a version number alone does not see the v317 class', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc('Handoff revision v317. No episodic id is cited.', { updated_at: null, version: 317 }),
      entries: [ep(790, ['material'], 'Material episodic after v317.', { timestamp: T790 })]
    });
    assert.strictEqual(gate.handoff.claim_basis, 'version_only');
    assert.strictEqual(gate.handoff.cited_episodic_id, null);
    assert.notStrictEqual(gate.status, 'warn');
    assert.strictEqual(gate.material_tip.id, 790);
  });

  test('updated_at warns when the handoff cites no episodic id', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc('Handoff revision v317. No episodic id is cited.', { updated_at: UPDATED }),
      entries: [ep(790, ['Material'], 'Material episodic after the handoff timestamp.', { timestamp: T790 })]
    });
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.handoff.claim_basis, 'updated_at');
    assert.strictEqual(gate.handoff.cited_episodic_id, null);
    assert.strictEqual(gate.material_tip.id, 790);
    assert.deepStrictEqual(gate.matching_tags, ['material']);
  });

  test('close verification wins over a later body citation', () => {
    const content = `${handoffText({ episodic: 789 })}\nThe body also mentions episodic ' + '791' + '.\n`;
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content),
      entries: lagEntries()
    });
    assert.strictEqual(gate.handoff.claim_basis, 'close_receipt');
    assert.strictEqual(gate.handoff.cited_episodic_id, 789);
    assert.strictEqual(gate.status, 'warn');
  });

  test('without a close section, the latest cited episodic id is the claim', () => {
    const content = 'Earlier episodic ' + '100' + '. The latest episodic id explicitly cited is episodic ' + '789' + '.';
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content),
      entries: [
        ep(789, ['handoff'], 'Cited tip.', { timestamp: T789 }),
        ep(790, ['board'], 'Newer board entry.', { timestamp: T790 })
      ]
    });
    assert.strictEqual(gate.handoff.claim_basis, 'body_citation');
    assert.strictEqual(gate.handoff.cited_episodic_id, 789);
    assert.strictEqual(gate.status, 'warn');
  });

  test('a session-graph episodic id is the claim when the handoff cites none', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc('Handoff revision v317. No episodic id is cited.', { version: 317, updated_at: UPDATED }),
      entries: [
        ep(789, [], 'Close record with no preferred tag.', { timestamp: T789 }),
        ep(791, ['decision'], 'Later decision.', { timestamp: T791 })
      ],
      sessions: [{ handoff: true, handoff_version: 317, episodic_id: 789, closed: true }]
    });
    assert.strictEqual(gate.handoff.claim_basis, 'session_graph');
    assert.strictEqual(gate.handoff.cited_episodic_id, 789);
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.material_tip.id, 791);
  });

  test('a later session-graph pointer is material even without a preferred tag', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(lagText, { sha256: LAG_SHA }),
      entries: [
        ep(789, ['handoff'], 'Cited session record.', { timestamp: T789 }),
        ep(795, [], 'Later close record, no preferred tag.', { timestamp: T792 })
      ],
      sessions: [{ handoff: false, episodic_id: 795, closed: true }]
    });
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.material_tip.id, 795);
    assert.strictEqual(gate.material_tip.basis, 'close_verification');
    assert.strictEqual(gate.block_eligible, true);
  });

  test('a layer-tip pointer id is material', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries: [
        ep(789, ['handoff'], 'Cited.', { timestamp: T789 }),
        ep(788, [], 'Pointer row.', { timestamp: T789, layer_tip: 796 }),
        ep(796, [], 'The pointed-to tip.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.material_tip.id, 796);
    assert.strictEqual(gate.material_tip.basis, 'layer_tip');
  });

  test('fallback wording is a warning and is not enough for a later block', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries: [
        ep(789, ['handoff'], 'Cited.', { timestamp: T789 }),
        ep(797, ['binding'], 'The board records the user decision to reconnect.', { timestamp: T792, bucket: 'binding' })
      ]
    });
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.material_tip.basis, 'fallback');
    assert.strictEqual(gate.fallback_only, true);
    assert.strictEqual(gate.block_eligible, false);
    assert.strictEqual(gate.fallback_logged.length, 1);
    assert.strictEqual(gate.fallback_logged[0].id, 797);
    assert.strictEqual(gate.fallback_logged_truncated, false);
    assert.strictEqual(gate.does_not_block, true);
  });

  test('binding without project-effect wording is not material', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries: [
        ep(789, ['handoff'], 'Cited.', { timestamp: T789 }),
        ep(798, ['durable'], 'A durable note about lunch.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.material_tip.id, 789);
  });

  test('event and high with project-effect wording is fallback material', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries: [
        ep(789, ['handoff'], 'Cited.', { timestamp: T789 }),
        ep(799, ['event'], 'Reminder-clear after the deploy.', { timestamp: T792, degree: 'high', bucket: 'event' })
      ]
    });
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.material_tip.basis, 'fallback');
    assert.strictEqual(gate.block_eligible, false);
  });

  test('scratch, probe, superseded, and ended rows are not the tip', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries: [
        ep(789, ['handoff'], 'Cited.', { timestamp: T789 }),
        ep(800, ['material', 'scratch'], 'Scratch that also says material.', { timestamp: T792 }),
        ep(801, ['probe', 'material'], 'Probe row.', { timestamp: T792 }),
        ep(802, ['test'], 'Test row.', { timestamp: T792 }),
        ep(803, ['material'], 'Superseded material.', { timestamp: T792, superseded_by: 804 }),
        ep(805, ['go-live'], 'Ended row.', { timestamp: T792, is_live: false }),
        ep(806, ['reconnect'], 'Past valid_until.', { timestamp: T792, valid_until: T789 })
      ],
      now: Date.parse('2026-11-06T18:00:00.000Z')
    });
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.material_tip.id, 789);
  });

  test('a preferred tag keeps a diagnosis row material', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries: [
        ep(789, ['handoff'], 'Cited.', { timestamp: T789 }),
        ep(807, ['diagnosis', 'HANDOFF-relevant'], 'Diagnosis that is also handoff-relevant.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.status, 'warn');
    assert.ok(gate.matching_tags.includes('handoff-relevant'));
  });

  test('a stale documented no-op still warns', () => {
    const content = handoffText({
      top: 'Documented no-op. version v317, sha256 abc, tip episodic ' + '789' + ', reason: no newer material tip.'
    });
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content),
      entries: [
        ep(789, ['handoff'], 'Cited.', { timestamp: T789 }),
        ep(808, ['decision'], 'A decision landed after the no-op was written.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.documented_no_op, true);
    assert.strictEqual(gate.does_not_block, true);
  });

  test('a missing handoff does not warn and does not invent a revision', () => {
    const gate = assessContinuityCurrency({
      handoff: null,
      entries: [ep(790, ['material'], 'Material with no handoff.', { timestamp: T790 })]
    });
    assert.strictEqual(gate.status, 'no_handoff');
    assert.strictEqual(gate.handoff, null);
    assert.strictEqual(gate.does_not_block, true);
  });

  test('the comparison does not modify its inputs', () => {
    const handoff = handoffDoc(lagText, { sha256: LAG_SHA });
    const entries = lagEntries();
    const frozen = JSON.stringify({ handoff, entries });
    assessContinuityCurrency({ handoff, entries });
    assert.strictEqual(JSON.stringify({ handoff, entries }), frozen);
  });

  test('the warn flag is the digit 1, and the block flag cannot turn on', () => {
    assert.strictEqual(continuityCurrencyEnabled(), false);
    assert.strictEqual(continuityCurrencyBlockEnabled(), false);
    withEnv({ CASCADE_CONTINUITY_CURRENCY: '1' }, () => {
      assert.strictEqual(continuityCurrencyEnabled(), true);
    });
    withEnv({ EMET_CONTINUITY_CURRENCY: '0', CASCADE_CONTINUITY_CURRENCY: '1' }, () => {
      assert.strictEqual(continuityCurrencyEnabled(), false);
    });
    withEnv({ EMET_CONTINUITY_CURRENCY_BLOCK: '1' }, () => {
      assert.strictEqual(continuityCurrencyBlockEnabled(), false);
    });
  });

  function liveLayout({ version, topId, oldId = 676 }) {
    return [
      `# HANDOFF v${version}`,
      '',
      '## 2026-11-08 nightly',
      '- Scope: wrap.',
      `- Close verification (this session): board written; episodic ${topId} (read back).`,
      '',
      '## 2026-10-16_emet-progress',
      'Retained from the earlier session.',
      '',
      '## §6 CLOSE VERIFICATION',
      '| Artifact | Done | Evidence |',
      '|---|---|---|',
      `| Episodic session record | yes | episodic ${oldId} |`,
      '| This handoff | Y | written last |'
    ].join('\n');
  }

  test('a newest-first handoff uses the top close verification, not the retained §6 table', () => {
    const content = liveLayout({ version: 325, topId: 811 });
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content, { version: 325, updated_at: '2026-11-08T21:55:00.000Z' }),
      entries: [
        ep(676, ['handoff'], 'Retained 2026-10-16 session record.', { timestamp: T789 }),
        ep(810, ['nightly-wrap', 'transcript-flags'], 'Nightly wrap flags only.', { timestamp: T791 }),
        ep(811, ['material'], 'Live material tip cited by the current close verification.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.handoff.claim_basis, 'close_receipt');
    assert.strictEqual(gate.handoff.cited_episodic_id, 811);
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.material_tip.id, 811);
  });

  test('a top close verification that cites tip-2 warns with that id', () => {
    const content = liveLayout({ version: 325, topId: 809 });
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content, { version: 325, updated_at: '2026-11-08T21:55:00.000Z' }),
      entries: [
        ep(676, ['handoff'], 'Retained 2026-10-16 session record.', { timestamp: T789 }),
        ep(809, ['handoff'], 'Close verification cited this id.', { timestamp: T790 }),
        ep(811, ['material'], 'Material tip after the citation.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.handoff.cited_episodic_id, 809);
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.material_tip.id, 811);
    assert.ok(gate.newer_material.some((row) => row.id === 811));
  });

  test('a warning lists the newest material rows and keeps the tip', () => {
    const entries = [];
    for (let id = 670; id <= 700; id++) {
      entries.push(ep(id, ['material'], `Material episodic ${id}.`, { timestamp: T789 + id }));
    }
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ version: 1, episodic: 670 }), { version: 1 }),
      entries
    });
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.lag_span.newer_material_count, 30);
    assert.strictEqual(gate.newer_material.length, 20);
    assert.strictEqual(gate.newer_material[0].id, 700);
    assert.strictEqual(gate.newer_material[19].id, 681);
  });

  test('an untagged entry pointed to by a session with closed false does not warn', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries: [
        ep(789, ['handoff'], 'Cited session record.', { timestamp: T789 }),
        ep(812, [], 'Untagged episodic after the handoff. No diagnosis mark.', { timestamp: T792 })
      ],
      sessions: [{ episodic_id: 812, closed: false, handoff: false }]
    });
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.material_tip.id, 789);
    assert.notStrictEqual(gate.material_tip.id, 812);
  });

  test('an untagged entry pointed to by a session with no closed field does not warn', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries: [
        ep(789, ['handoff'], 'Cited session record.', { timestamp: T789 }),
        ep(812, [], 'Untagged episodic after the handoff. No diagnosis mark.', { timestamp: T792 })
      ],
      sessions: [{ episodic_id: 812, handoff: false }]
    });
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.material_tip.id, 789);
    assert.notStrictEqual(gate.material_tip.id, 812);
  });

  test('an open-session pointer tagged transcript-flags does not warn', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries: [
        ep(789, ['handoff'], 'Cited session record.', { timestamp: T789 }),
        ep(810, ['nightly-wrap', 'transcript-flags'], 'Nightly wrap. Transcript flags only.', { timestamp: T792 })
      ],
      sessions: [{ episodic_id: 810, closed: false, handoff: false }]
    });
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.material_tip.id, 789);
    assert.notStrictEqual(gate.status, 'warn');
  });

  test('a closed-session pointer does not rescue a transcript-flags row', () => {
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries: [
        ep(789, ['handoff'], 'Cited session record.', { timestamp: T789 }),
        ep(810, ['nightly-wrap', 'transcript-flags'], 'Nightly wrap. Transcript flags only.', { timestamp: T792 })
      ],
      sessions: [{ episodic_id: 810, closed: true, handoff: true }]
    });
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.material_tip.id, 789);
  });

  test('a year-month after episodic is not an episodic id', () => {
    const content = [
      '# HANDOFF',
      '',
      '## nightly',
      '- Close verification (this session): episodic ' + '2026-11' + '.'
    ].join('\n');
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content, { updated_at: null, version: 317 }),
      entries: [ep(2027, ['material'], 'Newer than a misread year-month.', { timestamp: T792 })]
    });
    assert.notStrictEqual(gate.handoff.cited_episodic_id, 2026);
    assert.strictEqual(gate.handoff.cited_episodic_id, null);
    assert.strictEqual(gate.handoff.claim_basis, 'version_only');
    assert.notStrictEqual(gate.status, 'warn');
  });

  test('a date continuation is not an episodic id', () => {
    const content = [
      '# HANDOFF',
      '',
      '## nightly',
      '- Close verification (this session): episodic ' + '2026-11-06' + '.',
      'The body mentions episodic ' + '2026-11-06' + ' again.'
    ].join('\n');
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content, { updated_at: null, version: 317 }),
      entries: [ep(2027, ['material'], 'Newer than a misread year.', { timestamp: T792 })]
    });
    assert.notStrictEqual(gate.handoff.cited_episodic_id, 2026);
    assert.strictEqual(gate.handoff.cited_episodic_id, null);
    assert.strictEqual(gate.handoff.claim_basis, 'version_only');
    assert.notStrictEqual(gate.status, 'warn');
    assert.strictEqual(gate.material_tip.id, 2027);
  });

  test('a real episodic id still parses when a date is nearby', () => {
    const content = [
      '# HANDOFF',
      '',
      '## nightly',
      '- **Close verification (this session):** episodic ' + '2026' + ', noted on 2026-11-06.'
    ].join('\n');
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content, { version: 325 }),
      entries: [
        ep(2026, ['handoff'], 'Real id.', { timestamp: T789 }),
        ep(2027, ['material'], 'Newer material.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.handoff.cited_episodic_id, 2026);
    assert.strictEqual(gate.handoff.claim_basis, 'close_receipt');
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.material_tip.id, 2027);
  });

  test('an anchored close verification line is the claim', () => {
    const content = [
      '# HANDOFF',
      '',
      '## nightly',
      '- **Close verification (this session):** episodic ' + '811' + ' (read back).',
      'Notes mention close verification episodic ' + '676' + ' in the same section.'
    ].join('\n');
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content, { version: 325 }),
      entries: [
        ep(676, ['handoff'], 'Old.', { timestamp: T789 }),
        ep(811, ['material'], 'Current.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.handoff.cited_episodic_id, 811);
    assert.strictEqual(gate.handoff.claim_basis, 'close_receipt');
    assert.strictEqual(gate.status, 'current');
  });

  test('an unanchored close verification mention is not the claim', () => {
    const content = [
      '# HANDOFF',
      '',
      '## nightly',
      'The wrap notes mention close verification episodic ' + '676' + ' but this line is not the label.',
      '',
      '## §6 CLOSE VERIFICATION',
      '| Artifact | Done | Evidence |',
      '|---|---|---|',
      '| Session record in memory | Y | episodic ' + '811' + ' |'
    ].join('\n');
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content, { version: 325 }),
      entries: [
        ep(676, ['handoff'], 'Old.', { timestamp: T789 }),
        ep(811, ['handoff'], 'Section six.', { timestamp: T790 }),
        ep(812, ['material'], 'Newer.', { timestamp: T792 })
      ]
    });
    assert.notStrictEqual(gate.handoff.cited_episodic_id, 676);
    assert.strictEqual(gate.handoff.cited_episodic_id, 811);
    assert.strictEqual(gate.handoff.claim_basis, 'close_receipt');
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.material_tip.id, 812);
  });

  test('a documented no-op outside the top section does not count', () => {
    const content = [
      '# HANDOFF',
      '',
      '## 2026-11-08 nightly',
      '- Close verification (this session): episodic ' + '811' + '.',
      '',
      '## 2026-10-16 retained',
      'Documented no-op. version v1, tip episodic ' + '100' + ', reason: an older note.'
    ].join('\n');
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content, { version: 325 }),
      entries: [ep(811, ['handoff'], 'Current tip.', { timestamp: T792 })]
    });
    assert.strictEqual(gate.documented_no_op, false);
    assert.strictEqual(gate.status, 'current');
    assert.notStrictEqual(gate.status, 'no_op');
  });

  test('a documented no-op in the top section still counts', () => {
    const content = [
      '# HANDOFF',
      '',
      '## 2026-11-08 nightly',
      'Documented no-op. version v325, tip episodic ' + '811' + ', reason: no newer material tip.',
      '- Close verification (this session): episodic ' + '811' + '.',
      '',
      '## 2026-10-16 retained',
      'Earlier work.'
    ].join('\n');
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(content, { version: 325 }),
      entries: [
        ep(811, ['handoff'], 'Current tip.', { timestamp: T792 }),
        ep(812, ['scratch'], 'Scratch after the no-op.', { timestamp: T792 })
      ]
    });
    assert.strictEqual(gate.documented_no_op, true);
    assert.strictEqual(gate.status, 'no_op');
    assert.strictEqual(gate.material_tip.id, 811);
  });

  test('fallback log keeps the newest twenty', () => {
    const entries = [ep(789, ['handoff'], 'Cited.', { timestamp: T789 })];
    for (let id = 800; id <= 824; id++) {
      entries.push(ep(id, ['binding'], 'The board records the user decision.', { timestamp: T792, bucket: 'binding' }));
    }
    const gate = assessContinuityCurrency({
      handoff: handoffDoc(handoffText({ episodic: 789 })),
      entries
    });
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.fallback_only, true);
    assert.strictEqual(gate.fallback_logged.length, 20);
    assert.strictEqual(gate.fallback_logged[0].id, 824);
    assert.strictEqual(gate.fallback_logged[19].id, 805);
    assert.strictEqual(gate.fallback_logged_truncated, true);
    assert.strictEqual(gate.lag_span.newer_material_count, 25);
  });

  test('preferred tags are the brief list', () => {
    assert.deepStrictEqual([...PREFERRED_TAGS], [
      'material', 'board', 'decision', 'deploy', 'go-live',
      'reconnect', 'reminder-clear', 'handoff', 'handoff-rewrite', 'handoff-relevant'
    ]);
  });
});

testGroup('initialize and session open', () => {
  test('790-class lag warns on initialize and writes neither HANDOFF nor STATE', async () => {
    const store = await setUpStore();
    plant(store);
    const handoffBefore = JSON.stringify(docOf(store, 'HANDOFF.md'));
    const stateBefore = JSON.stringify(docOf(store, 'STATE.md'));
    const before = store.writes.length;
    const ready = await boot(store);
    assert.strictEqual(ready.state, 'ready');
    assert.strictEqual(ready.continuity_currency.status, 'warn');
    assert.strictEqual(ready.continuity_currency.does_not_block, true);
    assert.strictEqual(ready.continuity_currency.material_tip.id, 791);
    assert.deepStrictEqual(store.writes.slice(before), []);
    assert.strictEqual(JSON.stringify(docOf(store, 'HANDOFF.md')), handoffBefore);
    assert.strictEqual(JSON.stringify(docOf(store, 'STATE.md')), stateBefore);
  });

  test('the warning is on startup page 1', async () => {
    const store = await setUpStore();
    plant(store);
    const page1 = await withEnv({ EMET_CONTINUITY_CURRENCY: '1' }, () => withStore(store, () => initialize({})));
    assert.strictEqual(page1.continuity_currency.status, 'warn');
    assert.ok(page1.startup_page.keys.includes('continuity_currency'));
  });

  test('a documented no-op does not warn on initialize', async () => {
    const store = await setUpStore();
    const content = handoffText({
      top: 'Documented no-op. version v317, sha256 abc, tip episodic ' + '789' + ', reason: no newer material tip.'
    });
    plant(store, {
      content,
      entries: [
        ep(789, ['handoff'], 'Session record cited by the no-op.', { timestamp: T789 }),
        ep(792, ['scratch'], 'Scratch left after the wrap.', { timestamp: T792 })
      ]
    });
    const ready = await boot(store);
    assert.strictEqual(ready.continuity_currency.status, 'no_op');
    assert.notStrictEqual(ready.continuity_currency.status, 'warn');
  });

  test('a current citation does not warn on initialize', async () => {
    const store = await setUpStore();
    plant(store, {
      content: handoffText({ episodic: 791 }),
      entries: [...lagEntries(), ep(792, ['scratch'], 'Scratch after the tip.', { timestamp: T792 })]
    });
    const ready = await boot(store);
    assert.strictEqual(ready.continuity_currency.status, 'current');
    assert.strictEqual(ready.continuity_currency.material_tip.id, 791);
  });

  test('newer scratch and diagnosis-only rows do not warn on initialize', async () => {
    const store = await setUpStore();
    plant(store, {
      entries: [
        ep(789, ['handoff'], 'Session record.', { timestamp: T789 }),
        ep(792, ['scratch'], 'Scratch.', { timestamp: T792 }),
        ep(793, ['diagnosis'], 'Diagnosis only.', { timestamp: T792 + 10 })
      ]
    });
    const ready = await boot(store);
    assert.strictEqual(ready.continuity_currency.status, 'current');
  });

  test('the flag off has no warning surface and still writes nothing', async () => {
    const store = await setUpStore();
    plant(store);
    const handoffBefore = JSON.stringify(docOf(store, 'HANDOFF.md'));
    const stateBefore = JSON.stringify(docOf(store, 'STATE.md'));
    const before = store.writes.length;
    const ready = await withStore(store, () => initialize({ page: 'all' }));
    assert.strictEqual(ready.state, 'ready');
    assert.ok(!('continuity_currency' in ready));
    assert.deepStrictEqual(store.writes.slice(before), []);
    assert.strictEqual(JSON.stringify(docOf(store, 'HANDOFF.md')), handoffBefore);
    assert.strictEqual(JSON.stringify(docOf(store, 'STATE.md')), stateBefore);
  });

  test('the block flag does not block initialize', async () => {
    const store = await setUpStore();
    plant(store);
    const before = store.writes.length;
    const ready = await boot(store, { EMET_CONTINUITY_CURRENCY_BLOCK: '1' });
    assert.strictEqual(ready.state, 'ready');
    assert.strictEqual(ready.continuity_currency.status, 'warn');
    assert.strictEqual(ready.continuity_currency.does_not_block, true);
    assert.strictEqual(ready.continuity_currency.block_enabled, false);
    assert.strictEqual(ready.continuity_currency.block_ignored, true);
    assert.deepStrictEqual(store.writes.slice(before), []);
  });

  test('a store that is not ready shows no warning and writes nothing', async () => {
    const store = makeStore();
    const before = store.writes.length;
    const first = await withEnv({ EMET_CONTINUITY_CURRENCY: '1' }, () => withStore(store, () => initialize({})));
    assert.strictEqual(first.state, 'setup_required');
    assert.ok(!('continuity_currency' in first));
    assert.deepStrictEqual(store.writes.slice(before), []);
  });

  test('session open warns and does not write HANDOFF or STATE', async () => {
    const store = await setUpStore();
    plant(store);
    const handoffBefore = JSON.stringify(docOf(store, 'HANDOFF.md'));
    const stateBefore = JSON.stringify(docOf(store, 'STATE.md'));
    const before = store.writes.length;
    const opened = await withEnv({ EMET_CONTINUITY_CURRENCY: '1' }, () => withStore(store, () => sessionOpen(
      { slug: 'tip-lag' },
      null,
      { async ensureClient() { return new store.Client().db(); } }
    )));
    assert.strictEqual(opened.continuity_currency.status, 'warn');
    assert.strictEqual(opened.continuity_currency.does_not_block, true);
    assert.strictEqual(opened.continuity_currency.material_tip.id, 791);
    assert.deepStrictEqual(store.writes.slice(before), []);
    assert.strictEqual(JSON.stringify(docOf(store, 'HANDOFF.md')), handoffBefore);
    assert.strictEqual(JSON.stringify(docOf(store, 'STATE.md')), stateBefore);
  });

  test('a fallback-only lag warns on initialize', async () => {
    const store = await setUpStore();
    plant(store, {
      content: handoffText({ episodic: 789 }),
      entries: [
        ep(789, ['handoff'], 'Cited.', { timestamp: T789 }),
        ep(797, ['binding'], 'The board records the user decision to reconnect.', { timestamp: T792, bucket: 'binding' })
      ]
    });
    const ready = await boot(store);
    const gate = ready.continuity_currency;
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.fallback_only, true);
    assert.strictEqual(gate.fallback_logged[0].id, 797);
    assert.strictEqual(gate.does_not_block, true);
    assert.strictEqual(gate.block_eligible, false);
  });

  test('a 790-class lag on initialize summarizes every newer row', async () => {
    const store = await setUpStore();
    plant(store);
    const ready = await boot(store);
    const newer = ready.continuity_currency.newer_material;
    assert.strictEqual(ready.continuity_currency.status, 'warn');
    assert.ok(newer.length >= 2);
    assert.ok(newer.every((row) => typeof row.summary === 'string' && row.summary.length > 0));
    assert.ok(newer.every((row) => !row.summary.includes('\n')));
  });

  test('a flagged initialize reads episodic once and keeps tip 41', async () => {
    const store = await setUpStore();
    const entries = [];
    for (let id = 1; id <= 40; id++) {
      if (id === 7) {
        entries.push(ep(7, [], 'Pointer row below the first page.', { timestamp: T789, layer_tip: 41 }));
      } else {
        entries.push(ep(id, ['material'], `Material episodic ${id}.`, { timestamp: T789 + id }));
      }
    }
    entries.push(ep(41, [], 'Pointed-to tip with no preferred tag.', { timestamp: T792 }));
    entries.push(ep(42, [], 'Open-session episodic. Not a pointer.', { timestamp: T792 }));
    entries.push(ep(50, ['material'], 'Ended row must not become the tip.', { timestamp: T792, is_live: false }));
    const content = handoffText({ version: 317, episodic: 1 });
    plant(store, {
      content,
      version: 317,
      entries,
      sessions: [
        { handoff: true, handoff_version: 317, episodic_id: 1, closed: true },
        { episodic_id: 42, closed: false, handoff: false }
      ]
    });
    const expected = assessContinuityCurrency({
      handoff: handoffDoc(content, { version: 317 }),
      entries,
      sessions: [
        { handoff: true, handoff_version: 317, episodic_id: 1, closed: true },
        { episodic_id: 42, closed: false, handoff: false }
      ]
    });
    const watched = new Map();
    for (const name of ['emet_episodic', 'emet_sessions']) {
      const col = store.collection(name);
      const calls = [];
      const orig = col.find;
      col.find = function (query, options) {
        const cursor = orig.call(col, query, options);
        const call = { query, options: options || null, sort: null, limit: null, skip: null };
        calls.push(call);
        return {
          sort(spec) { call.sort = spec; cursor.sort(spec); return this; },
          skip(n) { call.skip = n; cursor.skip(n); return this; },
          limit(n) { call.limit = n; cursor.limit(n); return this; },
          project(spec) { call.project = spec; if (typeof cursor.project === 'function') cursor.project(spec); return this; },
          toArray() { return cursor.toArray(); }
        };
      };
      watched.set(name, calls);
    }
    const ready = await boot(store);
    const gate = ready.continuity_currency;
    assert.strictEqual(gate.status, expected.status);
    assert.strictEqual(gate.material_tip.id, expected.material_tip.id);
    assert.strictEqual(gate.material_tip.id, 41);
    assert.strictEqual(gate.material_tip.basis, 'layer_tip');
    assert.strictEqual(gate.lag_span.newer_material_count, expected.lag_span.newer_material_count);
    assert.notStrictEqual(gate.material_tip.id, 50);
    assert.notStrictEqual(gate.material_tip.id, 42);
    const episodicCalls = watched.get('emet_episodic').filter((call) => call.sort && call.sort.id === -1);
    assert.strictEqual(episodicCalls.length, 1);
    for (const call of episodicCalls) {
      assert.notDeepStrictEqual(call.query, {});
      assert.ok(call.query && Array.isArray(call.query.$or) && call.query.$or.length > 0);
      assert.strictEqual(call.limit, null);
      assert.strictEqual(call.skip, null);
      assert.ok(call.options && call.options.projection);
      assert.strictEqual(call.options.projection.id, 1);
      assert.strictEqual(call.options.projection.content, 1);
      assert.strictEqual(call.options.projection.context, 1);
      assert.strictEqual(call.options.projection.metadata, 1);
      assert.strictEqual(call.options.projection.is_live, 1);
      assert.strictEqual(call.options.projection.layer_tip, 1);
      assert.strictEqual(call.options.projection.superseded_by, 1);
      assert.ok(!('signature' in call.options.projection));
      assert.ok(!('sha256' in call.options.projection));
      assert.strictEqual(call.options.projection._id, 0);
    }
    const sessionCalls = watched.get('emet_sessions');
    assert.strictEqual(sessionCalls.length, 1);
    for (const call of sessionCalls) {
      assert.notDeepStrictEqual(call.query, {});
      assert.ok(call.query && Array.isArray(call.query.$or));
      assert.strictEqual(call.limit, null);
      assert.deepStrictEqual(call.sort, { episodic_id: -1 });
      assert.ok(call.options && call.options.projection);
      assert.strictEqual(call.options.projection.episodic_id, 1);
      assert.strictEqual(call.options.projection.closed, 1);
      assert.strictEqual(call.options.projection.handoff, 1);
      assert.strictEqual(call.options.projection.handoff_version, 1);
      assert.strictEqual(call.options.projection._id, 0);
      assert.ok(!('drops_seen' in call.options.projection));
    }
  });

  test('a repeated id keeps the copy that is not excluded', async () => {
    const store = await setUpStore();
    plant(store, {
      entries: [
        ep(789, ['handoff'], 'Cited.', { timestamp: T789 }),
        ep(790, ['material', 'scratch'], 'Scratch copy of the same id.', { timestamp: T790 }),
        ep(790, ['material'], 'Live material copy of the same id.', { timestamp: T790 })
      ]
    });
    const ready = await boot(store);
    assert.strictEqual(ready.continuity_currency.status, 'warn');
    assert.strictEqual(ready.continuity_currency.material_tip.id, 790);
    assert.strictEqual(ready.continuity_currency.material_tip.basis, 'preferred_tag');
    assert.match(ready.continuity_currency.material_tip.summary, /Live material copy/);
  });

  test('a repeated episodic id is counted once', async () => {
    const store = await setUpStore();
    const entries = [
      ep(789, ['handoff'], 'Cited.', { timestamp: T789 }),
      ep(790, ['material'], 'Material tip.', { timestamp: T790 }),
      ep(790, ['material'], 'The same id stored again.', { timestamp: T790 })
    ];
    plant(store, { entries });
    const ready = await boot(store);
    assert.strictEqual(ready.continuity_currency.status, 'warn');
    assert.strictEqual(ready.continuity_currency.material_tip.id, 790);
    assert.strictEqual(ready.continuity_currency.lag_span.newer_material_count, 1);
  });

  test('session open with the flag off does not add the field', async () => {
    const store = await setUpStore();
    plant(store);
    const opened = await withStore(store, () => sessionOpen(
      { slug: 'tip-lag-off' },
      null,
      { async ensureClient() { return new store.Client().db(); } }
    ));
    assert.ok(!('continuity_currency' in opened));
  });
});

testGroup('statechart', () => {
  test('the served diagram matches the document', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'continuity-currency-statechart.md'), 'utf8');
    const fenced = /```mermaid\n([\s\S]*?)\n```/.exec(doc);
    assert.ok(fenced);
    assert.strictEqual(fenced[1], CONTINUITY_CURRENCY_MERMAID);
    assert.match(CONTINUITY_CURRENCY_MERMAID, /NoHandoff/);
    assert.match(CONTINUITY_CURRENCY_MERMAID, /Unreadable/);
    assert.match(CONTINUITY_CURRENCY_MERMAID, /FallbackOnly/);
  });

  test('warn, current, and no-op never rewrite and never block', () => {
    let state = {
      phase: 'GateOff',
      flag: 'off',
      newer: 'none',
      claim: 'at_tip',
      handoffMutated: false,
      blocked: false,
      warning: false
    };
    const run = (event) => {
      const next = continuityCurrencyStep(state, event);
      assert.ok(next, event.type);
      assert.strictEqual(continuityCurrencyInvariant(next), true);
      state = next;
    };
    run({ type: 'flag_off' });
    assert.strictEqual(state.phase, 'GateOff');
    assert.strictEqual(state.warning, false);
    run({ type: 'enable' });
    run({ type: 'cite_tip' });
    assert.strictEqual(state.phase, 'Current');
    run({ type: 'initialize_again' });
    run({ type: 'scratch' });
    assert.strictEqual(state.phase, 'Current');
    assert.strictEqual(state.warning, false);
    run({ type: 'initialize_again' });
    run({ type: 'version_only' });
    assert.strictEqual(state.warning, false);
    run({ type: 'initialize_again' });
    run({ type: 'no_op' });
    assert.strictEqual(state.phase, 'DocumentedNoOp');
    assert.strictEqual(state.warning, false);
    run({ type: 'initialize_again' });
    run({ type: 'material_lag' });
    assert.strictEqual(state.phase, 'Warning');
    assert.strictEqual(state.warning, true);
    assert.strictEqual(state.blocked, false);
    assert.strictEqual(state.handoffMutated, false);
    run({ type: 'ask_block' });
    assert.strictEqual(state.phase, 'BlockHeld');
    assert.strictEqual(state.blocked, false);
    assert.strictEqual(state.handoffMutated, false);
    assert.strictEqual(continuityCurrencyStep(state, { type: 'rewrite' }), null);
  });

  test('no handoff, unreadable, and fallback-only do not rewrite and do not block', () => {
    let state = {
      phase: 'GateOff',
      flag: 'off',
      newer: 'none',
      claim: 'at_tip',
      handoffMutated: false,
      blocked: false,
      warning: false,
      blockEligible: false
    };
    const run = (event) => {
      const next = continuityCurrencyStep(state, event);
      assert.ok(next, event.type);
      assert.strictEqual(continuityCurrencyInvariant(next), true);
      assert.strictEqual(next.handoffMutated, false);
      assert.strictEqual(next.blocked, false);
      state = next;
    };
    run({ type: 'enable' });
    run({ type: 'no_handoff' });
    assert.strictEqual(state.phase, 'NoHandoff');
    assert.strictEqual(state.warning, false);
    run({ type: 'initialize_again' });
    run({ type: 'unreadable' });
    assert.strictEqual(state.phase, 'Unreadable');
    assert.strictEqual(state.warning, false);
    run({ type: 'initialize_again' });
    run({ type: 'fallback_only' });
    assert.strictEqual(state.phase, 'FallbackOnly');
    assert.strictEqual(state.warning, true);
    assert.strictEqual(state.newer, 'fallback');
    assert.strictEqual(state.claim, 'behind');
    assert.strictEqual(state.blockEligible, false);
    assert.strictEqual(state.blocked, false);
    run({ type: 'ask_block' });
    assert.strictEqual(state.phase, 'FallbackHeld');
    assert.strictEqual(state.blocked, false);
    assert.strictEqual(state.blockEligible, false);
    assert.strictEqual(state.warning, true);
    run({ type: 'initialize_again' });
    assert.strictEqual(state.phase, 'Comparing');
    assert.strictEqual(state.warning, false);
  });
});

const HUB = 'hub-tag';
const BOT = 'bot-tag';
const CITED = 21;

function seconds(iso) {
  return Date.parse(iso) / 1000;
}

function sortedIds(ids) {
  return [...ids].sort((a, b) => a - b);
}

function currentEntries(extra = []) {
  return [
    ep(10, ['handoff'], 'An early session before source tags were required.', {
      timestamp: seconds('2026-04-19T21:55:00.000Z')
    }),
    ep(11, ['handoff'], 'Tablet session with an unregistered source, before source tags were required.', {
      timestamp: seconds('2026-07-29T11:32:00.000Z'),
      source: 'guest-host'
    }),
    ep(20, ['handoff'], 'Hub session cited by the current handoff.', {
      timestamp: seconds('2026-11-18T12:00:00.000Z'),
      source: HUB
    }),
    ep(CITED, ['handoff'], 'Bot session cited by the current handoff.', {
      timestamp: seconds('2026-11-18T12:05:00.000Z'),
      source: BOT
    }),
    ...extra
  ];
}

function plantCurrency(store, entries) {
  const hubBody = handoffText({ version: 2, episodic: CITED });
  const botBody = handoffText({ version: 1, episodic: CITED });
  store.collection('documents').docs.push(
    {
      doc_id: 'HANDOFF.md',
      version: 2,
      sha256: sha(hubBody),
      updated_at: '2026-11-18T12:05:00.000Z',
      content: hubBody
    },
    {
      doc_id: `HANDOFF/${BOT}.md`,
      version: 1,
      sha256: sha(botBody),
      updated_at: '2026-11-18T12:05:00.000Z',
      content: botBody
    }
  );
  for (const entry of entries) store.collection('emet_episodic').docs.push({ ...entry });
}

async function currencyOf(entries, tags = [HUB, BOT]) {
  const store = makeStore();
  plantCurrency(store, entries);
  return withEnv({
    EMET_TAG_HANDOFFS: 'enforce',
    EMET_HUB_TAG: HUB,
    EMET_SOURCE_TAGS: tags.join(','),
    EMET_CONTINUITY_CURRENCY: '1',
    EMET_CONTINUITY_CURRENCY_BLOCK: '1'
  }, () => withStore(store, () => loadContinuityCurrency(store)));
}

testGroup('legacy pre-attribution', () => {
  test('pre-cutoff untagged rows and current handoffs read current', async () => {
    assert.strictEqual(TAG_ATTRIBUTION_BEGAN, '2026-09-27T00:00:00.000Z');
    const gate = await currencyOf(currentEntries());
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.overall_status, 'current');
    assert.strictEqual(gate.lag_span, undefined);
    assert.deepStrictEqual(gate.per_tag.map((row) => [row.tag, row.status]), [[HUB, 'current'], [BOT, 'current']]);
    assert.deepStrictEqual(sortedIds(gate.unattributed_material), []);
    assert.strictEqual(gate.legacy_pre_attribution.reading, LEGACY_PRE_ATTRIBUTION);
    assert.strictEqual(gate.legacy_pre_attribution.reading, 'legacy (pre-attribution)');
    assert.strictEqual(gate.legacy_pre_attribution.count, 2);
    assert.deepStrictEqual(sortedIds(gate.legacy_pre_attribution.ids), [10, 11]);
    assert.strictEqual(gate.legacy_pre_attribution.cutoff, TAG_ATTRIBUTION_BEGAN);
    assert.strictEqual(gate.legacy_pre_attribution.cutoff_basis, LEGACY_CUTOFF_BASIS);
    assert.strictEqual(gate.legacy_pre_attribution.cutoff_basis, 'after_last_unsourced_episodic');
    assert.strictEqual(gate.does_not_block, true);
    assert.strictEqual(gate.block_enabled, false);
    assert.strictEqual(gate.block_ignored, true);
    assert.strictEqual(continuityCurrencyBlockEnabled(), false);
  });

  test('an untagged row after the cutoff still warns', async () => {
    const gate = await currencyOf(currentEntries([
      ep(12, ['handoff'], 'Untagged session after source tags were required.', {
        timestamp: seconds('2026-10-02T15:00:00.000Z')
      }),
      ep(14, ['handoff'], 'Untagged session at the instant source tags became required.', {
        timestamp: seconds(TAG_ATTRIBUTION_BEGAN)
      })
    ]));
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.overall_status, 'warn');
    assert.strictEqual(gate.lag_span, undefined);
    assert.deepStrictEqual(gate.per_tag.map((row) => [row.tag, row.status]), [[HUB, 'current'], [BOT, 'current']]);
    assert.deepStrictEqual(sortedIds(gate.unattributed_material), [12, 14]);
    assert.deepStrictEqual(sortedIds(gate.legacy_pre_attribution.ids), [10, 11]);
    assert.strictEqual(gate.legacy_pre_attribution.count, 2);
    assert.strictEqual(gate.does_not_block, true);
    assert.strictEqual(gate.block_enabled, false);
  });

  test('an unregistered tag after the cutoff still warns', async () => {
    const gate = await currencyOf(currentEntries([
      ep(13, ['handoff'], 'Unregistered source after source tags were required.', {
        timestamp: seconds('2026-10-03T15:00:00.000Z'),
        source: 'guest-host'
      })
    ]));
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.overall_status, 'warn');
    assert.strictEqual(gate.lag_span, undefined);
    assert.deepStrictEqual(gate.per_tag.map((row) => [row.tag, row.status]), [[HUB, 'current'], [BOT, 'current']]);
    assert.deepStrictEqual(sortedIds(gate.unattributed_material), [13]);
    assert.deepStrictEqual(sortedIds(gate.legacy_pre_attribution.ids), [10, 11]);
    assert.strictEqual(gate.does_not_block, true);
    assert.strictEqual(gate.block_enabled, false);
  });

  test('a material row with no id after the cutoff still warns', async () => {
    const late = ep(1, ['handoff'], 'Material row with no id after the cutoff.', {
      timestamp: seconds('2026-10-04T12:00:00.000Z'),
      layer_tip: 99
    });
    delete late.id;
    const early = ep(1, ['handoff'], 'Material row with no id before the cutoff.', {
      timestamp: seconds('2026-07-16T12:00:00.000Z'),
      layer_tip: 98
    });
    delete early.id;
    const gate = await currencyOf(currentEntries([late, early]));
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.overall_status, 'warn');
    assert.strictEqual(gate.lag_span, undefined);
    assert.deepStrictEqual(gate.per_tag.map((row) => [row.tag, row.status]), [[HUB, 'current'], [BOT, 'current']]);
    assert.deepStrictEqual(gate.unattributed_material, []);
    assert.deepStrictEqual(sortedIds(gate.legacy_pre_attribution.ids), [10, 11]);
    assert.ok(!gate.legacy_pre_attribution.ids.includes(null));
  });

  test('a material row with no timestamp still warns', async () => {
    const gate = await currencyOf(currentEntries([
      ep(15, ['handoff'], 'Untagged material row with no timestamp.', { timestamp: null })
    ]));
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.lag_span, undefined);
    assert.deepStrictEqual(sortedIds(gate.unattributed_material), [15]);
    assert.deepStrictEqual(sortedIds(gate.legacy_pre_attribution.ids), [10, 11]);
  });

  test('a material row with a timestamp that does not parse still warns', async () => {
    const gate = await currencyOf(currentEntries([
      ep(16, ['handoff'], 'Untagged material row with a garbage timestamp.', { timestamp: 'not-a-time' })
    ]));
    assert.strictEqual(gate.status, 'warn');
    assert.strictEqual(gate.lag_span, undefined);
    assert.deepStrictEqual(sortedIds(gate.unattributed_material), [16]);
    assert.deepStrictEqual(sortedIds(gate.legacy_pre_attribution.ids), [10, 11]);
  });

  test('a no_handoff tag with no material rows after the cutoff stays out of the overall status', async () => {
    const idle = 'idle-tag';
    const old = 'old-tag';
    const gate = await currencyOf(currentEntries([
      ep(9, ['handoff'], 'Registered tag whose only material row is before the cutoff.', {
        timestamp: seconds('2026-07-01T12:00:00.000Z'),
        source: old
      })
    ]), [HUB, BOT, idle, old]);
    assert.strictEqual(gate.status, 'current');
    assert.strictEqual(gate.overall_status, 'current');
    assert.strictEqual(gate.lag_span, undefined);
    assert.strictEqual(gate.per_tag.find((row) => row.tag === idle).status, 'no_handoff');
    assert.strictEqual(gate.per_tag.find((row) => row.tag === old).status, 'no_handoff');
    assert.strictEqual(gate.per_tag.find((row) => row.tag === HUB).status, 'current');
    assert.strictEqual(gate.per_tag.find((row) => row.tag === BOT).status, 'current');
  });

  test('a no_handoff tag with material rows after the cutoff still counts', async () => {
    const writer = 'writer-tag';
    const gate = await currencyOf(currentEntries([
      ep(15, ['handoff'], 'Registered tag wrote material work after the cutoff and has no handoff.', {
        timestamp: seconds('2026-10-05T12:00:00.000Z'),
        source: writer
      })
    ]), [HUB, BOT, writer]);
    assert.strictEqual(gate.status, 'no_handoff');
    assert.strictEqual(gate.overall_status, 'no_handoff');
    assert.strictEqual(gate.lag_span, undefined);
    assert.strictEqual(gate.per_tag.find((row) => row.tag === writer).status, 'no_handoff');
    assert.strictEqual(gate.per_tag.find((row) => row.tag === HUB).status, 'current');
    assert.strictEqual(gate.does_not_block, true);
    assert.strictEqual(gate.block_enabled, false);
  });

  test('a no_handoff tag with a material row and no timestamp still counts', async () => {
    const tag = 'null-time';
    const gate = await currencyOf(currentEntries([
      ep(17, ['handoff'], 'Registered tag wrote material work with no timestamp and has no handoff.', {
        timestamp: null,
        source: tag
      })
    ]), [HUB, BOT, tag]);
    assert.strictEqual(gate.per_tag.find((row) => row.tag === tag).status, 'no_handoff');
    assert.strictEqual(gate.per_tag.find((row) => row.tag === HUB).status, 'current');
    assert.strictEqual(gate.overall_status, 'no_handoff');
    assert.strictEqual(gate.lag_span, undefined);
  });

  test('a no_handoff tag with a material row and a garbage timestamp still counts', async () => {
    const tag = 'bad-time';
    const gate = await currencyOf(currentEntries([
      ep(18, ['handoff'], 'Registered tag wrote material work with an unreadable timestamp and has no handoff.', {
        timestamp: 'not-a-time',
        source: tag
      })
    ]), [HUB, BOT, tag]);
    assert.strictEqual(gate.per_tag.find((row) => row.tag === tag).status, 'no_handoff');
    assert.strictEqual(gate.overall_status, 'no_handoff');
    assert.strictEqual(gate.lag_span, undefined);
  });

  test('a no_handoff tag with a material row at the cutoff still counts', async () => {
    const tag = 'cutoff-time';
    const gate = await currencyOf(currentEntries([
      ep(19, ['handoff'], 'Registered tag wrote material work at the cutoff and has no handoff.', {
        timestamp: seconds(TAG_ATTRIBUTION_BEGAN),
        source: tag
      })
    ]), [HUB, BOT, tag]);
    assert.strictEqual(gate.per_tag.find((row) => row.tag === tag).status, 'no_handoff');
    assert.strictEqual(gate.overall_status, 'no_handoff');
    assert.strictEqual(gate.lag_span, undefined);
  });
});

testGroup('deploy table', () => {
  test('the continuity-currency row says the reading is off unless set to 1 and warns only', () => {
    const deploy = fs.readFileSync(path.join(ROOT, 'docs/DEPLOY.md'), 'utf8');
    const start = deploy.indexOf('| `EMET_CONTINUITY_CURRENCY` |');
    assert.ok(start >= 0);
    const end = deploy.indexOf('\n| `EMET_', start + 1);
    const row = deploy.slice(start, end);
    assert.match(row, /warn-only/);
    assert.match(row, /Unset is off/);
    assert.match(row, /does not rewrite HANDOFF or STATE/);
    const block = deploy.indexOf('| `EMET_CONTINUITY_CURRENCY_BLOCK` |');
    assert.ok(block > start);
    assert.match(deploy.slice(block, block + 240), /not applied/);
  });

  test('the README continuity section says how to turn the reading on', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const start = readme.indexOf('**Continuity currency**');
    const end = readme.indexOf('**During the session**');
    const section = readme.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(section, /EMET_CONTINUITY_CURRENCY/);
    assert.match(section, /off unless it is `1`/);
    assert.match(section, /warns and does not block/);
    assert.match(section, /legacy_pre_attribution/);
  });
});

await summary();