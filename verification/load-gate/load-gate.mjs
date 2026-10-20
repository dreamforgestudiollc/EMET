/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Load gate for a client RUNE. The server never runs the file. This module
 * is the scanner EMET-GEMs vendors: keep it byte-identical, including the
 * corpus under verification/load-gate/. acorn 8.19.0 only. A parse error
 * fails closed. There is no second scan and no child process.
 *
 * Allowlist, not a denylist of tricks:
 * - Only the AST node types this walker knows are admitted. Anything else
 *   (including a future node) is refused.
 * - No `var`. No binding anywhere may reuse a top-level name.
 * - `Math` is only a direct read or call of a listed member. Never `random`.
 *   The Math object is never stored, passed, returned, thrown, or spread.
 * - A computed member key is a string/number literal or a `const` bound
 *   directly to a primitive literal, and that literal is not
 *   constructor, __proto__, or prototype. The one other form is a read of a
 *   top-level frozen null-prototype table inside an Object.hasOwn guard.
 *   The key is one `const` binding, the same binding in the guard and the
 *   read, and that binding is a primitive: `const n = String(input.n)` or
 *   `Number(...)`, or a `typeof` check for `'string'` or `'number'` before
 *   the guard. That includes `for (const k of ...)`. A member, a `let`, a
 *   parameter, a shadowed `String`/`Number`, a second const of the same
 *   name, or a const object does not count. A computed key in a binding or
 *   assignment pattern is a string or number literal only; concatenation, a
 *   member, and a const name are refused. See pass-guarded-factors.
 * - The guard is safe for a non-own key only because the table is frozen
 *   and its prototype is null. The primitive coercion is what keeps the
 *   checked key the same as the key that is read. `RegExp` has no admitted
 *   members (`RegExp.$1` fails). `Buffer` and locale members fail.
 * - A table is `Object.freeze` of an object literal whose own `__proto__`
 *   is null, or `Object.freeze` of an array, nested the same way, values
 *   primitive or the same pattern. No other top-level call is admitted.
 *   A table is never passed, spread, returned, or method-called.
 * - A member write is admitted only on an object or array literal created
 *   in that function. `prototype`, `__proto__`, and `Array.prototype` are
 *   refused wherever they appear.
 * - An import specifier is a relative path under the same GEM's `runes/`.
 *   `node:`, a bare name, a URL, `emet/rune`, and a path that normalizes
 *   outside the GEM or outside `runes/` are refused. `../` with no file
 *   list is refused. A `./` import is refused when the caller passes
 *   `files` and the target is not listed. A resolved real path that leaves
 *   `runes/` is refused. A file under `runes/` that is not `.js` or `.mjs`
 *   is refused.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import * as acorn from 'acorn';

const acornVersion = createRequire(import.meta.url)('acorn/package.json').version;
if (acornVersion !== '8.19.0') {
  throw new Error('acorn pin: expected 8.19.0, got ' + acornVersion);
}

/** Same cap as a listed file in gem.schema.json. Larger input is not parsed. */
export const MAX_SOURCE_BYTES = 65536;

/** Bare identifiers. Each key is its own rule. */
export const HOST_GLOBALS = Object.freeze({
  globalThis: 'global',
  global: 'global',
  self: 'global',
  window: 'global',
  process: 'env',
  Date: 'clock',
  performance: 'clock',
  crypto: 'random',
  setTimeout: 'timer',
  setInterval: 'timer',
  setImmediate: 'timer',
  clearTimeout: 'timer',
  clearInterval: 'timer',
  clearImmediate: 'timer',
  queueMicrotask: 'timer',
  requestAnimationFrame: 'timer',
  cancelAnimationFrame: 'timer',
  Function: 'Function',
  eval: 'eval',
  require: 'require',
  Reflect: 'reflect',
  Intl: 'intl',
  navigator: 'navigator',
  WebAssembly: 'wasm',
  Atomics: 'atomics',
  Proxy: 'proxy',
  WeakRef: 'weakref',
  FinalizationRegistry: 'finalizer',
  SharedArrayBuffer: 'memory',
  Buffer: 'memory',
  structuredClone: 'intrinsic'
});

/** Members of Object that walk or rewrite the object graph. Each key is its own rule. */
export const OBJECT_METHODS = Object.freeze({
  getOwnPropertyDescriptor: 'intrinsic',
  getOwnPropertyDescriptors: 'intrinsic',
  getPrototypeOf: 'intrinsic',
  setPrototypeOf: 'intrinsic',
  defineProperty: 'intrinsic',
  defineProperties: 'intrinsic'
});

/** Member names refused on every object. */
export const MEMBER_NAMES = Object.freeze(Object.assign(Object.create(null), {
  constructor: 'Function',
  ['__proto__']: 'prototype',
  prototype: 'prototype'
}));

/** Direct Math.x reads and calls. `random` is absent on purpose. */
export const MATH_MEMBERS = Object.freeze(new Set([
  'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh',
  'cbrt', 'ceil', 'clz32', 'cos', 'cosh', 'exp', 'expm1', 'floor', 'fround',
  'hypot', 'imul', 'log', 'log1p', 'log10', 'log2', 'max', 'min', 'pow',
  'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc',
  'E', 'LN10', 'LN2', 'LOG10E', 'LOG2E', 'PI', 'SQRT1_2', 'SQRT2'
]));

const STRUCTURAL_RULES = Object.freeze([
  'math', 'intrinsic', 'prototype', 'constructor', 'stack', 'computed',
  'table', 'member', 'callbind', 'var', 'shadow', 'for-in', 'module', 'new',
  'node', 'import', 'meta', 'bytes', 'parse', 'locale', 'specifier', 'extension'
]);

const FORBIDDEN_SPECIFIERS = new Set([
  'fs', 'node:fs', 'net', 'node:net', 'dgram', 'dns', 'tls', 'http', 'https',
  'child_process', 'worker_threads', 'cluster', 'vm', 'module', 'mongodb'
]);

/** A file under runes/ that is not a .js or .mjs module. Null means scan it. */
export function runeExtensionReason(rel) {
  if (typeof rel !== 'string' || !rel.startsWith('runes/') || rel.endsWith('/')) return null;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot <= 0 ? '' : base.slice(dot).toLowerCase();
  if (ext === '.js' || ext === '.mjs') return null;
  return 'rune extension'; // rune-ext
}

