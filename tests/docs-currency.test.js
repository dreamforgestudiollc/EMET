/**
 * Docs stay current with the code (the 0.3.5 review).
 *
 * The site tool table, the published-version lines, the retired owner path,
 * the roadmap, and every setting() name are read from the tree. A stale
 * count or a setting that the deploy docs omit fails here.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_REPORT_EMAIL } from '../src/error-report.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

delete process.env.EMET_SUBKEYS;
delete process.env.CASCADE_SUBKEYS;
const { TOOL_ANNOTATIONS } = await import('../src/annotations.js');

const ASIDE = new Set(['retire_doc', 'emet_status']);

function namesIn(html) {
  return [...html.matchAll(/<code>([a-z0-9_]+)<\/code>/g)].map((item) => item[1]);
}

function between(text, start, end) {
  const at = text.indexOf(start);
  assert.ok(at >= 0, start);
  const rest = text.slice(at + start.length);
  const stop = rest.indexOf(end);
  return stop < 0 ? rest : rest.slice(0, stop);
}

function walkJs(dir, out = []) {
  return walkCode(dir, out, false);
}

function walkCode(dir, out = [], mjs = false) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walkCode(abs, out, mjs);
      continue;
    }
    if (entry.name.endsWith('.js') || (mjs && entry.name.endsWith('.mjs'))) out.push(abs);
  }
  return out;
}

/** Unprefixed collections public src opens: a string passed to collection(), or a same-file const used that way. */
function unprefixedCollections() {
  const names = new Set();
  for (const file of walkJs(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\.collection\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) names.add(match[1]);
    for (const match of text.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*'([A-Za-z0-9_]+)'/g)) {
      if (new RegExp(`\\.collection\\(\\s*${match[1]}\\s*\\)`).test(text)) names.add(match[2]);
    }
  }
  return [...names].sort();
}

const masterHub = /master[\s*]+hub/i;
const legacyTag = new RegExp('grok' + '[-_]project', 'i');
const person = new RegExp('sop' + 'hia', 'i');

function namesInstall(text) {
  return masterHub.test(text) || legacyTag.test(text) || person.test(text);
}

/** setting() names that exist only for a test double. Production names stay out. */
const SETTING_ALLOWLIST = new Set();

testGroup('the site tool table matches annotations with sub-keys off', () => {
  const html = read('site/index.html');
  const block = between(html, '<h3>What the tools are allowed to do</h3>', '<h3>Examples</h3>');
  const keys = Object.keys(TOOL_ANNOTATIONS);
  const readOnly = keys.filter((name) => TOOL_ANNOTATIONS[name].readOnlyHint).sort();
  const destructive = keys.filter((name) => TOOL_ANNOTATIONS[name].destructiveHint).sort();
  const additive = keys.filter((name) => !TOOL_ANNOTATIONS[name].readOnlyHint && !TOOL_ANNOTATIONS[name].destructiveHint && !ASIDE.has(name)).sort();

  test('the code is 38 tools: 15 read-only, 13 additive, 8 destructive, plus retire_doc and emet_status', () => {
    assert.strictEqual(keys.length, 38);
    assert.strictEqual(readOnly.length, 15);
    assert.strictEqual(additive.length, 13);
    assert.strictEqual(destructive.length, 8);
    assert.ok(ASIDE.has('retire_doc') && ASIDE.has('emet_status'));
    for (const name of ASIDE) {
      assert.strictEqual(TOOL_ANNOTATIONS[name].readOnlyHint, false, name);
      assert.strictEqual(TOOL_ANNOTATIONS[name].destructiveHint, false, name);
    }
  });

  test('the site counts and names are that same split', () => {
    assert.ok(block.includes('Thirty-eight tools are registered with sub-keys off.'));
    assert.ok(!block.includes('Thirty tools'));
    assert.ok(block.includes('<dt>15 read-only</dt>'));
    assert.ok(block.includes('<dt>13 additive writes</dt>'));
    assert.ok(block.includes('<dt>8 that replace or hand out access</dt>'));
    assert.ok(!/11 read-only|10 additive|7 that replace/.test(block));
    const rows = [...block.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)];
    const tools = (html) => [...new Set(namesIn(html).filter((name) => keys.includes(name)))];
    const byTitle = new Map(rows.map((row) => [row[1].replace(/<[^>]+>/g, ''), tools(row[2])]));
    assert.deepStrictEqual(byTitle.get('15 read-only').sort(), readOnly);
    assert.deepStrictEqual(byTitle.get('13 additive writes').sort(), additive);
    assert.deepStrictEqual(byTitle.get('8 that replace or hand out access').sort(), destructive);
    const asideRow = rows.find((row) => row[1].includes('retire_doc'));
    assert.ok(asideRow);
    assert.deepStrictEqual(tools(asideRow[1] + asideRow[2]).filter((name) => ASIDE.has(name)).sort(), [...ASIDE].sort());
    const listed = [...byTitle.values()].flat();
    assert.deepStrictEqual([...new Set(listed)].sort(), keys.sort());
  });
});

