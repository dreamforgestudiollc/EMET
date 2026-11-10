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
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walkJs(abs, out);
      continue;
    }
    if (entry.name.endsWith('.js')) out.push(abs);
  }
  return out;
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

  test('the report address in current docs is the code default', () => {
    assert.strictEqual(DEFAULT_REPORT_EMAIL, 'dreamforgestudio@mail.hubbot.com');
    for (const rel of ['README.md', 'site/index.html', '.env.example', 'docs/features/errors.md', 'docs/DEPLOY.md', 'docs/ERROR-CODES-SPEC.md']) {
      assert.ok(read(rel).includes(DEFAULT_REPORT_EMAIL), rel);
    }
    for (const rel of ['README.md', 'site/index.html', '.env.example', 'docs/features/errors.md']) {
      assert.ok(!read(rel).includes('dreamforgestudio@mail.grokbot.com'), rel);
    }
  });
});

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
