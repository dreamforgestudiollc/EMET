/**
 * EMET - secret redaction tests.
 *
 * The regression these guard against is a secret reaching the store. The
 * scrubber lives inside the write path, so what is tested here is the scrubber
 * itself: that known secret shapes are masked, that the mask is visible, and
 * that the things it must NOT touch (digests, ids, prose) survive intact.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import {
  MASK, redactText, redactWithReport, redactDeep,
  registerSecret, registerSecretsFromEnv, registeredSecretCount, _clearRegisteredSecrets
} from '../src/redact.js';



_clearRegisteredSecrets();

testGroup('Registered literal secrets', () => {
  test('a registered value is masked wherever it appears', () => {
    registerSecret('Xy7!qwErTy#42');
    const out = redactText('the passphrase Xy7!qwErTy#42 was pasted, then Xy7!qwErTy#42 again');
    assert.ok(!out.includes('Xy7!qwErTy#42'));
    assert.strictEqual((out.match(/\*\*\*\*\*/g) || []).length, 2);
  });
  test('values shorter than six characters are refused', () => {
    assert.strictEqual(registerSecret('abc'), false);
    assert.strictEqual(redactText('abc is fine'), 'abc is fine');
  });
  test('registering a URI also registers its password', () => {
    _clearRegisteredSecrets();
    registerSecret('mongodb+srv://user:S3cretP4ss@cluster.example.net/?x=1');
    const out = redactText('the password is S3cretP4ss');
    assert.ok(!out.includes('S3cretP4ss'));
  });
  test('registerSecretsFromEnv picks up secret-bearing names only', () => {
    _clearRegisteredSecrets();
    const n = registerSecretsFromEnv({
      EMET_OAUTH_PASSPHRASE: 'p4ssPhr4se!', MONGODB_URI: 'mongodb://u:pw123456@h/db',
      EMET_SOURCE_TAG: 'cloud-host', PORT: '8080', SHORT_TOKEN: 'ab'
    });
    assert.strictEqual(n, 2);
    assert.ok(registeredSecretCount() >= 3); // passphrase, uri, uri password
    assert.ok(!redactText('tag p4ssPhr4se! pw123456').includes('p4ssPhr4se!'));
    assert.strictEqual(redactText('tag cloud-host'), 'tag cloud-host');
  });
  test('the longest literal wins when one contains another', () => {
    _clearRegisteredSecrets();
    registerSecret('secret-part');
    registerSecret('secret-part-longer');
    assert.strictEqual(redactText('x secret-part-longer y'), `x ${MASK} y`);
  });
});

_clearRegisteredSecrets();

testGroup('Pattern rules', () => {
  test('URI credentials are masked, host and path survive', () => {
    // Fixtures in this repository label themselves as fake, deliberately. This one
    // did not, and carried a real-shaped Atlas hostname and a random password -
    // replaced 2026-09-13. A credential is never fixed by deleting it from the head
    // of a branch; it is fixed by rotating it, because the history remains readable.
    const out = redactText('mongodb+srv://emet_example:notarealpassword0000@cluster0.example.mongodb.net/?authSource=admin');
    assert.strictEqual(out, `mongodb+srv://${MASK}:${MASK}@cluster0.example.mongodb.net/?authSource=admin`);
  });
  test('a URI without credentials is untouched', () => {
    const u = 'https://emet.example.up.railway.app/mcp';
    assert.strictEqual(redactText(u), u);
  });
  test('Bearer tokens are masked', () => {
    assert.strictEqual(redactText('Authorization: Bearer abcDEF123456789xyz'), `Authorization: Bearer ${MASK}`);
  });
  test('JWTs are masked', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    assert.strictEqual(redactText(`token ${jwt} end`), `token ${MASK} end`);
  });
  test('key: value masks the value and keeps the key', () => {
    assert.strictEqual(redactText('passphrase: example-Passphrase-123!'), `passphrase: ${MASK}`);
    assert.strictEqual(redactText('EMET_OAUTH_PASSPHRASE=hunter22'), `EMET_OAUTH_PASSPHRASE=${MASK}`);
    assert.strictEqual(redactText('"client_secret": "abcd1234"'), `"client_secret": "${MASK}"`);
    assert.strictEqual(redactText('api_key = sk-live-0000'), `api_key = ${MASK}`);
  });
  test('the hit count is exact', () => {
    const r = redactWithReport('password: one1234 and token: two2345 and Bearer zzzzzzzzzz');
    assert.strictEqual(r.hits, 3);
  });
});

// G4 / G5 (2026-09-07): the receipt's `redacted` misled four times in
// one day. Every document touch re-reported the masks the document already held,
// and a hyphenated English prefix turned "re-authorization:" into a key.
testGroup('G4: a hit is a change - already-masked text is left alone and not counted', () => {
  test('passphrase: ***** is matched, unchanged, and counts zero', () => {
    const s = `passphrase: ${MASK}`;
    assert.deepStrictEqual(redactWithReport(s), { text: s, hits: 0 });
  });
  test('scrubbing twice is idempotent in text AND in count', () => {
    const first = redactWithReport('EMET_OAUTH_PASSPHRASE=hunter22 and "client_secret": "abcd1234"');
    assert.strictEqual(first.hits, 2);
    const second = redactWithReport(first.text);
    assert.strictEqual(second.text, first.text);
    assert.strictEqual(second.hits, 0);
  });
  test('the STATE line of 2026-09-07 morning: once masked, a re-write reports zero', () => {
    const line = `Passphrase: ${MASK} chose NOT to rotate; the door masks the value.`;
    assert.deepStrictEqual(redactWithReport(line), { text: line, hits: 0 });
  });
  test('a new secret beside an old mask counts exactly one', () => {
    const r = redactWithReport(`passphrase: ${MASK} and later token: freshValue9`);
    assert.strictEqual(r.hits, 1);
    assert.strictEqual(r.text, `passphrase: ${MASK} and later token: ${MASK}`);
  });
  test('redactDeep leaves an already-masked secret-named value alone, uncounted', () => {
    const r = redactDeep({ client_secret: MASK, refresh_token: 'realvalue' });
    assert.strictEqual(r.value.client_secret, MASK);
    assert.strictEqual(r.value.refresh_token, MASK);
    assert.strictEqual(r.hits, 1);
  });
});