testGroup('a published version is not described as unpublished', () => {
  test('What 0.3.2 changed says the package was published on 2026-10-28', () => {
    const html = read('site/index.html');
    const section = between(html, '<h3>What 0.3.2 changed</h3>', '<h3>What 0.3.1 changed</h3>');
    assert.ok(section.includes('0.3.2 was published to npm on 2026-10-28.'));
    assert.ok(!/not published/i.test(section));
  });

  test('no What-changed section says not published', () => {
    const html = read('site/index.html');
    const project = between(html, 'id="project"', 'data-demo-mount="project"');
    const sections = project.split(/<h3>What /).slice(1);
    assert.ok(sections.length >= 4);
    for (const section of sections) {
      assert.ok(!/not published/i.test(section), section.slice(0, 40));
    }
  });
});

testGroup('the retired owner path is not the instruction', () => {
  test('every /owner/approvals mention sits next to retired, pointer, or chooser', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (/\.(js|md|html|example)$/.test(entry.name)) files.push(abs);
      }
    };
    walk(ROOT);
    const bad = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('/owner/approvals')) return;
        const window = lines.slice(Math.max(0, index - 20), index + 4).join('\n');
        if (!/retired|pointer|chooser/i.test(window)) bad.push(`${path.relative(ROOT, file)}:${index + 1}`);
      });
    }
    assert.deepStrictEqual(bad, []);
  });
});

testGroup('the roadmap names what is already live', () => {
  test('the status date, the site, npm, and the 0.3.0 topic-page tools are current', () => {
    const road = read('docs/ROADMAP.md');
    const site = read('site/index.html');
    assert.ok(road.startsWith('# EMET — Next Steps and Proposed Features\n\nStatus as of 2026-11-10'));
    assert.ok(!road.includes('Public landing page (parked)'));
    assert.ok(road.includes('**Public landing page and npm package (live).**'));
    assert.ok(road.includes('the public site and the npm package `@dreamforgestudiollc/emet` are published'));
    assert.ok(road.includes('Topic pages shipped in 0.3.0: `emet_page`, `emet_pages`, and `emet_page_lint`.'));
    assert.ok(road.includes('`emet_page_lint` shipped in 0.3.0'));
    assert.ok(site.includes('Status as of 2026-11-10'));
    assert.ok(site.includes('Its status date is 2026-11-10.'));
    assert.ok(!site.includes('2026-10-11'));
  });
});

