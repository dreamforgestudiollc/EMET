/**
 * The publish workflow refuses a release whose tag is not the package version.
 * The guard is the script the workflow runs. A mismatch must exit non-zero.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { releaseTagMismatch } from '../scripts/release-version-guard.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(ROOT, 'scripts', 'release-version-guard.mjs');

function run(tag, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-tag-'));
  const pkg = path.join(dir, 'package.json');
  fs.writeFileSync(pkg, JSON.stringify({ name: 'example', version }));
  const result = spawnSync(process.execPath, [script, tag, pkg], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

testGroup('release tag guard', () => {
  test('vX.Y.Z that names the package version passes', () => {
    assert.strictEqual(releaseTagMismatch('v1.2.3', '1.2.3'), '');
    const ok = run('v1.2.3', '1.2.3');
    assert.strictEqual(ok.status, 0, ok.stderr || ok.stdout);
  });

  test('a mismatch is rejected', () => {
    assert.match(releaseTagMismatch('v0.2.4', '0.2.5'), /does not match/);
    for (const [tag, version] of [
      ['v0.2.4', '0.2.5'],
      ['0.2.5', '0.2.5'],
      ['V0.2.5', '0.2.5'],
      ['v0.2.5 ', '0.2.5'],
      ['v0.2', '0.2'],
      ['v0.2.5-rc.1', '0.2.5-rc.1'],
      ['', '0.2.5'],
    ]) {
      const result = run(tag, version);
      assert.notStrictEqual(result.status, 0, `${tag} vs ${version} was accepted`);
      assert.match(result.stderr, /does not match/, result.stderr || result.stdout);
    }
  });

  test('the publish workflow runs the guard before publish and does not use an npm token', () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
    assert.match(yml, /types: \[published\]/);
    assert.match(yml, /workflow_dispatch:/);
    assert.match(yml, /id-token: write/);
    assert.match(yml, /contents: read/);
    assert.match(yml, /node-version: ['"]24['"]/);
    assert.match(yml, /registry-url: https:\/\/registry\.npmjs\.org/);
    assert.match(yml, /github\.event\.release\.tag_name/);
    assert.match(yml, /npm ci/);
    assert.match(yml, /npm test/);
    assert.match(yml, /npm publish --provenance --access public/);
    const guard = yml.indexOf('node scripts/release-version-guard.mjs');
    const ci = yml.indexOf('npm ci');
    const tests = yml.indexOf('npm test');
    const publish = yml.indexOf('npm publish --provenance --access public');
    assert.ok(guard >= 0 && guard < publish, 'guard step is missing or runs after publish');
    assert.ok(ci >= 0 && ci < tests && tests < publish, 'install, test, and publish are out of order');
    assert.ok(!yml.includes('NPM_TOKEN'));
  });
});

summary('RELEASE VERSION GUARD TEST SUMMARY');
