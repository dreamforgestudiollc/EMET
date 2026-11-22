/**
 * Sub-key session statechart.
 *
 * One key, one session slot. Renewal and reclaim replace that slot.
 * A handle with no key does not mint the next session.
 * The picture is docs/subkey-session-statechart.md.
 * The model is verification/subkey-session/SubkeySession.tla.
 */

export const SUBKEY_SESSION_MERMAID = `stateDiagram-v2
  [*] --> opening
  opening --> live: open commits
  opening --> ended: open lost
  live --> renewal_offered: last hour, handle still valid
  renewal_offered --> live: renew with the key and the handle
  live --> live: renew with the key and the handle
  live --> expired: handle expires
  renewal_offered --> expired: handle expires
  expired --> live: renew with the key and the handle, inside grace
  expired --> unwrapped: chat, no wrap-up, key still required to open
  unwrapped --> live: same key opens the next session
  live --> closed: owner, or same key reclaim, or a clean close
  ended --> auto_closed: sweep
  expired --> auto_closed: past grace, sweep
  unwrapped --> auto_closed: past grace, sweep
  opening --> auto_closed: past grace, sweep
  live --> revoked: revoke
  renewal_offered --> revoked: revoke
  closed --> [*]
  auto_closed --> [*]
  revoked --> [*]`;

export const SUBKEY_SESSION_STEPS = Object.freeze([
  'A session opens into one live slot for its key. A second open while that slot is still in its 12 hours is a collision for a bot key.',
  'Inside the last hour the server asks the caller to wrap up and open again with the sub-key and the current handle. The handle still works. The server does not mint a handle from that call.',
  'A renewal presents the sub-key and the current handle. The old session closes into the new one in the same write. One live session remains. The new row records the previous open.',
  'After expiry, the grace window still accepts that pair. The handle alone does not mint a session.',
  'A chat key is the kind the owner stored. A chat whose handle expired with no wrap-up record is marked unwrapped, and the next open with the key is still allowed. The reply tells the user to go back and wrap that chat up.',
  'A wrap-up record for that tag, written between the handle and now, lets the old session close into the new one.',
  'The owner, or a new open with the same key, carry-forward closes a stranded session of that key. Another key does not.',
  'Past the grace window, or when the link is already ended, the sweep records auto_closed. The row and the transcript stay. A status read is not refused and does not write handle_expired.'
]);

const SESS = new Set([
  'opening', 'live', 'renewal_offered', 'ended', 'expired', 'unwrapped', 'closed', 'auto_closed', 'revoked'
]);
const PHASE = new Set(['fresh', 'window', 'grace', 'beyond']);
const CLOSED = new Set(['closed', 'auto_closed', 'revoked']);
const ORDER = ['fresh', 'window', 'grace', 'beyond'];

function same(state, extra) {
  return { ...state, ...extra };
}

/** A step that changes the session record. `store` counts those writes. */
function wrote(state, extra) {
  const store = state.store || 0;
  return { ...state, ...extra, store: store + 1, prevStore: store, act: 'write' };
}

/** A read. The session record and the store counter stay where they are. */
function read(state, act) {
  const store = state.store || 0;
  return { ...state, store, prevStore: store, act };
}

/**
 * One step. An event that cannot happen returns null.
 * `credential` is `key` for renew and reclaim, `handle` for a bare handle, `foreign` for another tag.
 */
export function subkeySessionStep(state, event, credential = 'key') {
  if (!state || !SESS.has(state.sess) || !PHASE.has(state.phase)) return null;
  if (state.kind !== 'bot' && state.kind !== 'chat') return null;
  const next = { ...state };

  if (event === 'rest') {
    if (!CLOSED.has(state.sess)) return null;
    return same(state, {});
  }
  if (event === 'status') return read(state, 'status');
  if (CLOSED.has(state.sess)) return null;

  if (event === 'commit') {
    if (state.sess !== 'opening' || (state.phase !== 'fresh' && state.phase !== 'window')) return null;
    return wrote(state, { sess: 'live', live: 1 });
  }
  if (event === 'lose') {
    if (state.sess !== 'opening') return null;
    return wrote(state, { sess: 'ended', live: 0 });
  }
  if (event === 'offer') {
    if (state.sess !== 'live' || state.phase !== 'window' || state.live !== 1) return null;
    return wrote(state, { sess: 'renewal_offered' });
  }
  if (event === 'advance') {
    const i = ORDER.indexOf(state.phase);
    if (i < 0 || i === ORDER.length - 1) return null;
    const phase = ORDER[i + 1];
    if ((state.sess === 'live' || state.sess === 'renewal_offered') && (phase === 'grace' || phase === 'beyond')) {
      return wrote(state, { phase, sess: 'expired', live: 0 });
    }
    return wrote(state, { phase });
  }
  if (event === 'renew') {
    if (credential !== 'key') return null;
    if (state.gen >= 1) return null;
    if (state.phase !== 'window' && state.phase !== 'grace') return null;
    if (!['live', 'renewal_offered', 'expired'].includes(state.sess)) return null;
    return wrote(state, {
      sess: 'live', phase: 'fresh', gen: state.gen + 1, live: 1,
      prevClosed: true, closedBy: 'same', bareMint: false
    });
  }
  if (event === 'reclaim') {
    if (credential !== 'key') return null;
    if (state.reclaims >= 1) return null;
    if (state.sess === 'opening') return null;
    const stranded = ['ended', 'expired', 'unwrapped'].includes(state.sess) || state.phase === 'grace' || state.phase === 'beyond';
    if (state.kind !== 'chat' && !stranded) return null;
    const chatClean = state.kind === 'chat' && state.wrap && state.sess !== 'ended';
    return wrote(state, {
      sess: 'live', phase: 'fresh', live: 1, reclaims: state.reclaims + 1,
      prevClosed: chatClean || state.kind !== 'chat' || state.wrap || state.sess === 'ended' || state.phase === 'beyond',
      closedBy: 'same', bareMint: false
    });
  }
  if (event === 'unwrap') {
    if (state.kind !== 'chat' || state.wrap || state.phase !== 'grace' || state.sess !== 'expired') return null;
    return wrote(state, { sess: 'unwrapped', live: 0, bareMint: false });
  }
  if (event === 'owner_close') {
    return wrote(state, { sess: 'closed', live: 0, closedBy: 'owner', prevClosed: true });
  }
  if (event === 'sweep') {
    if (state.phase !== 'beyond' && state.sess !== 'ended') return null;
    if (state.sess === 'ended' || state.phase === 'beyond') {
      return wrote(state, { sess: 'auto_closed', live: 0, closedBy: 'sweep', prevClosed: true });
    }
    return null;
  }
  if (event === 'revoke') {
    return wrote(state, { sess: 'revoked', live: 0, closedBy: 'owner' });
  }
  if (event === 'bare_handle') {
    if (credential !== 'handle') return null;
    return read(state, 'bare');
  }
  if (event === 'foreign_close') {
    if (credential !== 'foreign') return null;
    return same(next, {});
  }
  if (event === 'collision') {
    if (state.kind !== 'bot' || !['live', 'renewal_offered'].includes(state.sess)) return null;
    if (state.phase !== 'fresh' && state.phase !== 'window') return null;
    return same(next, {});
  }
  return null;
}

