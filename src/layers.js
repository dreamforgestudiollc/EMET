/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * The six layers: what each is for, and how to tell when one has gone dark.
 *
 * WHY THIS FILE EXISTS. Creating six collections is not the same as having six
 * layers. A layer with no stated charter has no answer to "does this belong
 * here?", so nothing ever routes to it - and because an empty collection throws
 * no error and fails no test, it can stay empty for a very long time without
 * anyone noticing. In the deployment this design came from, the meta layer sat
 * nearly unused for roughly a year: the collection existed from the first day,
 * the tools accepted writes to it, and it was simply never the obvious place to
 * put anything. When it was finally given a definition, it filled immediately -
 * which is the proof the material had been there all along and was being
 * discarded.
 *
 * That is a design defect, not a user error, and it is fixed in two places:
 *
 *   1. Every layer ships with a charter - what belongs, what does NOT belong,
 *      when to write, when to read, and what its absence looks like. It ships in
 *      code, returned by emet_initialize, for the same reason the operating
 *      disciplines do: documentation is read by people, and this has to reach
 *      the model at the start of every session.
 *
 *   2. assessLayerHealth() reports a layer that has gone quiet. A store cannot
 *      know what SHOULD have been written, but it can see that one layer has
 *      taken almost nothing while the others filled, and say so. The point is
 *      that the year-long silence becomes a line in the first payload of the
 *      next session instead of a discovery someone happens to make.
 *
 * The distinction that does most of the work: episodic, semantic and procedural
 * are about the WORLD - what happened, what is true, how something is done. Meta
 * is about the SYSTEM - how the memory and the assistant are behaving, seen from
 * outside the exchange. Material that belongs in meta looks like nothing else
 * fits it, which is exactly why it gets dropped when meta has no definition.
 *
 * THIS FILE IS ALSO THE VOCABULARY HOME (2026-09-07). Beside the prose, each
 * charter entry carries the machine-readable twin of what the prose says:
 * the numeric importance band, whether the layer may be revised, whether a
 * provenance pointer is required, the aliases that resolve to it, and the
 * share of the store below which it counts as underused. Every other module
 * that needs one of these facts derives it from here - content_analyzer's
 * alias table, tools.js's episodic-revision check - so the layer list and its
 * rules are stated once. This file must never import the database or the
 * mongodb package: it describes the layers, it does not touch them.
 */

/** Where an unlabelled write lands when nothing else claims it. Stated once. */
export const FALLBACK_LAYER = 'working';

