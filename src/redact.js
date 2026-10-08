/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Secret redaction at the write path.
 *
 * Why this exists (2026-09-07): an OAuth passphrase was pasted into a chat and a
 * screenshot during a connector re-add, and the session transcript that would
 * carry it verbatim was minutes away from being written to the store. A rule
 * that says "do not paste secrets" is an instruction; a scrubber the content
 * passes through before it lands anywhere is a control. This module is the
 * control. It sits inside the single write path (THE DOOR, a decision record):
 * memory saves, transcript saves, document writes, and log output all pass
 * through it, so an instance cannot opt out by forgetting.
 *
 * What it masks, in order:
 *   1. Literal values of secret-bearing environment variables (anything whose
 *      name contains PASSPHRASE, PASSWORD, SECRET, TOKEN, API_KEY, PRIVATE_KEY,
 *      or MONGODB_URI), plus the user:password pair inside any URI among them.
 *      These are exact-string matches and cannot false-positive.
 *   2. Credentials embedded in URIs: scheme://user:password@host.
 *   3. Bearer tokens and JWTs.
 *   4. key/value pairs whose key names a secret (passphrase, password, secret,
 *      token, api_key, client_secret, access_token, refresh_token, authorization)
 *      followed by : or = and a value. The key survives, the value does not.
 *
 * What it deliberately does NOT mask: hex digests (sha256 values are 64 hex
 * chars and are part of the integrity record), ids, and ordinary prose. Rule 4
 * can mask a word in prose that follows "token:" - that is accepted. Masking a
 * word costs a word; missing a secret costs the secret. (An English prefix
 * hyphenated onto a key word - "re-authorization:" - is not treated as a key;
 * that one masked prose on 2026-09-07 and is excluded.)
 *
 * The mask is visible on purpose: '*****' says "something was here and was
 * removed", which is the honest record. A silent drop would be a summary.
 *
 * The hit count reports CHANGES. Text that already carries the mask is matched
 * and left as it is, uncounted - otherwise every read-modify-write of a
 * document re-reports the masks it already held (observed 2026-09-07).
 */

export const MASK = '*****';

const SECRET_ENV_NAME = /(PASSPHRASE|PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|MONGODB_URI)/i;
const MIN_LITERAL_LENGTH = 6;

// Registered literal secrets. A Set so re-registering is a no-op.
const literals = new Set();

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Registers one literal secret value. Anything shorter than MIN_LITERAL_LENGTH
 * is ignored - masking "abc" everywhere would shred ordinary text.
 * If the value is a URI with credentials, the user:password pair is registered
 * as well, so a URI quoted with a different host or query still masks.
 */
export function registerSecret(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < MIN_LITERAL_LENGTH) return false;
  literals.add(v);
  literalOrder = null;
  const m = v.match(/^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+)@/i);
  if (m && m[1].includes(':')) {
    const [, pass] = m[1].split(/:(.*)/s);
    if (pass && pass.length >= MIN_LITERAL_LENGTH) literals.add(pass);
  }
  return true;
}

/** Registers every secret-bearing value in an env object (defaults to process.env). */
export function registerSecretsFromEnv(env = process.env) {
  let n = 0;
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_NAME.test(k) && registerSecret(v)) n++;
  }
  return n;
}

/** Test seam. Not for production use. */
export function _clearRegisteredSecrets() {
  literals.clear();
  literalOrder = null;
}

// Longest-first order, computed once per registry change rather than once per
// write. The registry changes at startup and effectively never again; sorting
// it on every scrub was work repeated for no reason.
let literalOrder = null;
function orderedLiterals() {
  if (literalOrder === null) literalOrder = [...literals].sort((a, b) => b.length - a.length);
  return literalOrder;
}

export function registeredSecretCount() {
  return literals.size;
}

// A necessary-condition prefilter for the key/value rule. Every alternative in
// KEY_NAMES contains one of these substrings, so text without any of them
// cannot match - and skipping the full pattern then is free correctness.
const KEY_HINT = /pass|secret|token|key|authorization|credential/i;

