/**
 * EMET - bot roster, bot handoff template and bot registration (2026-10-01).
 *
 * The owner: "update EMET to recognize the bot tags and update
 * templates and such as necessary for it to be fully functional";
 * a bot roster template and a setup reference. No production code changes:
 * a tag is a bot tag only when bots/<tag>/HANDOFF.md is in EMET_RECORD_DOCS
 * (session-graph.js isBotTag), so these tests pin (1) that the configured
 * value used on the reference deploy makes the five non-hub bots bots and
 * leaves the hub a host, and (2) that the two new forms ship, parse, are
 * DRAFT (so a mapped bot handoff gets no marker and adds no nonconformance
 * backlog), and that a filled record of each conforms to its own form.
 * No database: settings and pure functions over text.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadShipped, clearShippedCache, checkRecord, validateDocument, templateFor,
  isGovernedByShippedCopy, countPlaceholders, STATUS, VERDICT
} from '../src/conformance.js';
import { isBotTag, mainRecordIds } from '../src/session-graph.js';
import { refuseBotMainRecord, isRecordDoc } from '../src/tools.js';
import { privateWordsIn } from './scrub-tokens.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BOTS = ['tester-bot', 'intake-bot', 'reviewer-bot', 'memory-bot', 'research-bot'];
const HUB = 'hub-bot';
// The exact value set on the reference deploy, 2026-10-01 (four bots, then a fifth).
const RECORD_DOCS = BOTS.map((t) => `bots/${t}/HANDOFF.md`).join(',');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const CLEAN = { EMET_RECORD_DOCS: undefined, CASCADE_RECORD_DOCS: undefined, EMET_SOURCE_TAG: undefined, CASCADE_SOURCE_TAG: undefined,
  EMET_HANDOFF_DOC: undefined, EMET_STATE_DOC: undefined, EMET_TEMPLATE_MAP: undefined, CASCADE_TEMPLATE_MAP: undefined };

console.log('\n=== Bot roster, bot handoff template, bot registration ===');

testGroup('the configured value: five bots are bots, the hub stays a host', () => {
  const env = { ...CLEAN, EMET_RECORD_DOCS: RECORD_DOCS };
  test('each of the five listed tags is a bot tag', () => withEnv(env, () => {
    for (const t of BOTS) assert.strictEqual(isBotTag(t), true, t);
  }));
  test('the hub tag and host tags are not bot tags', () => withEnv(env, () => {
    for (const t of [HUB, 'project-host', 'mobile', 'cli', 'unspecified']) assert.strictEqual(isBotTag(t), false, t);
  }));
  test('unset, no tag is a bot tag (the state the second reader found live)', () => withEnv(CLEAN, () => {
    for (const t of BOTS) assert.strictEqual(isBotTag(t), false, t);
  }));
  test('the legacy CASCADE_ name is hidden once the EMET_ name is set', () => withEnv({ ...env, CASCADE_RECORD_DOCS: 'bots/other-bot/HANDOFF.md' }, () => {
    assert.strictEqual(isBotTag('other-bot'), false);
    assert.strictEqual(isBotTag('tester-bot'), true);
  }));
  test('a bot tag is refused both main records; the hub is not', () => withEnv(env, () => {
    for (const t of BOTS) for (const id of mainRecordIds()) {
      assert.throws(() => refuseBotMainRecord(id, t, 'write_doc'), /is a main record and .* is a bot tag/, `${t} ${id}`);
    }
    for (const id of mainRecordIds()) assert.doesNotThrow(() => refuseBotMainRecord(id, HUB, 'write_doc'));
  }));
  test('a bot may write its own handoff, and it is a record (supersede-only after v1)', () => withEnv(env, () => {
    for (const t of BOTS) {
      assert.doesNotThrow(() => refuseBotMainRecord(`bots/${t}/HANDOFF.md`, t, 'write_doc'));
      assert.strictEqual(isRecordDoc(`bots/${t}/HANDOFF.md`), true, t);
    }
  }));
  test('listing the bots does not make the board a record (hub patch_doc on STATE.md unchanged)', () => withEnv(env, () => {
    assert.strictEqual(isRecordDoc('STATE.md'), false);
    assert.strictEqual(isRecordDoc('HANDOFF.md'), true);
  }));
  test('a stray space or leading ./ in the value: spaces are trimmed, ./ is not a match', () => {
    withEnv({ ...CLEAN, EMET_RECORD_DOCS: ' bots/tester-bot/HANDOFF.md , ./bots/intake-bot/HANDOFF.md' }, () => {
      assert.strictEqual(isBotTag('tester-bot'), true);
      assert.strictEqual(isBotTag('intake-bot'), false);
    });
  });
});

const BOT_HANDOFF_FILLED = `# example-bot — HANDOFF

## §0 RECORD CONTROL
- Template: \`templates/BOTHANDOFF.md\` rev 1 · Handoff revision: v1 · Supersedes: none — first revision
- Session id: 2026-10-01_example-bot-check · Source tag: example-bot · Bot: Example (roster row in \`bots/ROSTER.md\`)
- Host / interface: example host · Machine: example machine · Written (local): 2026-10-01 9:15 AM
- **Scope of this session, one line:** one read-only check, reported to the hub.

## §1 START HERE
- **The bot's next first action:** Wait for the hub's next brief.
- **Left open for the hub:** None — checked against this session's messages to the hub.
- **Why this session stopped:** finished

## §2 DONE THIS SESSION
| What | Evidence (commit, document revision, record id, receipt) |
|---|---|
| Ran the check | episodic 1 |

## §3 HANDED TO THE HUB
| Item (finding, question, draft, verdict) | Sent (local time) | Hub's reply or decision relayed, with the user's words where given |
|---|---|---|
| Verdict: pass | 9:14 AM | acknowledged |

## §4 ERRORS AND CORRECTIONS THIS SESSION
None identified this session.

## §5 CLOSE VERIFICATION
| Artifact | Done | Evidence |
|---|---|---|
| Working documents this session changed | N-A (none changed) | working_docs: [] |
| Session record in memory, written with session_id | Y | episodic 1, verified |
| Verbatim transcript, including the append after the save | Y | 2026-10-01_example-bot-check, part 1, exchange 2 |
| Main records untouched | Y | HANDOFF.md v5, STATE.md v9, same before and after |
| This handoff | Y | v1, written last |
`;

const ROSTER_FILLED = `# BOT ROSTER

## §0 RECORD CONTROL
- Template: \`templates/ROSTER.md\` rev 1 · Roster revision: the store's version governs
- Owner (the user): the user · Kept by (the hub): hub-example · Last updated: 2026-10-01 9:15 AM (local) · Session id: 2026-10-01_roster · Source tag: hub-example
- **What changed in this revision, one line:** first revision.

## §1 BOTS
| Tag | Name | Role | Host | Machine | Handoff doc | Tool profile | Owner | Status | Registered (SOURCE_TAGS · RECORD_DOCS) |
|---|---|---|---|---|---|---|---|---|---|
| example-bot | Example | tester | example host | example machine | \`bots/example-bot/HANDOFF.md\` | bot (provisional) | the user | PILOT | Y · Y |

## §2 HUB — host-level, never a bot
| Tag | Name | Host | Machine | Records it writes | Listed in RECORD_DOCS |
|---|---|---|---|---|---|
| hub-example | Hub | example host | example machine | \`HANDOFF.md\`, \`STATE.md\` | No — never |

## §3 CONFIGURATION READ-BACK
- Read (local): 2026-10-01 9:15 AM · Deployment: example · Read by: hub-example
- \`EMET_RECORD_DOCS\` bot entries: bots/example-bot/HANDOFF.md
- \`EMET_SOURCE_TAGS\` bot and hub entries: example-bot, hub-example
- **Agreement:** Y

## §4 CHANGE LOG
| Date (local) | Change (added · retired · role · profile) | User's words, verbatim | Decision record |
|---|---|---|---|
| 2026-10-01 | added example-bot | "add it" | procedural 1 |
`;

testGroup('the two new forms ship and are DRAFT', () => {
  clearShippedCache();
  for (const id of ['templates/BOTHANDOFF.md', 'templates/ROSTER.md']) {
    test(`${id} ships, names itself, is DRAFT and not IN FORCE`, () => {
      const t = loadShipped(id, { cache: false });
      assert.ok(t, `${id} is not in the release`);
      assert.strictEqual(t.template_id, id);
      assert.strictEqual(t.status, STATUS.DRAFT, `${id} status is ${t.status}`);
    });
    test(`${id} declares its sections and carries placeholders to fill`, () => {
      const t = loadShipped(id, { cache: false });
      assert.ok(t.required_sections.length >= 5, `${id}: ${t.required_sections.length} sections`);
      assert.strictEqual(t.required_sections[0].num, '0');
      assert.ok(t.placeholder_count > 0);
    });
    test(`${id} is under the shipped-copy lock (L1)`, () => assert.strictEqual(isGovernedByShippedCopy(id), true));
  }
  test('the bot handoff form asks for no board', () => {
    const t = loadShipped('templates/BOTHANDOFF.md', { cache: false });
    assert.ok(!t.required_sections.some((s) => /BOARD/.test(s.title)), 'a bot keeps no board');
  });
});

testGroup('filled records conform to their own form', () => {
  test('a filled bot handoff passes the bot handoff form', () => {
    const r = checkRecord(BOT_HANDOFF_FILLED, loadShipped('templates/BOTHANDOFF.md', { cache: false }));
    assert.deepStrictEqual(r.failures, []);
    assert.strictEqual(countPlaceholders(BOT_HANDOFF_FILLED), 0);
  });
  test('the same bot handoff fails the hub form (why bot handoffs are not mapped to it)', () => {
    const r = checkRecord(BOT_HANDOFF_FILLED, loadShipped('templates/HANDOFF.md', { cache: false }));
    assert.ok(r.failures.length > 0);
  });
  test('a bot handoff missing its close verification fails', () => {
    const cut = BOT_HANDOFF_FILLED.slice(0, BOT_HANDOFF_FILLED.indexOf('## §5'));
    const r = checkRecord(cut, loadShipped('templates/BOTHANDOFF.md', { cache: false }));
    assert.ok(r.failures.some((f) => /§5/.test(f)), r.failures.join('; '));
  });
  test('a filled roster passes the roster form', () => {
    const r = checkRecord(ROSTER_FILLED, loadShipped('templates/ROSTER.md', { cache: false }));
    assert.deepStrictEqual(r.failures, []);
  });
});

testGroup('no nonconformance backlog: unmapped, or mapped to a DRAFT form', () => {
  test('with EMET_TEMPLATE_MAP unchanged, a bot handoff and the roster are untemplated', () => withEnv(CLEAN, () => {
    assert.strictEqual(templateFor('bots/tester-bot/HANDOFF.md'), null);
    assert.strictEqual(templateFor('bots/ROSTER.md'), null);
    assert.strictEqual(validateDocument('bots/tester-bot/HANDOFF.md', 'anything').verdict, VERDICT.UNTEMPLATED);
  }));
  test('mapped to the DRAFT bot handoff form, a short bot handoff is checked but not marked', () => withEnv(
    { ...CLEAN, EMET_TEMPLATE_MAP: 'bots/tester-bot/HANDOFF.md=templates/BOTHANDOFF.md' }, () => {
      const v = validateDocument('bots/tester-bot/HANDOFF.md', 'a short note with no sections');
      assert.strictEqual(v.verdict, VERDICT.UNGATED, JSON.stringify(v));
    }));
});

testGroup('the setup reference is linked where setup is described', () => {
  test('docs/BOTS.md ships with a document control line', () => assert.match(read('docs/BOTS.md'), /^\*\*Document control:\*\* id `docs\/BOTS\.md`/m));
  test('README links it', () => assert.match(read('README.md'), /\(docs\/BOTS\.md\)/));
  test('GUIDED-SETUP links it', () => assert.match(read('docs/GUIDED-SETUP.md'), /\(BOTS\.md\)/));
  test('DEPLOY links it and no longer maps bot handoffs to the hub form', () => {
    const d = read('docs/DEPLOY.md');
    assert.match(d, /\(BOTS\.md\)/);
    assert.ok(!d.includes('=templates/HANDOFF.md'), 'DEPLOY still suggests the hub form for bot handoffs');
  });
  test('the register lists both new forms', () => {
    const i = read('templates/INDEX.md');
    assert.match(i, /`templates\/BOTHANDOFF\.md`/);
    assert.match(i, /`templates\/ROSTER\.md`/);
  });
  test('BOTS.md: the refused-write check runs only once HANDOFF.md exists (review C-1)', () => {
    assert.match(read('docs/BOTS.md'), /only once `HANDOFF\.md` exists/);
  });
  test('BOTS.md: refusals cover listed tags only; both variables in one change (review C-3)', () => {
    const b = read('docs/BOTS.md');
    assert.match(b, /only for tags listed in `EMET_RECORD_DOCS`/);
    assert.match(b, /misspelled tag is treated as a host/);
    assert.match(b, /set `EMET_SOURCE_TAGS` and `EMET_RECORD_DOCS` together/);
  });
  test('BOTS.md §5 states the C-3 limit in bold: "These refusals cover listed tags only." (review nit D3a)', () => {
    const b = read('docs/BOTS.md');
    const s5 = b.slice(b.indexOf('\n## 5.'), b.indexOf('\n## 6.'));
    assert.ok(s5.length > 0, 'BOTS.md §5 not found');
    assert.match(s5, /\*\*These refusals cover listed tags only\.\*\*/);
  });
  test('BOTS.md after the bot guards: no stale "can write the main records" for unlisted tags; guards off without a registry', () => {
    const b = read('docs/BOTS.md');
    assert.ok(!/treated as a host: it is not refused, and it can write the main records/.test(b));
    assert.ok(!/treated as a host and can write the main records/.test(b));
    assert.match(b, /refuse any tag not registered there, a missing source included/);
    assert.match(b, /With `EMET_SOURCE_TAGS` unset, neither guard applies; both are opt-in/);
    assert.match(b, /a registered tag that is not listed as a bot can still write the main records and any bot's folder/);
    assert.match(b, /The hub's tag must be in `EMET_SOURCE_TAGS`/);
  });
  test('BOTS.md carries the name-every-write rule (a decision record)', () => {
    const b = read('docs/BOTS.md');
    assert.match(b, /\*\*Name every write attempt\.\*\*/);
    assert.match(b, /a write not on it, a retry, or a write after the close is a finding/);
  });
  test('BOTS.md uses generic example tags', () => assert.deepStrictEqual(privateWordsIn(read('docs/BOTS.md')), []));
  test('the bot handoff form can record a main-record breach (Y / N)', () => {
    assert.match(read('templates/BOTHANDOFF.md'), /\| Main records untouched \| Y \/ N/);
  });
  test('the shipped forms carry no install-specific bot names', () => {
    for (const f of ['templates/ROSTER.md', 'templates/BOTHANDOFF.md']) {
      assert.deepStrictEqual(privateWordsIn(read(f)), [], f);
    }
  });
});

summary();