export const LAYER_CHARTER = Object.freeze({
  identity: {
    importance: '0.9 - 1.0',
    importance_range: [0.9, 1.0],
    revisable: 'with care',
    provenance: 'n/a',
    aliases: ['core', 'self', 'values'],
    holds:
      'Who the assistant is and who it serves. Durable self-definition, the user\'s standing ' +
      'requirements, and the standards they have set for how they are worked with.',
    does_not_hold:
      'Anything that could change next month. A preference expressed once is semantic or episodic, ' +
      'not identity.',
    write_when:
      'The user defines or redefines the working relationship, or states a standard meant to ' +
      'hold indefinitely. Rare by nature - a handful of entries a year is healthy.',
    read_when: 'Session start, via emet_initialize.',
    neglect_symptom:
      'The assistant reintroduces itself differently in different sessions, or keeps rediscovering ' +
      'the same standing instruction.'
  },

  semantic: {
    importance: '0.6 - 0.9',
    importance_range: [0.6, 0.9],
    revisable: true,
    provenance: 'required',
    aliases: ['facts', 'knowledge'],
    expected_share: 0.05,
    holds:
      'Facts that stay true independently of when they were learned. People, systems, ' +
      'relationships, definitions, established conclusions and the evidence behind them.',
    does_not_hold:
      'Events (episodic) or steps (procedural). If the entry is only meaningful with a date ' +
      'attached, it is not semantic.',
    write_when:
      'A durable fact is established or a prior one is corrected. Correct by superseding, never ' +
      'by editing.',
    read_when: 'Before answering anything that may have prior context.',
    neglect_symptom:
      'The same fact is re-derived from scratch in session after session, or an outdated version ' +
      'of it keeps resurfacing because the correction was never written.'
  },

  episodic: {
    importance: '0.4 - 0.7',
    importance_range: [0.4, 0.7],
    revisable: false,
    provenance: 'encouraged',
    aliases: ['events', 'conversations'],
    expected_share: 0.05,
    holds:
      'What happened, and when. Session records, decisions as events, problems solved, progress ' +
      'through long work. The continuity bridge between sessions.',
    does_not_hold:
      'Standing rules or reusable procedure - those outlive the event and belong elsewhere.',
    write_when:
      'A session closes, a problem is solved, or long work passes a milestone. During extended ' +
      'work, write progress as it happens rather than reconstructing it at the end.',
    read_when: 'Session start, newest first, for where things were left.',
    neglect_symptom:
      'Later sessions cannot say what happened in earlier ones, and the handoff document becomes ' +
      'the only record of a period of work.'
  },

  procedural: {
    importance: '0.5 - 0.8',
    importance_range: [0.5, 0.8],
    revisable: true,
    provenance: 'required',
    aliases: ['skills', 'howto', 'how-to'],
    expected_share: 0.05,
    holds:
      'How to do something, and decisions that govern future action - with the reasoning that ' +
      'produced them. Configurations, working methods, standing choices.',
    does_not_hold:
      'The occasion on which the decision was made (episodic) or the fact it rests on (semantic).',
    write_when:
      'A decision is made that constrains later work, or a method is established that would ' +
      'otherwise have to be rediscovered. Always record the rationale: a rule without its reason ' +
      'gets followed after its justification has expired.',
    read_when: 'Before repeating a task, and before overriding an existing approach.',
    neglect_symptom:
      'Settled questions get reopened, or a practice continues after the reason for it is gone ' +
      'because nobody can find what it was for.'
  },

  meta: {
    importance: '0.6 - 0.9',
    importance_range: [0.6, 0.9],
    revisable: true,
    provenance: 'encouraged',
    aliases: ['insights', 'reasoning'],
    expected_share: 0.03,
    holds:
      'Everything visible only from OUTSIDE the exchange, looking back at it. Two branches, one ' +
      'layer, deliberately: (1) how the memory system itself behaves - retrieval quality, save ' +
      'failures, protocol efficacy, classes of drift; (2) how the assistant behaves toward the ' +
      'user - calibration, recurring failure modes in the working relationship, and the ' +
      'standards the user sets for it.',
    does_not_hold:
      'Facts about the world, events, or task procedure. The test: if it is a property of the ' +
      'running system rather than of the subject matter, it is meta.',
    write_when:
      'A retrieval fails or succeeds surprisingly. A protocol proves out or breaks down. The ' +
      'user corrects how they are being worked with. Record wins as well as failures - a rule ' +
      'firing correctly weeks later is a surprise worth keeping, and a layer that only collects ' +
      'failures reads as a catalogue of defects rather than a calibration record. Consolidate ' +
      'related observations into one standing entry at roughly three instances, not before.',
    read_when:
      'Session start, ordered by importance rather than recency - consolidating an entry ' +
      're-timestamps it, so a recency query returns whatever was last revised rather than what ' +
      'matters most.',
    neglect_symptom:
      'THE COMMON ONE, AND IT IS SILENT. The same misunderstanding recurs across months with no ' +
      'record that it ever happened before; the user repeats a correction they have already ' +
      'given; the system\'s own failure patterns are invisible because nothing was ever the ' +
      'obvious place to put them. A near-empty meta layer beside healthy episodic and semantic ' +
      'layers almost always means the material is being produced and discarded, not that there ' +
      'is none.'
  },

  working: {
    importance: '0.3 - 0.6',
    importance_range: [0.3, 0.6],
    revisable: true,
    provenance: 'n/a',
    aliases: ['temp', 'scratch', 'wip'],
    expected_share: 0.02,
    holds:
      'Short-lived context: what is in flight right now, notes left for the next instance, ' +
      'intermediate state that matters this week and not next quarter.',
    does_not_hold:
      'Anything expected to matter in three months. A working entry does not fade or ' +
      'disappear with age. When it is superseded, or when it carries an explicit end date, ' +
      'that date is recorded and the entry stays readable, marked.',
    write_when:
      'Leaving instructions for whoever picks the work up, or parking state that has nowhere ' +
      'else to go yet.',
    read_when: 'Resuming interrupted work.',
    neglect_symptom:
      'Transient notes get written to episodic or procedural instead, where they permanently ' +
      'dilute the layers that are supposed to hold durable material.'
  }
});

/** One-line summaries, for payloads where the full charter is too much. */
export const LAYER_SUMMARY = Object.freeze({
  identity: 'Who the assistant is and who it serves. Durable, rarely written.',
  semantic: 'Facts that stay true regardless of when they were learned.',
  episodic: 'What happened and when. The bridge between sessions.',
  procedural: 'How things are done, and decisions with their reasoning.',
  meta: 'How the system and the assistant are behaving, seen from outside the exchange.',
  working: 'Short-lived context and notes for whoever picks the work up.'
});

