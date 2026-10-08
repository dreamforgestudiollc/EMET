/**
 * EMET - the one test harness (2026-09-29, test-tree pass).
 *
 * Until this pass every suite carried its own copy of test/testGroup/summary -
 * 34 copies in about six variants (sync, async, queued, two summary formats).
 * A defect fixed in one copy stayed in the other 33, and a new suite started by
 * copying whichever file was nearest. Suites now import from here. This file
 * does not end in .test.js, so the runner never runs it as a suite.
 *
 * Ordering rule, which covers every variant the old copies had:
 *  - A test whose body is synchronous runs the moment it is declared, exactly
 *    as the plain copies did - so a test reads the values in scope at that
 *    point, not values reassigned later.
 *  - A test whose body returns a promise starts a serial chain; every test and
 *    group heading declared while the chain is busy waits its turn, in
 *    declaration order. That is the old queued behaviour (receipt suite): no
 *    two async tests overlap, which matters where a test changes process.env.
 *  - test() returns a promise that settles when that test has finished, so
 *    `await test(...)` works as the async copies did.
 *  - summary() waits for the chain, prints one uniform block, and exits 1 on
 *    any failure. Output lines are unchanged: "  PASS: " / "  FAIL: ".
 */

let passCount = 0;
let failCount = 0;
const failures = [];
let tail = null; // the serial chain, or null when nothing async is pending

function pass(description) { passCount++; console.log(`  PASS: ${description}`); }
function fail(description, error) {
  const message = error && error.message !== undefined ? error.message : String(error);
  failCount++; failures.push({ description, error: message });
  console.log(`  FAIL: ${description}`); console.log(`        ${message}`);
}

let pending = 0;
function enqueue(task) {
  pending++;
  const p = (tail || Promise.resolve()).then(task).finally(() => { pending--; if (pending === 0) tail = null; });
  tail = p;
  return p;
}

function settle(description, result) {
  return Promise.resolve(result).then(() => pass(description), (e) => fail(description, e));
}

/** Declare and run one test. Returns a promise that settles when it is done. */
export function test(description, fn) {
  if (tail) return enqueue(() => { let r; try { r = fn(); } catch (e) { fail(description, e); return; } return settle(description, r); });
  let result;
  try { result = fn(); } catch (e) { fail(description, e); return Promise.resolve(); }
  if (result && typeof result.then === 'function') { const settled = settle(description, result); return enqueue(() => settled); }
  pass(description);
  return Promise.resolve();
}

/** Print a group heading (in order, even behind a busy chain), then register the group's tests. */
export function testGroup(name, fn) {
  const heading = () => console.log(`\n=== ${name} ===`);
  if (tail) enqueue(async () => heading()); else heading();
  return fn ? fn() : undefined;
}

/** Wait for every pending test, print the one summary block, exit 1 on any failure. */
export async function summary(title = 'TEST SUMMARY') {
  while (tail) await tail;
  console.log('\n' + '='.repeat(60)); console.log(title); console.log('='.repeat(60));
  console.log(`Total: ${passCount + failCount}`); console.log(`Passed: ${passCount}`); console.log(`Failed: ${failCount}`);
  if (failCount > 0) { console.log('\nFailures:'); failures.forEach((f) => console.log(`  - ${f.description}: ${f.error}`)); process.exit(1); }
  console.log('\nAll tests passed!');
}

/** Counts so far - for a suite that reports its own sub-totals. */
export function counts() { return { passed: passCount, failed: failCount }; }
