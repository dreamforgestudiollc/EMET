/**
 * Every guide path named in src/, docs/, templates/, README.md, and gems/
 * resolves the way read_doc does.
 * guides/NAME.md is a doc id. The alias map wins, then guides/NAME.md at the
 * repo root, then the first gems/<id>/guides/NAME.md in sorted gem-id order.
 * A gems/.../guides/...md path must exist as written.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { readShippedGuide } = await import('../src/guides.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = /(?:gems\/[A-Za-z0-9._-]+\/)?guides\/[A-Za-z0-9_./-]+\.md/g;
const GUIDE_ID = /^guides\/([A-Za-z0-9_-]+\.md)$/;
const GUIDE_ALIAS = Object.freeze({
  'guides/NEURODIVERGENT_SUPPORT.md': 'gems/neurendipity/guides/NEURODIVERGENT_SUPPORT.md'
});

function textFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(abs);
        continue;
      }
      if (/\.(js|mjs|json|md)$/.test(entry.name)) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

function scanRoots() {
  const files = [];
  for (const dir of ['src', 'docs', 'templates', 'gems']) {
    files.push(...textFiles(path.join(ROOT, dir)));
  }
  files.push(path.join(ROOT, 'README.md'));
  return files;
}

/** Where read_doc would read this path, as a repo-relative file, or null. */
function resolveGuide(rel) {
  if (rel.startsWith('gems/')) return fs.existsSync(path.join(ROOT, rel)) ? rel : null;
  const match = GUIDE_ID.exec(rel);
  if (!match) return null;
  if (Object.prototype.hasOwnProperty.call(GUIDE_ALIAS, rel)) {
    const aliased = GUIDE_ALIAS[rel];
    if (fs.existsSync(path.join(ROOT, aliased))) return aliased;
  }
  if (fs.existsSync(path.join(ROOT, 'guides', match[1]))) return `guides/${match[1]}`;
  const gemsDir = path.join(ROOT, 'gems');
  if (!fs.existsSync(gemsDir)) return null;
  const gems = fs.readdirSync(gemsDir).filter((id) => /^[a-z0-9-]+$/.test(id)).sort();
  for (const id of gems) {
    if (fs.existsSync(path.join(gemsDir, id, 'guides', match[1]))) return `gems/${id}/guides/${match[1]}`;
  }
  return null;
}

testGroup('named guide paths exist', () => {
  test('every named guide path resolves where read_doc would read it', () => {
    const missing = [];
    const seen = new Set();
    for (const file of scanRoots()) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.match(GUIDE) || []) {
        seen.add(match);
        const found = resolveGuide(match);
        if (!found) {
          missing.push(`${path.relative(ROOT, file)} -> ${match}`);
          continue;
        }
        if (match.startsWith('guides/')) {
          const doc = readShippedGuide(match);
          const bytes = fs.readFileSync(path.join(ROOT, found), 'utf8');
          if (!doc || doc.content !== bytes) missing.push(`${path.relative(ROOT, file)} -> ${match} != ${found}`);
        }
      }
    }
    assert.ok(seen.has('gems/bot-team-backup/guides/BOT_TEAM_BACKUP.md'));
    assert.ok(seen.has('guides/BELTS.md'));
    assert.deepStrictEqual(missing, []);
  });

  test('the old setup path is absent at the top level and read_doc finds the GEM copy', () => {
    const bare = 'guides/BOT_TEAM_BACKUP.md';
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'guides', 'BOT_TEAM_BACKUP.md')), false);
    assert.strictEqual(resolveGuide(bare), 'gems/bot-team-backup/guides/BOT_TEAM_BACKUP.md');
    const doc = readShippedGuide(bare);
    assert.strictEqual(doc.content, fs.readFileSync(path.join(ROOT, 'gems/bot-team-backup/guides/BOT_TEAM_BACKUP.md'), 'utf8'));
    assert.strictEqual(resolveGuide('guides/NOT_A_REAL_GUIDE.md'), null);
    assert.strictEqual(readShippedGuide('guides/NOT_A_REAL_GUIDE.md'), null);
  });
});

summary('GUIDE PATHS');
