#!/usr/bin/env node
/**
 * verify-emet — drive EMET the way a plain install would.
 *
 * The process uses a temporary directory and the in-memory test database in
 * tests/memstore.js. It does not read .env and it does not keep the parent
 * process's EMET or database settings. A tool that still needs a service or
 * setting a plain install does not have is reported as a gap and is not given
 * a stand-in success. A run whose only problems are gaps exits 3. A tool
 * that failed exits 1.
 *
 *   node scripts/verify-emet.mjs doctor
 *   node scripts/verify-emet.mjs list
 *   node scripts/verify-emet.mjs run [tool...]
 *   node scripts/verify-emet.mjs feature <id>
 *   node scripts/verify-emet.mjs --help
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fileURLToPath(import.meta.url);
const STANDALONE_URI = 'mongodb://127.0.0.1:9/emet-verify-standalone';
const SOURCE = 'verify-host';
const FEATURE_DIR = path.join(ROOT, 'docs', 'features');

/** Tools a plain temp database cannot honestly exercise. Calling them against
 *  the in-memory store would return an empty vector search and look like success. */
export const STANDALONE_GAPS = Object.freeze([
  {
    tool: 'semantic_recall',
    feature: 'search',
    need: 'A vector search index on the six memory collections. The standalone test database has no vector index.',
    instead: 'Use recall or query_layer. Those search the words you stored. semantic_recall works after that index exists on your own database.'
  },
  {
    tool: 'corpus_recall',
    feature: 'search',
    need: 'A corpus collection you load yourself, plus a vector search index. A plain install has neither.',
    instead: 'Leave corpus_recall until you have loaded a corpus. It is not where session memory lives. Use recall for session memory.'
  },
  {
    tool: 'emet_subkey_request',
    feature: 'subkeys',
    need: 'EMET_SUBKEYS=1, an owner-generated pepper, and an authenticated owner login over HTTP. A standalone temp run has none of these, so the tool is not registered.',
    instead: 'Leave sub-keys off for a single client. To turn them on, set the flag and a pepper you generate, then start the server again. See docs/features/subkeys.md.'
  },
  {
    tool: 'emet_subkey_claim',
    feature: 'subkeys',
    need: 'A one-time nonce from emet_subkey_request, which itself needs sub-keys and an owner HTTP login.',
    instead: 'Request a key from the owner login first. A standalone temp run cannot mint one. See docs/features/subkeys.md.'
  },
  {
    tool: 'emet_subkey_revoke',
    feature: 'subkeys',
    need: 'A live sub-key, which a standalone temp run does not create.',
    instead: 'Revoke from the owner login after a key exists. See docs/features/subkeys.md.'
  },
  {
    tool: 'emet_subkey_end_session',
    feature: 'subkeys',
    need: 'A live sub-key session. Standalone mode does not open one.',
    instead: 'End the session from the owner login when a bot is stuck and the key should stay usable. See docs/features/subkeys.md.'
  }
]);

export const FEATURES = Object.freeze([
  { id: 'startup', file: 'startup.md', title: 'Startup', tools: ['emet_initialize', 'emet_setup_complete', 'emet_status'] },
  { id: 'memory', file: 'memory.md', title: 'Memory layers', tools: ['save_to_layer', 'recall', 'query_layer', 'revise_memory'] },
  { id: 'search', file: 'search.md', title: 'Search beyond keywords', tools: ['semantic_recall', 'corpus_recall'] },
  { id: 'transcripts', file: 'transcripts.md', title: 'Transcripts', tools: ['emet_session_open', 'emet_transcript_append', 'save_transcript', 'query_transcripts', 'revise_transcript', 'emet_session_close'] },
  { id: 'documents', file: 'documents.md', title: 'Documents', tools: ['read_doc', 'read_doc_history', 'write_doc', 'list_docs', 'patch_doc', 'retire_doc', 'rename_doc', 'restore_doc', 'validate_doc', 'accept_nonconformance'] },
  { id: 'pages', file: 'pages.md', title: 'Topic pages', tools: ['emet_page', 'emet_pages', 'emet_page_lint'] },
  { id: 'errors', file: 'errors.md', title: 'Error codes and the error log', tools: ['emet_error_report'] },
  { id: 'record', file: 'record.md', title: 'The record and the floor', tools: ['emet_gaps', 'emet_floor'] },
  { id: 'access', file: 'access.md', title: 'Access', tools: ['emet_client_approve', 'emet_invite_create', 'emet_member_access_create'] },
  { id: 'subkeys', file: 'subkeys.md', title: 'Client sub-keys', tools: ['emet_subkey_request', 'emet_subkey_claim', 'emet_subkey_revoke', 'emet_subkey_end_session'] },
  { id: 'gems', file: 'gems.md', title: 'GEMs', tools: [] }
]);

