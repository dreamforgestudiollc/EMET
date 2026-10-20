/**
 * CORE TOUCH. Reviewers: this suite is the one that covers a change in core.
 *
 * src/setup.js asks one optional first-run question, bot_team_backup, and
 * stores the yes/no flag on bootstrap/USER.md. src/tools.js exposes that
 * optional answer on emet_setup_complete. There is no backup scheduler, no
 * secret store, and no code that copies a bot prompt. The recipe lives in
 * gems/bot-team-backup/.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeStore, withStore } from './memstore.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
const { parseBotTeamBackup, setupBegin, setupComplete, ENV_FILE } = await import('../src/setup.js');
const { checkGem } = await import('../src/gem-check.js');
const { hostTools } = await import('../src/tools.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANSWERS = { assistant_name: 'Ada', assistant_character: 'Plain.', user_name: 'Sam Example', user_context: 'A shared memory.', more_than_one_bot: 'no' };
const docOf = (s, id) => (s.cols.get('documents') ? s.cols.get('documents').docs.find((d) => d.doc_id === id) : null);

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-bot-team-'));
  return path.join(dir, '.env');
}

testGroup('bot-team backup is one optional recorded answer', () => {
  test('the question is optional, last, and recommends yes', async () => {
    const begin = await withStore(makeStore(), () => setupBegin());
    const keys = begin.questions.map((item) => item.key);
    assert.strictEqual(keys[keys.length - 1], 'bot_team_backup');
    const q = begin.questions[begin.questions.length - 1];
    assert.strictEqual(q.required, false);
    assert.match(q.ask, /Yes is the recommended choice/);
    assert.match(q.ask, /off unless you say yes/);
    assert.match(begin.instructions, /bot_team_backup is optional/);
    assert.match(begin.instructions, /Yes is the recommended choice/);
  });

  test('Yes and Yes. parse like the multi-bot question; anything else is refused', () => {
    assert.strictEqual(parseBotTeamBackup('yes'), true);
    assert.strictEqual(parseBotTeamBackup('Yes'), true);
    assert.strictEqual(parseBotTeamBackup('Yes.'), true);
    assert.strictEqual(parseBotTeamBackup('YES'), true);
    assert.strictEqual(parseBotTeamBackup(' yes '), true);
    assert.strictEqual(parseBotTeamBackup('y'), true);
    assert.strictEqual(parseBotTeamBackup('no'), false);
    assert.strictEqual(parseBotTeamBackup('No.'), false);
    assert.strictEqual(parseBotTeamBackup(''), false);
    assert.strictEqual(parseBotTeamBackup('   '), false);
    assert.strictEqual(parseBotTeamBackup(undefined), false);
    assert.strictEqual(parseBotTeamBackup(null), false);
    assert.strictEqual(parseBotTeamBackup('maybe'), null);
    assert.strictEqual(parseBotTeamBackup('yeah'), null);
    assert.strictEqual(parseBotTeamBackup(true), null);
    assert.strictEqual(parseBotTeamBackup(false), null);
    assert.strictEqual(parseBotTeamBackup(['yes']), null);
  });

  test('yes records the flag and does not copy a bot or write a secret', async () => {
    const envFile = tempEnv();
    const s = makeStore();
    const done = await withStore(s, () => setupComplete({ ...ANSWERS, bot_team_backup: 'yes' }, null, { envFile }));
    assert.strictEqual(done.bot_team_backup, true);
    assert.match(done.next_step, /gems\/bot-team-backup\/guides\/BOT_TEAM_BACKUP\.md/);
    assert.match(done.next_step, /never store secret values/i);
    const user = docOf(s, 'bootstrap/USER.md').content;
    assert.match(user, /## §4 BOT-TEAM BACKUP\nyes\n/);
    assert.ok(!fs.existsSync(envFile));
    assert.ok(!fs.existsSync(ENV_FILE) || !fs.readFileSync(ENV_FILE, 'utf8').includes('bot-team'));
    const ids = s.cols.get('documents').docs.map((d) => d.doc_id);
    assert.ok(ids.every((id) => !id.startsWith('bot-team/')));
    assert.ok(!/sk-[A-Za-z0-9]{16,}|password\s*[:=]\s*\S{8,}/i.test(user));
  });

  test('no and an absent answer both record no', async () => {
    for (const extra of [{ bot_team_backup: 'no' }, {}]) {
      const s = makeStore();
      const done = await withStore(s, () => setupComplete({ ...ANSWERS, ...extra }));
      assert.strictEqual(done.bot_team_backup, false);
      assert.match(done.next_step, /Bot-team backup stays off/);
      assert.match(docOf(s, 'bootstrap/USER.md').content, /## §4 BOT-TEAM BACKUP\nno\n/);
    }
  });

  test('Yes and Yes. record the flag before any other write', async () => {
    for (const bot_team_backup of ['Yes', 'Yes.']) {
      const s = makeStore();
      const done = await withStore(s, () => setupComplete({ ...ANSWERS, bot_team_backup }));
      assert.strictEqual(done.bot_team_backup, true);
      assert.match(docOf(s, 'bootstrap/USER.md').content, /## §4 BOT-TEAM BACKUP\nyes\n/);
    }
  });

  test('anything else writes nothing', async () => {
    for (const bot_team_backup of ['maybe', 'yeah', true, ['yes']]) {
      const s = makeStore();
      await assert.rejects(
        () => withStore(s, () => setupComplete({ ...ANSWERS, bot_team_backup })),
        (e) => e.field === 'bot_team_backup' && /Nothing was written/.test(e.message) && /Yes is the recommended choice/.test(e.message)
      );
      assert.deepStrictEqual(s.writes, []);
      assert.ok(!docOf(s, 'bootstrap/USER.md'));
    }
  });

  test('emet_setup_complete still declares bot_team_backup as a string', () => {
    const tool = hostTools().find((row) => row.name === 'emet_setup_complete');
    const prop = tool.inputSchema.properties.answers.properties.bot_team_backup;
    assert.ok(prop, 'bot_team_backup dropped from emet_setup_complete');
    assert.strictEqual(prop.type, 'string');
    const source = fs.readFileSync(path.join(ROOT, 'src/tools.js'), 'utf8');
    assert.match(source, /bot_team_backup:\s*\{\s*type:\s*"string"/);
  });

  test('the bundled add-on passes gem-check and stays off', async () => {
    const report = await checkGem(path.join(ROOT, 'gems', 'bot-team-backup'));
    assert.strictEqual(report.exitCode, 0, (report.lines || []).join('\n'));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'gems', 'bot-team-backup', 'gem.json'), 'utf8'));
    assert.strictEqual(manifest.defaultOn, false);
    assert.strictEqual(manifest.released, true);
    assert.deepStrictEqual(manifest.runes, []);
  });
});

summary('BOT-TEAM BACKUP TEST SUMMARY');