export const LAYERS = Object.freeze(Object.keys(LAYER_CHARTER));

/**
 * alias (lower-case) -> canonical layer name, derived from the charter. Kept
 * frozen so nobody adds an alias here instead of on the layer it belongs to.
 */
export const LAYER_ALIASES = Object.freeze(
  Object.fromEntries(
    LAYERS.flatMap((layer) => (LAYER_CHARTER[layer].aliases || []).map((alias) => [alias, layer]))
  )
);

/**
 * Canonical layer name for a layer or alias, case-insensitively; null when the
 * name is neither. Pure: no throw, no side effect.
 */
export function resolveLayer(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  if (LAYERS.includes(key)) return key;
  return Object.prototype.hasOwnProperty.call(LAYER_ALIASES, key) ? LAYER_ALIASES[key] : null;
}

/**
 * The numeric importance band for a layer: { min, max, midpoint }.
 * Throws a plain Error for an unknown layer (aliases are not accepted here -
 * resolve first if you hold one).
 */
export function bandFor(layer) {
  const entry = LAYER_CHARTER[layer];
  if (!entry || !Array.isArray(entry.importance_range)) {
    throw new Error(`Unknown layer '${layer}'. Must be one of: ${LAYERS.join(', ')}`);
  }
  const [min, max] = entry.importance_range;
  // Rounded so 0.3 + 0.6 reads as 0.45, not 0.44999999999999996.
  return { min, max, midpoint: Number(((min + max) / 2).toFixed(4)) };
}

/** Named importance buckets. The word is the differentiator; the range is
 *  compatibility for the stored float. Degree (low/mid/high) is the only
 *  reason to pick a number other than the midpoint. The owner 2026-09-26. */
export const IMPORTANCE_BUCKETS = Object.freeze({
  constitutive: { range: [0.9, 1.0], layers: ['identity'] },
  durable: { range: [0.6, 0.9], layers: ['semantic', 'meta'] },
  binding: { range: [0.5, 0.8], layers: ['procedural'] },
  event: { range: [0.4, 0.7], layers: ['episodic'] },
  scratch: { range: [0.3, 0.6], layers: ['working'] }
});

export const IMPORTANCE_DEGREES = Object.freeze(['low', 'mid', 'high']);

const LAYER_BUCKET = Object.freeze(
  Object.fromEntries(
    Object.entries(IMPORTANCE_BUCKETS).flatMap(([name, spec]) =>
      spec.layers.map((layer) => [layer, name]))
  )
);

export function bucketForLayer(layer) {
  return LAYER_BUCKET[layer] || null;
}

function degreeValue(min, max, degree) {
  if (degree === 'low') return Number(min.toFixed(4));
  if (degree === 'high') return Number(max.toFixed(4));
  return Number(((min + max) / 2).toFixed(4));
}

function degreeFromValue(min, max, value) {
  const span = max - min;
  if (span <= 0) return 'mid';
  const t = (value - min) / span;
  if (t < 1 / 3) return 'low';
  if (t > 2 / 3) return 'high';
  return 'mid';
}

/** Resolve a caller importance (number, bucket word, or bucket:degree) to
 *  { importance, bucket, degree, defaulted }. Unknown bucket words throw. */
export function resolveImportance(layer, raw, extras = {}) {
  const band = bandFor(layer);
  const layerBucket = bucketForLayer(layer);
  let bucket = typeof extras.importance_bucket === 'string'
    ? extras.importance_bucket.trim().toLowerCase()
    : null;
  let degree = typeof extras.importance_degree === 'string'
    ? extras.importance_degree.trim().toLowerCase()
    : null;

  if (typeof raw === 'string') {
    const parts = raw.trim().toLowerCase().split(/[:\/]/);
    if (IMPORTANCE_BUCKETS[parts[0]]) {
      bucket = parts[0];
      if (parts[1]) degree = parts[1];
    } else if (IMPORTANCE_DEGREES.includes(parts[0])) {
      degree = parts[0];
    } else {
      throw new Error(
        `Unknown importance bucket '${raw}'. Use one of: ${Object.keys(IMPORTANCE_BUCKETS).join(', ')}` +
        ` (optional :low|:mid|:high).`
      );
    }
  }

  if (bucket && !IMPORTANCE_BUCKETS[bucket]) {
    throw new Error(
      `Unknown importance bucket '${bucket}'. Use one of: ${Object.keys(IMPORTANCE_BUCKETS).join(', ')}`
    );
  }
  if (degree && !IMPORTANCE_DEGREES.includes(degree)) {
    throw new Error(`Unknown importance degree '${degree}'. Use low, mid, or high.`);
  }

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const value = raw;
    const inferredBucket = bucket || layerBucket;
    const spec = inferredBucket ? IMPORTANCE_BUCKETS[inferredBucket] : null;
    const [bmin, bmax] = spec ? spec.range : [band.min, band.max];
    return {
      importance: value,
      bucket: inferredBucket,
      degree: degree || degreeFromValue(bmin, bmax, value),
      defaulted: false,
      numeric_given: true
    };
  }

  if (bucket) {
    const [min, max] = IMPORTANCE_BUCKETS[bucket].range;
    return {
      importance: degreeValue(min, max, degree || 'mid'),
      bucket,
      degree: degree || 'mid',
      defaulted: false,
      numeric_given: false
    };
  }

  return {
    importance: degreeValue(band.min, band.max, degree || 'mid'),
    bucket: layerBucket,
    degree: degree || 'mid',
    defaulted: raw === undefined || raw === null,
    numeric_given: false
  };
}