const EXPECT_REFUSAL = Object.freeze({
  emet_invite_create: 'EMET-AUTH-030',
  emet_member_access_create: 'EMET-AUTH-034'
});

const KEEP_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'TERM', 'NODE_OPTIONS'];

export function gapFor(tool) {
  return STANDALONE_GAPS.find((gap) => gap.tool === tool) || null;
}

export function featureById(id) {
  return FEATURES.find((feature) => feature.id === id) || null;
}

export function parseArgs(argv) {
  const flags = { json: false, dryRun: false, help: false, worker: false };
  const rest = [];
  for (const arg of argv) {
    if (arg === '--json') flags.json = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--worker') flags.worker = true;
    else if (arg.startsWith('-')) {
      const err = new Error(`verify-emet: unknown option ${arg}.\nRun verify-emet --help to see the options that exist.`);
      err.exitCode = 2;
      throw err;
    } else rest.push(arg);
  }
  return { command: rest[0] || 'run', positionals: rest.slice(1), flags };
}

export function helpText() {
  return `verify-emet — drive a standalone EMET and report what a plain install cannot do

The command brings EMET up in a temporary directory. The database is the
in-memory store the test suite already uses (tests/memstore.js). The parent
process's EMET settings and .env file are not used. Nothing here is a release
check against your real database.

Subcommands
  doctor              Check Node, the temp directory, and the test database.
                      Prints every known standalone gap. Exits 3 while any gap
                      remains, and 1 if Node or the test database is the
                      problem, so a green doctor cannot hide a missing service.
  list                List feature ids and the tools a plain process registers
                      (sub-keys off). With no extra arguments this is a catalog,
                      not a drive.
  run [tool...]       Drive every registered tool, or just the tools you name.
                      A tool in the gap list is reported and not called.
  feature <id>        Drive one feature from docs/features. The id is the file
                      name without .md. Run list to see the ids.

Options
  --json              Print one JSON object on stdout and nothing else.
  --dry-run           Do not call a tool whose annotation says it can replace
                      or hand out access, and do not run the emet_status write
                      probe. The report says "skipped" and names the call that
                      a real run would make.
  --help, -h          Show this guide.

Exit codes
  0                   Every tool that was driven passed, and the selection
                      contained no standalone gap.
  1                   A tool failed, Node is older than 22, or the test
                      database is missing. The message says what to do
                      instead.
  2                   The command line was not understood.
  3                   The only problems are standalone gaps. Each gap says
                      what to do instead. Do not treat a gap as a crash.

Examples
  npm run verify
  npm run verify -- doctor --json
  npm run verify -- list
  npm run verify -- run emet_floor recall
  npm run verify -- run --dry-run
  npm run verify -- feature errors
  node scripts/verify-emet.mjs feature startup

A gap means the tool is real and registered (or registered once its flag is on)
and this standalone process cannot exercise it without a service or setting a
plain npm install does not have. Fixing the product is separate work. This
command only names the gap.
`;
}

function standaloneEnv(base = process.env) {
  const env = {};
  for (const key of KEEP_ENV) if (base[key]) env[key] = base[key];
  return env;
}

function blankDotenvKeys() {
  const blanked = [];
  let raw = '';
  try { raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return blanked; }
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = '';
    blanked.push(key);
  }
  return blanked;
}

function nodeOk() {
  const major = Number(process.versions.node.split('.')[0]);
  return { version: process.version, ok: major >= 22, major };
}

