/**
 * First-use setup turns delegated client sub-keys on only when the owner says
 * more than one bot or AI will use the memory, and only when .env is the
 * config source. The running process is not flipped. The pepper is not returned.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeStore, withStore, withEnv } from './memstore.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
const { parseMoreThanOneBot, upsertEnvAssignments, enableSubkeysAtFirstUse, setupBegin, setupComplete, subkeySetupNote, HOSTED_SUBKEY_STEPS, ENV_FILE } = await import('../src/setup.js');
const { redactText } = await import('../src/redact.js');
const { realEnvIsConfigSource, defaultEnvFile } = await import('../src/env.js');

const CLEAN = {
  EMET_SUBKEYS: undefined, EMET_SUBKEY_PEPPER: undefined, EMET_SUBKEY_PEPPER_VERSION: undefined,
  CASCADE_SUBKEYS: undefined, CASCADE_SUBKEY_PEPPER: undefined,
  RAILWAY_ENVIRONMENT: undefined, RAILWAY_PROJECT_ID: undefined, RAILWAY_SERVICE_ID: undefined,
  FLY_APP_NAME: undefined, RENDER: undefined, RENDER_SERVICE_ID: undefined, DYNO: undefined, K_SERVICE: undefined
};
const ANSWERS = { assistant_name: 'Ada', assistant_character: 'Plain.', user_name: 'Sam Example', user_context: 'A shared memory.' };

function tempEnv(body = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-subkey-setup-'));
  const file = path.join(dir, '.env');
  if (body !== null) fs.writeFileSync(file, body);
  return file;
}

function hostedRefusal(error) {
  return error.field === 'more_than_one_bot'
    && /No pepper or \.env was written/.test(error.message)
    && /without yes/.test(error.message)
    && /docs\/SUBKEYS\.md/.test(error.message)
    && /EMET_SUBKEYS=1/.test(error.message)
    && /EMET_SUBKEY_PEPPER_VERSION=1/.test(error.message);
}

/** Restores the default .env if a test writes it. */
async function guardingDefaultEnv(fn) {
  const existed = fs.existsSync(ENV_FILE);
  const before = existed ? fs.readFileSync(ENV_FILE, 'utf8') : null;
  try {
    return await fn();
  } finally {
    if (!existed) {
      if (fs.existsSync(ENV_FILE)) fs.unlinkSync(ENV_FILE);
    } else if (fs.readFileSync(ENV_FILE, 'utf8') !== before) {
      fs.writeFileSync(ENV_FILE, before);
    }
  }
}

function assertNoDefaultEnvWrite(existed, before) {
  if (!existed) assert.equal(fs.existsSync(ENV_FILE), false);
  else assert.strictEqual(fs.readFileSync(ENV_FILE, 'utf8'), before);
  assert.strictEqual(process.env.EMET_SUBKEYS, undefined);
  assert.strictEqual(process.env.EMET_SUBKEY_PEPPER, undefined);
}

console.log('\n=== sub-key first-use setup ===');

testGroup('the interview asks, and only yes or no counts', () => {
  test('more_than_one_bot is optional and is the last question', async () => {
    const begin = await withStore(makeStore(), () => setupBegin());
    const q = begin.questions.find((item) => item.key === 'more_than_one_bot');
    assert.ok(q);
    assert.strictEqual(q.required, false);
    assert.strictEqual(begin.questions[begin.questions.length - 1].key, 'more_than_one_bot');
    assert.match(begin.instructions, /Leaving it out leaves sub-keys off/);
  });
  test('yes and no parse; absent means no; anything else does not', () => {
    assert.strictEqual(parseMoreThanOneBot('yes'), true);
    assert.strictEqual(parseMoreThanOneBot('No.'), false);
    assert.strictEqual(parseMoreThanOneBot(''), false);
    assert.strictEqual(parseMoreThanOneBot(undefined), false);
    assert.strictEqual(parseMoreThanOneBot('maybe'), null);
  });
});

