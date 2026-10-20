/**
 * Load-gate allowlist. The scanner and the corpus live in
 * verification/load-gate/ so EMET-GEMs can vendor those two files
 * byte-for-byte. Each rule has one corpus witness that passes when that
 * rule is turned off. Each walker branch has one witness that passes when
 * that line is removed. Each logic mutant (guard identity, freeze, null
 * prototype, polarity, RegExp's neighbors) lets its witness through.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { refuseHostAccess, hostRules } from '../src/host-reach.js';
import { scanModuleSource } from '../src/gem-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'verification/load-gate/load-gate.mjs');
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'verification/load-gate/corpus.json'), 'utf8'));

function verdict(fn, source, rules, options) {
  try {
    fn(source, rules, options);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.reason, rule: e && e.rule };
  }
}

function gateOptions(item) {
  if (!item || typeof item !== 'object') return undefined;
  const options = {};
  if (typeof item.from === 'string') options.from = item.from;
  if (Array.isArray(item.files)) options.files = item.files;
  if (typeof item.path === 'string') options.path = item.path;
  if (item.resolved && typeof item.resolved === 'object' && !Array.isArray(item.resolved)) options.resolved = item.resolved;
  return Object.keys(options).length ? options : undefined;
}

function gateVerdict(fn, item, rules) {
  return verdict(fn, item.source, rules, gateOptions(item));
}

testGroup('load-gate corpus', () => {
  test('every case does what the corpus says', () => {
    assert.ok(corpus.cases.length > 16);
    for (const item of corpus.cases) {
      const got = gateVerdict(refuseHostAccess, item);
      if (item.expect === 'pass') {
        assert.strictEqual(got.ok, true, item.id + ' ' + got.reason);
      } else {
        assert.strictEqual(got.ok, false, item.id);
        assert.strictEqual(got.reason, item.reason, item.id);
        assert.strictEqual(got.rule, item.rule, item.id);
      }
    }
  });

  test('every rule has one witness, and turning that rule off lets it through', () => {
    const ids = Object.keys(hostRules());
    let killed = 0;
    for (const id of ids) {
      const witnesses = corpus.cases.filter((item) => item.sole && item.rule === id);
      assert.ok(witnesses.length >= 1, id);
      const off = hostRules();
      off[id] = false;
      for (const item of witnesses) {
        assert.strictEqual(gateVerdict(refuseHostAccess, item).ok, false, id + ' did not fail');
        assert.strictEqual(gateVerdict(refuseHostAccess, item, off).ok, true, id + ' ' + item.id);
      }
      const other = corpus.cases.find((item) => item.sole && item.rule !== id);
      assert.strictEqual(gateVerdict(refuseHostAccess, other, off).ok, false, id + ' also disabled ' + other.rule);
      killed++;
    }
    assert.strictEqual(killed, ids.length);
    console.log('mutation kills: ' + killed);
  });

  test('the review forms are refused by the scan gem-check runs', () => {
    for (const item of corpus.cases) {
      if (item.expect !== 'refuse' || item.rule === 'parse' || item.rule === 'bytes') continue;
      const got = item.via === 'gate' ? gateVerdict(refuseHostAccess, item) : verdict(scanModuleSource, item.source);
      assert.strictEqual(got.ok, false, item.id);
      assert.strictEqual(got.reason, item.reason, item.id);
    }
  });

  test('a parse error fails closed, and there is no weaker second scan', () => {
    const src = fs.readFileSync(GATE, 'utf8');
    assert.doesNotMatch(src, /function fallback|function naive/);
    assert.match(src, /8\.19\.0/);
    const bridge = fs.readFileSync(path.join(ROOT, 'src/host-reach.js'), 'utf8');
    assert.doesNotMatch(bridge, /acorn\.parse|function walk/);
  });
});

test('every walker branch is the reason its fixture fails', async () => {
  const src = fs.readFileSync(GATE, 'utf8');
  const ids = [...src.matchAll(/\/\/ branch:([a-z0-9-]+)/g)].map((m) => m[1]);
  const tagged = corpus.cases.filter((item) => item.branch);
  assert.deepStrictEqual(tagged.map((item) => item.branch).sort(), [...ids].sort());
  const dir = path.join(ROOT, 'tests/.mutants');
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    let killed = 0;
    for (const id of ids) {
      const item = tagged.find((row) => row.branch === id);
      assert.strictEqual(verdict(refuseHostAccess, item.source).ok, false, id);
      let n = 0;
      const mutated = src.split('\n').map((line) => {
        if (!new RegExp(`// branch:${id}$`).test(line.trim())) return line;
        n += 1;
        return 'void 0; // branch:' + id;
      }).join('\n');
      assert.strictEqual(n, 1, id);
      const file = path.join(dir, id + '.mjs');
      await fs.promises.writeFile(file, mutated);
      const mod = await import(pathToFileURL(file).href);
      const after = verdict(mod.refuseHostAccess, item.source);
      if (id === 'parse') assert.notStrictEqual(after.reason, 'parse', id);
      else assert.strictEqual(after.ok, true, id + ' mutant still ' + after.reason);
      killed += 1;
    }
    const noBang = src.replace('allowHashBang: true', 'allowHashBang: false');
    const bangFile = path.join(dir, 'bang.mjs');
    await fs.promises.writeFile(bangFile, noBang);
    const bang = await import(pathToFileURL(bangFile).href);
    const hash = '#!/usr/bin/env node\nexport const x = 1\n';
    assert.strictEqual(verdict(refuseHostAccess, hash).ok, true);
    assert.strictEqual(verdict(bang.refuseHostAccess, hash).reason, 'parse');
    killed += 1;
    console.log('branch kills: ' + killed);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('every rule-logic check is the reason its fixture fails', async () => {
  const src = fs.readFileSync(GATE, 'utf8');
  function replaceOnce(text, from, to, id) {
    const count = text.split(from).length - 1;
    assert.strictEqual(count, 1, id);
    return text.replace(from, to);
  }
  const logic = [
    ['any-key', 'guard-other-key', (s) => replaceOnce(s, 'function keysMatch(ctx, guard, keyNode) {\n    if (!guard || !keyNode) return false;', 'function keysMatch(ctx, guard, keyNode) {\n    if (!guard || !keyNode) return false;\n    return true;', 'any-key')],
    ['shadow-name', 'guard-shadow-key', (s) => replaceOnce(s, 'return !!(bound && bound.snapshot && keyIsPrim(ctx, bound) && guard.binding === bound);', 'return !!(bound && bound.snapshot && keyIsPrim(ctx, bound) && guard.key.name === keyNode.name);', 'shadow-name')],
    ['let-snapshot', 'guard-let', (s) => replaceOnce(s, 'return !!(bound && bound.snapshot && keyIsPrim(ctx, bound) && guard.binding === bound);', 'return !!(bound && guard.binding === bound);', 'let-snapshot')],
    ['prim-key', 'guard-object-key', (s) => replaceOnce(s, 'return !!(bound && bound.snapshot && keyIsPrim(ctx, bound) && guard.binding === bound);', 'return !!(bound && bound.snapshot && guard.binding === bound);', 'prim-key')],
    ['member-key', 'guard-member', (s) => replaceOnce(s, "if (node.type === 'Identifier') return 'ident';\n    return null;", "if (node.type === 'Identifier') return 'ident';\n    if (node.type === 'MemberExpression') return 'member';\n    return null;", 'member-key')],
    ['member-prop', 'guard-other-member', (s) => {
      const enabled = replaceOnce(s, "if (node.type === 'Identifier') return 'ident';\n    return null;", "if (node.type === 'Identifier') return 'ident';\n    if (node.type === 'MemberExpression') return 'member';\n    return null;", 'member-prop-mode');
      return replaceOnce(enabled, 'if (!a.computed) return a.property.name === b.property.name;', 'if (!a.computed) return true;', 'member-prop');
    }],
    ['guard-table', 'guard-other-table', (s) => replaceOnce(s, 'return ctx.guards.some((g) => g.table === tableName && keysMatch(ctx, g, keyNode));', 'return ctx.guards.some((g) => keysMatch(ctx, g, keyNode));', 'guard-table')],
    ['if-negation', 'guard-negated-read', (s) => replaceOnce(s, 'const cons0 = guard && !guard.negated ? withGuards(ctx, ctx.guards.concat(guard)) : ctx; // if-cons', 'const cons0 = guard ? withGuards(ctx, ctx.guards.concat(guard)) : ctx; // if-cons', 'if-negation')],
    ['early-positive', 'guard-positive-early', (s) => replaceOnce(s, 'if (!guard || !guard.negated || !abrupt(stmt.consequent)) return null;', 'if (!guard || !abrupt(stmt.consequent)) return null;', 'early-positive')],
    ['closure-guards', 'guard-closure', (s) => replaceOnce(s, 'guards: fn ? [] : ctx.guards,', 'guards: ctx.guards,', 'closure-guards')],
    ['null-proto', 'table-no-null-proto', (s) => replaceOnce(s, 'if (!sawNull) return null;', 'if (false && !sawNull) return null;', 'null-proto')],
    ['seal-as-freeze', 'table-seal', (s) => replaceOnce(s, "&& node.callee.property.type === 'Identifier' && node.callee.property.name === 'freeze';", "&& node.callee.property.type === 'Identifier' && (node.callee.property.name === 'freeze' || node.callee.property.name === 'seal');", 'seal-as-freeze')],
    ['union-prim', 'table-row-bind', (s) => replaceOnce(s, "return { kind: 'table', schema: { kind: 'object', props }, name: null };", "return { kind: 'prim', value: null, vtype: 'null' };", 'union-prim')],
    ['object-keys', 'intrinsic-keys', (s) => replaceOnce(s, "Object: new Set(['hasOwn', 'freeze', 'is']),", "Object: new Set(['hasOwn', 'freeze', 'is', 'keys']),", 'object-keys')],
    ['object-assign', 'intrinsic-assign', (s) => replaceOnce(s, "Object: new Set(['hasOwn', 'freeze', 'is']),", "Object: new Set(['hasOwn', 'freeze', 'is', 'assign']),", 'object-assign')],
    ['or-polarity', 'guard-or-wrong', (s) => replaceOnce(s, "if (guard && ((node.operator === '&&' && !guard.negated) || (node.operator === '||' && guard.negated))) {", "if (guard && ((node.operator === '&&' && !guard.negated) || node.operator === '||')) {", 'or-polarity')],
    ['and-polarity', 'guard-and-wrong', (s) => replaceOnce(s, "if (guard && ((node.operator === '&&' && !guard.negated) || (node.operator === '||' && guard.negated))) {", "if (guard && (node.operator === '&&' || (node.operator === '||' && guard.negated))) {", 'and-polarity')],
    ['early-abrupt', 'guard-no-abrupt', (s) => replaceOnce(s, 'if (!guard || !guard.negated || !abrupt(stmt.consequent)) return null;', 'if (!guard || !guard.negated) return null;', 'early-abrupt')],
    ['freeze-any', 'table-freeze-value', (s) => replaceOnce(s, 'return freezeSchema(arg, ctx);', 'return freezeSchema(arg, ctx) || { kind: \'object\', props: new Map() };', 'freeze-any')],
    ['hasown-name', 'guard-fake-is', (s) => replaceOnce(s, "function isHasOwnName(name) {\n    return name === 'hasOwn';\n  }", "function isHasOwnName(name) {\n    return name === 'hasOwn' || name === 'is';\n  }", 'hasown-name')],
    ['array-dynamic', 'table-array-dynamic', (s) => replaceOnce(s, "function dynamicTable(schema) {\n    if (schema && schema.kind === 'object') return unionObject(schema);\n    return null;\n  }", "function dynamicTable(schema) {\n    if (schema && schema.kind === 'object') return unionObject(schema);\n    return { kind: 'prim', value: null, vtype: 'null' };\n  }", 'array-dynamic')],
    ['banned-key', 'computed-constructor', (s) => replaceOnce(s, "function bannedKey(name) {\n    if (name === 'constructor') return 'constructor';\n    if (name === '__proto__' || name === 'prototype') return 'prototype';\n    return null;\n  }", "function bannedKey() {\n    return null;\n  }", 'banned-key')],
    ['template-prim', 'computed-template-interp', (s) => replaceOnce(s, "if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {", "if (node.type === 'TemplateLiteral') {", 'template-prim')],
    ['shadow-new', 'new-error-shadow', (s) => replaceOnce(s, "if (callee.type === 'Identifier' && ERRORS.has(callee.name) && !lookup(ctx, callee.name)) return VALUE; // new-intrinsic", "if (callee.type === 'Identifier' && ERRORS.has(callee.name)) return VALUE; // new-intrinsic", 'shadow-new')],
    ['ternary-else', 'guard-ternary-else', (s) => replaceOnce(s, 'const alt = guard && guard.negated ? withGuards(ctx, ctx.guards.concat(guard)) : ctx; // ternary-alt', 'const alt = guard ? withGuards(ctx, ctx.guards.concat(guard)) : ctx; // ternary-alt', 'ternary-else')],
    ['locale-tostring', 'locale-tostring', (s) => replaceOnce(s, "name === 'toLocaleString' || ", '', 'locale-tostring')],
    ['locale-compare', 'locale-compare', (s) => replaceOnce(s, "name === 'localeCompare' || ", '', 'locale-compare')],
    ['buffer', 'buffer-alloc', (s) => replaceOnce(s, "\n  Buffer: 'memory',", '', 'buffer')],
    ['freeze-object', 'freeze-not-object', (s) => replaceOnce(s, "node.type === 'Identifier' && node.name === 'Object' && ctx", "node.type === 'Identifier' && ctx", 'freeze-object')],
    ['typeof-let', 'guard-typeof-let', (s) => replaceOnce(s, "if (node.kind === 'const') {\n        info.snapshot = true;", "if (node.kind === 'const' || node.kind === 'let') {\n        info.snapshot = true;", 'typeof-let')],
    ['typeof-param', 'guard-typeof-param', (s) => replaceOnce(s, "snapshot: kind === 'const'", "snapshot: kind === 'const' || kind === 'param'", 'typeof-param')],
    ['shadow-string', 'guard-shadow-string', (s) => replaceOnce(s, 'return !lookup(ctx, callee.name);', 'return true;', 'shadow-string')],
    ['typeof-or', 'guard-typeof-or', (s) => replaceOnce(s, "if (node.operator === '||' && left.positive && right.positive) return { name: left.name, polarity: 'include' };", "if (node.operator === '||') return { name: left.name, polarity: left.positive ? 'include' : 'exclude' };", 'typeof-or')],
    ['typeof-no-abrupt', 'guard-typeof-no-abrupt', (s) => replaceOnce(s, "if (!info || info.polarity !== 'exclude' || !abrupt(stmt.consequent)) return null;", "if (!info || info.polarity !== 'exclude') return null;", 'typeof-no-abrupt')],
    ['typeof-closure', 'guard-typeof-closure', (s) => replaceOnce(s, 'prims: fn ? [] : ctx.prims,', 'prims: ctx.prims,', 'typeof-closure')],
    ['locale-upper', 'locale-upper', (s) => replaceOnce(s, "name === 'toLocaleUpperCase' || ", '', 'locale-upper')],
    ['locale-lower', 'locale-lower', (s) => replaceOnce(s, " || name === 'toLocaleLowerCase'", '', 'locale-lower')],
    ['locale-pattern', 'locale-destructure', (s) => replaceOnce(s, 'function refuseLocaleKey(name) {\n    if (isLocaleName(name)) failLocale();\n  }', 'function refuseLocaleKey() {\n  }', 'locale-pattern')],
    ['pattern-computed', 'dk-input', (s) => replaceOnce(s, 'if (name == null) failComputed(); // pattern-prop-literal', "if (name == null && role !== 'pattern') failComputed(); // pattern-prop-literal", 'pattern-computed')],
    ['computed-call', 'call-computed', (s) => replaceOnce(s, '    if (member.computed) return literalKey(member.property);\n', '', 'computed-call')],
    ['pattern-proto', 'pattern-proto', (s) => replaceOnce(s, "if (ban === 'prototype' && !(role === 'prop' && name === '__proto__')) { failPrototype(); return 'poison'; }", "if (ban === 'prototype' && !((role === 'prop' || role === 'pattern') && name === '__proto__')) { failPrototype(); return 'poison'; }", 'pattern-proto')],
    ['write-input-key', 'write-input-key', (s) => replaceOnce(s, "if (role === 'member') return { name: null, dynamic: true, stop: null };", "if (role === 'member' || role === 'write') return { name: null, dynamic: true, stop: null };", 'write-input-key')],
    ['bigint-key', 'computed-bigint', (s) => {
      const prim = replaceOnce(s, "typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean'", "typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean' || typeof node.value === 'bigint'", 'bigint-direct');
      return replaceOnce(prim, "prim.vtype === 'string' || prim.vtype === 'number' || prim.vtype === 'boolean' || prim.vtype === 'null'", "prim.vtype === 'string' || prim.vtype === 'number' || prim.vtype === 'boolean' || prim.vtype === 'null' || prim.vtype === 'bigint'", 'bigint-key');
    }],
    ['import-node', 'import-node-child', (s) => replaceOnce(s, "if (spec.startsWith('node:')) return 'specifier not allowed'; // import-node", "if (spec.startsWith('node:')) return null; // import-node", 'import-node')],
    ['import-forbidden', 'import-fs', (s) => replaceOnce(s, "if (FORBIDDEN_SPECIFIERS.has(spec) || spec.includes('mongodb')) return 'specifier not allowed'; // import-forbidden", "if (FORBIDDEN_SPECIFIERS.has(spec) || spec.includes('mongodb')) return null; // import-forbidden", 'import-forbidden')],
    ['import-url', 'import-url', (s) => replaceOnce(s, "if (spec.includes('://')) return 'specifier not allowed'; // import-url", "if (spec.includes('://')) return null; // import-url", 'import-url')],
    ['import-bare', 'import-bare', (s) => replaceOnce(s, "if (!spec.startsWith('./') && !spec.startsWith('../')) return 'specifier not allowed'; // import-bare", "if (!spec.startsWith('./') && !spec.startsWith('../')) return null; // import-bare", 'import-bare')],
    ['import-emet', 'import-emet', (s) => replaceOnce(s, "return 'emet/rune'; // import-emet", "return null; // import-emet", 'import-emet')],
    ['import-escape', 'import-escape', (s) => replaceOnce(s, "if (norm.startsWith('../') || norm === '..' || norm.startsWith('/')) return 'specifier not allowed'; // import-escape", "if (norm.startsWith('../') || norm === '..' || norm.startsWith('/')) return null; // import-escape", 'import-escape')],
    ['import-dotdot', 'import-dotdot', (s) => replaceOnce(s, "if (mode !== 'gc16' && !hasList && spec.startsWith('../')) return 'specifier not allowed'; // import-dotdot", "if (mode !== 'gc16' && !hasList && spec.startsWith('../')) return null; // import-dotdot", 'import-dotdot')],
    ['import-unlisted', 'import-unlisted', (s) => replaceOnce(s, "if (hasList && !listed.includes(norm)) return 'specifier not allowed'; // import-unlisted", "if (hasList && !listed.includes(norm)) return null; // import-unlisted", 'import-unlisted')],
    ['import-runes', 'import-outside-runes', (s) => replaceOnce(s, "if (!norm.startsWith('runes/')) return 'specifier not allowed'; // import-runes", "if (!norm.startsWith('runes/')) return null; // import-runes", 'import-runes')],
    ['import-symlink', 'import-symlink', (s) => replaceOnce(s, "return 'specifier not allowed'; // import-symlink", "return null; // import-symlink", 'import-symlink')],
    ['rune-ext', 'rune-txt', (s) => replaceOnce(s, "return 'rune extension'; // rune-ext", "return null; // rune-ext", 'rune-ext')],
    ['pattern-bigint', 'pattern-bigint', (s) => {
      const prim = replaceOnce(s, "typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean'", "typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean' || typeof node.value === 'bigint'", 'pattern-bigint-direct');
      return replaceOnce(prim, "if (!prim || (prim.vtype !== 'string' && prim.vtype !== 'number')) return null;", "if (!prim || (prim.vtype !== 'string' && prim.vtype !== 'number' && prim.vtype !== 'bigint')) return null;", 'pattern-bigint');
    }],
    ['delete-input', 'delete-input-key', (s) => replaceOnce(s, "if (node.operator === 'delete' && node.argument.type === 'MemberExpression') checkMemberWrite(node.argument, ctx); // delete-member", "if (node.operator === 'delete' && node.argument.type === 'MemberExpression') { /* delete-member */ }", 'delete-input')]
  ];
  const cross = corpus.cases.find((item) => item.id === 'math-member');
  const dir = path.join(ROOT, 'tests/.mutants');
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    let killed = 0;
    for (const [id, witnessId, apply] of logic) {
      const item = corpus.cases.find((row) => row.id === witnessId);
      assert.ok(item, witnessId);
      assert.strictEqual(gateVerdict(refuseHostAccess, item).ok, false, id);
      const file = path.join(dir, 'logic-' + id + '.mjs');
      await fs.promises.writeFile(file, apply(src));
      const mod = await import(pathToFileURL(file).href);
      const after = gateVerdict(mod.refuseHostAccess, item);
      assert.strictEqual(after.ok, true, id + ' mutant still ' + after.rule + ' ' + after.reason);
      assert.strictEqual(verdict(mod.refuseHostAccess, cross.source).ok, false, id + ' also let math through');
      killed += 1;
    }
    const pin = src.replace("if (acornVersion !== '8.19.0') {", "if (acornVersion !== '9.9.9') {");
    assert.notStrictEqual(pin, src);
    const pinFile = path.join(dir, 'logic-acorn-pin.mjs');
    await fs.promises.writeFile(pinFile, pin);
    await assert.rejects(() => import(pathToFileURL(pinFile).href), /acorn pin/);
    killed += 1;
    console.log('logic kills: ' + killed);
    assert.strictEqual(killed, 57);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

summary('host reach');