/**
 * The write policy for a layer: whether it may be revised, whether a
 * provenance pointer is required, where an unlabelled write falls back to,
 * and the aliases that resolve to it. Throws a plain Error for an unknown layer.
 */
export function policyFor(layer) {
  const entry = LAYER_CHARTER[layer];
  if (!entry) {
    throw new Error(`Unknown layer '${layer}'. Must be one of: ${LAYERS.join(', ')}`);
  }
  return {
    revisable: entry.revisable,
    provenance: entry.provenance,
    fallback_layer: FALLBACK_LAYER,
    aliases: [...(entry.aliases || [])]
  };
}

/**
 * Flags a layer that has effectively gone dark.
 *
 * A store cannot know what should have been written. It can see that one layer
 * received almost nothing while the others filled, and that is enough to be
 * worth saying out loud - it is the signal that was missing for a year.
 *
 * Deliberately conservative. It reports and explains; it never blocks anything,
 * and it stays quiet on a store too new to have a pattern yet.
 *
 * @param {object} totals  layer name -> lifetime entry count
 * @param {object} recent  layer name -> entries within the recent window (optional)
 */
export function assessLayerHealth(totals = {}, recent = null) {
  const total = Object.values(totals).reduce((a, b) => a + (b || 0), 0);
  if (total < 50) {
    return { assessed: false, reason: 'Too few entries so far to judge whether any layer is underused.' };
  }

  // identity is expected to be small; judging it by share would flag it forever,
  // so its charter carries no expected_share and it is skipped here.
  const findings = [];

  for (const layer of LAYERS) {
    const minShare = LAYER_CHARTER[layer].expected_share;
    if (typeof minShare !== 'number') continue;
    const count = totals[layer] || 0;
    const share = count / total;
    if (share >= minShare) continue;
    findings.push({
      layer,
      entries: count,
      share: Number(share.toFixed(4)),
      expected_share_at_least: minShare,
      what_it_is_for: LAYER_SUMMARY[layer],
      how_to_tell: LAYER_CHARTER[layer].neglect_symptom,
      instruction:
        `The ${layer} layer holds ${count} of ${total} entries. That is low enough that material ` +
        `belonging there is probably being written elsewhere or discarded. Read its charter, and ` +
        `when something fits it this session, write it there. Do not backfill invented entries.`
    });
  }

  if (recent) {
    for (const layer of LAYERS) {
      if ((totals[layer] || 0) > 0 && (recent[layer] || 0) === 0 && layer !== 'identity') {
        findings.push({
          layer,
          entries: totals[layer],
          recent_entries: 0,
          what_it_is_for: LAYER_SUMMARY[layer],
          instruction:
            `The ${layer} layer has not been written to recently although it has been used before. ` +
            `Worth noticing if the work of this period should have produced entries there.`
        });
      }
    }
  }

  return {
    assessed: true,
    total_entries: total,
    underused: findings,
    note: findings.length
      ? 'A layer with no charter has no answer to "does this belong here?", so nothing routes to it ' +
        'and the silence is never an error. Treat this as a prompt to check, not as a quota to fill.'
      : 'All six layers are in active use.'
  };
}

export default {
  LAYER_CHARTER, LAYER_SUMMARY, LAYERS, LAYER_ALIASES, FALLBACK_LAYER,
  IMPORTANCE_BUCKETS, IMPORTANCE_DEGREES,
  resolveLayer, bandFor, bucketForLayer, resolveImportance, policyFor, assessLayerHealth
};
