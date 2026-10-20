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
import { releaseTagMismatch, releaseTagCommitFault } from '../scripts/release-version-guard.mjs';

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
    assert.match(releaseTagMismatch('v0.2.5', '0.2.6'), /does not match/);
    for (const [tag, version] of [
      ['v0.2.5', '0.2.6'],
      ['0.2.6', '0.2.6'],
      ['V0.2.6', '0.2.6'],
      ['v0.2.6 ', '0.2.6'],
      ['v0.2', '0.2'],
      ['v0.2.6-rc.1', '0.2.6-rc.1'],
      ['', '0.2.6'],
    ]) {
      const result = run(tag, version);
      assert.notStrictEqual(result.status, 0, `${tag} vs ${version} was accepted`);
      assert.match(result.stderr, /does not match/, result.stderr || result.stdout);
    }
  });

  test('the publish workflow runs the guard before publish and does not use an npm token', () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
    assert.match(yml, /types: \[published\]/);
    assert.deepStrictEqual(workflowOnKeys(yml), ['release']);
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
    const withDispatch = yml.replace('on:\n  release:', 'on:\n  release:\n    types: [published]\n  workflow_dispatch:');
    assert.notDeepStrictEqual(workflowOnKeys(withDispatch), ['release']);
  });

  test('a release tag that is not HEAD fails, and a missing tag passes', () => {
    assert.strictEqual(releaseTagCommitFault('', 'abc'), '');
    assert.strictEqual(releaseTagCommitFault('abc', 'abc'), '');
    assert.match(releaseTagCommitFault('old', 'abc'), /not HEAD/);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-tag-commit-'));
    const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git(['init']);
    git(['config', 'user.email', 'dev@example.com']);
    git(['config', 'user.name', 'Dev']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(['add', 'a.txt']);
    git(['commit', '-m', 'one']);
    git(['tag', 'v1.2.3']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n');
    git(['commit', '-am', 'two']);
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    const at = git(['rev-list', '-n1', 'v1.2.3']).stdout.trim();
    assert.notStrictEqual(at, head);
    const pkg = path.join(repo, 'package.json');
    fs.writeFileSync(pkg, JSON.stringify({ name: 'example', version: '1.2.3' }));
    const stuck = spawnSync(process.execPath, [script, 'v1.2.3', pkg], { encoding: 'utf8', env: { ...process.env, EMET_GUARD_REPO: repo } });
    assert.notStrictEqual(stuck.status, 0, stuck.stdout);
    assert.match(stuck.stderr, /not HEAD/);
    fs.writeFileSync(pkg, JSON.stringify({ name: 'example', version: '9.9.9' }));
    const missing = spawnSync(process.execPath, [script, 'v9.9.9', pkg], { encoding: 'utf8', env: { ...process.env, EMET_GUARD_REPO: repo } });
    assert.strictEqual(missing.status, 0, missing.stderr || missing.stdout);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('package.json, server.json and glama.json versions agree', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const server = JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8'));
    const glama = JSON.parse(fs.readFileSync(path.join(ROOT, 'glama.json'), 'utf8'));
    assert.strictEqual(pkg.version, '0.2.6');
    assert.strictEqual(server.version, pkg.version);
    assert.strictEqual(server.packages[0].version, pkg.version);
    assert.strictEqual(glama.version, pkg.version);
  });
});

function workflowOnKeys(yaml) {
  const keys = [];
  let inOn = false;
  for (const line of String(yaml).split(/\r?\n/)) {
    if (!inOn) {
      if (/^on:\s*$/.test(line)) inOn = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const key = line.match(/^  ([A-Za-z0-9_-]+):/);
    if (key) keys.push(key[1]);
  }
  return keys;
}

summary('RELEASE VERSION GUARD TEST SUMMARY');