/**
 * Why this import specifier is refused, or null when it is allowed.
 * mode 'gc16' still allows `emet/rune` so GC-19 can name that failure.
 * `listed` is the GEM's file paths. Omit it on a source-only scan: a `./`
 * import is not a host reach, and `../` is refused unless the list proves it.
 * The normalized target must stay under `runes/`. `resolved` maps that
 * normalized path to its real path relative to the GEM. A real path outside
 * `runes/` is refused, which is how a symlink that leaves `runes/` fails.
 */
export function runeSpecifierReason(spec, fileRel, listed, mode, resolved) {
  if (spec === 'emet/rune') {
    if (mode === 'gc16') return null;
    return 'emet/rune'; // import-emet
  }
  if (typeof spec !== 'string') return 'specifier not allowed';
  if (spec.startsWith('node:')) return 'specifier not allowed'; // import-node
  if (FORBIDDEN_SPECIFIERS.has(spec) || spec.includes('mongodb')) return 'specifier not allowed'; // import-forbidden
  if (spec.includes('://')) return 'specifier not allowed'; // import-url
  if (!spec.startsWith('./') && !spec.startsWith('../')) return 'specifier not allowed'; // import-bare
  const hasList = Array.isArray(listed);
  const base = typeof fileRel === 'string' && fileRel.length > 0 ? fileRel : 'runes/module.js';
  const dir = path.posix.dirname(base);
  const norm = path.posix.normalize(path.posix.join(dir, spec));
  if (norm.startsWith('../') || norm === '..' || norm.startsWith('/')) return 'specifier not allowed'; // import-escape
  if (mode !== 'gc16' && !hasList && spec.startsWith('../')) return 'specifier not allowed'; // import-dotdot
  if (!norm.startsWith('runes/')) return 'specifier not allowed'; // import-runes
  if (hasList && !listed.includes(norm)) return 'specifier not allowed'; // import-unlisted
  if (resolved && typeof resolved === 'object' && Object.prototype.hasOwnProperty.call(resolved, norm)) {
    const real = resolved[norm];
    if (typeof real !== 'string' || !real.startsWith('runes/') || real.split('/').includes('..')) {
      return 'specifier not allowed'; // import-symlink
    }
  }
  return null;
}

const INTRINSICS = new Set(['Object', 'Array', 'JSON', 'Number', 'String', 'Boolean', 'RegExp', 'Error', 'TypeError', 'RangeError', 'EvalError', 'ReferenceError', 'SyntaxError', 'URIError']);
const ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'EvalError', 'ReferenceError', 'SyntaxError', 'URIError']);
const STACK_NAMES = new Set(['prepareStackTrace', 'stackTraceLimit', 'captureStackTrace', 'stack']);
const ALLOWED_MEMBERS = Object.freeze({
  Object: new Set(['hasOwn', 'freeze', 'is']),
  Array: new Set(['isArray']),
  JSON: new Set(['parse', 'stringify']),
  Number: new Set(['isFinite', 'isNaN', 'isInteger', 'isSafeInteger', 'parseFloat', 'parseInt']),
  String: new Set(['fromCharCode', 'fromCodePoint']),
  Boolean: new Set(),
  RegExp: new Set(),
  Error: new Set(),
  TypeError: new Set(),
  RangeError: new Set(),
  EvalError: new Set(),
  ReferenceError: new Set(),
  SyntaxError: new Set(),
  URIError: new Set()
});

const PARSE_OPTIONS = Object.freeze({
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowHashBang: true
});

const VALUE = Object.freeze({ kind: 'value' });
const POISON = Object.freeze({ kind: 'poison' });

export function hostRules() {
  const rules = Object.create(null);
  for (const name of Object.keys(HOST_GLOBALS)) rules[name] = true;
  for (const name of Object.keys(OBJECT_METHODS)) rules[name] = true;
  for (const name of STRUCTURAL_RULES) rules[name] = true;
  return rules;
}

function normalizeOff(rules) {
  const off = new Set();
  if (!rules) return off;
  if (rules.off instanceof Set) {
    for (const id of rules.off) off.add(id);
    return off;
  }
  for (const [key, value] of Object.entries(rules)) {
    if (value === false) off.add(key);
  }
  return off;
}

/**
 * Throw when the source is not an admitted RUNE. `rules` is a hostRules()
 * object with some keys set false, or `{ off: Set }`. A false rule is the
 * mutation hook used to prove that rule still has a witness.
 */
