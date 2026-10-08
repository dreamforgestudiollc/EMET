/**
 * EMET - the Atlas role is the one statement of what the server may do
 * (2026-09-29). If the code starts deleting from a collection the role does
 * not allow, production would fail on the first delete; this test fails first,
 * so the decision is made in src/atlas-role.js, in the open.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ATLAS_ROLE_NAME, DATABASE_ACTIONS, DELETE_ALLOWED, atlasPrivileges } from '../src/atlas-role.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

testGroup('the role never grants delete on the record', () => {
  test('no database-wide REMOVE or DROP', () => {
    for (const a of ['REMOVE', 'DROP_COLLECTION', 'DROP_DATABASE']) assert.ok(!DATABASE_ACTIONS.includes(a), a);
  });
  test('delete is allowed only on the token and probe collections', () =>
    assert.deepStrictEqual(Object.keys(DELETE_ALLOWED).sort(), ['_emet_verify', '{prefix}oauth_tokens']));
  test('the token collection follows the install prefix', () => {
    assert.ok(atlasPrivileges('mydb', 'abc_').includes('REMOVE@mydb.abc_oauth_tokens'));
    assert.ok(atlasPrivileges('mydb', 'abc_').includes('REMOVE@mydb._emet_verify'));
  });
  test('no memory layer, document or transcript collection is in the delete list', () => {
    for (const c of Object.keys(DELETE_ALLOWED)) assert.ok(!/^(emet_(episodic|semantic|procedural|meta|identity|working)|documents|documents_history|transcripts|exchanges)$/.test(c), c);
  });
  test('the privilege strings are in Atlas CLI form', () => {
    const p = atlasPrivileges('emet');
    assert.ok(p.includes('FIND@emet') && p.includes('REMOVE@emet.emet_oauth_tokens') && p.includes('REMOVE@emet._emet_verify'));
    assert.ok(!p.includes('DROP_COLLECTION@emet._emet_verify'));
    assert.ok(!p.some((x) => x.startsWith('REMOVE@emet') && !x.includes('.')));
    assert.throws(() => atlasPrivileges('bad name'));
  });
  test('the role has a name', () => assert.strictEqual(ATLAS_ROLE_NAME, 'emetRecordKeeper'));
});

testGroup('every delete in src/ is covered by the role', () => {
  // Deletes are found by call, then attributed to a collection by the file's
  // known collection variables. A new delete anywhere fails here until it is
  // named in DELETE_ALLOWED or removed.
  const KNOWN = [
    { file: 'oauth-provider.js', collection: '{prefix}oauth_tokens', count: 6 },
    { file: 'setup.js', collection: '_emet_verify', count: 1 } // the probe document only; the collection is not dropped
  ];
  const found = {};
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.js') && x !== 'atlas-role.js')) {
    const n = (fs.readFileSync(path.join(SRC, f), 'utf8').match(/\.(deleteOne|deleteMany|findOneAndDelete|drop|dropCollection|dropDatabase)\s*\(/g) || []).length;
    if (n) found[f] = n;
  }
  test('deletes appear only where the role expects them', () =>
    assert.deepStrictEqual(found, Object.fromEntries(KNOWN.map((k) => [k.file, k.count]))));
  test('each expected delete target is allowed by the role', () => {
    for (const k of KNOWN) assert.ok(DELETE_ALLOWED[k.collection], k.collection);
  });
  test('oauth-provider deletes from the tokens collection', () => {
    const src = fs.readFileSync(path.join(SRC, 'oauth-provider.js'), 'utf8');
    assert.ok(/emet_oauth_tokens|oauth_tokens/.test(src));
  });
});

summary('Atlas Role Test Summary');
