/**
 * EMET - tool annotation tests.
 *
 * No database, no credentials: these assert the shape of what every host is
 * handed. An unannotated tool is treated by a cautious host as if it might do
 * anything, so "every tool declares all four hints" is a contract, not a
 * nicety, and it belongs in a test rather than in a review habit.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { TOOLS } from '../src/tools.js';
import { TOOL_ANNOTATIONS, annotate } from '../src/annotations.js';





const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

testGroup('Every tool is annotated', () => {
  test('TOOLS is non-empty', () => assert(TOOLS.length > 0));
  test('every tool has an annotations object', () => {
    const missing = TOOLS.filter(t => !t.annotations).map(t => t.name);
    assert.deepStrictEqual(missing, [], `unannotated: ${missing.join(', ')}`);
  });
  test('every tool declares all four hints as booleans', () => {
    for (const tool of TOOLS) {
      for (const hint of HINTS) {
        assert.strictEqual(typeof tool.annotations[hint], 'boolean', `${tool.name}.${hint}`);
      }
    }
  });
  test('every tool has a human-readable title', () => {
    for (const tool of TOOLS) assert(typeof tool.annotations.title === 'string' && tool.annotations.title.length > 0, tool.name);
  });
  test('annotating did not drop inputSchema', () => {
    for (const tool of TOOLS) assert(tool.inputSchema, `${tool.name} lost its inputSchema`);
  });
  test('no annotation entry exists for a tool that does not exist', () => {
    const names = new Set(TOOLS.map(t => t.name));
    const orphans = Object.keys(TOOL_ANNOTATIONS).filter(n => !names.has(n));
    assert.deepStrictEqual(orphans, [], `orphaned entries: ${orphans.join(', ')}`);
  });
});

testGroup('The declarations say what EMET actually is', () => {
  test('openWorldHint is false on every tool - EMET reaches only its own store', () => {
    for (const tool of TOOLS) assert.strictEqual(tool.annotations.openWorldHint, false, tool.name);
  });
  test('read tools are marked read-only', () => {
    for (const name of ['read_doc', 'list_docs', 'recall', 'query_layer', 'query_transcripts']) {
      const tool = TOOLS.find(t => t.name === name);
      assert(tool, `${name} missing`);
      assert.strictEqual(tool.annotations.readOnlyHint, true, name);
    }
  });
  test('write tools are not marked read-only', () => {
    for (const name of ['write_doc', 'patch_doc', 'save_to_layer', 'save_transcript']) {
      const tool = TOOLS.find(t => t.name === name);
      assert(tool, `${name} missing`);
      assert.strictEqual(tool.annotations.readOnlyHint, false, name);
    }
  });
  test('a read-only tool is never also marked destructive', () => {
    for (const tool of TOOLS) {
      if (tool.annotations.readOnlyHint) assert.strictEqual(tool.annotations.destructiveHint, false, tool.name);
    }
  });
  test('document replacement is marked destructive', () => {
    for (const name of ['write_doc', 'patch_doc']) {
      assert.strictEqual(TOOLS.find(t => t.name === name).annotations.destructiveHint, true, name);
    }
  });
  test('additive writes are not marked destructive', () => {
    for (const name of ['emet_session_close', 'save_to_layer', 'revise_memory']) {
      assert.strictEqual(TOOLS.find(t => t.name === name).annotations.destructiveHint, false, name);
    }
  });
  test('revise_memory is additive - supersession never destroys the parent', () => {
    assert.strictEqual(TOOLS.find(t => t.name === 'revise_memory').annotations.destructiveHint, false);
  });
  test('emet_status is not read-only - with probe: true it writes a probe on purpose', () => {
    assert.strictEqual(TOOLS.find(t => t.name === 'emet_status').annotations.readOnlyHint, false);
  });
});

testGroup('annotate() fails loudly rather than silently', () => {
  test('throws when a tool has no annotation entry', () => {
    assert.throws(() => annotate([{ name: 'a_tool_nobody_annotated', inputSchema: {} }]), /no annotation entry/);
  });
  test('names the offending tool in the error', () => {
    try { annotate([{ name: 'unlisted_tool', inputSchema: {} }]); assert.fail('should have thrown'); }
    catch (e) { assert(e.message.includes('unlisted_tool')); }
  });
  test('passes through a correctly annotated tool', () => {
    const [out] = annotate([{ name: 'read_doc', inputSchema: {} }]);
    assert.strictEqual(out.annotations.readOnlyHint, true);
  });
});

summary('ANNOTATION TEST SUMMARY');