export function refuseHostAccess(source, rules, options) {
  const off = normalizeOff(rules);
  const importMode = options && options.importMode === 'gc16' ? 'gc16' : 'strict';
  const importFrom = options && typeof options.from === 'string' ? options.from : undefined;
  const importFiles = options && Array.isArray(options.files) ? options.files : undefined;
  const importResolved = options && options.resolved && typeof options.resolved === 'object' && !Array.isArray(options.resolved)
    ? options.resolved
    : undefined;
  function fail(branch, rule, reason) {
    if (off.has(rule)) return;
    const err = new Error('rune reaches the host');
    err.reason = reason;
    err.rule = rule;
    err.branch = branch;
    throw err;
  }
  function failMathValue() {
    fail('math-value', 'math', 'random'); // branch:math-value
  }
  function failMathMember() {
    fail('math-member', 'math', 'random'); // branch:math-member
  }
  function failMathWrite() {
    fail('math-write', 'math', 'random'); // branch:math-write
  }
  function failIntrinsic() {
    fail('intrinsic', 'intrinsic', 'intrinsic'); // branch:intrinsic
  }
  function failPrototype() {
    fail('prototype', 'prototype', 'prototype'); // branch:prototype
  }
  function failConstructor() {
    fail('constructor', 'constructor', 'Function'); // branch:constructor
  }
  function failStack() {
    fail('stack', 'stack', 'intrinsic'); // branch:stack
  }
  function failComputed() {
    fail('computed', 'computed', 'computed key'); // branch:computed
  }
  function failTable() {
    fail('table', 'table', 'module state'); // branch:table
  }
  function failMember() {
    fail('member', 'member', 'module state'); // branch:member
  }
  function failCallBind() {
    fail('callbind', 'callbind', 'module state'); // branch:callbind
  }
  function failVar() {
    fail('var', 'var', 'syntax'); // branch:var
  }
  function failShadow() {
    fail('shadow', 'shadow', 'syntax'); // branch:shadow
  }
  function failForIn() {
    fail('for-in', 'for-in', 'syntax'); // branch:for-in
  }
  function failModule() {
    fail('module', 'module', 'module state'); // branch:module
  }
  function failNew() {
    fail('new', 'new', 'module state'); // branch:new
  }
  function failNode() {
    fail('node', 'node', 'syntax'); // branch:node
  }
  function failImport() {
    fail('import', 'import', 'syntax'); // branch:import
  }
  function failMeta() {
    fail('meta', 'meta', 'env'); // branch:meta
  }
  function failLocale() {
    fail('locale', 'locale', 'intl'); // branch:locale
  }
  function failObjectMethod(name) {
    fail('object-method', name, 'intrinsic'); // branch:object-method
  }

  function noteImport(sourceNode) {
    if (!sourceNode || sourceNode.type !== 'Literal' || typeof sourceNode.value !== 'string') {
      fail('specifier', 'specifier', 'specifier not allowed');
      return;
    }
    const reason = runeSpecifierReason(sourceNode.value, importFrom, importFiles, importMode, importResolved);
    if (reason) fail('specifier', 'specifier', reason);
  }

  if (options && typeof options.path === 'string') {
    const extReason = runeExtensionReason(options.path);
    if (extReason) fail('extension', 'extension', extReason);
  }

  if (typeof source !== 'string') source = String(source);
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    fail('bytes', 'bytes', 'too large'); // branch:bytes
    return;
  }
  let ast;
  try {
    ast = acorn.parse(source, PARSE_OPTIONS);
  } catch {
    fail('parse', 'parse', 'parse'); // branch:parse
    return;
  }

  const root = {
    parent: null,
    map: new Map(),
    fnDepth: 0,
    guards: [],
    prims: [],
    topNames: new Set(),
    imports: new Set()
  };

  function lookup(ctx, name) {
    for (let s = ctx; s; s = s.parent) {
      if (s.map.has(name)) return s.map.get(name);
    }
    return null;
  }
  function child(ctx, fn) {
    return {
      parent: ctx,
      map: new Map(),
      fnDepth: fn ? ctx.fnDepth + 1 : ctx.fnDepth,
      guards: fn ? [] : ctx.guards,
      prims: fn ? [] : ctx.prims,
      topNames: ctx.topNames,
      imports: ctx.imports
    };
  }
  function withGuards(ctx, guards) {
    return {
      parent: ctx.parent,
      map: ctx.map,
      fnDepth: ctx.fnDepth,
      guards,
      prims: ctx.prims,
      topNames: ctx.topNames,
      imports: ctx.imports
    };
  }
  function withPrims(ctx, prims) {
    return {
      parent: ctx.parent,
      map: ctx.map,
      fnDepth: ctx.fnDepth,
      guards: ctx.guards,
      prims,
      topNames: ctx.topNames,
      imports: ctx.imports
    };
  }
  function fork(ctx, guards, prims) {
    if (guards === ctx.guards && prims === ctx.prims) return ctx;
    return {
      parent: ctx.parent,
      map: ctx.map,
      fnDepth: ctx.fnDepth,
      guards,
      prims,
      topNames: ctx.topNames,
      imports: ctx.imports
    };
  }
  function bind(ctx, name, info) {
    if (ctx.fnDepth > 0 && ctx.topNames.has(name)) failShadow();
    ctx.map.set(name, info);
  }

  function directPrim(node) {
    if (!node) return null;
    if (node.type === 'Literal' && !node.regex) {
      if (node.value === null) return { value: null, vtype: 'null' };
      if (typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean') {
        return { value: node.value, vtype: typeof node.value };
      }
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
      return { value: node.quasis.map((q) => q.value.cooked).join(''), vtype: 'string' };
    }
    if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+') && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
      const n = node.operator === '-' ? -node.argument.value : node.argument.value;
      return { value: n, vtype: 'number' };
    }
    return null;
  }
  function evalPrim(node, ctx) {
    const direct = directPrim(node);
    if (direct) return direct;
    if (node && node.type === 'Identifier' && ctx) {
      const b = lookup(ctx, node.name);
      if (b && b.kind === 'prim') return { value: b.value, vtype: b.vtype };
    }
    return null;
  }
  function primName(prim) {
    if (!prim) return null;
    if (prim.vtype === 'null') return 'null';
    return String(prim.value);
  }
  function bannedKey(name) {
    if (name === 'constructor') return 'constructor';
    if (name === '__proto__' || name === 'prototype') return 'prototype';
    return null;
  }

  function isObjectGlobal(node, ctx) {
    return !!(node && node.type === 'Identifier' && node.name === 'Object' && ctx && !lookup(ctx, node.name));
  }
  function isFreezeCall(node, ctx) {
    return node && node.type === 'CallExpression' && node.arguments.length === 1
      && node.callee.type === 'MemberExpression' && !node.callee.computed && !node.callee.optional
      && isObjectGlobal(node.callee.object, ctx)
      && node.callee.property.type === 'Identifier' && node.callee.property.name === 'freeze';
  }
  function isLocaleName(name) {
    return name === 'toLocaleString' || name === 'localeCompare' || name === 'toLocaleDateString' || name === 'toLocaleTimeString' || name === 'toLocaleUpperCase' || name === 'toLocaleLowerCase';
  }
  function refuseLocaleKey(name) {
    if (isLocaleName(name)) failLocale();
  }
  // Direct string/number literal, including `1`, `-1`, and a template with no holes.
  function literalKey(node) {
    const prim = directPrim(node);
    if (!prim || (prim.vtype !== 'string' && prim.vtype !== 'number')) return null;
    return primName(prim);
  }
  // constructor / prototype / locale for every resolved key name.
  // Returns 'poison' or 'locale' when that name is one of those, even if the
  // rule is off, so a later check does not replace the refusal.
  // Object-literal `__proto__` is the one exception: the value check stays with the literal.
  function screenKey(name, role) {
    if (name == null) return null;
    const ban = bannedKey(name);
    if (ban === 'constructor') { failConstructor(); return 'poison'; }
    if (ban === 'prototype' && !(role === 'prop' && name === '__proto__')) { failPrototype(); return 'poison'; }
    if (role !== 'prop' && isLocaleName(name)) { refuseLocaleKey(name); return 'locale'; }
    return null;
  }
  // Every Property and MemberExpression key comes through here.
  // role 'member' may be dynamic (a guarded table index). 'write' may be a const primitive.
  // 'prop' and 'pattern' accept a computed key only when it is a literal.
  function readKey(node, ctx, role) {
    const computed = !!node.computed;
    const keyNode = node.type === 'MemberExpression' ? node.property : node.key;
    if (!computed) {
      let name = null;
      if (keyNode && keyNode.type === 'Identifier') name = keyNode.name;
      else name = literalKey(keyNode);
      if (role === 'pattern' && name == null) failComputed();
      return { name, dynamic: false, stop: screenKey(name, role) };
    }
    expr(keyNode, ctx, 'value');
    if (role === 'pattern' || role === 'prop') {
      const name = literalKey(keyNode);
      if (name == null) failComputed(); // pattern-prop-literal
      return { name, dynamic: false, stop: name == null ? null : screenKey(name, role) };
    }
    const prim = evalPrim(keyNode, ctx);
    if (prim && (prim.vtype === 'string' || prim.vtype === 'number' || prim.vtype === 'boolean' || prim.vtype === 'null')) {
      const name = primName(prim);
      return { name, dynamic: false, stop: screenKey(name, role) };
    }
    if (role === 'member') return { name: null, dynamic: true, stop: null };
    failComputed();
    return { name: null, dynamic: false, stop: null };
  }
  function calleeMethodName(member) {
    if (!member.computed && member.property.type === 'Identifier') return member.property.name;
    if (member.computed) return literalKey(member.property);
    return null;
  }
  function freezeSchema(node, ctx) {
    if (!node) return null;
    if (node.type === 'ArrayExpression') {
      const elements = [];
      for (const el of node.elements) {
        if (!el || el.type === 'SpreadElement') return null;
        const prim = directPrim(el);
        if (prim) { elements.push({ kind: 'prim', value: prim.value, vtype: prim.vtype }); continue; }
        if (isFreezeCall(el, ctx)) {
          const inner = freezeSchema(el.arguments[0], ctx);
          if (!inner) return null;
          elements.push(inner);
          continue;
        }
        return null;
      }
      return { kind: 'array', elements };
    }
    if (node.type !== 'ObjectExpression') return null;
    let sawNull = false;
    const props = new Map();
    for (const prop of node.properties) {
      if (prop.type === 'SpreadElement' || prop.type !== 'Property') return null;
      if (prop.method || prop.kind !== 'init' || prop.shorthand) return null;
      const name = readKey(prop, ctx, 'prop').name;
      if (name == null) return null;
      if (name === '__proto__') {
        if (prop.value.type === 'Literal' && prop.value.value === null && !sawNull) { sawNull = true; continue; }
        failPrototype();
        return null;
      }
      const prim = directPrim(prop.value);
      if (prim) { props.set(name, { kind: 'prim', value: prim.value, vtype: prim.vtype }); continue; }
      if (isFreezeCall(prop.value, ctx)) {
        const inner = freezeSchema(prop.value.arguments[0], ctx);
        if (!inner) return null;
        props.set(name, inner);
        continue;
      }
      return null;
    }
    if (!sawNull) return null;
    return { kind: 'object', props };
  }
  function tryFreeze(node, ctx) {
    if (!isFreezeCall(node, ctx)) return null;
    const arg = node.arguments[0];
    if (arg.type === 'SpreadElement') return null;
    return freezeSchema(arg, ctx);
  }

  function sameExpr(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'Identifier') return a.name === b.name;
    if (a.type === 'Literal') return !a.regex && !b.regex && a.value === b.value;
    if (a.type === 'UnaryExpression') return a.operator === b.operator && sameExpr(a.argument, b.argument);
    if (a.type === 'MemberExpression') {
      if (!!a.computed !== !!b.computed || !!a.optional !== !!b.optional) return false;
      if (!sameExpr(a.object, b.object)) return false;
      if (!a.computed) return a.property.name === b.property.name;
      return sameExpr(a.property, b.property);
    }
    return false;
  }
  function isHasOwnName(name) {
    return name === 'hasOwn';
  }
  function matchHasOwn(node) {
    if (!node) return null;
    let negated = false;
    let call = node;
    if (node.type === 'UnaryExpression' && node.operator === '!') {
      negated = true;
      call = node.argument;
    }
    if (!call || call.type !== 'CallExpression' || call.arguments.length !== 2) return null;
    const callee = call.callee;
    if (callee.type !== 'MemberExpression' || callee.computed || callee.optional) return null;
    if (callee.object.type !== 'Identifier' || callee.object.name !== 'Object') return null;
    if (callee.property.type !== 'Identifier' || !isHasOwnName(callee.property.name)) return null;
    const table = call.arguments[0];
    if (!table || table.type !== 'Identifier') return null;
    return { table: table.name, key: call.arguments[1], negated };
  }
  // ident is the only admitted key. member stays off unless a logic mutant turns it on.
  function keyMode(node) {
    if (!node) return null;
    if (node.type === 'Identifier') return 'ident';
    return null;
  }
  function noteGuard(ctx, guard) {
    if (!guard) return null;
    const mode = keyMode(guard.key);
    if (mode === 'member') return { table: guard.table, key: guard.key, binding: null, negated: guard.negated };
    if (mode !== 'ident') return null;
    const binding = lookup(ctx, guard.key.name);
    if (!binding) return null;
    return { table: guard.table, key: guard.key, binding, negated: guard.negated };
  }
  function keysMatch(ctx, guard, keyNode) {
    if (!guard || !keyNode) return false;
    const mode = keyMode(keyNode);
    if (mode === 'member') return sameExpr(guard.key, keyNode);
    if (mode !== 'ident' || guard.key.type !== 'Identifier') return false;
    const bound = lookup(ctx, keyNode.name);
    return !!(bound && bound.snapshot && keyIsPrim(ctx, bound) && guard.binding === bound);
  }
  function keyIsPrim(ctx, bound) {
    if (!bound) return false;
    if (bound.kind === 'prim' || bound.primKey) return true;
    return ctx.prims.some((item) => item === bound);
  }
  function isPrimCoercion(node, ctx) {
    if (!node || node.type !== 'CallExpression' || node.optional) return false;
    if (node.arguments.length !== 1 || !node.arguments[0] || node.arguments[0].type === 'SpreadElement') return false;
    const callee = node.callee;
    if (callee.type !== 'Identifier') return false;
    if (callee.name !== 'String' && callee.name !== 'Number') return false;
    return !lookup(ctx, callee.name);
  }
  function typeofPair(node) {
    if (!node || node.type !== 'BinaryExpression') return null;
    if (node.operator !== '===' && node.operator !== '!==') return null;
    let unary = null;
    let lit = null;
    if (node.left.type === 'UnaryExpression' && node.left.operator === 'typeof') {
      unary = node.left;
      lit = node.right;
    } else if (node.right.type === 'UnaryExpression' && node.right.operator === 'typeof') {
      unary = node.right;
      lit = node.left;
    } else return null;
    if (!unary.argument || unary.argument.type !== 'Identifier') return null;
    if (!lit || lit.type !== 'Literal' || (lit.value !== 'string' && lit.value !== 'number')) return null;
    return { name: unary.argument.name, positive: node.operator === '===', type: lit.value };
  }
  function typeNarrow(node) {
    const one = typeofPair(node);
    if (one) return { name: one.name, polarity: one.positive ? 'include' : 'exclude' };
    if (!node || node.type !== 'LogicalExpression') return null;
    const left = typeofPair(node.left);
    const right = typeofPair(node.right);
    if (!left || !right || left.name !== right.name || left.type === right.type) return null;
    if (node.operator === '||' && left.positive && right.positive) return { name: left.name, polarity: 'include' };
    if (node.operator === '&&' && !left.positive && !right.positive) return { name: left.name, polarity: 'exclude' };
    return null;
  }
  function guarded(ctx, tableName, keyNode) {
    return ctx.guards.some((g) => g.table === tableName && keysMatch(ctx, g, keyNode));
  }

  function consume(schema, role) {
    if (!schema || schema.kind === 'poison') return schema || VALUE;
    if (role === 'member-object' || role === 'hasown-table' || role === 'callee') return schema;
    if (schema.kind === 'math') { failMathValue(); return VALUE; }
    if (schema.kind === 'intrinsic') { failIntrinsic(); return VALUE; }
    if (schema.kind === 'table') { failTable(); return VALUE; }
    return schema.kind === 'prim' ? schema : VALUE;
  }
  function expr(node, ctx, role) {
    if (!node) return VALUE;
    return consume(raw(node, ctx), role || 'value');
  }

  function propSchema(schema, name) {
    if (!schema) return VALUE;
    if (schema.kind === 'array') {
      if (!/^(0|[1-9][0-9]*)$/.test(name)) return VALUE;
      const el = schema.elements[Number(name)];
      if (!el) return VALUE;
      if (el.kind === 'prim') return el;
      return { kind: 'table', schema: el, name: null };
    }
    if (schema.kind !== 'object') return VALUE;
    const prop = schema.props.get(name);
    if (!prop) return VALUE;
    if (prop.kind === 'prim') return prop;
    if (prop.kind === 'object' || prop.kind === 'array') return { kind: 'table', schema: prop, name: null };
    return VALUE;
  }
  function unionObject(schema) {
    const vals = [...schema.props.values()];
    if (vals.every((v) => v.kind === 'prim')) return { kind: 'prim', value: null, vtype: 'null' };
    if (vals.every((v) => v.kind === 'object')) {
      const keys = new Set();
      for (const v of vals) for (const k of v.props.keys()) keys.add(k);
      const props = new Map();
      for (const key of keys) {
        const kids = vals.map((v) => v.props.get(key));
        if (kids.length === vals.length && kids.every((k) => k && k.kind === 'prim')) {
          props.set(key, { kind: 'prim', value: null, vtype: 'null' });
        }
      }
      return { kind: 'table', schema: { kind: 'object', props }, name: null };
    }
    return { kind: 'table', schema: { kind: 'object', props: new Map() }, name: null };
  }
  function dynamicTable(schema) {
    if (schema && schema.kind === 'object') return unionObject(schema);
    return null;
  }

  function resolveMember(member, ctx) {
    const obj = expr(member.object, ctx, 'member-object');
    if (obj.kind === 'poison') return { obj, schema: POISON };
    const key = readKey(member, ctx, 'member');
    const keyName = key.name;
    const dynamic = key.dynamic;
    if (key.stop === 'poison') return { obj, schema: POISON };
    if (key.stop === 'locale') return { obj, schema: VALUE };
    if (keyName && Object.hasOwn(OBJECT_METHODS, keyName)) {
      failObjectMethod(keyName);
      return { obj, schema: VALUE };
    }
    if (keyName && STACK_NAMES.has(keyName)) { failStack(); return { obj, schema: VALUE }; }
    if (obj.kind === 'math') {
      if (!keyName || !MATH_MEMBERS.has(keyName)) failMathMember();
      return { obj, schema: VALUE };
    }
    if (obj.kind === 'intrinsic') {
      const allowed = ALLOWED_MEMBERS[obj.name] || new Set();
      if (!keyName || !allowed.has(keyName)) failIntrinsic();
      return { obj, schema: { kind: 'intrinsic-member', name: obj.name, member: keyName } };
    }
    if (obj.kind === 'table') {
      if (keyName != null && !dynamic) return { obj, schema: propSchema(obj.schema, keyName) };
      if (dynamic && obj.name && guarded(ctx, obj.name, member.property)) {
        const next = dynamicTable(obj.schema);
        if (next) return { obj, schema: next };
      }
      failComputed();
      return { obj, schema: VALUE };
    }
    if (dynamic) { failComputed(); return { obj, schema: VALUE }; }
    if (obj.kind === 'local') return { obj, schema: { kind: 'local' } };
    return { obj, schema: VALUE };
  }

  function checkMemberWrite(member, ctx) {
    const key = readKey(member, ctx, 'write');
    if (key.stop) return;
    const keyName = key.name;
    if (keyName && Object.hasOwn(OBJECT_METHODS, keyName)) {
      failObjectMethod(keyName);
      return;
    }
    if (keyName && STACK_NAMES.has(keyName)) { failStack(); return; }
    const obj = expr(member.object, ctx, 'member-object');
    if (!obj || obj.kind === 'poison') return;
    if (obj.kind === 'math') { failMathWrite(); return; }
    if (obj.kind === 'intrinsic' || obj.kind === 'intrinsic-member') { failIntrinsic(); return; }
    if (obj.kind === 'table') { failTable(); return; }
    if (obj.kind !== 'local') failMember();
  }

  function visitArgs(args, ctx, firstRole) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!arg) continue;
      if (arg.type === 'SpreadElement') expr(arg.argument, ctx, 'value');
      else expr(arg, ctx, i === 0 && firstRole ? firstRole : 'value');
    }
  }

  function rawIdent(node, ctx) {
    const bound = lookup(ctx, node.name);
    if (bound) {
      if (bound.kind === 'table') return { kind: 'table', schema: bound.schema, name: node.name };
      if (bound.kind === 'prim') return { kind: 'prim', value: bound.value, vtype: bound.vtype };
      if (bound.kind === 'local') return { kind: 'local' };
      return VALUE;
    }
    if (HOST_GLOBALS[node.name]) {
      fail('global', node.name, HOST_GLOBALS[node.name]); // branch:global
      return VALUE;
    }
    if (node.name === 'Math') return { kind: 'math' };
    if (INTRINSICS.has(node.name)) return { kind: 'intrinsic', name: node.name };
    return VALUE;
  }

  function raw(node, ctx) {
    if (!node || typeof node.type !== 'string') { failNode(); return VALUE; }
    switch (node.type) {
      case 'Identifier':
        return rawIdent(node, ctx);
      case 'Literal':
        return directPrim(node) || VALUE;
      case 'TemplateLiteral':
        for (const e of node.expressions) expr(e, ctx, 'value');
        return directPrim(node) || VALUE;
      case 'UnaryExpression':
        if (node.operator === 'delete' && node.argument.type === 'MemberExpression') checkMemberWrite(node.argument, ctx); // delete-member
        else expr(node.argument, ctx, 'value');
        return VALUE;
      case 'UpdateExpression':
        if (node.argument.type === 'MemberExpression') checkMemberWrite(node.argument, ctx);
        else expr(node.argument, ctx, 'value');
        return VALUE;
      case 'BinaryExpression':
        expr(node.left, ctx, 'value');
        expr(node.right, ctx, 'value');
        return VALUE;
      case 'LogicalExpression': {
        const guard = noteGuard(ctx, matchHasOwn(node.left));
        expr(node.left, ctx, 'value');
        let rightCtx = ctx;
        if (guard && ((node.operator === '&&' && !guard.negated) || (node.operator === '||' && guard.negated))) {
          rightCtx = withGuards(ctx, ctx.guards.concat(guard));
        }
        expr(node.right, rightCtx, 'value');
        return VALUE;
      }
      case 'AssignmentExpression':
        assignTarget(node.left, ctx);
        expr(node.right, ctx, 'value');
        return VALUE;
      case 'ConditionalExpression': {
        const guard = noteGuard(ctx, matchHasOwn(node.test));
        expr(node.test, ctx, 'value');
        const cons = guard && !guard.negated ? withGuards(ctx, ctx.guards.concat(guard)) : ctx; // ternary-cons
        const alt = guard && guard.negated ? withGuards(ctx, ctx.guards.concat(guard)) : ctx; // ternary-alt
        expr(node.consequent, cons, 'value');
        expr(node.alternate, alt, 'value');
        return VALUE;
      }
      case 'SequenceExpression':
        for (const e of node.expressions) expr(e, ctx, 'value');
        return VALUE;
      case 'ArrayExpression':
        for (const el of node.elements) if (el) expr(el.type === 'SpreadElement' ? el.argument : el, ctx, 'value');
        return { kind: 'local' };
      case 'ObjectExpression':
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') { expr(prop.argument, ctx, 'value'); continue; }
          if (prop.type !== 'Property') { failNode(); continue; }
          const name = readKey(prop, ctx, 'prop').name;
          if (name === '__proto__') {
            const ok = prop.value.type === 'Literal' && prop.value.value === null;
            if (!ok) failPrototype();
          }
          if (prop.kind === 'init' && !prop.method) expr(prop.value, ctx, 'value');
          else visitFunction(prop.value, ctx);
        }
        return { kind: 'local' };
      case 'MemberExpression':
        return resolveMember(node, ctx).schema;
      case 'ChainExpression':
        return raw(node.expression, ctx);
      case 'CallExpression':
        return rawCall(node, ctx);
      case 'NewExpression':
        return rawNew(node, ctx);
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        visitFunction(node, ctx);
        return VALUE;
      case 'YieldExpression':
        if (node.argument) expr(node.argument, ctx, 'value');
        return VALUE;
      case 'AwaitExpression':
        expr(node.argument, ctx, 'value');
        return VALUE;
      case 'ThisExpression':
        return VALUE;
      case 'MetaProperty':
        failMeta();
        return VALUE;
      case 'ImportExpression':
        failImport();
        if (node.source) expr(node.source, ctx, 'value');
        return VALUE;
      case 'TaggedTemplateExpression':
        failNode();
        return VALUE;
      default:
        failNode();
        return VALUE;
    }
  }

  function rawCall(node, ctx) {
    const callee = node.callee;
    if (callee.type === 'MemberExpression') {
      const keyName = calleeMethodName(callee);
      if (keyName === 'call' || keyName === 'apply' || keyName === 'bind') failCallBind();
      const resolved = resolveMember(callee, ctx);
      if (resolved.schema && resolved.schema.kind === 'intrinsic-member' && resolved.schema.name === 'Object' && isHasOwnName(resolved.schema.member)) {
        visitArgs(node.arguments, ctx, 'hasown-table');
        return VALUE;
      }
      if (resolved.obj && resolved.obj.kind === 'table') failTable();
      visitArgs(node.arguments, ctx, null);
      return VALUE;
    }
    const schema = expr(callee, ctx, 'callee');
    if (schema.kind === 'math') failMathValue();
    if (schema.kind === 'intrinsic' && !ERRORS.has(schema.name)) {
      const asCall = schema.name === 'Array' || schema.name === 'Object' || schema.name === 'Number' || schema.name === 'String' || schema.name === 'Boolean';
      if (!asCall) failIntrinsic();
    }
    if (schema.kind === 'table') failTable();
    visitArgs(node.arguments, ctx, null);
    return VALUE;
  }

  function rawNew(node, ctx) {
    visitArgs(node.arguments, ctx, null);
    const callee = node.callee;
    if (callee.type === 'Identifier' && ERRORS.has(callee.name) && !lookup(ctx, callee.name)) return VALUE; // new-intrinsic
    expr(callee, ctx, 'callee');
    failNew();
    return VALUE;
  }

  function assignTarget(node, ctx) {
    if (!node) return;
    if (node.type === 'Identifier') return;
    if (node.type === 'MemberExpression') { checkMemberWrite(node, ctx); return; }
    if (node.type === 'AssignmentPattern') {
      assignTarget(node.left, ctx);
      expr(node.right, ctx, 'value');
      return;
    }
    if (node.type === 'RestElement') { assignTarget(node.argument, ctx); return; }
    if (node.type === 'ObjectPattern') {
      for (const prop of node.properties) {
        if (prop.type === 'RestElement') { assignTarget(prop.argument, ctx); continue; }
        if (prop.type !== 'Property') { failNode(); continue; }
        readKey(prop, ctx, 'pattern');
        assignTarget(prop.value, ctx);
      }
      return;
    }
    if (node.type === 'ArrayPattern') {
      for (const el of node.elements) if (el) assignTarget(el, ctx);
      return;
    }
    failNode();
  }

  function bindPattern(node, ctx, kind) {
    if (!node) return;
    if (node.type === 'Identifier') { bind(ctx, node.name, { kind: 'value', snapshot: kind === 'const' }); return; }
    if (node.type === 'AssignmentPattern') {
      if (node.right) expr(node.right, ctx, 'value');
      bindPattern(node.left, ctx, kind);
      return;
    }
    if (node.type === 'RestElement') { bindPattern(node.argument, ctx, kind); return; }
    if (node.type === 'ObjectPattern') {
      for (const prop of node.properties) {
        if (prop.type === 'RestElement') { bindPattern(prop.argument, ctx, kind); continue; }
        if (prop.type !== 'Property') { failNode(); continue; }
        readKey(prop, ctx, 'pattern');
        bindPattern(prop.value, ctx, kind);
      }
      return;
    }
    if (node.type === 'ArrayPattern') {
      for (const el of node.elements) if (el) bindPattern(el, ctx, kind);
      return;
    }
    failNode();
  }

  function isFn(node) {
    return node && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression');
  }

  function bindTop(name, init, ctx) {
    if (!init) { failModule(); bind(ctx, name, { kind: 'value' }); return; }
    if (isFn(init)) {
      if (init.generator) failNode();
      visitFunction(init, ctx);
      bind(ctx, name, { kind: 'function' });
      return;
    }
    const prim = directPrim(init);
    if (prim) { bind(ctx, name, { kind: 'prim', value: prim.value, vtype: prim.vtype }); return; }
    const frozen = tryFreeze(init, ctx);
    if (frozen) { bind(ctx, name, { kind: 'table', schema: frozen }); return; }
    if (init.type === 'Identifier' && ctx.imports.has(init.name)) {
      bind(ctx, name, { kind: 'value' });
      return;
    }
    expr(init, ctx, 'value');
    failModule();
    bind(ctx, name, { kind: 'value' });
  }

  function visitVar(node, ctx, top) {
    if (node.kind === 'var') failVar();
    if (node.kind !== 'const' && node.kind !== 'let' && node.kind !== 'var') failNode();
    if (top && node.kind !== 'const') failModule();
    for (const decl of node.declarations) {
      if (decl.id.type !== 'Identifier') {
        if (decl.init) expr(decl.init, ctx, 'value');
        bindPattern(decl.id, ctx, node.kind);
        if (top) failModule();
        continue;
      }
      if (top) { bindTop(decl.id.name, decl.init, ctx); continue; }
      let info = { kind: 'value' };
      if (decl.init && node.kind === 'const') {
        const prim = directPrim(decl.init);
        if (prim) info = { kind: 'prim', value: prim.value, vtype: prim.vtype };
      }
      if (decl.init && (decl.init.type === 'ObjectExpression' || decl.init.type === 'ArrayExpression')) {
        info = { kind: 'local' };
      }
      if (node.kind === 'const') {
        info.snapshot = true;
        if (info.kind === 'prim' || isPrimCoercion(decl.init, ctx)) info.primKey = true;
      }
      if (decl.init && info.kind !== 'prim') expr(decl.init, ctx, 'value');
      bind(ctx, decl.id.name, info);
    }
  }

  function visitFunction(node, ctx) {
    if (!node) return;
    if (node.generator) failNode();
    const scope = child(ctx, true);
    for (const param of node.params || []) bindPattern(param, scope, 'param');
    if (node.body && node.body.type === 'BlockStatement') visitBlock(node.body, scope, true);
    else if (node.body) expr(node.body, scope, 'value');
  }

  function hoist(body, scope) {
    for (const stmt of body) {
      if (stmt.type === 'FunctionDeclaration' && stmt.id) bind(scope, stmt.id.name, { kind: 'function' });
    }
  }

  function abrupt(stmt) {
    if (!stmt) return false;
    if (stmt.type === 'ReturnStatement' || stmt.type === 'ThrowStatement' || stmt.type === 'BreakStatement' || stmt.type === 'ContinueStatement') return true;
    if (stmt.type === 'BlockStatement' && stmt.body.length === 1) return abrupt(stmt.body[0]);
    return false;
  }
  function earlyGuard(stmt) {
    if (stmt.type !== 'IfStatement' || stmt.alternate) return null;
    const guard = matchHasOwn(stmt.test);
    if (!guard || !guard.negated || !abrupt(stmt.consequent)) return null;
    return guard;
  }
  function earlyPrim(stmt, ctx) {
    if (!stmt || stmt.type !== 'IfStatement' || stmt.alternate) return null;
    const info = typeNarrow(stmt.test);
    if (!info || info.polarity !== 'exclude' || !abrupt(stmt.consequent)) return null;
    const binding = lookup(ctx, info.name);
    if (!binding || !binding.snapshot) return null;
    return binding;
  }
  function visitSeq(body, scope) {
    let guards = scope.guards;
    let prims = scope.prims;
    for (const stmt of body) {
      const here = fork(scope, guards, prims);
      const extra = noteGuard(here, earlyGuard(stmt));
      const prim = earlyPrim(stmt, here);
      visitStmt(stmt, here);
      if (extra) guards = guards.concat(extra);
      if (prim) prims = prims.concat(prim);
    }
  }

  function visitBlock(block, ctx, same) {
    const scope = same ? ctx : child(ctx, false);
    hoist(block.body, scope);
    visitSeq(block.body, scope);
  }

  function visitStmt(stmt, ctx) {
    switch (stmt.type) {
      case 'EmptyStatement':
      case 'DebuggerStatement':
        return;
      case 'BlockStatement':
        visitBlock(stmt, ctx, false);
        return;
      case 'ExpressionStatement':
        expr(stmt.expression, ctx, 'value');
        return;
      case 'ReturnStatement':
        if (stmt.argument) expr(stmt.argument, ctx, 'value');
        return;
      case 'ThrowStatement':
        expr(stmt.argument, ctx, 'value');
        return;
      case 'LabeledStatement':
        visitStmt(stmt.body, ctx);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        return;
      case 'IfStatement': {
        const guard = noteGuard(ctx, matchHasOwn(stmt.test));
        const narrow = typeNarrow(stmt.test);
        expr(stmt.test, ctx, 'value');
        const cons0 = guard && !guard.negated ? withGuards(ctx, ctx.guards.concat(guard)) : ctx; // if-cons
        const alt0 = guard && guard.negated ? withGuards(ctx, ctx.guards.concat(guard)) : ctx; // if-alt
        const binding = narrow && lookup(ctx, narrow.name);
        const primed = binding && binding.snapshot ? binding : null;
        const cons = primed && narrow.polarity === 'include' ? withPrims(cons0, cons0.prims.concat(primed)) : cons0;
        const alt = primed && narrow.polarity === 'exclude' ? withPrims(alt0, alt0.prims.concat(primed)) : alt0;
        visitStmt(stmt.consequent, cons);
        if (stmt.alternate) visitStmt(stmt.alternate, alt);
        return;
      }
      case 'SwitchStatement':
        expr(stmt.discriminant, ctx, 'value');
        for (const c of stmt.cases) {
          if (c.test) expr(c.test, ctx, 'value');
          const scope = child(ctx, false);
          hoist(c.consequent, scope);
          visitSeq(c.consequent, scope);
        }
        return;
      case 'WhileStatement':
      case 'DoWhileStatement':
        expr(stmt.test, ctx, 'value');
        visitStmt(stmt.body, ctx);
        return;
      case 'ForStatement': {
        const scope = child(ctx, false);
        if (stmt.init) {
          if (stmt.init.type === 'VariableDeclaration') visitVar(stmt.init, scope, false);
          else expr(stmt.init, scope, 'value');
        }
        if (stmt.test) expr(stmt.test, scope, 'value');
        if (stmt.update) expr(stmt.update, scope, 'value');
        visitStmt(stmt.body, scope);
        return;
      }
      case 'ForOfStatement':
        if (stmt.await) failNode();
        {
          const scope = child(ctx, false);
          if (stmt.left.type === 'VariableDeclaration') visitVar(stmt.left, scope, false);
          else expr(stmt.left, scope, 'value');
          expr(stmt.right, ctx, 'value');
          visitStmt(stmt.body, scope);
        }
        return;
      case 'ForInStatement':
        if (stmt.left.type === 'VariableDeclaration' && stmt.left.kind === 'var') failVar();
        failForIn();
        return;
      case 'TryStatement':
        visitBlock(stmt.block, ctx, false);
        if (stmt.handler) {
          const scope = child(ctx, false);
          if (stmt.handler.param) bindPattern(stmt.handler.param, scope, 'catch');
          visitBlock(stmt.handler.body, scope, true);
        }
        if (stmt.finalizer) visitBlock(stmt.finalizer, ctx, false);
        return;
      case 'VariableDeclaration':
        visitVar(stmt, ctx, ctx.fnDepth === 0);
        return;
      case 'FunctionDeclaration':
        if (stmt.generator) failNode();
        if (stmt.id && ctx.fnDepth === 0) bind(ctx, stmt.id.name, { kind: 'function' });
        visitFunction(stmt, ctx);
        return;
      case 'ImportDeclaration':
        noteImport(stmt.source);
        for (const spec of stmt.specifiers) {
          ctx.topNames.add(spec.local.name);
          ctx.imports.add(spec.local.name);
          bind(ctx, spec.local.name, { kind: 'import' });
        }
        return;
      case 'ExportNamedDeclaration':
        if (stmt.source) noteImport(stmt.source);
        if (stmt.declaration) visitStmt(stmt.declaration, ctx);
        return;
      case 'ExportAllDeclaration':
        noteImport(stmt.source);
        failNode();
        return;
      case 'ExportDefaultDeclaration':
        if (stmt.declaration.type === 'FunctionDeclaration') {
          if (stmt.declaration.id) {
            ctx.topNames.add(stmt.declaration.id.name);
            bind(ctx, stmt.declaration.id.name, { kind: 'function' });
          }
          visitFunction(stmt.declaration, ctx);
          return;
        }
        if (isFn(stmt.declaration)) { visitFunction(stmt.declaration, ctx); return; }
        expr(stmt.declaration, ctx, 'value');
        return;
      default:
        failNode();
    }
  }

  function addTop(stmt, ctx) {
    if (!stmt) return;
    if (stmt.type === 'FunctionDeclaration' && stmt.id) ctx.topNames.add(stmt.id.name);
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) addPatternNames(decl.id, ctx);
    }
    if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) addTop(stmt.declaration, ctx);
    if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration.type === 'FunctionDeclaration' && stmt.declaration.id) {
      ctx.topNames.add(stmt.declaration.id.name);
    }
    if (stmt.type === 'ImportDeclaration') {
      for (const spec of stmt.specifiers) ctx.topNames.add(spec.local.name);
    }
  }
  function addPatternNames(node, ctx) {
    if (!node) return;
    if (node.type === 'Identifier') ctx.topNames.add(node.name);
    else if (node.type === 'AssignmentPattern') addPatternNames(node.left, ctx);
    else if (node.type === 'RestElement') addPatternNames(node.argument, ctx);
    else if (node.type === 'ObjectPattern') for (const p of node.properties) addPatternNames(p.type === 'RestElement' ? p.argument : p.value, ctx);
    else if (node.type === 'ArrayPattern') for (const el of node.elements) addPatternNames(el, ctx);
  }

  for (const stmt of ast.body) addTop(stmt, root);
  for (const stmt of ast.body) visitStmt(stmt, root);
}

/** Same scan, returning a verdict instead of throwing. GEMs' caller can use either. */
export function scanSource(source, rules, options) {
  try {
    refuseHostAccess(source, rules, options);
    return { ok: true, rules: [] };
  } catch (e) {
    return { ok: false, reason: e.reason || 'parse', rule: e.rule || null, rules: e.rule ? [e.rule] : [] };
  }
}
