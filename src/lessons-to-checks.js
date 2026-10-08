/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Lessons that became checks (2026-09-27).
 *
 * Three rules that had lived as advice - read at startup, sometimes ignored -
 * are held here as checks the server runs. Each names the failure it prevents
 * (charter commitment 6) and each is a pure function, so the rule is testable
 * without a database. The wiring lives in tools.js (transcript append),
 * session.js (close) and setup.js (initialize).
 *
 *   1. machineLineCheck   - the first transcript append of a session must carry
 *                           a measured machine name and a clock reading, or the
 *                           words `no local shell MCP`. Two sessions on
 *                           2026-09-26 skipped the machine check and still got a
 *                           transcript started.
 *   2. applyCloseCap      - three blocked closes on one session escalate to the
 *                           user instead of retrying. A host looping on close
 *                           burns attempts; after three, the wrap plan is wrong
 *                           and the loop cannot see the plan.
 *   3. pendingLessons     - corrections recorded three or more times in the meta
 *                           layer with no disposition are named at startup, so
 *                           the next conversion is a standing decision rather
 *                           than a count nobody reads. This is the learning
 *                           edge: what makes lesson-to-check conversion recur.
 *   4. checkLessonFields  - (2026-09-29) the lesson key and disposition are
 *                           validated at the write, so a correction the reader
 *                           would never count is refused rather than stored.
 *
 * Source of the three-attempt rule and the scope line: Hanako, "Loops and
 * Graphs" (2026-08-23), read in full 2026-09-27; the user's decisions are in
 * the owner's store.
 */

// ---------------------------------------------------------------------------
// 1. Machine line on the first transcript append
// ---------------------------------------------------------------------------

export const NO_SHELL_PHRASE = 'no local shell MCP';

/**
 * Reads the known machine names out of the user's install notes. The notes are
 * a markdown document; the machines are the first column of any table whose
 * header row names a `Name` column. Nothing else in the document is parsed.
 * Returns [] when the document has no such table.
 */