// Pattern rules. Each replaces with a function so the hit count is exact.
// `pre` is a cheap NECESSARY condition: a substring the full pattern cannot
// match without. It never decides a match - it only decides whether the
// expensive scan is worth starting.
const KEY_NAMES = '(?:pass(?:phrase|word|wd)|secret|token|api[_-]?key|client_secret|access_token|refresh_token|authorization|credential)';
const RULES = [
  // scheme://user:password@host  ->  scheme://*****:*****@host
  { name: 'uri-credentials', pre: (t) => t.includes('://'),
    re: /([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/gi, sub: (_m, scheme) => `${scheme}${MASK}:${MASK}@` },
  // Bearer <token>
  { name: 'bearer', pre: (t) => t.includes('Bearer'),
    re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, sub: (_m, w) => `${w} ${MASK}` },
  // JWT
  { name: 'jwt', pre: (t) => t.includes('eyJ'),
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, sub: () => MASK },
  // key: value / key = value / "key": "value"   (key survives, value is masked)
  { name: 'key-value',
    // Every alternative in KEY_NAMES contains one of these substrings, and the
    // rule also requires a ':' or '='. Both are NECESSARY conditions, so
    // failing this check cannot skip a match the full pattern would have found.
    pre: (t) => KEY_HINT.test(t) && (t.includes(':') || t.includes('=')),
    // The scheme words of an Authorization header are not the secret; the
    // bearer rule above has already masked what followed them.
    // G5 (2026-09-07): the prefix class lets a header name like x-api-key
    // through, but it also let "re-authorization:" in prose count as a key and
    // mask the word after it (thread §32). An English prefix joined by a hyphen
    // is not a key name: re-, pre-, de-, un-, non- are excluded right before
    // the key word.
    // G6 (2026-09-07): the value stops at a backtick and does not swallow a
    // trailing period or closing parenthesis - prose like `passphrase: x`. kept
    // losing its closing backtick and full stop. A secret that itself ends in
    // "." or ")" keeps that one character visible; accepted.
    re: new RegExp(`(["']?\\b[\\w.-]*(?<!\\b(?:re|pre|de|un|non)-)${KEY_NAMES}["']?\\s*[:=]\\s*)(["']?)(?!(?:Bearer|Basic|Digest)\\b)(?=[^\\s"'\`,;}\\]]{4})([^\\s"'\`,;}\\]]*[^\\s"'\`,;}\\].)])([.)]*)(\\2)`, 'gi'),
    sub: (_m, key, q, _v, trail, q2) => `${key}${q}${MASK}${trail}${q2}` }
];

/**
 * Redacts a string. Returns { text, hits } where hits is the number of
 * replacements made. Non-strings are returned unchanged with hits 0.
 */
export function redactWithReport(input) {
  if (typeof input !== 'string' || input.length === 0) return { text: input, hits: 0 };
  let text = input;
  let hits = 0;
  // Literals first: exact, longest first so a value that contains another is
  // masked whole rather than leaving a fragment.
  //
  // These are literal strings, so they need no regex at all. The previous
  // version compiled one RegExp per literal PER CALL and scanned the whole body
  // with it whether or not the literal was present. indexOf answers "is it
  // here" far more cheaply than a regex scan, and split/join is the same
  // operation as a global replace on an escaped literal - identical output,
  // identical hit count.
  for (const lit of orderedLiterals()) {
    if (!text.includes(lit)) continue;
    const parts = text.split(lit);
    hits += parts.length - 1;
    text = parts.join(MASK);
  }
  // G4 (2026-09-07): a hit is a CHANGE. Text that already carries the mask
  // ("passphrase: *****") matches the key/value rule and is replaced with
  // itself; counting that made every read-modify-write of a document report
  // the masks it already held as new redactions. The receipt's `redacted` is
  // the number of spans this write changed - nothing else.
  for (const rule of RULES) {
    // The prefilter is a necessary condition for the pattern, so skipping on a
    // miss cannot change the output. It exists because the scrubber was paying
    // nearly full price on documents containing no secrets at all: measured
    // 2026-09-08, a clean 300 KB body cost 6.40 ms against 7.25 ms for a
    // secret-bearing one. The cost was scanning, not replacing.
    if (rule.pre && !rule.pre(text)) continue;
    text = text.replace(rule.re, (...args) => {
      const out = rule.sub(...args);
      if (out !== args[0]) hits++;
      return out;
    });
  }
  return { text, hits };
}

/** Convenience: the redacted string only. */
export function redactText(input) {
  return redactWithReport(input).text;
}

const SECRET_KEY = new RegExp(`^[\\w.-]*${KEY_NAMES}$`, 'i');

/**
 * Deep-redacts any value: strings are scrubbed; object keys that name a secret
 * have their value masked outright regardless of content; arrays and plain
 * objects are walked. Other types pass through. Returns { value, hits }.
 */
export function redactDeep(value, _seen = new WeakSet()) {
  if (typeof value === 'string') {
    const r = redactWithReport(value);
    return { value: r.text, hits: r.hits };
  }
  if (Array.isArray(value)) {
    let hits = 0;
    const out = value.map(v => { const r = redactDeep(v, _seen); hits += r.hits; return r.value; });
    return { value: out, hits };
  }
  if (value && typeof value === 'object') {
    if (_seen.has(value)) return { value, hits: 0 };
    _seen.add(value);
    if (value instanceof Date || Buffer.isBuffer?.(value)) return { value, hits: 0 };
    let hits = 0;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && v !== null && v !== undefined && v !== '' && typeof v !== 'object') {
        // G4: an already-masked value is left as it is and not counted.
        if (v === MASK) { out[k] = v; } else { out[k] = MASK; hits++; }
      } else {
        const r = redactDeep(v, _seen); hits += r.hits; out[k] = r.value;
      }
    }
    return { value: out, hits };
  }
  return { value, hits: 0 };
}

// Load-time registration: the process's own secrets are always known to it.
registerSecretsFromEnv();