testGroup('operator settings in setting() are in the example and the deploy table', () => {
  test('EMET_CLAIMED_TAG_KILL_DATE, EMET_DEEP_LINK_TTL_MINUTES, and EMET_RESTORE_TAGS name the code defaults', () => {
    for (const rel of ['.env.example', 'docs/DEPLOY.md']) {
      const text = read(rel);
      assert.ok(text.includes('EMET_CLAIMED_TAG_KILL_DATE'), rel);
      assert.ok(text.includes('2026-12-15'), rel);
      assert.ok(text.includes('EMET-AUTH-040'), rel);
      assert.ok(text.includes('EMET_DEEP_LINK_TTL_MINUTES'), rel);
      assert.ok(text.includes('EMET_RESTORE_TAGS'), rel);
      assert.ok(/Default 15/.test(text), rel);
    }
  });

  test('every setting() name is in .env.example and the DEPLOY environment table', () => {
    const names = new Set();
    for (const file of walkJs(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/setting\(\s*'([A-Z0-9_]+)'/g)) names.add(match[1]);
    }
    assert.ok(names.size > 20);
    const example = read('.env.example');
    const deploy = read('docs/DEPLOY.md');
    const table = between(deploy, '## Environment variables', '\n## ');
    const missing = [];
    for (const name of [...names].sort()) {
      if (SETTING_ALLOWLIST.has(name)) continue;
      const key = `EMET_${name}`;
      if (!example.includes(key) || !table.includes(key)) missing.push(key);
    }
    assert.deepStrictEqual(missing, []);
  });

  test('the DEPLOY legacy lists are the setting() names and the direct process.env names', () => {
    const setting = new Set();
    const direct = new Set();
    for (const file of walkJs(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/setting\(\s*'([A-Z0-9_]+)'/g)) setting.add(match[1]);
      for (const match of text.matchAll(/process\.env\.EMET_([A-Z0-9_]+)/g)) direct.add(match[1]);
      for (const match of text.matchAll(/process\.env\[['"]EMET_([A-Z0-9_]+)['"]\]/g)) direct.add(match[1]);
    }
    for (const name of setting) direct.delete(name);
    const block = between(read('docs/DEPLOY.md'), '**Legacy `CASCADE_` names.**', '**The two-pass deploy');
    const [settingPart, directPart] = block.split('These read `process.env` directly');
    const listed = (part) => [...part.matchAll(/`EMET_([A-Z0-9_]+)`/g)].map((match) => match[1]);
    assert.deepStrictEqual(listed(settingPart).sort(), [...setting].sort());
    assert.deepStrictEqual(listed(directPart).sort(), [...direct].sort());
  });

  test('the report address in current docs is the code default', () => {
    assert.strictEqual(DEFAULT_REPORT_EMAIL, 'dreamforgestudio@mail.hubbot.com');
    for (const rel of ['README.md', 'site/index.html', '.env.example', 'docs/features/errors.md', 'docs/DEPLOY.md', 'docs/ERROR-CODES-SPEC.md', 'CHANGELOG.md']) {
      assert.ok(read(rel).includes(DEFAULT_REPORT_EMAIL), rel);
    }
    for (const rel of ['README.md', 'site/index.html', '.env.example', 'docs/features/errors.md']) {
      assert.ok(!read(rel).includes('dreamforgestudio@mail.grokbot.com'), rel);
    }
  });
});

testGroup('the charter names the built socket, and install names stay out of public text', () => {
  test('CHARTER §4 says the socket is built and points at its code and note', () => {
    const charter = read('CHARTER.md');
    const row = charter.slice(charter.indexOf('**Extension socket**'), charter.indexOf('## §5'));
    assert.ok(row.includes('The socket is built.'));
    assert.ok(row.includes('`src/socket.js`'));
    assert.ok(row.includes('`docs/gem/README.md`'));
    assert.ok(row.includes('`gem-library/SPEC.md`'));
    assert.ok(charter.includes('revised with the user\'s approval 2026-11-10 (the extension socket is built; §4 Extension socket)'));
    assert.ok(!row.includes('socket not built'));
    const gem = read('docs/gem/README.md');
    assert.ok(gem.includes('The socket is `src/socket.js`.'));
    assert.ok(gem.includes('EMET bundles four GEMs'));
    assert.ok(!gem.includes('This release'));
    assert.ok(!gem.includes('once built'));
    assert.ok(!gem.includes('both lines say'));
    assert.ok(!gem.includes('for one release'));
  });

  test('src, docs, the site, gems, templates, packed guides, the README, the changelog, and server.json do not name the scrubbed install words', () => {
    const roots = ['src', 'docs', 'site', 'gems', 'gem-library', 'templates', 'areas', 'guides', 'verification', 'README.md', 'CHANGELOG.md', 'server.json', 'CHARTER.md', '.env.example'];
    const bad = [];
    const files = [];
    for (const rel of roots) {
      const abs = path.join(ROOT, rel);
      if (fs.statSync(abs).isDirectory()) files.push(...walkCode(abs, [], true), ...walkText(abs));
      else files.push(abs);
    }
    const seen = new Set();
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (namesInstall(fs.readFileSync(file, 'utf8'))) bad.push(path.relative(ROOT, file));
    }
    assert.deepStrictEqual(bad, []);
  });

  test('a camelCase or snake_case form of the scrubbed name is flagged', () => {
    assert.ok(namesInstall('const ' + 'sop' + 'hia' + 'Actor = 1'));
    assert.ok(namesInstall('const ' + 'sop' + 'hia' + '_door = 1'));
    assert.ok(namesInstall('function is' + 'Sop' + 'hia' + 'Credential() {}'));
    assert.ok(!namesInstall('a grok project'));
  });

  test('the 0.3.5 upgrade note stamps bound-host and limits the alias to stored data', () => {
    const stamp = 'stamped `bound-host`';
    const flat = (text) => text.replace(/<code>/g, '`').replace(/<\/code>/g, '`');
    const notes = [
      between(read('CHANGELOG.md'), '### Upgrade', '### Changed'),
      between(read('docs/DEPLOY.md'), '## Upgrading to 0.3.5', '## Upgrading to 0.3.4'),
      between(read('docs/SETUP.md'), '## Upgrading to 0.3.5', '## Upgrading to 0.3.4'),
      between(read('site/index.html'), 'What 0.3.5 changed', 'What 0.3.4 changed'),
    ].map(flat);
    for (const note of notes) {
      assert.ok(note.includes(stamp), note.slice(0, 240));
      assert.ok(note.includes('stored data only'));
      assert.ok(note.includes('new consent'));
    }
  });

  test('the 0.3.1 changelog records the address that release shipped', () => {
    const log = read('CHANGELOG.md');
    const shipped = between(log, '## 0.3.1 - ', '## 0.3.0 - ');
    assert.ok(shipped.includes('dreamforgestudio@mail.grokbot.com'));
    assert.ok(!shipped.includes('dreamforgestudio@mail.hubbot.com'));
    const current = between(log, '## 0.3.5 - ', '## 0.3.4 - ');
    assert.ok(current.includes('In 0.3.2 the default'));
    assert.ok(current.includes('dreamforgestudio@mail.hubbot.com'));
  });

  test('SETUP §6, the README, and the site list every unprefixed collection src opens', () => {
    const names = unprefixedCollections();
    assert.ok(names.includes('persons'));
    assert.ok(names.includes('invites'));
    const setup = between(read('docs/SETUP.md'), '6. **One database per EMET instance.**', '\n7. **');
    const readme = between(read('README.md'), '- These collections are not prefixed', '\n- Dynamic Client');
    const siteLists = [...read('site/index.html').matchAll(/These collections are not prefixed:([\s\S]*?)<\/li>/g)].map((match) => match[1]);
    assert.strictEqual(siteLists.length, 2);
    for (const name of names) {
      assert.ok(setup.includes('`' + name + '`'), `SETUP §6 ${name}`);
      assert.ok(readme.includes('`' + name + '`'), `README ${name}`);
      for (const block of siteLists) assert.ok(block.includes('>' + name + '<'), `site ${name}`);
    }
  });
});

function walkText(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walkText(abs, out);
      continue;
    }
    if (/\.(md|html|json|example)$/.test(entry.name) || entry.name === '.env.example') out.push(abs);
  }
  return out;
}

testGroup('hosted-deployment comments do not name the old host', () => {
  test('src comments do not say Railway EMET', () => {
    const hits = [];
    for (const file of walkJs(path.join(ROOT, 'src'))) {
      if (fs.readFileSync(file, 'utf8').includes('Railway EMET')) hits.push(path.relative(ROOT, file));
    }
    assert.deepStrictEqual(hits, []);
  });
});

summary('docs currency');