testGroup('a yes writes the flag, a pepper and version 1, and does not return the pepper', () => {
  test('upsert keeps comments, replaces an active line, and appends the rest', () => {
    const out = upsertEnvAssignments('# EMET_SUBKEYS=1\nEMET_SUBKEYS=0\nMONGODB_DB=emet\n', {
      EMET_SUBKEYS: '1',
      EMET_SUBKEY_PEPPER: 'pepper-value-pepper-value-pepper-32',
      EMET_SUBKEY_PEPPER_VERSION: '1'
    });
    assert.match(out, /^# EMET_SUBKEYS=1$/m);
    assert.match(out, /^EMET_SUBKEYS=1$/m);
    assert.ok(!out.includes('EMET_SUBKEYS=0'));
    assert.match(out, /^MONGODB_DB=emet$/m);
    assert.match(out, /^EMET_SUBKEY_PEPPER=pepper-value-pepper-value-pepper-32$/m);
    assert.match(out, /^EMET_SUBKEY_PEPPER_VERSION=1$/m);
  });

  test('yes generates a 32-byte pepper, version 1, mode 0600, and does not flip the process', () => withEnv(CLEAN, () => {
    const file = tempEnv('MONGODB_DB=emet\n');
    const turned = enableSubkeysAtFirstUse({ envFile: file });
    const text = fs.readFileSync(file, 'utf8');
    const pepper = text.match(/^EMET_SUBKEY_PEPPER=(.+)$/m)[1];
    assert.strictEqual(turned.pepper_generated, true);
    assert.strictEqual(turned.pepper_version, 1);
    assert.strictEqual(turned.restart_for_owner_page, true);
    assert.ok(Buffer.byteLength(pepper) >= 32);
    assert.strictEqual(process.env.EMET_SUBKEYS, undefined);
    assert.strictEqual(process.env.EMET_SUBKEY_PEPPER, undefined);
    assert.strictEqual(process.env.EMET_SUBKEY_PEPPER_VERSION, undefined);
    assert.strictEqual((fs.statSync(file).mode & 0o777), 0o600);
    assert.ok(!JSON.stringify(turned).includes(pepper));
    assert.ok(!redactText('leak ' + pepper).includes(pepper));
    assert.match(text, /^EMET_SUBKEYS=1$/m);
  }));

  test('a second yes keeps the pepper', () => withEnv(CLEAN, () => {
    const file = tempEnv('');
    enableSubkeysAtFirstUse({ envFile: file });
    const first = fs.readFileSync(file, 'utf8').match(/^EMET_SUBKEY_PEPPER=(.+)$/m)[1];
    const again = enableSubkeysAtFirstUse({ envFile: file });
    const second = fs.readFileSync(file, 'utf8').match(/^EMET_SUBKEY_PEPPER=(.+)$/m)[1];
    assert.strictEqual(again.pepper_generated, false);
    assert.strictEqual(second, first);
    assert.strictEqual(process.env.EMET_SUBKEYS, undefined);
  }));

  test('a pepper already in the file is kept and not copied into the process', () => withEnv(CLEAN, () => {
    const existing = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const file = tempEnv(`EMET_SUBKEY_PEPPER=${existing}\nEMET_SUBKEY_PEPPER_VERSION=1\n`);
    const turned = enableSubkeysAtFirstUse({ envFile: file });
    assert.strictEqual(turned.pepper_generated, false);
    assert.strictEqual(process.env.EMET_SUBKEY_PEPPER, undefined);
    assert.match(fs.readFileSync(file, 'utf8'), /^EMET_SUBKEYS=1$/m);
    assert.ok(fs.readFileSync(file, 'utf8').includes(existing));
  }));

  test('a platform environment refuses and writes no pepper', () => withEnv({ ...CLEAN, RAILWAY_ENVIRONMENT: 'production' }, () => {
    const file = tempEnv('MONGODB_DB=emet\n');
    assert.throws(() => enableSubkeysAtFirstUse({ envFile: file }), hostedRefusal);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'MONGODB_DB=emet\n');
    assert.strictEqual(process.env.EMET_SUBKEYS, undefined);
    assert.match(HOSTED_SUBKEY_STEPS, /openssl rand -hex 32/);
    assert.match(HOSTED_SUBKEY_STEPS, /No pepper or \.env was written/);
    assert.match(subkeySetupNote(true, { env_error: HOSTED_SUBKEY_STEPS }), /No pepper or \.env was written/);
    assert.match(subkeySetupNote(true, { env_error: HOSTED_SUBKEY_STEPS }), /without yes/);
    assert.match(subkeySetupNote(true, { env_error: HOSTED_SUBKEY_STEPS }), /docs\/SUBKEYS\.md/);
    assert.match(subkeySetupNote(true, { env_error: 'Could not write .env. Sub-keys were not turned on.' }), /could not be written/i);
  }));

  test('a missing directory does not turn the flag on', () => withEnv(CLEAN, () => {
    const file = path.join(os.tmpdir(), 'emet-missing-dir-' + process.pid, 'nope', '.env');
    assert.throws(() => enableSubkeysAtFirstUse({ envFile: file }), /Could not write \.env/);
    assert.strictEqual(process.env.EMET_SUBKEYS, undefined);
  }));
});

