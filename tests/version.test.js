/**
 * The version is pinned in one constant (src/version.js) and in package.json;
 * they must agree, and every place the server reports a version uses the
 * constant.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';

console.log('\n=== version ===');
const { EMET_VERSION } = await import('../src/version.js');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

testGroup('one version', () => {
  test('src/version.js, package.json and package-lock.json agree on 0.2.3', () => {
    assert.strictEqual(EMET_VERSION, '0.2.3');
    assert.strictEqual(pkg.version, EMET_VERSION);
    assert.strictEqual(lock.version, EMET_VERSION);
    assert.strictEqual(lock.packages[''].version, EMET_VERSION);
  });
  test('no source file pins a version literal of its own', () => {
    for (const f of ['index.js', 'http-remote.js', 'logger.js', 'tools.js']) {
      const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
      assert.ok(!/version:\s*['"]\d+\.\d+\.\d+['"]/.test(src) && !/\bv\d+\.\d+\.\d+\b/.test(src), `${f} pins its own version`);
      assert.ok(src.includes('EMET_VERSION'), `${f} does not use EMET_VERSION`);
    }
  });
});

await summary('Version Test Summary');
