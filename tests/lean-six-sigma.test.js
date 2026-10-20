/**
 * Lean Six Sigma ships as gems/lean-six-sigma. The rune files are the attached
 * bytes. requires.emet is >=0.2.6 and released is true, so 0.2.6 seats it.
 * The emet-gems-9b5191a fixture keeps requires.emet >=0.3.0 and released false.
 * FORMULAS.md in the attachment has 30 "Test vector" lines. The 49 golden
 * cases are tests/fixtures/emet-gems-9b5191a/verification/golden-outputs.json.
 * This file runs those cases on the shipped runes, plus every rune-backed
 * worked example, including the negative-limit examples beside the vectors.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const { checkGem } = await import('../src/gem-check.js');
const { seatGems } = await import('../src/socket.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEM = path.join(ROOT, 'gems/lean-six-sigma');
const FIXTURE = path.join(ROOT, 'tests/fixtures/emet-gems-9b5191a/lean-six-sigma');
const GOLDEN = path.join(ROOT, 'tests/fixtures/emet-gems-9b5191a/verification/golden-outputs.json');
const DIGESTS = path.join(ROOT, 'tests/fixtures/emet-gems-9b5191a/DIGESTS.json');
const RUNE_DIGESTS = {
  'runes/lss_capability.js': 'sha256:572c51f83006d798ce6e6b2c5752e74d78c07253683b87203bf09cf1493db9fb',
  'runes/lss_control_limits.js': 'sha256:28367f8f0bf588ffabf3c7a7b7238e462fdabd0ef4a6bb8e3498bd092f3cf532',
  'runes/lss_dpmo_sigma.js': 'sha256:0daa1dd326deec76f95a7340d63bd2cafa2442b5725358618f5a1dd3b2481f73',
  'runes/lss_hypothesis.js': 'sha256:4edd30e5e33227057c4cf502d43a1bc18de844d813c1ab929b4b7c4dd3ff5ef9',
  'runes/lss_sample_size.js': 'sha256:5a099e639ea71121fe51ed3d08778e186760a27c773a4feac3eeb25dc6dcbfae'
};
const REVENDORED = {
  'guides/BELTS.md': 'sha256:e9e591af0e2d89a27cddf73da48e4f4acacd1785e22473d42dd3b56366d008d0',
  'CHANGELOG.md': 'sha256:74459ce8384f8732ee484f0a935ae47a9a5bbe9a431668fb4064d019209b6af9'
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function digestOf(file) {
  const buf = fs.readFileSync(file);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);
}

const capability = (await import(pathToFileURL(path.join(GEM, 'runes/lss_capability.js')).href)).run;
const dpmo = (await import(pathToFileURL(path.join(GEM, 'runes/lss_dpmo_sigma.js')).href)).run;
const limits = (await import(pathToFileURL(path.join(GEM, 'runes/lss_control_limits.js')).href)).run;
const sample = (await import(pathToFileURL(path.join(GEM, 'runes/lss_sample_size.js')).href)).run;
const hypothesis = (await import(pathToFileURL(path.join(GEM, 'runes/lss_hypothesis.js')).href)).run;

testGroup('the shipped Lean Six Sigma GEM seats on 0.2.6', () => {
  test('version, released, and requires are the shipping values', () => {
    const manifest = readJson(path.join(GEM, 'gem.json'));
    assert.strictEqual(manifest.version, '0.9.0');
    assert.strictEqual(manifest.released, true);
    assert.strictEqual(manifest.requires.emet, '>=0.2.6');
    assert.strictEqual(manifest.defaultOn, false);
    for (const rune of manifest.runes) {
      assert.strictEqual(rune.version, '0.9.0');
      assert.ok(rune.description.includes('lean-six-sigma@0.9.0'));
      assert.strictEqual(RUNE_DIGESTS[rune.artifact], rune.sha256);
    }
    const changelog = fs.readFileSync(path.join(GEM, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /requires\.emet is >=0\.2\.6/);
    assert.match(changelog, /0\.9\.0/);
    assert.ok(!changelog.includes('1.0.0-beta'));
  });

  test('rune bytes match the attachment, and only BELTS and CHANGELOG were re-vendored', () => {
    const shipped = readJson(path.join(GEM, 'gem.json'));
    const fixture = readJson(path.join(FIXTURE, 'gem.json'));
    assert.strictEqual(fixture.version, '1.0.0');
    assert.strictEqual(fixture.released, false);
    assert.strictEqual(fixture.requires.emet, '>=0.3.0');
    for (const [rel, digest] of Object.entries(RUNE_DIGESTS)) {
      assert.strictEqual(digestOf(path.join(GEM, rel)), digest);
      assert.strictEqual(fs.readFileSync(path.join(GEM, rel)).equals(fs.readFileSync(path.join(FIXTURE, rel))), true, rel);
    }
    for (const [rel, digest] of Object.entries(REVENDORED)) {
      assert.strictEqual(shipped.files.find((file) => file.path === rel).digest, digest);
    }
    const index = readJson(path.join(ROOT, 'gems/artifact-index.json'));
    assert.deepStrictEqual(Object.values(index).map((row) => row.gem), ['fieldnote', 'fieldnote']);
    for (const digest of Object.values(RUNE_DIGESTS)) assert.strictEqual(index[digest], undefined);
  });

  test('gem-check passes on 0.2.6, and the fixture still requires 0.3.0', async () => {
    const shipped = await checkGem(GEM, { emetVersion: '0.2.6' });
    assert.strictEqual(shipped.exitCode, 0, (shipped.lines || []).join('\n'));
    const early = await checkGem(FIXTURE, { emetVersion: '0.2.6' });
    assert.notStrictEqual(early.exitCode, 0);
    assert.ok((early.lines || []).some((line) => /GC-20 fail:/.test(line) && /requires\.emet excludes/.test(line)));
    const later = await checkGem(FIXTURE, { emetVersion: '0.3.0' });
    assert.strictEqual(later.exitCode, 0, (later.lines || []).join('\n'));
  });

  test('the shipped gem.json and CHANGELOG.md match the recorded placeholder digests', () => {
    const recorded = readJson(DIGESTS);
    for (const rel of ['gem.json', 'CHANGELOG.md']) {
      assert.strictEqual(digestOf(path.join(GEM, rel)), recorded.files[rel], rel);
    }
  });

  test('the release seats it off, with no legacy pin', async () => {
    const seated = await seatGems({ log: { warn() {}, info() {}, error() {} } });
    const row = seated.gems_available.find((gem) => gem.id === 'lean-six-sigma');
    assert.strictEqual(row.loadable, true, row.reason);
    assert.strictEqual(row.active, false);
    assert.strictEqual(row.version, '0.9.0');
  });
});

testGroup('the 49 golden cases match the shipped runes', () => {
  test('every golden stdout matches JSON.stringify of the shipped rune', async () => {
    const golden = readJson(GOLDEN);
    assert.strictEqual(golden.cases.length, 49);
    const runs = new Map();
    let matched = 0;
    for (const row of golden.cases) {
      assert.ok(row.artifact.startsWith('runes/') && row.artifact.endsWith('.js'), row.name);
      if (!runs.has(row.artifact)) {
        const mod = await import(pathToFileURL(path.join(GEM, row.artifact)).href);
        assert.strictEqual(typeof mod.run, 'function', row.artifact);
        runs.set(row.artifact, mod.run);
      }
      const got = JSON.stringify(runs.get(row.artifact)(row.payload));
      assert.strictEqual(got, row.stdout, row.name);
      matched += 1;
    }
    assert.strictEqual(matched, 49);
  });
});

testGroup('FORMULAS.md worked examples run on the shipped files', () => {
  const formulas = fs.readFileSync(path.join(GEM, 'guides/FORMULAS.md'), 'utf8');

  test('the guide still has its 30 test-vector lines and the hand-only results', () => {
    const vectors = formulas.match(/Test vector/g) || [];
    assert.strictEqual(vectors.length, 30);
    for (const line of [
      'First pass yield = (100 - 2) / 100 = 0.98',
      'RTY = 0.9 * 0.8 * 0.95 = 0.684',
      'Sigma level: not computed',
      'Takt = 480 / 240 = 2',
      'OEE = 0.9 * 0.8 * 0.75 = 0.54',
      'Inventory = 20 * 2 = 40',
      'RPN = 8 * 4 * 5 = 160'
    ]) assert.ok(formulas.includes(line), line);
  });

  test('capability, DPMO, and yield match the guide', () => {
    const cp = capability({ index: 'cp', sigmaKind: 'within', usl: 10, lsl: 0, sigma: 1 });
    near(cp.value, 10 / 6, 'cp');
    assert.strictEqual(cp.wrote, false);
    const cpu = capability({ index: 'cpu', sigmaKind: 'within', usl: 10, mean: 7, sigma: 1 });
    near(cpu.value, 1, 'cpu');
    const cpl = capability({ index: 'cpl', sigmaKind: 'within', mean: 7, lsl: 0, sigma: 1 });
    near(cpl.value, 7 / 3, 'cpl');
    const cpk = capability({ index: 'cpk', sigmaKind: 'within', usl: 10, lsl: 0, mean: 7, sigma: 1 });
    near(cpk.value, 1, 'cpk');
    const pp = capability({ index: 'pp', sigmaKind: 'overall', usl: 10, lsl: 0, sigma: 1 });
    near(pp.value, 10 / 6, 'pp');
    const ppk = capability({ index: 'ppk', sigmaKind: 'overall', usl: 10, lsl: 0, mean: 7, sigma: 1 });
    near(ppk.value, 1, 'ppk');
    const ranged = capability({ index: 'cp', sigmaKind: 'within', usl: 10, lsl: 0, rBar: 1.128, d2: 1.128 });
    near(ranged.sigmaUsed, 1, 'sigma hat');
    near(ranged.value, 10 / 6, 'cp from range');
    const again = capability({ index: 'cp', sigmaKind: 'within', usl: 10, lsl: 0, sigma: 1 });
    assert.deepStrictEqual(again, cp);

    const yieldRow = dpmo({ defects: 10, units: 100, opportunitiesPerUnit: 5 });
    near(yieldRow.dpo, 0.02, 'dpo');
    near(yieldRow.dpmo, 20000, 'dpmo');
    near(yieldRow.opportunityYield, 0.98, 'yield');
    assert.ok(yieldRow.flags.includes('sigma-not-computed'));
    assert.strictEqual(yieldRow.wrote, false);
    assert.deepStrictEqual(dpmo({ defects: 10, units: 100, opportunitiesPerUnit: 5 }), yieldRow);
  });

  test('control limits match the guide, including limits that stay negative', () => {
    const xbar = limits({ chart: 'xbar-r', xDoubleBar: 50, rBar: 4, n: 5, a2: 0.577, d3: 0, d4: 2.115 });
    near(xbar.ucl, 52.308, 'x ucl');
    near(xbar.lcl, 47.692, 'x lcl');
    near(xbar.uclR, 8.46, 'r ucl');
    near(xbar.lclR, 0, 'r lcl');
    const negative = limits({ chart: 'xbar-r', xDoubleBar: -5, rBar: 2, n: 5, a2: 0.577, d3: 0, d4: 2.115 });
    near(negative.ucl, -3.846, 'neg ucl');
    near(negative.lcl, -6.154, 'neg lcl');
    assert.ok(!negative.flags.includes('lcl-floored-at-zero'));
    const lower = limits({ chart: 'xbar-r', xDoubleBar: -1, rBar: 2, n: 5, a2: 0.577, d3: 0, d4: 2.115 });
    near(lower.lcl, -2.154, 'neg lower');
    const imr = limits({ chart: 'i-mr', xBar: 10, mrBar: 2 });
    near(imr.ucl, 10 + 6 / 1.128, 'imr ucl');
    near(imr.lcl, 10 - 6 / 1.128, 'imr lcl');
    near(imr.uclR, 6.534, 'mr ucl');
    near(imr.lclR, 0, 'mr lcl');
    const imrNeg = limits({ chart: 'i-mr', xBar: -1, mrBar: 0.5 });
    near(imrNeg.lcl, -1 - 1.5 / 1.128, 'imr neg');
    assert.ok(!imrNeg.flags.includes('lcl-floored-at-zero'));
    const p = limits({ chart: 'p', pBar: 0.1, n: 100 });
    near(p.ucl, 0.19, 'p ucl');
    near(p.lcl, 0.01, 'p lcl');
    const np = limits({ chart: 'np', pBar: 0.1, n: 100 });
    near(np.center, 10, 'np center');
    near(np.ucl, 19, 'np ucl');
    near(np.lcl, 1, 'np lcl');
    const c = limits({ chart: 'c', cBar: 16 });
    near(c.ucl, 28, 'c ucl');
    near(c.lcl, 4, 'c lcl');
    const clamp = limits({ chart: 'c', cBar: 1 });
    near(clamp.ucl, 4, 'c clamp ucl');
    near(clamp.lcl, 0, 'c clamp lcl');
    assert.ok(clamp.flags.includes('lcl-floored-at-zero'));
    const u = limits({ chart: 'u', uBar: 4, n: 4 });
    near(u.ucl, 7, 'u ucl');
    near(u.lcl, 1, 'u lcl');
    assert.deepStrictEqual(limits({ chart: 'c', cBar: 16 }), c);
  });

  test('sample size and the hypothesis examples match the guide', () => {
    const proportion = sample({ kind: 'proportion', z: 2, p: 0.5, e: 0.1 });
    assert.strictEqual(proportion.n, 100);
    const mean = sample({ kind: 'mean', z: 2, sigma: 5, e: 1 });
    assert.strictEqual(mean.n, 100);
    assert.deepStrictEqual(sample({ kind: 'proportion', z: 2, p: 0.5, e: 0.1 }), proportion);
    const t = hypothesis({ test: 'one-sample-t', xBar: 10, mu0: 8, s: 2, n: 16 });
    near(t.t, 4, 't');
    assert.strictEqual(t.df, 15);
    const chi = hypothesis({ test: 'chi-square-gof', observed: [10, 20, 30], expected: [20, 20, 20], parametersEstimated: 0 });
    near(chi.chiSquare, 10, 'chi');
    assert.strictEqual(chi.df, 2);
    const anova = hypothesis({ test: 'anova-oneway', groups: [[1, 2, 3], [4, 5, 6]] });
    near(anova.grandMean, 3.5, 'grand');
    near(anova.ssb, 13.5, 'ssb');
    near(anova.ssw, 4, 'ssw');
    near(anova.msb, 13.5, 'msb');
    near(anova.msw, 1, 'msw');
    near(anova.f, 13.5, 'f');
    assert.strictEqual(anova.dfBetween, 1);
    assert.strictEqual(anova.dfWithin, 4);
    const fit = hypothesis({ test: 'simple-regression', x: [1, 2, 3], y: [2, 4, 6] });
    near(fit.slope, 2, 'slope');
    near(fit.intercept, 0, 'intercept');
    near(fit.r2, 1, 'r2');
    const z = hypothesis({ test: 'z-interval', xBar: 10, sigma: 2, n: 16, z: 2 });
    near(z.low, 9, 'z low');
    near(z.high, 11, 'z high');
    const interval = hypothesis({ test: 't-interval', xBar: 10, s: 2, n: 16, tCrit: 2 });
    near(interval.low, 9, 't low');
    near(interval.high, 11, 't high');
    assert.strictEqual(t.wrote, false);
    assert.deepStrictEqual(hypothesis({ test: 'one-sample-t', xBar: 10, mu0: 8, s: 2, n: 16 }), t);
  });

  test('every coverage deliverable resolves in the shipped files', () => {
    const manifest = readJson(path.join(GEM, 'gem.json'));
    assert.strictEqual(manifest.coverage.length, 90);
    const floor = readJson(path.join(GEM, 'floor.json'));
    for (const entry of manifest.coverage) {
      if (entry.delivers.startsWith('rune:')) {
        const name = entry.delivers.slice('rune:'.length);
        assert.ok(manifest.runes.some((rune) => rune.name === name), entry.id);
        continue;
      }
      const [file, anchor] = entry.delivers.split('#');
      if (file === 'floor.json') {
        const [section, line] = anchor.split('.');
        assert.strictEqual(typeof floor.sections[section].lines[line], 'string', entry.id);
        continue;
      }
      const text = fs.readFileSync(path.join(GEM, file), 'utf8');
      assert.match(text, new RegExp(`^#{1,3} ${anchor}$`, 'm'), entry.id);
    }
  });
});

summary('LEAN SIX SIGMA');