function emit(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = [];
  lines.push(`verify-emet ${report.command}${report.dry_run ? ' (dry-run)' : ''}`);
  if (report.node) lines.push(`node: ${report.node}${report.node_ok ? '' : ' — install Node.js 22 or newer and run this again'}`);
  if (report.database) lines.push(`database: ${report.database}`);
  if (report.temp_dir) lines.push(`temp: ${report.temp_dir}`);
  if (report.features) {
    lines.push('');
    lines.push('features:');
    for (const feature of report.features) lines.push(`  ${feature.id}  ${feature.title}  docs/features/${feature.file}`);
  }
  if (report.registered_tools) {
    lines.push('');
    lines.push('registered tools (sub-keys off):');
    for (const name of report.registered_tools) lines.push(`  ${name}`);
  }
  if (report.results) {
    lines.push('');
    for (const row of report.results) {
      const tag = row.status === 'pass' ? 'PASS' : row.status === 'gap' ? 'GAP' : row.status === 'skipped' ? 'SKIP' : 'FAIL';
      lines.push(`${tag}  ${row.tool}${row.detail ? `  ${row.detail}` : ''}`);
      if (row.need) lines.push(`      needs: ${row.need}`);
      if (row.instead) lines.push(`      instead: ${row.instead}`);
    }
  }
  if (report.instead) lines.push(`\n${report.instead}`);
  if (report.hint) lines.push(`\n${report.hint}`);
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function usage(message) {
  const report = {
    ok: false,
    command: 'usage',
    instead: message,
    hint: 'Run verify-emet --help for the subcommands and options.'
  };
  return report;
}

function gapRow(gap) {
  return { tool: gap.tool, feature: gap.feature, status: 'gap', need: gap.need, instead: gap.instead };
}

export function finishCode(report) {
  const results = report.results || [];
  const failed = results.some((row) => row.status === 'fail');
  const gaps = results.some((row) => row.status === 'gap') || (report.gaps || []).length > 0;
  if (report.node_ok === false) return 1;
  if (report.test_database_present === false) return 1;
  if (failed) return 1;
  if (gaps) return 3;
  return 0;
}

async function workerMain(argv) {
  const { command, positionals, flags } = parseArgs(argv);
  const blanked = blankDotenvKeys();
  process.env.MONGODB_URI = STANDALONE_URI;
  if (command === 'doctor') return doctor(flags, blanked);
  if (command === 'list') return list(flags);
  if (command === 'run') return drive(positionals, flags, blanked);
  if (command === 'feature') {
    if (!positionals[0]) {
      const report = usage('verify-emet: feature needs an id, for example "feature errors".\nRun verify-emet list to see the feature ids.');
      emit(report, flags.json);
      return 2;
    }
    const feature = featureById(positionals[0]);
    if (!feature) {
      const report = usage(`verify-emet: no feature "${positionals[0]}".\nThe ids are the file names in docs/features. Run verify-emet list.`);
      emit(report, flags.json);
      return 2;
    }
    if (!feature.tools.length) {
      const report = {
        ok: true,
        command: 'feature',
        feature: feature.id,
        dry_run: flags.dryRun,
        results: [],
        hint: `${feature.title} has no tool of its own. Read docs/features/${feature.file}. emet_floor and emet_status report the GEMs that are seated.`
      };
      emit(report, flags.json);
      return 0;
    }
    return drive(feature.tools, flags, blanked, feature.id);
  }
  const report = usage(`verify-emet: unknown command "${command}".\nUse doctor, list, run, or feature.`);
  emit(report, flags.json);
  return 2;
}

async function doctor(flags, blanked) {
  const node = nodeOk();
  const memstore = path.join(ROOT, 'tests', 'memstore.js');
  const present = fs.existsSync(memstore);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-verify-'));
  let storeOk = false;
  let storeError = null;
  if (present) {
    try {
      const { makeStore } = await import(pathToFileURL(memstore));
      const store = makeStore();
      storeOk = typeof store.collection === 'function' && typeof store.Client === 'function';
    } catch (error) {
      storeError = error.message;
    }
  }
  for (const key of blanked) delete process.env[key];
  const report = {
    ok: false,
    command: 'doctor',
    node: node.version,
    node_ok: node.ok,
    temp_dir: temp,
    database: present && storeOk ? 'in-memory test store (tests/memstore.js)' : 'missing',
    test_database_present: present && storeOk,
    host_env_used: false,
    mongodb_uri: process.env.MONGODB_URI === STANDALONE_URI ? 'standalone-placeholder' : 'unexpected',
    gaps: STANDALONE_GAPS.map(gapRow),
    results: STANDALONE_GAPS.map(gapRow)
  };
  if (!node.ok) report.hint = 'Install Node.js 22 or newer, then run verify-emet doctor again.';
  else if (!present || !storeOk) {
    report.hint = storeError
      ? `The test database module failed to load (${storeError}). Run this from a checkout that contains tests/memstore.js.`
      : 'tests/memstore.js is not in this tree. Clone the repository and run npm run verify from that checkout. A pack of the npm package does not include the test database.';
  } else report.hint = 'Doctor exits 3 while a standalone gap remains. The gaps are listed above. A tool failure exits 1. npm run verify drives the tools that can run.';
  report.ok = finishCode(report) === 0;
  emit(report, flags.json);
  return finishCode(report);
}

function pathToFileURL(file) {
  return new URL(`file://${file}`);
}

async function registeredNames() {
  delete process.env.EMET_SUBKEYS;
  delete process.env.CASCADE_SUBKEYS;
  const { hostTools } = await import('../src/tools.js');
  return hostTools().map((tool) => tool.name);
}

async function list(flags) {
  const names = await registeredNames();
  const report = {
    ok: true,
    command: 'list',
    features: FEATURES.map(({ id, title, file, tools }) => ({ id, title, file, tools })),
    registered_tools: names,
    gaps: STANDALONE_GAPS.map((gap) => gap.tool),
    hint: 'Run verify-emet feature <id> or verify-emet run [tool...]. --help explains --json and --dry-run.'
  };
  emit(report, flags.json);
  return 0;
}

function unwrap(result) {
  let body = null;
  try { body = JSON.parse(result?.content?.[0]?.text || 'null'); } catch { body = null; }
  return {
    isError: result?.isError === true,
    body,
    data: body && body.data !== undefined ? body.data : null,
    error: body && body.error ? body.error : null
  };
}

function errorText(parsed) {
  const message = parsed.error && (parsed.error.message || parsed.error.emet_code) || 'the tool returned an error';
  const code = parsed.error && parsed.error.emet_code;
  return code ? `${code}: ${message}` : String(message);
}

function short(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const AREA = (slug, title) => `# Area — ${title}

## §0 RECORD CONTROL
- Template: \`templates/AREA.md\` · Area revision: the store's version governs
- Slug: ${slug}
- Title: ${title}

## §1 SELECTOR
- **Layers:** semantic
- **Tags:** verify
- **Keywords:** none
- **Doc id prefixes:** notes/
- **Source clients:** any
- **Staleness days:** 30
- **Item cap:** 20

## §2 SCOPE
Selector for the ${slug} page. This document names what to look at.
`;

const BROKEN_AREA = `# Area — Broken

## §0 RECORD CONTROL
- Template: \`templates/AREA.md\` · Area revision: the store's version governs
- Slug: broken
- Title: Broken
`;

async function drive(only, flags, blanked, featureId = null) {
  const node = nodeOk();
  if (!node.ok) {
    const report = {
      ok: false, command: featureId ? 'feature' : 'run', feature: featureId, node: node.version, node_ok: false,
      hint: 'Install Node.js 22 or newer, then run this again.'
    };
    emit(report, flags.json);
    return 1;
  }
  const memstorePath = path.join(ROOT, 'tests', 'memstore.js');
  if (!fs.existsSync(memstorePath)) {
    const report = {
      ok: false, command: featureId ? 'feature' : 'run', feature: featureId, node: node.version, node_ok: true,
      test_database_present: false,
      hint: 'tests/memstore.js is missing. Clone the repository and run npm run verify there. Do not point this command at a database you care about in order to skip the test store.'
    };
    emit(report, flags.json);
    return 1;
  }

  const { makeStore, withStore } = await import(pathToFileURL(memstorePath));
  const { EmetDatabase } = await import('../src/database.js');
  const { dispatchTool } = await import('../src/dispatch.js');
  const { TOOL_ANNOTATIONS } = await import('../src/annotations.js');
  const { actorStore } = await import('../src/persons.js');
  const stdioActor = { personId: null, clientId: 'stdio', scopes: [], transport: 'stdio', authenticated: false };
  for (const key of blanked) if (key !== 'MONGODB_URI') delete process.env[key];
  process.env.MONGODB_URI = STANDALONE_URI;
  process.env.EMET_RESTORE_TAGS = SOURCE;
  delete process.env.EMET_SUBKEYS;
  delete process.env.CASCADE_SUBKEYS;
  delete process.env.EMET_INVITES;
  delete process.env.CASCADE_INVITES;
  delete process.env.EMET_MEMBER_ACCESS;
  delete process.env.CASCADE_MEMBER_ACCESS;
  delete process.env.EMET_SOURCE_TAGS;
  delete process.env.CASCADE_SOURCE_TAGS;

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-verify-'));
  process.chdir(temp);
  const store = makeStore();
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const dbManager = new EmetDatabase(silent);
  const ctx = { dbManager, logger: silent };
  const state = { loadId: null, sessionId: null, partId: null, memoryId: null, noteId: 'notes/verify.md', renamedId: 'notes/verify-renamed.md', areaId: 'areas/verify.md', brokenId: 'areas/broken.md', noteVersion: null };

  const selected = only.length ? new Set(only) : null;
  const results = [];

  function wanted(tool) {
    return !selected || selected.has(tool);
  }

  async function call(tool, args, { destructive = false, detail, required = false } = {}) {
    if (!required && !wanted(tool)) return null;
    const gap = gapFor(tool);
    if (gap) {
      results.push(gapRow(gap));
      return null;
    }
    const replaces = destructive || TOOL_ANNOTATIONS[tool]?.destructiveHint === true;
    if (flags.dryRun && replaces) {
      results.push({
        tool,
        status: 'skipped',
        detail: 'dry-run',
        instead: `Run without --dry-run to call ${tool}. Arguments would be ${JSON.stringify(args)}.`
      });
      return null;
    }
    let parsed;
    try {
      const raw = await withStore(store, () => actorStore.run(stdioActor, () => dispatchTool(tool, args, ctx)));
      parsed = unwrap(raw);
    } catch (error) {
      results.push({
        tool,
        status: 'fail',
        detail: short(error.message),
        instead: `The call threw before it returned a tool result. Read docs/features for ${tool} and run verify-emet run ${tool} again after the store is reachable.`
      });
      return null;
    }
    if (parsed.isError) {
      const code = parsed.error && parsed.error.emet_code;
      if (EXPECT_REFUSAL[tool] && code === EXPECT_REFUSAL[tool]) {
        results.push({ tool, status: 'pass', detail: `refused with ${code}, which is what a plain install does while that door is off` });
        return null;
      }
      results.push({
        tool,
        status: 'fail',
        detail: short(errorText(parsed)),
        instead: short(parsed.error && parsed.error.message) || `Run verify-emet feature ${featureOf(tool)} and follow the gotcha for ${tool}.`
      });
      return null;
    }
    results.push({ tool, status: 'pass', detail: detail ? detail(parsed.data) : undefined });
    return parsed.data;
  }

  const floorOnly = selected && [...selected].every((tool) => tool === 'emet_floor' || gapFor(tool));
  const prefix = !floorOnly && (!selected || needsWrite(selected) || wanted('emet_initialize') || wanted('emet_setup_complete') || wanted('emet_session_open') || wanted('emet_transcript_append') || wanted('read_doc') || wanted('emet_error_report') || wanted('emet_status') || wanted('list_docs') || wanted('emet_gaps'));

  if (prefix) {
    const first = await call('emet_initialize', { page: 'all' }, { required: !selected || wanted('emet_initialize'), detail: (data) => `state ${data && data.state || 'unknown'}` });
    if (first && first.state === 'setup_required') state.loadId = first.startup_page && first.startup_page.load_id;
    await call('emet_setup_complete', {
      answers: {
        assistant_name: 'Verifier',
        assistant_character: 'Plain and careful. It checks the record and does not invent.',
        user_name: 'Verify User',
        user_context: 'A standalone check of this install.',
        user_preferences: 'Short answers.',
        source_tag: SOURCE,
        more_than_one_bot: 'no',
        bot_team_backup: 'no'
      },
      source: SOURCE
    }, { required: !selected || needsWrite(selected) || wanted('emet_setup_complete'), destructive: true, detail: (data) => data && data.ok ? 'interview recorded' : 'setup returned' });
    const ready = await call('emet_initialize', { page: 'all' }, { required: true, detail: (data) => `state ${data && data.state || 'unknown'}` });
    if (ready && ready.startup_page) state.loadId = ready.startup_page.load_id;
    if (state.loadId && (!selected || needsWrite(selected) || wanted('emet_session_open') || wanted('emet_transcript_append'))) {
      const opened = await call('emet_session_open', { slug: 'verify', load_id: state.loadId }, {
        required: !selected || needsWrite(selected) || wanted('emet_session_open'),
        detail: (data) => `session ${data && data.session_id || 'opened'}`
      });
      if (opened && opened.session_id) state.sessionId = opened.session_id;
      if (state.sessionId && (!selected || needsWrite(selected) || wanted('emet_transcript_append'))) {
        const appended = await call('emet_transcript_append', {
          session_id: state.sessionId,
          user_message: 'Start the standalone check.',
          assistant_message: 'no local shell MCP. The check is running.',
          exchange_index: 1,
          source: SOURCE
        }, { required: !selected || needsWrite(selected) || wanted('emet_transcript_append'), detail: () => 'exchange 1 stored' });
        if (appended && appended.session_id) state.partId = appended.session_id;
      }
    }
  }

  await call('emet_floor', { compact: true }, { detail: (data) => data && data.compact ? 'compact floor' : 'floor' });
  await call('emet_status', {}, { detail: (data) => data && data.initialized === true ? 'initialized' : `initialized ${data && data.initialized}` });
  if (wanted('emet_status')) {
    await call('emet_status', { probe: true }, {
      destructive: true,
      detail: (data) => data && data.probe && data.probe.ok ? 'probe passed' : 'probe returned'
    });
  }

  await call('list_docs', {}, { detail: (data) => `${data && data.count != null ? data.count : 0} documents` });
  await call('read_doc', { doc_id: 'bootstrap/USER.md' }, { detail: (data) => `version ${data && data.version}` });
  await call('read_doc_history', { doc_id: 'bootstrap/USER.md' }, { detail: (data) => data && data.revisions ? `${data.revisions.length} revisions` : 'history' });
  await call('validate_doc', { doc_id: 'bootstrap/USER.md' }, { detail: (data) => data && (data.verdict || data.result && data.result.verdict) || 'checked' });

  const sessionArgs = state.sessionId ? { session_id: state.sessionId, source: SOURCE } : { source: SOURCE };
  const note = await call('write_doc', {
    ...sessionArgs,
    doc_id: state.noteId,
    content: '# Verify note\n\nA standalone check wrote this note.\n',
    reason: 'Standalone verify note.'
  }, { detail: (data) => `version ${data && data.version}` });
  if (note && note.version) state.noteVersion = note.version;

  await call('patch_doc', {
    ...sessionArgs,
    doc_id: state.noteId,
    old_str: 'A standalone check wrote this note.',
    new_str: 'A standalone check revised this note.',
    reason: 'Standalone verify edit.'
  }, { detail: () => 'one replacement' });

  if (state.noteVersion) {
    await call('restore_doc', {
      ...sessionArgs,
      doc_id: state.noteId,
      version: state.noteVersion,
      reason: 'Standalone verify restore.',
      source: SOURCE
    }, { detail: () => `restored version ${state.noteVersion}` });
  } else if (wanted('restore_doc')) {
    results.push({
      tool: 'restore_doc',
      status: 'fail',
      detail: 'no retained version to restore',
      instead: 'write_doc has to succeed first. Run verify-emet run write_doc and read the failure above.'
    });
  }

  await call('rename_doc', {
    ...sessionArgs,
    old_id: state.noteId,
    new_id: state.renamedId,
    reason: 'Standalone verify rename.'
  }, { detail: () => state.renamedId });

  const dropId = 'drops/2026-10-21-verify.md';
  await call('write_doc', {
    ...sessionArgs,
    doc_id: dropId,
    content: '# Verify drop\n\nA standalone check left this drop.\n',
    reason: 'Standalone verify drop.'
  }, { detail: () => dropId });
  await call('retire_doc', {
    ...sessionArgs,
    doc_id: dropId,
    reason: 'Standalone verify retire.'
  }, { detail: () => 'marked obsolete' });

  const area = await call('write_doc', {
    ...sessionArgs,
    doc_id: state.areaId,
    content: AREA('verify', 'Verify'),
    reason: 'Standalone verify area.'
  }, { detail: () => state.areaId });
  await call('emet_pages', {}, { detail: (data) => data && Array.isArray(data.areas) ? `${data.areas.length} areas` : 'listed' });
  if (area) {
    await call('emet_page', { area: 'verify' }, { detail: () => 'page computed' });
    await call('emet_page_lint', { area: 'verify' }, { detail: () => 'lint returned' });
  } else if (wanted('emet_page') || wanted('emet_page_lint')) {
    for (const tool of ['emet_page', 'emet_page_lint']) {
      if (wanted(tool) && !results.some((row) => row.tool === tool)) {
        results.push({
          tool,
          status: 'fail',
          detail: 'no area document',
          instead: 'The owner writes areas/<slug>.md with write_doc, then calls this tool. Run verify-emet run write_doc first and fix that failure.'
        });
      }
    }
  }

  await call('write_doc', {
    ...sessionArgs,
    doc_id: state.brokenId,
    content: BROKEN_AREA,
    reason: 'Standalone verify nonconformance.'
  }, { detail: () => 'incomplete area stored' });
  await call('accept_nonconformance', {
    ...sessionArgs,
    doc_id: state.brokenId,
    reason: 'Accepted for the standalone check only.'
  }, { detail: () => 'acceptance recorded' });

  const saved = await call('save_to_layer', {
    ...sessionArgs,
    layer: 'working',
    content: 'A standalone verify sentence kept in working memory.',
    metadata: { source: SOURCE, importance: 'scratch' }
  }, { detail: (data) => `id ${data && data.id}` });
  if (saved && saved.id) state.memoryId = saved.id;
  await call('recall', { query: 'standalone verify' }, { detail: (data) => `${Array.isArray(data) ? data.length : 0} matches` });
  await call('query_layer', { layer: 'working', options: { limit: 5 } }, { detail: (data) => `${Array.isArray(data) ? data.length : (data && data.count) || 0} rows` });
  if (state.memoryId) {
    await call('revise_memory', {
      ...sessionArgs,
      layer: 'working',
      target_id: state.memoryId,
      content: 'A standalone verify sentence, revised.',
      metadata: { source: SOURCE }
    }, { detail: () => `supersedes ${state.memoryId}` });
  } else if (wanted('revise_memory')) {
    results.push({
      tool: 'revise_memory',
      status: 'fail',
      detail: 'no memory id to supersede',
      instead: 'save_to_layer has to succeed first. Run verify-emet run save_to_layer and read that result.'
    });
  }

  await call('query_transcripts', {
    timestamp_start: 0,
    timestamp_end: Math.floor(Date.now() / 1000) + 3600
  }, { detail: (data) => `${Array.isArray(data) ? data.length : (data && data.count != null ? data.count : 0)} sessions` });

  if (state.sessionId) {
    await call('save_transcript', {
      session_id: state.partId || state.sessionId,
      session_start: Math.floor(Date.now() / 1000) - 60,
      exchanges: [{ user_message: 'Batch check.', assistant_message: 'no local shell MCP. Batch stored.', exchange_index: 1 }],
      source: SOURCE
    }, { detail: () => 'batch transcript stored' });
    await call('revise_transcript', {
      session_id: state.partId || state.sessionId,
      exchanges: [{
        exchange_index: 1,
        user_message: 'Start the standalone check.',
        assistant_message: 'no local shell MCP. The check is running, revised.'
      }],
      reason: 'Standalone verify corrected the first exchange.',
      source: SOURCE
    }, { detail: () => 'revision stored' });
  }

  await call('emet_gaps', { limit: 5 }, { detail: () => 'gap counts returned' });
  await call('emet_error_report', { limit: 5 }, { detail: (data) => data && data.email ? 'report and draft' : 'report' });
  await call('emet_client_approve', { tag: 'verify-client', decision: 'deny', reason: 'Standalone check, not a real client.' }, {
    detail: (data) => data && data.decision ? data.decision : 'decided'
  });
  await call('emet_invite_create', { display_name: 'Verify Guest' }, { destructive: true });
  await call('emet_member_access_create', { display_name: 'Verify Member' }, { destructive: true });

  if (state.sessionId) {
    await call('emet_session_close', {
      session_id: state.sessionId,
      source: SOURCE,
      receipts: {
        working_docs: [],
        episodic_id: state.memoryId || 0,
        board_doc: 'STATE.md',
        board_version: 1,
        transcript_session_id: state.sessionId,
        transcript_parts: [state.sessionId],
        transcript_exchanges: 1,
        handoff_version: 1
      }
    }, { detail: (data) => `state ${data && data.state || 'returned'}` });
  } else if (wanted('emet_session_close')) {
    results.push({
      tool: 'emet_session_close',
      status: 'fail',
      detail: 'no session was opened',
      instead: 'Call emet_initialize, read every page, then emet_session_open with that load_id. Run verify-emet feature startup and then feature transcripts.'
    });
  }

  for (const gap of STANDALONE_GAPS) {
    if (wanted(gap.tool) && !results.some((row) => row.tool === gap.tool)) results.push(gapRow(gap));
  }

  const report = {
    ok: false,
    command: featureId ? 'feature' : 'run',
    feature: featureId,
    dry_run: flags.dryRun,
    node: node.version,
    node_ok: true,
    database: 'in-memory test store (tests/memstore.js)',
    temp_dir: temp,
    host_env_used: false,
    results
  };
  report.ok = finishCode(report) === 0;
  if (!report.ok) {
    const gapCount = results.filter((row) => row.status === 'gap').length;
    const failCount = results.filter((row) => row.status === 'fail').length;
    report.hint = failCount
      ? `${failCount} tool${failCount === 1 ? '' : 's'} failed. Each failure says what to do instead. ${gapCount} gap${gapCount === 1 ? '' : 's'} left as gaps.`
      : `${gapCount} standalone gap${gapCount === 1 ? '' : 's'}. They are listed above. This command does not paper over them.`;
  }
  emit(report, flags.json);
  return finishCode(report);
}

function featureOf(tool) {
  const feature = FEATURES.find((item) => item.tools.includes(tool));
  return feature ? feature.id : 'list';
}

function needsWrite(selected) {
  if (!selected) return true;
  const writes = new Set([
    'emet_session_open', 'emet_transcript_append', 'save_transcript', 'revise_transcript', 'emet_session_close',
    'write_doc', 'patch_doc', 'rename_doc', 'restore_doc', 'retire_doc', 'accept_nonconformance',
    'save_to_layer', 'revise_memory', 'emet_page', 'emet_pages', 'emet_page_lint', 'emet_client_approve'
  ]);
  return [...selected].some((tool) => writes.has(tool));
}

function spawnWorker(argv) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-verify-'));
  const child = spawn(process.execPath, [SCRIPT, '--worker', ...argv], {
    cwd: temp,
    env: standaloneEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const out = [];
  const err = [];
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));
  return new Promise((resolve) => {
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (stderr.trim()) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
      process.stdout.write(stdout);
      resolve(code == null ? 1 : code);
    });
  });
}

async function main(argv) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (error) {
    const report = usage(error.message);
    const json = argv.includes('--json');
    emit(report, json);
    return error.exitCode || 2;
  }
  if (parsed.flags.help || parsed.command === 'help') {
    process.stdout.write(helpText());
    return 0;
  }
  if (parsed.flags.worker) return workerMain(argv.filter((arg) => arg !== '--worker'));
  const forward = [];
  if (parsed.flags.json) forward.push('--json');
  if (parsed.flags.dryRun) forward.push('--dry-run');
  forward.push(parsed.command, ...parsed.positionals);
  return spawnWorker(forward);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT);
if (invoked) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    process.stderr.write(`verify-emet: ${error && error.message ? error.message : error}\nRun verify-emet --help if the command was not what you meant.\n`);
    process.exit(1);
  });
}
