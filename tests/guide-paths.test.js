/**
 * Every guide path named in src/ and docs/ has a file.
 * guides/NAME.md is a doc id: it exists at guides/NAME.md or under
 * gems/<id>/guides/NAME.md. A gems/.../guides/...md path must exist as written.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = /(?:gems\/[A-Za-z0-9._-]+\/)?guides\/[A-Za-z0-9_./-]+\.md/g;

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
      if (/\.(js|mjs|md)$/.test(entry.name)) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

function exists(rel) {
  if (rel.startsWith('gems/')) return fs.existsSync(path.join(ROOT, rel));
  if (fs.existsSync(path.join(ROOT, rel))) return true;
  const name = path.posix.basename(rel);
  const gems = path.join(ROOT, 'gems');
  if (!fs.existsSync(gems)) return false;
  return fs.readdirSync(gems).some((id) => fs.existsSync(path.join(gems, id, 'guides', name)));
}

testGroup('named guide paths exist', () => {
  test('every guide path in src/ and docs/ resolves to a file', () => {
    const missing = [];
    const seen = new Set();
    for (const dir of ['src', 'docs']) {
      for (const file of textFiles(path.join(ROOT, dir))) {
        const text = fs.readFileSync(file, 'utf8');
        for (const match of text.match(GUIDE) || []) {
          seen.add(match);
          if (!exists(match)) missing.push(`${path.relative(ROOT, file)} -> ${match}`);
        }
      }
    }
    assert.ok(seen.has('gems/bot-team-backup/guides/BOT_TEAM_BACKUP.md'));
    assert.deepStrictEqual(missing, []);
  });
});

summary('GUIDE PATHS');
