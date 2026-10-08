/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Throttle for the passphrase form (security audit finding H4, 2026-09-19).
 *
 * The tool-call rate limiter runs inside /mcp, behind bearer auth. Nothing
 * limited POST /oauth/approve, so the one secret that gates every device could
 * be guessed at network speed. This counts FAILED passphrase attempts per
 * client address inside a sliding window and refuses further attempts once
 * the count is reached, until the oldest failure ages out. A correct
 * passphrase clears the address. In memory only: a restart forgets, which is
 * acceptable for a form a person fills in by hand.
 */

export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED = 10000;

export class ApproveThrottle {
  constructor({ maxFailures = DEFAULT_MAX_FAILURES, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.now = now;
    this.failures = new Map(); // ip -> [timestamps of failures inside the window]
  }

  _live(ip) {
    const t = this.now();
    const kept = (this.failures.get(ip) || []).filter((ts) => t - ts < this.windowMs);
    if (kept.length) this.failures.set(ip, kept); else this.failures.delete(ip);
    return kept;
  }

  /** @returns {{allowed: boolean, retryAfterS: number}} */
  check(ip) {
    const kept = this._live(String(ip));
    if (kept.length < this.maxFailures) return { allowed: true, retryAfterS: 0 };
    const retryAfterS = Math.max(1, Math.ceil((kept[0] + this.windowMs - this.now()) / 1000));
    return { allowed: false, retryAfterS };
  }

  recordFailure(ip) {
    const key = String(ip);
    const kept = this._live(key);
    kept.push(this.now());
    this.failures.set(key, kept);
    if (this.failures.size > MAX_TRACKED) this.failures.delete(this.failures.keys().next().value);
  }

  recordSuccess(ip) { this.failures.delete(String(ip)); }
}
