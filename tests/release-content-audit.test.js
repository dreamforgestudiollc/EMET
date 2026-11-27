/**
 * Every public release includes a content audit of the first-timer
 * surfaces, not only a version-string agreement. This suite is the
 * automated part of docs/RELEASING.md. It is necessary and not
 * sufficient: a first-timer walk and a review still have to happen.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';
import {
  BASELINE_REL,
  loadBaseline,
  loadSurfaceFiles,
  reportDashes,
  setupTokenHitsFrom,
} from './release-dash-audit.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const ISO_LEAD =
  'ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control memory for AI agents. Nothing is deleted.';

const SURFACES = [
  'README.md',
  'docs/SETUP.md',
  'docs/DEPLOY.md',
  'docs/ROADMAP.md',
  'docs/GUIDED-SETUP.md',
  'docs/BOTS.md',
  'docs/SUBKEYS.md',
  'docs/PERMISSIONS.md',
  'docs/CONSOLE.md',
  'docs/ERROR-CODES.md',
  'docs/RELEASING.md',
  'docs/features/access.md',
  'docs/features/documents.md',
  'docs/features/subkeys.md',
  'docs/features/startup.md',
  'docs/features/errors.md',
  'site/index.html',
  'site/sitemap.xml',
  'CHANGELOG.md',
  'RELEASE_NOTES-0.3.8.md',
  'package.json',
  'server.json',
  '.env.example',
];

const FIRST_TIMER = [
  'README.md',
  'docs/SETUP.md',
  'docs/DEPLOY.md',
  'docs/GUIDED-SETUP.md',
  'site/index.html',
];

const OPERATOR = FIRST_TIMER.concat([
  'docs/BOTS.md',
  'docs/SUBKEYS.md',
  '.env.example',
]);

const STALE = [
  'The passphrase is the whole perimeter',
  'same passphrase used to connect a device',
  'approvals page uses the same passphrase as connecting',
  'chooser asks for the existing owner passphrase',
  'the same check as the OAuth consent page',
];

const PLANT = 'A planted follow-up line — must be caught.';

function currentReport() {
  return reportDashes(loadSurfaceFiles(ROOT), loadBaseline(ROOT));
}

function makeTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-dash-'));
  const files = loadSurfaceFiles(ROOT);
  for (const [rel, text] of Object.entries(files)) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }
  const fixture = path.join(tmp, BASELINE_REL);
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.copyFileSync(path.join(ROOT, BASELINE_REL), fixture);
  fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tests/release-dash-audit.js'), path.join(tmp, 'tests/release-dash-audit.js'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));
  return tmp;
}

function checkTree(tmp, { plant = false, version } = {}) {
  if (version) {
    const pkgPath = path.join(tmp, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = version;
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  if (plant) fs.appendFileSync(path.join(tmp, 'README.md'), `\n${PLANT}\n`);
  return reportDashes(loadSurfaceFiles(tmp), loadBaseline(tmp));
}

function initGitTagged(tmp, tag) {
  const opts = { cwd: tmp, encoding: 'utf8' };
  const run = (args) => {
    const result = spawnSync('git', args, opts);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
  };
  run(['-c', 'commit.gpgsign=false', 'init']);
  run(['add', '-A']);
  run(['-c', 'user.email=dev@example.com', '-c', 'user.name=dev', '-c', 'commit.gpgsign=false', 'commit', '-m', 'tree']);
  run(['tag', tag]);
}

function planted(report) {
  return report.newDashes.some((hit) => hit.text.includes(PLANT));
}

console.log('\n=== Release content audit ===');

testGroup('the release checklist names every surface', () => {
  test('docs/RELEASING.md exists and lists the audit surfaces', () => {
    const text = read('docs/RELEASING.md');
    for (const name of [
      'site/index.html',
      'README.md',
      'docs/SETUP.md',
      'docs/DEPLOY.md',
      'docs/GUIDED-SETUP.md',
      'docs/ROADMAP.md',
      'docs/BOTS.md',
      'docs/SUBKEYS.md',
      'docs/PERMISSIONS.md',
      'docs/CONSOLE.md',
      'docs/ERROR-CODES.md',
      'docs/features/',
      'CHANGELOG.md',
      'RELEASE_NOTES-',
      'package.json',
      'server.json',
      'site/sitemap.xml',
      'first-time',
      'EMET-AUTH-046',
      'EMET-DOC-025',
      'EMET-DOC-089',
      'EMET-DOC-090',
      'EMET-MEM-018',
      'write_doc_begin',
      'carry_forward',
      'EMET_TAG_HANDOFFS',
      'EMET_CONTINUITY_CURRENCY',
      '/owner/admin-password',
    ]) {
      assert.ok(text.includes(name), `RELEASING.md missing ${name}`);
    }
  });

  test('every listed surface file is present', () => {
    for (const rel of SURFACES) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
    }
  });
});

testGroup('first-timer pages teach the current 0.3.8 path', () => {
  test('README, Setup, Deploy, Guided setup, and the site name the two HTTP secrets', () => {
    for (const rel of FIRST_TIMER) {
      const text = read(rel);
      assert.ok(text.includes('/owner/admin-password'), `${rel} missing /owner/admin-password`);
      assert.match(text, /admin password/i, `${rel} missing admin password`);
      assert.match(text, /connect passphrase/i, `${rel} missing connect passphrase`);
    }
  });

  test('README and the site name key sign-in, integrity, and condense codes', () => {
    for (const rel of ['README.md', 'site/index.html']) {
      const text = read(rel);
      for (const needle of [
        'EMET-AUTH-046',
        'EMET-AUTH-045',
        'EMET-DOC-025',
        'EMET-DOC-089',
        'EMET-DOC-090',
        'condense_approved',
        'write_doc_begin',
        'EMET-MEM-018',
        'carry_forward',
      ]) {
        assert.ok(text.includes(needle), `${rel} missing ${needle}`);
      }
    }
  });

  test('Setup and Deploy 0.3.8 notes name fail-closed create, integrity, and AUTH-046', () => {
    for (const rel of ['docs/SETUP.md', 'docs/DEPLOY.md']) {
      const text = read(rel);
      const at = text.indexOf('## Upgrading to 0.3.8');
      assert.ok(at >= 0, rel);
      const stop = text.indexOf('\n## Upgrading to 0.3.7', at);
      const section = text.slice(at, stop);
      for (const needle of [
        '401',
        '409',
        'EMET-AUTH-046',
        'EMET-DOC-025',
        'EMET-DOC-089',
        'EMET-DOC-090',
        'condense_approved',
      ]) {
        assert.ok(section.includes(needle), `${rel} 0.3.8 upgrade missing ${needle}`);
      }
    }
  });

  test('the roadmap marks the current feature set as already shipping', () => {
    const text = read('docs/ROADMAP.md');
    for (const needle of [
      'admin password',
      'EMET-AUTH-046',
      'EMET-DOC-089',
      'condense_approved',
      'write_doc_begin',
      'carry_forward',
      'EMET-MEM-018',
      'EMET_TAG_HANDOFFS',
      'EMET_CONTINUITY_CURRENCY',
      '/owner/chooser',
    ]) {
      assert.ok(text.includes(needle), `ROADMAP.md missing ${needle}`);
    }
  });
});

testGroup('retired secret flows are not taught as current', () => {
  test('first-timer and operator docs do not call the connect passphrase the whole perimeter', () => {
    const hits = [];
    for (const rel of OPERATOR) {
      const text = read(rel);
      for (const phrase of STALE) {
        if (text.includes(phrase)) hits.push(`${rel}: ${phrase}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});

testGroup('published descriptions keep the ISO lead and stay dash-clean where required', () => {
  test('server.json description is exactly the ISO lead', () => {
    const server = JSON.parse(read('server.json'));
    assert.equal(server.description, ISO_LEAD);
  });

  test('package.json description starts with the ISO lead and stays in agreement with the published 0.3.8 listing', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.description.startsWith(ISO_LEAD), 'package.json description must start with the ISO lead');
    // The published 0.3.8 npm listing still has an em dash after "EMET 0.3.8".
    // Keep this string in agreement until the next npm publish. Do not retitle it here.
    assert.ok(pkg.description.includes('EMET 0.3.8'), 'package.json description must name 0.3.8');
  });

  test('in-repo 0.3.8 release notes name the current 0.3.8 behavior', () => {
    const text = read('RELEASE_NOTES-0.3.8.md');
    for (const needle of [
      'ISO 9001 7.5.3 / ISO 13485 4.2.5',
      'admin password',
      'connect passphrase',
      'EMET-AUTH-046',
      'EMET-DOC-025',
      'EMET-DOC-089',
      'EMET-DOC-090',
      'condense_approved',
    ]) {
      assert.ok(text.includes(needle), `RELEASE_NOTES-0.3.8.md missing ${needle}`);
    }
  });

  test('sitemap lastmod is the 0.3.8 release date or later', () => {
    const text = read('site/sitemap.xml');
    const match = text.match(/<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/);
    assert.ok(match, 'site/sitemap.xml has no lastmod');
    assert.ok(match[1] >= '2026-11-27', `sitemap lastmod ${match[1]} is older than 2026-11-27`);
  });
});

testGroup('new or edited audit prose has no em or en dash', () => {
  test('the tree matches the checked-in dash baseline', () => {
    const report = currentReport();
    assert.deepEqual(report.newDashes, []);
    assert.deepEqual(report.staleBaseline, []);
  });

  test('a planted em dash in the 0.3.8 release notes fails the check', () => {
    const files = loadSurfaceFiles(ROOT);
    const baseline = loadBaseline(ROOT);
    assert.deepEqual(reportDashes(files, baseline).newDashes, []);
    files['RELEASE_NOTES-0.3.8.md'] += '\nThe admin password — set it here.\n';
    const hits = reportDashes(files, baseline).newDashes;
    assert.ok(hits.some((hit) => hit.file === 'RELEASE_NOTES-0.3.8.md' && hit.text.includes('admin password')), JSON.stringify(hits));
  });

  test('a second copy of an existing dashed line is a new dash, and a missing baseline line is stale', () => {
    const files = loadSurfaceFiles(ROOT);
    const baseline = loadBaseline(ROOT);
    const existing = baseline.lines['README.md'][0];
    files['README.md'] += `\n${existing}\n`;
    const extra = reportDashes(files, baseline);
    assert.ok(extra.newDashes.some((hit) => hit.file === 'README.md' && hit.text === existing), JSON.stringify(extra.newDashes));
    const reduced = loadSurfaceFiles(ROOT);
    reduced['README.md'] = reduced['README.md'].split('\n').filter((line) => line !== existing).join('\n');
    const stale = reportDashes(reduced, baseline);
    assert.ok(stale.staleBaseline.some((hit) => hit.file === 'README.md' && hit.text === existing), JSON.stringify(stale.staleBaseline));
  });

  test('a plant in a docs file outside the short SURFACES list is caught', () => {
    const files = loadSurfaceFiles(ROOT);
    const baseline = loadBaseline(ROOT);
    assert.ok(Object.prototype.hasOwnProperty.call(files, 'docs/SECURITY-AT-SCALE.md'));
    files['docs/SECURITY-AT-SCALE.md'] += `\n${PLANT}\n`;
    const hits = reportDashes(files, baseline).newDashes;
    assert.ok(hits.some((hit) => hit.file === 'docs/SECURITY-AT-SCALE.md' && hit.text.includes(PLANT)), JSON.stringify(hits));
  });

  test('a missing baseline fails with a clear message and does not use git', () => {
    assert.throws(() => loadBaseline(os.tmpdir()), /legacy dash baseline is missing/);
    assert.throws(() => reportDashes({}, null), /legacy dash baseline is missing/);
  });

  test('a new dash is caught when the version is 0.3.9 and that tag does not exist, and a clean tree passes', () => {
    const tmp = makeTree();
    try {
      const clean = checkTree(tmp, { version: '0.3.9' });
      assert.deepEqual(clean.newDashes, []);
      assert.deepEqual(clean.staleBaseline, []);
      const dirty = checkTree(tmp, { version: '0.3.9', plant: true });
      assert.ok(planted(dirty), JSON.stringify(dirty.newDashes));
      assert.equal(dirty.staleBaseline.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a new dash is caught when HEAD is tagged with the current version, and a clean tree passes', () => {
    const cleanTree = makeTree();
    const dirtyTree = makeTree();
    try {
      const version = JSON.parse(read('package.json')).version;
      initGitTagged(cleanTree, `v${version}`);
      const clean = checkTree(cleanTree);
      assert.deepEqual(clean.newDashes, []);
      assert.deepEqual(clean.staleBaseline, []);
      fs.appendFileSync(path.join(dirtyTree, 'README.md'), `\n${PLANT}\n`);
      initGitTagged(dirtyTree, `v${version}`);
      const dirty = checkTree(dirtyTree);
      assert.ok(planted(dirty), JSON.stringify(dirty.newDashes));
    } finally {
      fs.rmSync(cleanTree, { recursive: true, force: true });
      fs.rmSync(dirtyTree, { recursive: true, force: true });
    }
  });

  test('a new dash is caught with no .git directory, and a clean tree passes', () => {
    const tmp = makeTree();
    try {
      assert.equal(fs.existsSync(path.join(tmp, '.git')), false);
      const clean = checkTree(tmp);
      assert.deepEqual(clean.newDashes, []);
      assert.deepEqual(clean.staleBaseline, []);
      const dirty = checkTree(tmp, { plant: true });
      assert.ok(planted(dirty), JSON.stringify(dirty.newDashes));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

testGroup('a later private setup token is not documented on public surfaces', () => {
  test('EMET_ADMIN_SETUP_TOKEN is absent from README, docs, the site, changelog, release notes, and .env.example', () => {
    assert.deepEqual(setupTokenHitsFrom(loadSurfaceFiles(ROOT)), []);
  });

  test('a plant in README or GUIDED-SETUP fails the setup-token check', () => {
    const files = loadSurfaceFiles(ROOT);
    assert.deepEqual(setupTokenHitsFrom(files), []);
    const plant = 'Set EMET_ADMIN_SETUP_TOKEN before first run.\n';
    const inReadme = setupTokenHitsFrom({ ...files, 'README.md': `${files['README.md']}\n${plant}` });
    const inGuided = setupTokenHitsFrom({ ...files, 'docs/GUIDED-SETUP.md': `${files['docs/GUIDED-SETUP.md']}\n${plant}` });
    assert.deepEqual(inReadme, ['README.md']);
    assert.deepEqual(inGuided, ['docs/GUIDED-SETUP.md']);
  });
});

await summary('Release content audit');
