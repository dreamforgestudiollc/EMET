/**
 * Commitment 1 names the client-executed RUNE carve-out in the words of the
 * private charter, and the ISO 9001 7.5.3 / ISO 13485 4.2.5 lines stay.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const charter = fs.readFileSync(path.join(ROOT, 'CHARTER.md'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const ABOUT = 'EMET is an MCP memory server built for ISO 9001 / ISO 13485 document control: persistent, shared memory for AI agents and bot teams. Nothing is deleted; records are superseded, retired and retained. Controlled templates, verified writes, a word-for-word transcript tier, stdio and remote HTTP with OAuth, on MongoDB.';

testGroup('the charter carve-out is the private sentence', () => {
  test('commitment 1 and the extension socket say EMET verifies the record, not the computation', () => {
    assert.ok(charter.includes('EMET verifies the record, not the computation.'));
    assert.ok(charter.includes('A client-executed RUNE is the carve-out stated on the Extension socket (§4): EMET verifies the record, not the computation.'));
    assert.ok(charter.includes('**Client execution, a carve-out from commitment 1 (2026-10-16):** EMET verifies the record, not the computation. Client-executed RUNE results are recorded as attested by the client; they are replayable from recorded inputs, not re-executed by EMET. The socket does not run RUNE code.'));
  });
  test('the ISO 9001 7.5.3 / ISO 13485 4.2.5 lines are unchanged', () => {
    assert.ok(charter.includes(`> ${ABOUT}\n`));
    assert.ok(charter.includes('Document control (ISO 9001 7.5.3 / ISO 13485 4.2.5)'));
    assert.ok(readme.includes('## Document control (ISO 9001 7.5.3 / ISO 13485 4.2.5)'));
    assert.match(readme, /built for document control in environments that work under ISO 9001 and ISO 13485/);
  });
});

summary('CHARTER CARVE-OUT TEST SUMMARY');
