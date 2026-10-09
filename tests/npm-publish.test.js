/**
 * package.json and server.json are ready for a public npm release and the
 * Official MCP Registry. Nothing is published from this suite. The packed
 * file list is what `npm pack --dry-run` would ship.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { digest, isPrivateTree, privateWordsIn } from './scrub-tokens.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const server = JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8'));
const FILES = [
  'src/',
  'templates/',
  'guides/',
  'docs/*.md',
  'CHARTER.md',
  'CHANGELOG.md',
  'server.json',
  '.env.example',
  'README.md',
  'LICENSE',
];

function packDryRun() {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const start = r.stdout.indexOf('[');
  assert.ok(start >= 0, r.stdout);
  const parsed = JSON.parse(r.stdout.slice(start));
  assert.ok(Array.isArray(parsed) && parsed[0], 'npm pack --json did not return a pack result');
  return parsed[0];
}

function banned(rel) {
  if (rel === '.env' || (rel.startsWith('.env') && rel !== '.env.example')) return true;
  if (rel === 'REVIEW.md' || rel === 'package-lock.json') return true;
  return /^(?:tests|scripts|docs\/status|\.github|site|coverage|node_modules)\//.test(rel)
    || /(?:\.backup_|\.sqlite_backup|\.deleted_|_smoke_|_probe|_canary)/.test(rel);
}

const INSTALL_SOURCE_TAGS = ['desktop-cowork', 'cowork-cloud', 'grok-project'];

/** Why a packed example must not ship. Empty means the public example. */
export function envExampleFaults(text) {
  const faults = [];
  for (const line of String(text).split(/\r?\n/)) {
    const code = line.trim();
    if (!code || code.startsWith('#')) continue;
    if (/^EMET_OAUTH_PASSPHRASE\s*=/.test(code)) faults.push('passphrase');
    if (/^HOST\s*=\s*0\.0\.0\.0\b/.test(code)) faults.push('bind');
  }
  if (INSTALL_SOURCE_TAGS.some((tag) => text.includes(tag)) || text.includes('cli,mobile')) faults.push('source-tags');
  return faults;
}

function textPrivateHits(entries) {
  const bad = [];
  for (const entry of entries) {
    const words = privateWordsIn(entry.text, entry.digests);
    if (words.length) bad.push([entry.path, words]);
  }
  return bad;
}

function packedTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-pack-'));
  const r = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const start = r.stdout.indexOf('[');
  assert.ok(start >= 0, r.stdout);
  const parsed = JSON.parse(r.stdout.slice(start));
  assert.ok(Array.isArray(parsed) && parsed[0], 'npm pack --json did not return a pack result');
  const entry = parsed[0];
  const tgz = path.join(dir, entry.filename);
  const read = (rel) => {
    const ex = spawnSync('tar', ['-xOf', tgz, `package/${rel}`], { encoding: 'utf8' });
    assert.strictEqual(ex.status, 0, `${rel}\n${ex.stderr}`);
    return ex.stdout;
  };
  return { entry, read, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

testGroup('npm publish metadata', () => {
  test('the package name, version, and registry manifest agree', () => {
    assert.strictEqual(pkg.name, 'emet');
    assert.strictEqual(pkg.version, '0.2.4');
    assert.strictEqual(pkg.mcpName, 'io.github.dreamforgestudiollc/emet');
    assert.strictEqual(server.name, pkg.mcpName);
    assert.strictEqual(server.version, pkg.version);
    assert.strictEqual(server.packages[0].identifier, pkg.name);
    assert.strictEqual(server.packages[0].version, pkg.version);
    assert.strictEqual(server.packages[0].registryType, 'npm');
    assert.strictEqual(server.packages[0].transport.type, 'stdio');
    assert.ok(server.description.length > 0 && server.description.length <= 100);
    assert.strictEqual(pkg.license, 'MIT');
    assert.strictEqual(pkg.homepage, 'https://dreamforgestudiollc.github.io/EMET/');
    assert.strictEqual(pkg.bugs.url, 'https://github.com/dreamforgestudiollc/EMET/issues');
    assert.strictEqual(pkg.repository.url, 'git+https://github.com/dreamforgestudiollc/EMET.git');
    assert.strictEqual(pkg.main, 'src/index.js');
    assert.strictEqual(pkg.bin.emet, 'src/index.js');
    assert.strictEqual(pkg.engines.node, '>=20');
    assert.strictEqual(pkg.publishConfig, undefined);
    assert.deepStrictEqual(pkg.files, FILES);
    for (const word of ['mcp', 'mcp-server', 'model-context-protocol', 'ai-memory', 'agent-memory', 'persistent-memory']) {
      assert.ok(pkg.keywords.includes(word), word);
    }
  });

  test('npm pack --dry-run ships runtime files and docs, and leaves private paths out', () => {
    const packed = packDryRun();
    const paths = packed.files.map((f) => f.path);
    for (const rel of ['package.json', 'src/index.js', 'src/http-remote.js', 'templates/BOARD.md', 'guides/NEURODIVERGENT_SUPPORT.md', 'CHARTER.md', 'CHANGELOG.md', 'server.json', 'docs/SETUP.md', 'docs/DEPLOY.md', '.env.example', 'README.md', 'LICENSE']) {
      assert.ok(paths.includes(rel), rel);
    }
    const bad = paths.filter(banned);
    assert.deepStrictEqual(bad, []);
    assert.ok(!paths.some((rel) => rel.startsWith('docs/status/')));
  });

  test('the packed example does not assign a passphrase, bind every interface, or name this install', () => {
    const planted = [
      'EMET_OAUTH_PASSPHRASE=CHANGE_ME',
      'HOST=0.0.0.0',
      'EMET_SOURCE_TAGS=cli,mobile,desktop-cowork,cowork-cloud,grok-project',
    ].join('\n');
    assert.deepStrictEqual(envExampleFaults(planted), ['passphrase', 'bind', 'source-tags']);
    assert.deepStrictEqual(envExampleFaults('# EMET_OAUTH_PASSPHRASE=\n# HOST=0.0.0.0\nEMET_SOURCE_TAGS=laptop,phone,cli\n'), []);
    const packed = packedTree();
    try {
      const text = packed.read('.env.example');
      assert.deepStrictEqual(envExampleFaults(text), []);
      assert.match(text, /^HOST=127\.0\.0\.1$/m);
      assert.match(text, /^# EMET_OAUTH_PASSPHRASE=$/m);
      assert.match(text, /^EMET_SOURCE_TAGS=laptop,phone,cli$/m);
    } finally {
      packed.cleanup();
    }
  });

  test('packed text has no install-specific names on the scrubbed tree', () => {
    const zebra = new Set([digest('zebra')]);
    assert.deepStrictEqual(textPrivateHits([{ path: 'x.txt', text: 'The Zebra said so', digests: zebra }]), [['x.txt', ['zebra']]]);
    // This private checkout still has install names in src and docs. The publish
    // scrub drops the private markers, and on that tree every packed text file is checked.
    if (isPrivateTree(ROOT)) return;
    const packed = packedTree();
    try {
      const entries = packed.entry.files.map((f) => ({ path: f.path, text: packed.read(f.path) }));
      assert.deepStrictEqual(textPrivateHits(entries), []);
    } finally {
      packed.cleanup();
    }
  });
});

summary('NPM PUBLISH TEST SUMMARY');