testGroup('setupComplete writes .env after the store, and a hosted yes writes nothing', () => {
  test('yes on a new store writes identity first, masks the pepper, and leaves the process off', () => withEnv(CLEAN, async () => {
    const file = tempEnv('MONGODB_DB=emet\n');
    const s = makeStore();
    const done = await withStore(s, () => setupComplete({ ...ANSWERS, more_than_one_bot: 'yes' }, null, { envFile: file }));
    const pepper = fs.readFileSync(file, 'utf8').match(/^EMET_SUBKEY_PEPPER=(.+)$/m)[1];
    const { writeDoc } = await import('../src/tools.js');
    const wrote = await withStore(s, () => writeDoc('notes/pepper-mask.md', 'leak ' + pepper, 'example-host', null, null, { provision: true }));
    const stored = s.cols.get('documents').docs.find((d) => d.doc_id === 'notes/pepper-mask.md');
    const dumped = JSON.stringify(done) + JSON.stringify([...s.cols.values()].map((c) => c.docs));
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.subkeys.enabled, true);
    assert.strictEqual(done.subkeys.pepper_generated, true);
    assert.strictEqual(done.subkeys.pepper_version, 1);
    assert.match(done.next_step, /Restart \(or redeploy\)/);
    assert.match(done.next_step, /EMET_SOURCE_TAGS/);
    assert.match(done.next_step, /docs\/SUBKEYS\.md/);
    assert.ok(!dumped.includes(pepper));
    assert.ok(!JSON.stringify(wrote).includes(pepper));
    assert.ok(stored && !stored.content.includes(pepper));
    assert.ok(s.cols.get('documents').docs.length >= 3);
    assert.strictEqual(process.env.EMET_SUBKEYS, undefined);
  }));

  test('no leaves the flag unset and writes no pepper file lines', () => withEnv(CLEAN, async () => {
    const file = tempEnv('MONGODB_DB=emet\n');
    const before = fs.readFileSync(file, 'utf8');
    const s = makeStore();
    const done = await withStore(s, () => setupComplete({ ...ANSWERS, more_than_one_bot: 'no' }, null, { envFile: file }));
    assert.strictEqual(done.subkeys.enabled, false);
    assert.strictEqual(done.subkeys.turned_on, false);
    assert.match(done.next_step, /stay off/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(process.env.EMET_SUBKEYS, undefined);
  }));

  test('leaving the answer out is the same as no', () => withEnv(CLEAN, async () => {
    const file = tempEnv('MONGODB_DB=emet\n');
    const before = fs.readFileSync(file, 'utf8');
    const s = makeStore();
    const done = await withStore(s, () => setupComplete({ ...ANSWERS }, null, { envFile: file }));
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.subkeys.enabled, false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  }));

  test('a bad answer writes nothing', async () => {
    const s = makeStore();
    await assert.rejects(
      () => withStore(s, () => setupComplete({ ...ANSWERS, more_than_one_bot: 'maybe' })),
      (e) => e.field === 'more_than_one_bot' && /Nothing was written/.test(e.message) && /yes or no/.test(e.message)
    );
    assert.deepStrictEqual(s.writes, []);
  });

  test('a hosted yes writes nothing and names the three variables', () => withEnv({ ...CLEAN, RAILWAY_ENVIRONMENT: 'production' }, async () => {
    const file = tempEnv('MONGODB_DB=emet\n');
    const before = fs.readFileSync(file, 'utf8');
    const s = makeStore();
    await assert.rejects(
      () => withStore(s, () => setupComplete({ ...ANSWERS, more_than_one_bot: 'yes' }, null, { envFile: file })),
      hostedRefusal
    );
    assert.deepStrictEqual(s.writes, []);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    assert.strictEqual(process.env.EMET_SUBKEYS, undefined);
  }));

  test('a hosted yes on a new store writes no documents and no pepper', () => withEnv({ ...CLEAN, RAILWAY_ENVIRONMENT: 'production' }, () => guardingDefaultEnv(async () => {
    const startup = { loaded: true, keys: ['MONGODB_DB'] };
    const existed = fs.existsSync(ENV_FILE);
    const before = existed ? fs.readFileSync(ENV_FILE, 'utf8') : null;
    const s = makeStore();
    assert.strictEqual(s.writes.length, 0);
    await assert.rejects(
      () => withStore(s, () => setupComplete({ ...ANSWERS, more_than_one_bot: 'yes' }, null, { startup })),
      hostedRefusal
    );
    assert.deepStrictEqual(s.writes, []);
    for (const col of s.cols.values()) assert.strictEqual(col.docs.length, 0);
    assertNoDefaultEnvWrite(existed, before);
    assert.strictEqual(path.resolve(ENV_FILE), path.resolve(defaultEnvFile()));
  })));

  test('a startup .env that did not load refuses yes on the default path', () => withEnv(CLEAN, () => guardingDefaultEnv(async () => {
    // keys is non-empty so only the not-loaded check refuses. An empty list would still refuse on the next line.
    const startup = { loaded: false, keys: ['MONGODB_DB'] };
    const existed = fs.existsSync(ENV_FILE);
    const before = existed ? fs.readFileSync(ENV_FILE, 'utf8') : null;
    assert.strictEqual(realEnvIsConfigSource(process.env, startup), true);
    assert.throws(() => enableSubkeysAtFirstUse({ startup }), hostedRefusal);
    const s = makeStore();
    await assert.rejects(
      () => withStore(s, () => setupComplete({ ...ANSWERS, more_than_one_bot: 'yes' }, null, { startup })),
      hostedRefusal
    );
    assert.deepStrictEqual(s.writes, []);
    assertNoDefaultEnvWrite(existed, before);
  })));

  test('a startup .env that loaded no keys refuses yes on the default path', () => withEnv(CLEAN, () => guardingDefaultEnv(async () => {
    const startup = { loaded: true, keys: [] };
    const existed = fs.existsSync(ENV_FILE);
    const before = existed ? fs.readFileSync(ENV_FILE, 'utf8') : null;
    assert.strictEqual(realEnvIsConfigSource(process.env, startup), true);
    assert.throws(() => enableSubkeysAtFirstUse({ startup }), hostedRefusal);
    const s = makeStore();
    await assert.rejects(
      () => withStore(s, () => setupComplete({ ...ANSWERS, more_than_one_bot: 'yes' }, null, { startup })),
      hostedRefusal
    );
    assert.deepStrictEqual(s.writes, []);
    assertNoDefaultEnvWrite(existed, before);
  })));

  test('an unwritable .env is reported after the store writes succeed', () => withEnv(CLEAN, async () => {
    const file = path.join(os.tmpdir(), 'emet-missing-dir-' + process.pid + '-b', 'nope', '.env');
    const s = makeStore();
    const done = await withStore(s, () => setupComplete({ ...ANSWERS, more_than_one_bot: 'yes' }, null, { envFile: file }));
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.subkeys.enabled, false);
    assert.match(done.subkeys.env_error, /Could not write \.env/);
    assert.match(done.next_step, /store is set up/i);
    assert.ok(s.cols.get('documents').docs.length >= 3);
    assert.strictEqual(process.env.EMET_SUBKEYS, undefined);
    assert.equal(fs.existsSync(file), false);
  }));
});

summary();
