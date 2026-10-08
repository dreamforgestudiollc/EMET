/**
 * Seed front-matter checker (product note on templates/SEED.md).
 * Trigger kind and status are checked, not merely required.
 */
import { test, summary } from './harness.js';
import assert from 'assert';
import {
  parseTemplate, checkRecord, checkSeedFrontMatter
} from '../src/conformance.js';


const TPL = parseTemplate(`# TEMPLATE — SEED
**Template control:** id \`templates/SEED.md\` · status: IN FORCE · approved: user
## §1 THE IDEA
body
## §2 WHOSE IDEA
body
## §3 WHEN IT FIRES
body
## §4 OPEN QUESTIONS
body
## §5 STATUS LOG
body
## §6 RELATED
body
`, { doc_id: 'templates/SEED.md' });

const BODY = `## §1 THE IDEA
Parked until the date.
## §2 WHOSE IDEA
Assistant-authored; not decided by the user.
## §3 WHEN IT FIRES — WHAT TO DO FIRST
Name it at startup.
## §4 OPEN QUESTIONS
None.
## §5 STATUS LOG
| Date | Status | Evidence |
|---|---|---|
| 2026-09-26 | DORMANT — planted | this revision |
## §6 RELATED
None.
`;

function seed(fm) {
  return `---\n${fm}\n---\n\n# SEED\n\n${BODY}`;
}

const GOOD_FM = `template: templates/SEED.md rev 11
trigger:
  - kind: DATE
    test: 2026-11-01
status: DORMANT
planted: 2026-09-26
planted_by: project-host
session: 2026-09-26_saturday-grok-init`;

test('good front matter has no field failures', () => {
  assert.deepStrictEqual(checkSeedFrontMatter(GOOD_FM), []);
});

test('missing kind fails', () => {
  const f = checkSeedFrontMatter(GOOD_FM.replace(/\ntrigger:[\s\S]*?status/, '\nstatus'));
  assert.ok(f.some((x) => /no trigger kind/.test(x)), JSON.stringify(f));
});

test('illegal kind fails', () => {
  const f = checkSeedFrontMatter(GOOD_FM.replace('kind: DATE', 'kind: SOON'));
  assert.ok(f.some((x) => /SOON/.test(x)), JSON.stringify(f));
});

test('placeholder test fails', () => {
  const f = checkSeedFrontMatter(GOOD_FM.replace('test: 2026-11-01', 'test: __'));
  assert.ok(f.some((x) => /no test/.test(x)), JSON.stringify(f));
});

test('illegal status fails', () => {
  const f = checkSeedFrontMatter(GOOD_FM.replace('status: DORMANT', 'status: WAITING'));
  assert.ok(f.some((x) => /WAITING/.test(x)), JSON.stringify(f));
});

test('shelved without resumes_when fails', () => {
  const f = checkSeedFrontMatter(GOOD_FM.replace('status: DORMANT', 'status: SHELVED'));
  assert.ok(f.some((x) => /resumes_when/.test(x)), JSON.stringify(f));
});

test('a filled seed record conforms', () => {
  const r = checkRecord(seed(GOOD_FM), TPL, { doc_id: 'seeds/example.md' });
  assert.strictEqual(r.failures.length, 0, JSON.stringify(r.failures));
});

test('a seed with a bad kind is nonconforming', () => {
  const r = checkRecord(seed(GOOD_FM.replace('kind: DATE', 'kind: EVENT')), TPL, { doc_id: 'seeds/example.md' });
  assert.ok(r.failures.some((x) => /EVENT/.test(x)), JSON.stringify(r.failures));
});

summary('seed-checker-2026-09-26');
