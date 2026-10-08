/**
 * EMET - dual-dispatch drift test (work list C4).
 *
 * One source tree, two transports: index.js (stdio) and http-remote.js (HTTP)
 * each carry a switch that maps a tool name to a handler. The tool LIST comes
 * from tools.js. Three things can drift apart silently: a tool declared but
 * dispatched on only one transport, a case that names a tool that no longer
 * exists, and a case present on one transport and absent on the other. The
 * `session_id` / `conversation_id` divergence (an earlier fix) was this class of
 * defect. This test reads both switches and the declared list and fails on
 * any difference.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TOOLS, createSuccessResponse, attachWarnings } from '../src/tools.js';
import { sourceOf, requireRegisteredSource } from '../src/dispatch.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');


/** Every `case '<name>':` / `case "<name>":` in a file, in order. */
function casesIn(file) {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8');
  const out = [];
  const re = /^\s*case\s+(['"])([A-Za-z_][\w]*)\1\s*:/gm;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[2]);
  return out;
}

const declared = TOOLS.map((t) => t.name);
const table = casesIn('dispatch.js');
const stdio = casesIn('index.js');
const http = casesIn('http-remote.js');
const diff = (a, b) => a.filter((x) => !b.includes(x));

// 2026-09-27 (code audit, finding 1.1): the two per-transport switches are gone.
// src/dispatch.js is the one table; each transport routes callTool through it.
// What this test now guards: the table matches the declared list exactly, and
// neither transport has grown a switch of its own again.
testGroup('The declared tool list and the one dispatch table agree', () => {
  test('every declared tool is in the dispatch table', () => {
    assert.deepStrictEqual(diff(declared, table), [], `declared but not in dispatch.js: ${diff(declared, table).join(', ')}`);
  });
  test('the table dispatches nothing that is not declared', () => {
    assert.deepStrictEqual(diff(table, declared), [], `in dispatch.js but not declared: ${diff(table, declared).join(', ')}`);
  });
  test('no tool is dispatched twice', () => {
    assert.strictEqual(new Set(table).size, table.length, 'duplicate case in dispatch.js');
  });
  test('the declared list has no duplicate names', () => {
    assert.strictEqual(new Set(declared).size, declared.length);
  });
  test('neither transport carries a tool switch of its own', () => {
    assert.deepStrictEqual(stdio, [], `index.js dispatches tools itself: ${stdio.join(', ')}`);
    assert.deepStrictEqual(http, [], `http-remote.js dispatches tools itself: ${http.join(', ')}`);
  });
  test('both transports route through dispatch.js', () => {
    for (const file of ['index.js', 'http-remote.js']) {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8');
      assert.ok(/['"]\.\/dispatch\.js['"]/.test(src), `${file} does not import dispatch.js`);
      assert.ok(/dispatchTool\(name, args, \{ dbManager, logger, AuditOperation \}\)/.test(src), `${file}: callTool does not hand the transport context to dispatchTool`);
    }
  });
});

testGroup('The dispatch table passes the right arguments to the doors', () => {
  const tableSrc = fs.readFileSync(path.join(SRC, 'dispatch.js'), 'utf8');
  const stdioSrc = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const httpSrc = fs.readFileSync(path.join(SRC, 'http-remote.js'), 'utf8');
  test('no transport or the table stamps a source tag before saveMemory (A3: the door decides)', () => {
    for (const [name, src] of [['index.js', stdioSrc], ['http-remote.js', httpSrc], ['dispatch.js', tableSrc]]) {
      assert.ok(!/tagMeta\s*\(/.test(src), `${name} calls tagMeta`);
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.ok(!/SOURCE_TAG/.test(code), `${name} references SOURCE_TAG in code`);
      assert.ok(!/source\s*[:=]\s*setting\(/.test(src), `${name} sets source from setting()`);
    }
  });
  test('query_transcripts passes session_id and no legacy alias (the alias-drift class; audit 1.5a)', () => {
    const i = tableSrc.indexOf("case 'query_transcripts'");
    const line = tableSrc.slice(i, tableSrc.indexOf('\n', i));
    assert.ok(/args\.session_id/.test(line), 'query_transcripts dispatch does not pass session_id');
    assert.ok(!/conversation_id/.test(tableSrc), 'the conversation_id alias is back');
  });
  test('setupComplete receives the logger (the argument drift the audit found)', () => {
    assert.ok(/setupComplete\(args\.answers \|\| \{\}, logger[,)]/.test(tableSrc));
  });
  // 2026-09-27 (code audit 1.5c, the owner): one name for the source tag on every write.
  test('sourceOf prefers `source` and reads the four older names as aliases', () => {
    assert.strictEqual(sourceOf({ source: 'a', updated_by: 'b' }), 'a');
    assert.strictEqual(sourceOf({ updated_by: 'b' }), 'b');
    assert.strictEqual(sourceOf({ retired_by: 'c' }), 'c');
    assert.strictEqual(sourceOf({ accepted_by: 'd' }), 'd');
    assert.strictEqual(sourceOf({ channel: 'e' }), 'e');
    assert.strictEqual(sourceOf({}), null);
  });
  test('every document and transcript write in the table takes its tag from sourceOf', () => {
    for (const tool of ['write_doc', 'patch_doc', 'retire_doc', 'rename_doc', 'accept_nonconformance', 'save_transcript', 'revise_transcript', 'emet_transcript_append']) {
      const i = tableSrc.indexOf(`case '${tool}'`);
      const line = tableSrc.slice(i, tableSrc.indexOf('\n', i));
      assert.ok(/sourceOf\(args\)/.test(line), `${tool} does not use sourceOf`);
      assert.ok(!/args\.(updated_by|retired_by|accepted_by|channel)\b/.test(line), `${tool} still reads an old name directly`);
    }
  });
  // 2026-09-27 (code audit 1.5d, the owner: "validate"): a transcript write names a registered host.
  test('a transcript write with an unregistered source tag is refused, naming the registry', () => {
    const prev = process.env.EMET_SOURCE_TAGS;
    process.env.EMET_SOURCE_TAGS = 'cli,mobile,cloud-host';
    try {
      assert.strictEqual(requireRegisteredSource('mobile', 'save_transcript'), 'mobile');
      assert.throws(() => requireRegisteredSource('cloud-scheduled-intake', 'save_transcript'), /"cloud-scheduled-intake" is not registered/);
      assert.throws(() => requireRegisteredSource('claude_project', 'save_transcript'), (e) => /"claude_project" is not registered/.test(e.message) && !/cli, mobile, cloud-host/.test(e.message));
      assert.throws(() => requireRegisteredSource(null, 'emet_transcript_append'), /Validation failed for 'source': emet_transcript_append: pass "source"[\s\S]*one is required/);
      assert.strictEqual(requireRegisteredSource(null, 'revise_transcript', true), null, 'revise_transcript may omit it (parent\'s)');
    } finally { if (prev === undefined) delete process.env.EMET_SOURCE_TAGS; else process.env.EMET_SOURCE_TAGS = prev; }
  });
  test('with no registry configured any non-empty tag passes, an empty one still does not', () => {
    const prev = process.env.EMET_SOURCE_TAGS;
    delete process.env.EMET_SOURCE_TAGS;
    try {
      assert.strictEqual(requireRegisteredSource('anything', 'save_transcript'), 'anything');
      assert.throws(() => requireRegisteredSource('', 'save_transcript'), /required/);
    } finally { if (prev !== undefined) process.env.EMET_SOURCE_TAGS = prev; }
  });
  test('the three transcript writes go through requireRegisteredSource; write_doc no longer takes path_hint', () => {
    for (const tool of ['save_transcript', 'revise_transcript', 'emet_transcript_append']) {
      const i = tableSrc.indexOf(`case '${tool}'`);
      const line = tableSrc.slice(i, tableSrc.indexOf('\n', i));
      assert.ok(/requireRegisteredSource\(/.test(line), `${tool} does not validate its source`);
    }
    assert.ok(!TOOLS.find((t) => t.name === 'write_doc').inputSchema.properties.path_hint, 'path_hint is back in the write_doc schema');
    assert.ok(!/args\.path_hint/.test(tableSrc), 'the table still reads path_hint');
  });
  test('every write tool advertises `source` in its schema', () => {
    for (const tool of ['write_doc', 'patch_doc', 'retire_doc', 'rename_doc', 'accept_nonconformance', 'save_transcript', 'revise_transcript', 'emet_transcript_append']) {
      const def = TOOLS.find((t) => t.name === tool);
      assert.ok(def.inputSchema.properties.source, `${tool} schema has no source`);
    }
  });
});

// The envelope is the one surface both transports share, which is why the
// caller-facing advisory lives there rather than in either dispatch switch.
// A server-side warn() cannot reach the caller at all, and on the HTTP
// transport it does not even reach a log - that logger discards warn().
testGroup('Response envelope carries caller-facing warnings', () => {
  const envelopeOf = (response) => JSON.parse(response.content[0].text);

  test('an array payload with no warnings produces no warnings field', () => {
    const envelope = envelopeOf(createSuccessResponse([{ id: 1 }], 'query_layer'));
    assert.strictEqual('warnings' in envelope, false);
    assert.deepStrictEqual(envelope.data, [{ id: 1 }]);
  });

  test('attachWarnings surfaces in the envelope beside data', () => {
    const rows = attachWarnings([{ id: 1 }], ['Ignored unrecognised filter key(s): memory_id.']);
    const envelope = envelopeOf(createSuccessResponse(rows, 'query_layer'));
    assert.deepStrictEqual(envelope.warnings, ['Ignored unrecognised filter key(s): memory_id.']);
    assert.deepStrictEqual(envelope.data, [{ id: 1 }]);
  });

  test('attachWarnings does not change what the array itself serialises to', () => {
    const rows = attachWarnings([{ id: 1 }], ['anything']);
    assert.strictEqual(JSON.stringify(rows), JSON.stringify([{ id: 1 }]));
    assert.strictEqual(rows.length, 1);
  });

  test('attachWarnings is a no-op for non-arrays and empty advisories', () => {
    assert.deepStrictEqual(attachWarnings([{ id: 1 }], []).warnings, undefined);
    const receipt = { verified: true, warnings: ['inside data'] };
    assert.strictEqual(attachWarnings(receipt, ['ignored']).warnings.length, 1);
  });

  test('an object payload keeps its own warnings inside data and is not hoisted', () => {
    const envelope = envelopeOf(createSuccessResponse({ verified: true, warnings: ['inside'] }, 'save_to_layer'));
    assert.strictEqual('warnings' in envelope, false);
    assert.deepStrictEqual(envelope.data.warnings, ['inside']);
  });
});

testGroup('Every tool call is audited on both transports (security audit H6, 2026-09-19)', () => {
  // Before this, logger.audit fired inside three tool functions and nowhere
  // else, so twenty-four tools left no audit entry. The floor is one TOOL_CALL
  // entry per dispatch, on each transport, written where no tool can skip it.
  const handlerOf = (file) => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const start = src.indexOf('setRequestHandler(CallToolRequestSchema');
    assert.ok(start >= 0, `${file}: CallToolRequestSchema handler not found`);
    return src.slice(start, src.indexOf('async function callTool', start));
  };
  for (const file of ['index.js', 'http-remote.js']) {
    test(`${file} audits TOOL_CALL in the dispatch handler itself`, () => {
      const handler = handlerOf(file);
      assert.ok(/logger\.audit\(AuditOperation\.TOOL_CALL,/.test(handler), `${file}: no TOOL_CALL audit in the handler`);
      assert.ok(/callTool\(name, args\)/.test(handler), `${file}: the handler must route through callTool so the audit wraps every case`);
    });
  }
  test('the audit entry carries the tool name and outcome, never the arguments', () => {
    for (const file of ['index.js', 'http-remote.js']) {
      const line = handlerOf(file).match(/logger\.audit\(AuditOperation\.TOOL_CALL,[^\n]*/)[0];
      assert.ok(/tool: name/.test(line) && /success:/.test(line) && /durationMs/.test(line), `${file}: ${line}`);
      assert.ok(!/args/.test(line), `${file}: arguments must not reach the audit line`);
      // 2026-09-27 (code audit 1.6, the owner): parameter NAMES are recorded, values never.
      assert.ok(/params: paramNames/.test(line), `${file}: the audit line does not carry the parameter names`);
      const decl = handlerOf(file).match(/const paramNames = ([^\n]*)/);
      assert.ok(decl && /Object\.keys\(/.test(decl[1]) && !/Object\.values|JSON\.stringify\(args/.test(decl[1]), `${file}: paramNames must be keys only`);
    }
  });
});

summary('Dispatch Drift Test Summary');