export function knownMachinesFromInstallNotes(content) {
  if (typeof content !== 'string' || !content) return [];
  const lines = content.split(/\r?\n/);
  const names = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim().toLowerCase());
    if (cells[0] !== 'name') continue;
    // header found; consume the separator and the rows
    let j = i + 1;
    if (j < lines.length && /^\|\s*-{2,}/.test(lines[j].trim())) j++;
    for (; j < lines.length; j++) {
      const row = lines[j].trim();
      if (!row.startsWith('|')) break;
      const first = row.split('|').slice(1, -1)[0];
      const name = String(first || '').replace(/[`*_]/g, '').trim();
      if (name && !/^-+$/.test(name)) names.add(name);
    }
    i = j;
  }
  return [...names];
}

const CLOCK_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/,                 // 2026-09-27
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/i, // 15:29:12, 3:29 PM
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/i
];

/**
 * The check itself. `assistant_message` is the first reply of the session as
 * the host appends it. Passes when it carries the literal no-shell phrase, or
 * a known machine name together with something that reads as a clock.
 *
 * With no known names (a store whose install notes have no machine table) the
 * check cannot tell a measured name from a typed one and is NOT enforced; the
 * result says so, so a stranger's first session is not blocked by a table
 * they have not written yet. Presence is checked, not truth: a model can type
 * a name it never measured. The floor rises from "skipped silently" to "had
 * to state something checkable".
 */
export function machineLineCheck(assistant_message, knownMachines = []) {
  const text = String(assistant_message || '');
  const names = Array.isArray(knownMachines) ? knownMachines.filter(Boolean) : [];
  if (names.length === 0) {
    return { enforced: false, ok: true, reason: 'not enforced: the install notes name no machines' };
  }
  if (text.toLowerCase().includes(NO_SHELL_PHRASE.toLowerCase())) {
    return { enforced: true, ok: true, matched: NO_SHELL_PHRASE };
  }
  const lower = text.toLowerCase();
  const machine = names.find((n) => lower.includes(String(n).toLowerCase()));
  const clock = CLOCK_PATTERNS.some((re) => re.test(text));
  if (machine && clock) return { enforced: true, ok: true, matched: machine };
  const missing = [];
  if (!machine) missing.push(`a known machine name (${names.join(', ')})`);
  if (!clock) missing.push('a date or time reading');
  return {
    enforced: true,
    ok: false,
    missing,
    reason:
      `first transcript append must carry the measured machine line - ${missing.join(' and ')} - ` +
      `or the words "${NO_SHELL_PHRASE}". Run the machine check and put its raw return in the reply.`
  };
}

// ---------------------------------------------------------------------------
// 2. Cap blocked closes at three
// ---------------------------------------------------------------------------

export const CLOSE_CAP = 3;

/**
 * Given the state the close check computed and how many blocked results this
 * session has already had, decide the state to return and the count to store.
 *
 *   - complete / incomplete pass through; the counter is untouched.
 *   - blocked increments the counter; on reaching the cap it becomes escalate.
 *   - once at the cap, a further blocked result stays escalate and the counter
 *     stops - the host has been told to stop, and counting past three adds
 *     nothing.
 *
 * The counter never resets on a receipt change (the user's ruling 2026-09-27):
 * three blocked closes means the plan for the wrap is wrong, and a changed
 * receipt is one more attempt at the same plan. It resets only with a new
 * session, which has a new base id. A close that would be complete is never
 * refused - the cap stops retries, not a correct close.
 */
export function applyCloseCap(state, priorBlocked = 0, cap = CLOSE_CAP) {
  const prior = Math.max(0, Number(priorBlocked) || 0);
  if (state !== 'blocked') return { state, blocked_count: prior, escalated: false };
  const count = Math.min(cap, prior + 1);
  const escalated = count >= cap;
  return { state: escalated ? 'escalate' : 'blocked', blocked_count: count, escalated };
}

/**
 * SCOPE for each missing item: what the host may touch to clear it, and
 * nothing else. Without a scope a returned item grows - the host opens the
 * store, notices two adjacent things, and the one-item correction becomes a
 * rewrite nobody asked for.
 */
export function scopeFor(problem) {
  const p = String(problem || '');
  if (/transcript/i.test(p)) {
    return 'query_transcripts for this session only; append only the named exchanges with emet_transcript_append; touch no other session';
  }
  if (/^handoff/i.test(p)) {
    return 'write_doc HANDOFF.md whole, with supersedes set to the version in force; no other document';
  }
  if (/^board/i.test(p) || /STATE\.md/i.test(p)) {
    return 'patch the board rows this session changed and its counts; nothing else on the board';
  }
  if (/episodic/i.test(p)) {
    return 'save_to_layer episodic (one session record) and query_layer to read it back; no other layer';
  }
  if (/^working document/i.test(p)) {
    return 'that one document only';
  }
  if (/^receipt/i.test(p)) {
    return 'supply the named receipt from what the tools returned this session; do not rewrite an artifact to match a recollection';
  }
  if (/does not exist|was not updated/i.test(p)) {
    return 'that one document only';
  }
  return 'only what the line names';
}

/** The lines the host says when the cap is reached. Built from `missing`. */
export function escalateSpeak(missing = []) {
  return [
    `Close escalated: ${CLOSE_CAP} blocked closes on this session. Stop retrying.`,
    'Hand the user this list and wait for their word:',
    ...missing.map((m) => `- ${m}`)
  ];
}

// ---------------------------------------------------------------------------
// 3. Pending lessons at startup
// ---------------------------------------------------------------------------

export const LESSON_REPEAT_THRESHOLD = 3;
export const DISPOSITION_KINDS = Object.freeze(['check', 'document', 'uncheckable']);

function dispositionOf(row) {
  const md = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const d = md.lesson_disposition || (md.custom && md.custom.lesson_disposition);
  if (!d || typeof d !== 'object') return null;
  if (!DISPOSITION_KINDS.includes(d.kind)) return null;
  return { kind: d.kind, ref: d.ref || null };
}

/**
 * A lesson is pending when the live meta rows sharing one explicit key have
 * reached the threshold and no live member carries a disposition.
 *
 * A disposition is recorded the way everything in a layer is: a new meta
 * entry with the same metadata.lesson key and metadata.lesson_disposition
 * {kind: check|document|uncheckable, ref}. It joins the lesson and settles it.
 * No new tool, no mutation.
 *
 * `rows` are live meta entries: {id, content, timestamp, metadata:{lesson,...}}.
 * lessons@3 (2026-09-29): the tag-family shadow detector is removed.
 */
export const LESSONS_RULE_VERSION = 'lessons@3';

/** The explicit key: metadata.lesson (or metadata.custom.lesson), a short slug
 *  the writer sets when recording a correction - "machine-check-skipped",
 *  "codes-not-plain-words". Same key, same lesson. No inference. */
function lessonKeyOf(row) {
  const md = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const k = md.lesson ?? (md.custom && md.custom.lesson);
  return typeof k === 'string' && k.trim() ? k.trim().toLowerCase() : null;
}

function familyEntry(members, key) {
  const disposition = members.map(dispositionOf).find(Boolean) || null;
  const ids = members.map((m) => m.id).filter((x) => x !== undefined).sort((a, b) => a - b);
  const latest = members.reduce((a, b) => ((b.timestamp || 0) > (a.timestamp || 0) ? b : a), members[0]);
  return {
    entry: {
      ...(key ? { lesson_key: key } : {}),
      lesson: String(latest.content || '').slice(0, 200),
      count: members.length,
      ids,
      latest_at: latest.timestamp ? new Date(latest.timestamp * 1000).toISOString() : null
    },
    disposition
  };
}

/**
 * One detector, the explicit key (2026-09-29). Rows carrying metadata.lesson
 * are grouped by that key - the writer says "same lesson" at save time and
 * nothing is inferred. The tag-family heuristic that ran beside it in shadow
 * from 2026-09-27 was DROPPED on the owner's ruling: "that's
 * just another instance of forking... I would rather the original be more
 * heavily, better enforced, than having a backup that can rot or fork." The
 * enforcement moved to the write: checkLessonFields below refuses a malformed
 * key or disposition at the door, so a lesson that would never be counted is
 * not stored in the first place.
 *
 * The output carries a decision receipt: the rule version, the state it saw
 * (row counts), and the route.
 */
export function pendingLessons(rows, { threshold = LESSON_REPEAT_THRESHOLD } = {}) {
  const live = (Array.isArray(rows) ? rows : []).filter((r) => r && r.is_live !== false && !r.superseded_by);

  // --- authoritative: explicit key ---------------------------------------
  const byKey = new Map();
  for (const r of live) {
    const k = lessonKeyOf(r);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const pending = [];
  const dispositioned = [];
  for (const [key, members] of byKey) {
    if (members.length < threshold) continue;
    const { entry, disposition } = familyEntry(members, key);
    if (disposition) dispositioned.push({ ...entry, disposition });
    else pending.push(entry);
  }
  pending.sort((a, b) => b.count - a.count);

  return {
    threshold,
    pending,
    dispositioned_count: dispositioned.length,
    // Decision receipt: what rule ran, what it saw, which route produced the answer.
    receipt: {
      rule_version: LESSONS_RULE_VERSION,
      state: { live_meta_rows: live.length, keyed_rows: [...byKey.values()].reduce((n, m) => n + m.length, 0), keys: byKey.size },
      route: 'explicit-key'
    },
    instructions: pending.length
      ? 'Name each pending lesson to the user at startup, one line each, after the parked list: what the correction was and how many times it has landed. Ask nothing of it. Each is settled by a new meta entry carrying the same metadata.lesson key and metadata.lesson_disposition {kind: check|document|uncheckable, ref} - a check names the server check, a document names where the rule now lives, uncheckable records that the server cannot hear it. When recording a correction, set metadata.lesson to a short stable slug so the repeat can be counted.'
      : 'No keyed correction has recurred to the threshold without a disposition. When recording a correction, set metadata.lesson to a short stable slug so repeats can be counted.'
  };
}

// ---------------------------------------------------------------------------
// 4. The lesson fields are checked at the door (2026-09-29, a decision record)
// ---------------------------------------------------------------------------

/** A lesson key is a lowercase slug: letters and digits in hyphen-joined
 *  words, 3 to 64 characters - "codes-not-plain-words". */
export const LESSON_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LESSON_KEY_MIN = 3;
export const LESSON_KEY_MAX = 64;
export const LESSON_LAYER = 'meta';

/** The slug a malformed key most likely meant, offered in the refusal. */
export function suggestLessonKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LESSON_KEY_MAX);
}

/**
 * Checks the lesson fields of one write and returns null when they are sound,
 * or the reason the write must be refused. Pure: no store, no clock.
 *
 * The reader (pendingLessons) counts only live META rows whose key matches, so
 * anything it would silently never count is refused here instead of being
 * discovered months later as a correction that never reached the threshold:
 *   - a key that is not a string, not a slug, or outside 3-64 characters
 *     (no normalising: "Codes Not Plain Words" is refused with the slug it
 *     most likely meant, so the writer's key and the counted key are one);
 *   - a key on any layer but meta;
 *   - two different keys (top level and under metadata.custom);
 *   - a disposition that is not {kind: check|document|uncheckable}, a check
 *     or document disposition with no ref naming it, or a disposition with
 *     no key (it would settle nothing).
 * An empty metadata, or one with no lesson fields, returns null.
 */
export function checkLessonFields(layer, metadata) {
  const md = metadata && typeof metadata === 'object' ? metadata : {};
  const custom = md.custom && typeof md.custom === 'object' ? md.custom : {};
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null;

  const keys = [has(md, 'lesson') ? md.lesson : undefined, has(custom, 'lesson') ? custom.lesson : undefined].filter((k) => k !== undefined);
  const disps = [has(md, 'lesson_disposition') ? md.lesson_disposition : undefined, has(custom, 'lesson_disposition') ? custom.lesson_disposition : undefined].filter((d) => d !== undefined);
  if (!keys.length && !disps.length) return null;

  for (const k of keys) {
    if (typeof k !== 'string') return `metadata.lesson must be a string slug, got ${typeof k}.`;
    if (k.length < LESSON_KEY_MIN || k.length > LESSON_KEY_MAX || !LESSON_KEY_PATTERN.test(k)) {
      const s = suggestLessonKey(k);
      return `metadata.lesson "${k}" is not a lesson key: use a lowercase slug of letters and digits joined by hyphens, ${LESSON_KEY_MIN}-${LESSON_KEY_MAX} characters` +
        (s.length >= LESSON_KEY_MIN ? ` - for example "${s}".` : '.');
    }
  }
  if (keys.length === 2 && keys[0] !== keys[1]) return `metadata.lesson "${keys[0]}" and metadata.custom.lesson "${keys[1]}" disagree: one write carries one lesson key.`;

  if (layer !== LESSON_LAYER) {
    return `lesson fields belong on the ${LESSON_LAYER} layer, where repeated corrections are counted; this write names "${layer || 'no layer'}". Save the correction to ${LESSON_LAYER}.`;
  }

  for (const d of disps) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return 'metadata.lesson_disposition must be an object {kind, ref}.';
    if (!DISPOSITION_KINDS.includes(d.kind)) return `metadata.lesson_disposition.kind must be one of ${DISPOSITION_KINDS.join(', ')}; got "${d.kind}".`;
    if (d.kind !== 'uncheckable' && !(typeof d.ref === 'string' && d.ref.trim())) {
      return `a "${d.kind}" disposition must name its ref - the server check, or where the rule is now written.`;
    }
  }
  if (disps.length && !keys.length) return 'metadata.lesson_disposition settles a lesson by its key; this write carries no metadata.lesson, so it would settle nothing.';
  return null;
}

export default {
  NO_SHELL_PHRASE, knownMachinesFromInstallNotes, machineLineCheck,
  CLOSE_CAP, applyCloseCap, scopeFor, escalateSpeak,
  LESSON_REPEAT_THRESHOLD, DISPOSITION_KINDS, pendingLessons,
  LESSON_KEY_PATTERN, suggestLessonKey, checkLessonFields
};
