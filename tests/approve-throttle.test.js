/**
 * EMET - passphrase-form throttle tests (security audit H4, 2026-09-19).
 * Pure: a fake clock, no network, no database.
 */
import { test, summary } from './harness.js';
import assert from 'assert';
import { ApproveThrottle } from '../src/approve-throttle.js';


function clock(start = 1_000_000) { let t = start; return { now: () => t, tick: (ms) => { t += ms; } }; }

console.log('\n=== ApproveThrottle ===');

test('a fresh address is allowed', () => {
  const c = clock(); const th = new ApproveThrottle({ maxFailures: 3, windowMs: 1000, now: c.now });
  assert.deepStrictEqual(th.check('1.1.1.1'), { allowed: true, retryAfterS: 0 });
});

test('the Nth failure inside the window blocks the address, with a Retry-After', () => {
  const c = clock(); const th = new ApproveThrottle({ maxFailures: 3, windowMs: 60_000, now: c.now });
  th.recordFailure('1.1.1.1'); th.recordFailure('1.1.1.1');
  assert.strictEqual(th.check('1.1.1.1').allowed, true, 'two failures still allowed');
  th.recordFailure('1.1.1.1');
  const r = th.check('1.1.1.1');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.retryAfterS, 60);
});

test('the block lifts when the oldest failure ages out of the window', () => {
  const c = clock(); const th = new ApproveThrottle({ maxFailures: 3, windowMs: 60_000, now: c.now });
  th.recordFailure('a'); c.tick(10_000); th.recordFailure('a'); th.recordFailure('a');
  assert.strictEqual(th.check('a').allowed, false);
  c.tick(50_001);
  assert.strictEqual(th.check('a').allowed, true, 'first failure is now outside the window');
});

test('a correct passphrase clears the address', () => {
  const c = clock(); const th = new ApproveThrottle({ maxFailures: 2, windowMs: 60_000, now: c.now });
  th.recordFailure('b'); th.recordFailure('b');
  assert.strictEqual(th.check('b').allowed, false);
  th.recordSuccess('b');
  assert.strictEqual(th.check('b').allowed, true);
});

test('addresses are counted separately', () => {
  const c = clock(); const th = new ApproveThrottle({ maxFailures: 1, windowMs: 60_000, now: c.now });
  th.recordFailure('x');
  assert.strictEqual(th.check('x').allowed, false);
  assert.strictEqual(th.check('y').allowed, true);
});

test('defaults are five failures in fifteen minutes', () => {
  const th = new ApproveThrottle();
  assert.strictEqual(th.maxFailures, 5);
  assert.strictEqual(th.windowMs, 15 * 60 * 1000);
});

summary('Approve Throttle Test Summary');