testGroup('G5: a hyphenated English prefix does not make a key', () => {
  test('the §32 sentence survives: "re-authorization: no passphrase prompt" is prose', () => {
    const p = 'the refresh is a tool-list operation, not a re-authorization: zero passphrase prompt, no consent screen';
    assert.deepStrictEqual(redactWithReport(p), { text: p, hits: 0 });
  });
  test('pre-, de-, un-, non- likewise', () => {
    for (const s of ['pre-token: warmup', 'de-authorization: cleared', 'un-secret: public', 'non-password: nothing']) {
      assert.strictEqual(redactWithReport(s).hits, 0, s);
    }
  });
  test('real hyphenated header names still mask', () => {
    assert.strictEqual(redactText('x-api-key: sk-live-0000'), `x-api-key: ${MASK}`);
    assert.strictEqual(redactText('x-access-token = abcd1234'), `x-access-token = ${MASK}`);
    assert.strictEqual(redactText('Authorization: Bearer abcDEF123456789xyz'), `Authorization: Bearer ${MASK}`);
  });
  test('G6: the value stops at a backtick and keeps a trailing period or parenthesis', () => {
    assert.strictEqual(redactText('see `passphrase: hunter22`.'), `see \`passphrase: ${MASK}\`.`);
    assert.strictEqual(redactText('(password: hunter22).'), `(password: ${MASK}).`);
    assert.strictEqual(redactText('token: abcd1234. Next sentence.'), `token: ${MASK}. Next sentence.`);
  });
  test('G6: already-masked text with trailing punctuation is idempotent and uncounted', () => {
    const s = `the line \`Passphrase: ${MASK}\`. stood.`;
    assert.deepStrictEqual(redactWithReport(s), { text: s, hits: 0 });
  });
  test('G6: a value with an interior period is still masked whole', () => {
    assert.strictEqual(redactText('secret: ab.cd.ef99'), `secret: ${MASK}`);
    assert.strictEqual(redactText('passphrase: example-Passphrase-123!'), `passphrase: ${MASK}`);
  });
  test('the accepted cost stands: a bare "Passphrase: Word" in prose still masks the word', () => {
    // Documented in the module header. Masking a word costs a word; missing a secret costs the secret.
    assert.strictEqual(redactText('Passphrase: unchanged since the last review'), `Passphrase: ${MASK} since the last review`);
  });
});

testGroup('What must survive', () => {
  test('sha256 digests are not masked', () => {
    const d = 'sha256 cea5142b4791bc01e04626883d088db08483b5de51bf682ac17dbef49a82a93a';
    assert.strictEqual(redactText(d), d);
  });
  test('prose that merely mentions a secret is untouched', () => {
    const p = 'the passphrase was pasted into chat; rotation offered. Token exchange succeeded.';
    assert.strictEqual(redactText(p), p);
  });
  test('ids, timestamps and urls survive', () => {
    const s = 'an incident record at 1788796792 via https://claude.ai/oauth/mcp-oauth-client-metadata';
    assert.strictEqual(redactText(s), s);
  });
  test('non-strings pass through with zero hits', () => {
    assert.deepStrictEqual(redactWithReport(42), { text: 42, hits: 0 });
    assert.deepStrictEqual(redactWithReport(null), { text: null, hits: 0 });
  });
});

testGroup('Deep redaction', () => {
  test('secret-named keys are masked regardless of value shape', () => {
    const r = redactDeep({ client_secret: 'x', note: 'ok', nested: { refresh_token: 'abc', keep: 1 } });
    assert.strictEqual(r.value.client_secret, MASK);
    assert.strictEqual(r.value.nested.refresh_token, MASK);
    assert.strictEqual(r.value.nested.keep, 1);
    assert.strictEqual(r.value.note, 'ok');
    assert.strictEqual(r.hits, 2);
  });
  test('strings inside arrays and objects are scrubbed', () => {
    const r = redactDeep({ exchanges: [{ user_message: 'use Bearer abcdefghijklmnop please' }] });
    assert.strictEqual(r.value.exchanges[0].user_message, `use Bearer ${MASK} please`);
    assert.strictEqual(r.hits, 1);
  });
  test('null and empty secret-named values are left alone (absence stays visible)', () => {
    const r = redactDeep({ token: null, secret: '' });
    assert.strictEqual(r.value.token, null);
    assert.strictEqual(r.value.secret, '');
    assert.strictEqual(r.hits, 0);
  });
  test('Dates survive as Dates', () => {
    const d = new Date();
    assert.strictEqual(redactDeep({ when: d }).value.when, d);
  });
});

summary('Redaction Test Summary');
