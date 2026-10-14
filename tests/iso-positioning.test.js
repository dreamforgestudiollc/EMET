/**
 * EMET - the ISO document-control positioning is standing (the user,
 * 2026-10-11). CHARTER.md §7 holds the exact repository description, and the
 * README keeps its "Document control" section and the "built for" wording. A
 * documentation or site pass that drops either fails here first. The
 * repository description on GitHub is set by hand from the charter text.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ABOUT = 'EMET is an MCP memory server built for ISO 9001 / ISO 13485 document control: persistent, shared memory for AI agents and bot teams. Nothing is deleted; records are superseded, retired and retained. Controlled templates, verified writes, a word-for-word transcript tier, stdio and remote HTTP with OAuth, on MongoDB.';
const HEADING = '## Document control (ISO 9001 7.5.3 / ISO 13485 4.2.5)';

testGroup('the ISO positioning does not drift', () => {
  test('the charter states the repository description exactly', () => {
    assert.ok(read('CHARTER.md').includes(`> ${ABOUT}\n`));
  });
  test('the README keeps the document control section and the built-for wording', () => {
    const readme = read('README.md');
    assert.ok(readme.includes(`\n${HEADING}\n`), HEADING);
    const at = readme.indexOf(HEADING);
    const section = readme.slice(at, readme.indexOf('\n## ', at + HEADING.length));
    assert.match(section, /built for document control in environments that work under ISO 9001 and ISO 13485/);
    assert.match(section, /claims no conformity/);
    for (const term of ['No delete', 'superseded', 'retire_doc', 'read_doc_history', 'never patched', 'controlled documents', 'write-path.test.js']) {
      assert.ok(section.includes(term), term);
    }
  });
  test('neither claims certification', () => {
    for (const text of [ABOUT, read('README.md')]) assert.ok(!/\b(is|are) (ISO[ -]?)?certified\b|\bISO[ -]compliant\b/i.test(text));
  });
});

summary();