export function initialSubkeySessions() {
  const rows = [];
  for (const kind of ['bot', 'chat']) {
    for (const wrap of [false, true]) {
      rows.push({
        sess: 'opening', phase: 'fresh', kind, wrap, gen: 0, live: 0,
        reclaims: 0, bareMint: false, closedBy: 'none', prevClosed: false,
        store: 0, prevStore: 0, act: 'init'
      });
    }
  }
  return rows;
}

const EVENTS = [
  'commit', 'lose', 'offer', 'advance', 'renew', 'reclaim', 'unwrap',
  'owner_close', 'sweep', 'revoke', 'bare_handle', 'status', 'foreign_close', 'collision', 'rest'
];

function credFor(event) {
  if (event === 'bare_handle') return 'handle';
  if (event === 'foreign_close') return 'foreign';
  return 'key';
}

function keyOf(state) {
  return [state.sess, state.phase, state.kind, state.wrap, state.gen, state.live, state.reclaims, state.bareMint, state.closedBy, state.prevClosed].join('|');
}

/**
 * Every reachable slot. `stranded` is a non-closed state from which
 * commit, lose, advance, and sweep cannot reach a closed state.
 */
export function auditSubkeySessions() {
  const start = initialSubkeySessions();
  const seen = new Map();
  const queue = [];
  for (const row of start) {
    seen.set(keyOf(row), row);
    queue.push(row);
  }
  while (queue.length) {
    const row = queue.shift();
    for (const event of EVENTS) {
      const step = subkeySessionStep(row, event, credFor(event));
      if (!step) continue;
      const id = keyOf(step);
      if (seen.has(id)) continue;
      seen.set(id, step);
      queue.push(step);
    }
  }
  const rows = [...seen.values()];
  const problems = [];
  for (const row of rows) {
    if (row.live > 1) problems.push({ rule: 'live', row });
    if (row.bareMint) problems.push({ rule: 'bare', row });
    if (row.closedBy === 'foreign') problems.push({ rule: 'foreign', row });
    if ((row.sess === 'closed' || row.sess === 'auto_closed') && !['same', 'owner', 'sweep'].includes(row.closedBy)) {
      problems.push({ rule: 'closer', row });
    }
    if (row.sess === 'unwrapped' && row.live !== 0) problems.push({ rule: 'unwrapped', row });
    const status = subkeySessionStep(row, 'status', 'key');
    if (!status || status.act !== 'status' || status.store !== row.store || status.sess !== row.sess || status.prevStore !== status.store) {
      problems.push({ rule: 'status-write', row });
    }
    const bare = subkeySessionStep(row, 'bare_handle', 'handle');
    if (bare && (bare.act !== 'bare' || bare.store !== row.store || bare.sess !== row.sess || bare.live !== row.live)) {
      problems.push({ rule: 'bare-write', row });
    }
  }
  const progress = new Set(['commit', 'lose', 'advance', 'sweep']);
  const stranded = [];
  for (const row of rows) {
    if (['closed', 'auto_closed', 'revoked'].includes(row.sess)) continue;
    const reach = new Map([[keyOf(row), row]]);
    const q = [row];
    let settled = false;
    while (q.length) {
      const cur = q.shift();
      if (['closed', 'auto_closed', 'revoked'].includes(cur.sess)) { settled = true; break; }
      for (const event of progress) {
        const step = subkeySessionStep(cur, event, 'key');
        if (!step) continue;
        const id = keyOf(step);
        if (reach.has(id)) continue;
        reach.set(id, step);
        q.push(step);
      }
    }
    if (!settled) stranded.push(row);
  }
  return { count: rows.length, problems, stranded };
}
