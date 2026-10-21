/**
 * verify-emet: help, errors that say what to do, JSON, dry-run, and gaps.
 * The full drive is `npm run verify`. This file checks the command itself.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { STANDALONE_GAPS, finishCode, helpText } = await import('../scripts/verify-emet.mjs');
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

/** doctor, list, run, and feature load the server. engines requires Node 22. */
function testOnNode22(description, fn) {
  if (NODE_MAJOR < 22) {
    test(`${description} (skipped: Node ${process.version}; engines requires >=22)`, () => {});
    return;
  }
  test(description, fn);
}

function run(args) {
  const proc = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-emet.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return proc;
}

function jsonOf(proc) {
  let body;
  try { body = JSON.parse(proc.stdout); } catch (error) {
    assert.fail(`stdout was not JSON (status ${proc.status}): ${proc.stdout.slice(0, 400)}\n${error.message}`);
  }
  return body;
}

testGroup('verify-emet command', () => {
  test('--help names the subcommands, --json, and --dry-run', () => {
    const text = helpText();
    for (const word of ['doctor', 'list', 'run', 'feature', '--json', '--dry-run', 'gap']) {
      assert.ok(text.includes(word), word);
    }
    assert.match(text, /Exit codes[\s\S]*\n {2}1 +A tool failed/);
    assert.match(text, /\n {2}3 +The only problems are standalone gaps/);
    const proc = run(['--help']);
    assert.strictEqual(proc.status, 0);
    assert.ok(proc.stdout.includes('doctor'));
    assert.ok(proc.stdout.includes('--dry-run'));
    assert.ok(proc.stdout.includes('what to do instead') || proc.stdout.includes('what a plain install cannot do'));
  });

  test('an unknown command says which commands exist', () => {
    const proc = run(['frobnicate']);
    assert.strictEqual(proc.status, 2);
    assert.match(proc.stdout, /unknown command/);
    assert.match(proc.stdout, /doctor, list, run, or feature/);
  });

  test('an unknown option points at --help', () => {
    const proc = run(['--nope']);
    assert.strictEqual(proc.status, 2);
    assert.match(proc.stdout, /unknown option/);
    assert.match(proc.stdout, /--help/);
  });

  test('feature without an id says to run list', () => {
    const proc = run(['feature']);
    assert.strictEqual(proc.status, 2);
    assert.match(proc.stdout, /feature needs an id/);
    assert.match(proc.stdout, /verify-emet list/);
  });

  test('an unknown feature id names the map', () => {
    const proc = run(['feature', 'not-a-feature']);
    assert.strictEqual(proc.status, 2);
    assert.match(proc.stdout, /no feature/);
    assert.match(proc.stdout, /docs\/features/);
  });

  test('gaps alone exit 3, and a real failure stays at 1', () => {
    assert.strictEqual(finishCode({ results: [{ status: 'pass' }] }), 0);
    assert.strictEqual(finishCode({ results: [{ status: 'gap' }, { status: 'pass' }] }), 3);
    assert.strictEqual(finishCode({ gaps: [{ status: 'gap' }] }), 3);
    assert.strictEqual(finishCode({ results: [{ status: 'fail' }] }), 1);
    assert.strictEqual(finishCode({ results: [{ status: 'fail' }, { status: 'gap' }] }), 1);
    assert.strictEqual(finishCode({ node_ok: false, results: [{ status: 'gap' }] }), 1);
    assert.strictEqual(finishCode({ test_database_present: false, results: [{ status: 'gap' }] }), 1);
  });

  testOnNode22('list --json includes the plain tool list and the feature ids', () => {
    const proc = run(['list', '--json']);
    assert.strictEqual(proc.status, 0);
    const body = jsonOf(proc);
    assert.ok(body.registered_tools.includes('emet_error_report'));
    assert.ok(body.registered_tools.includes('recall'));
    assert.ok(!body.registered_tools.includes('emet_subkey_request'));
    assert.ok(body.features.some((feature) => feature.id === 'errors'));
    assert.ok(body.gaps.includes('semantic_recall'));
  });

  testOnNode22('doctor --json exits 3 and lists the standalone gaps', () => {
    const proc = run(['doctor', '--json']);
    assert.strictEqual(proc.status, 3);
    const body = jsonOf(proc);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.host_env_used, false);
    assert.strictEqual(body.test_database_present, true);
    const tools = body.gaps.map((gap) => gap.tool).sort();
    assert.deepStrictEqual(tools, STANDALONE_GAPS.map((gap) => gap.tool).sort());
    for (const gap of body.gaps) {
      assert.ok(gap.need && gap.instead, gap.tool);
    }
  });

  testOnNode22('run emet_floor passes with no gap', () => {
    const proc = run(['run', '--json', 'emet_floor']);
    assert.strictEqual(proc.status, 0, proc.stdout);
    const body = jsonOf(proc);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.results.length, 1);
    assert.strictEqual(body.results[0].status, 'pass');
    assert.strictEqual(body.host_env_used, false);
  });

  testOnNode22('feature search reports gaps and does not call the tools', () => {
    const proc = run(['feature', 'search', '--json']);
    assert.strictEqual(proc.status, 3);
    const body = jsonOf(proc);
    assert.strictEqual(body.feature, 'search');
    const byTool = Object.fromEntries(body.results.map((row) => [row.tool, row]));
    assert.strictEqual(byTool.semantic_recall.status, 'gap');
    assert.strictEqual(byTool.corpus_recall.status, 'gap');
    assert.ok(byTool.semantic_recall.instead);
    assert.ok(!body.results.some((row) => row.status === 'pass'));
    assert.ok(!body.results.some((row) => row.status === 'fail'));
  });

  testOnNode22('a run whose only problems are gaps exits 3', () => {
    const proc = run(['run', '--json', 'semantic_recall', 'corpus_recall']);
    assert.strictEqual(proc.status, 3, proc.stdout);
    const body = jsonOf(proc);
    assert.strictEqual(body.ok, false);
    assert.ok(body.results.length >= 2);
    assert.ok(body.results.every((row) => row.status === 'gap'));
  });

  testOnNode22('a real tool failure exits 1, including when a gap is in the same run', () => {
    const alone = run(['run', '--json', 'restore_doc']);
    assert.strictEqual(alone.status, 1, alone.stdout);
    const aloneBody = jsonOf(alone);
    assert.ok(aloneBody.results.some((row) => row.tool === 'restore_doc' && row.status === 'fail'));
    assert.ok(!aloneBody.results.some((row) => row.status === 'gap'));

    const mixed = run(['run', '--json', 'restore_doc', 'semantic_recall']);
    assert.strictEqual(mixed.status, 1, mixed.stdout);
    const mixedBody = jsonOf(mixed);
    assert.ok(mixedBody.results.some((row) => row.status === 'fail'));
    assert.ok(mixedBody.results.some((row) => row.tool === 'semantic_recall' && row.status === 'gap'));
  });

  testOnNode22('--dry-run skips emet_setup_complete and says what to run instead', () => {
    const proc = run(['run', '--dry-run', '--json', 'emet_setup_complete']);
    assert.strictEqual(proc.status, 0, proc.stdout);
    const body = jsonOf(proc);
    assert.strictEqual(body.dry_run, true);
    const setup = body.results.find((row) => row.tool === 'emet_setup_complete');
    assert.ok(setup, 'setup row missing');
    assert.strictEqual(setup.status, 'skipped');
    assert.match(setup.instead, /without --dry-run/);
    assert.match(setup.instead, /emet_setup_complete/);
  });
});

summary('VERIFY CLI TEST SUMMARY');
