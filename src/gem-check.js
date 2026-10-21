/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * gem-check, revision 2026-10-12. The gate in gem-library/CONFORMANCE.md.
 * The socket runs these same functions. Nothing here imports the store,
 * a GEM's code, or a JSON-schema library. A throw inside a check is a
 * failure of that check. The process exits 1 on any failure.
 *
 * CLI: node src/gem-check.js <gem-directory> [--emet-version x.y.z]
 *   stdout: one line per check, `GC-01 pass` or `GC-01 fail: <reason>`
 *   exit 0 all required checks passed or skipped as specified
 *   exit 1 a failure, or an unexpected throw
 *   exit 2 the argument is missing or not a directory
 *   stderr is empty on exit 0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveModulePath } from './module-path.js';
import { refuseHostAccess, MAX_SOURCE_BYTES, runeSpecifierReason, runeExtensionReason } from './host-reach.js';
import { CodedError } from './error-codes.js';

export const SPEC_REVISION = '2026-10-12';
export const CHECK_IDS = Object.freeze([
  'GC-01', 'GC-02', 'GC-03', 'GC-04', 'GC-05', 'GC-06', 'GC-07', 'GC-08', 'GC-09', 'GC-10',
  'GC-11', 'GC-12', 'GC-13', 'GC-14', 'GC-15', 'GC-16', 'GC-17', 'GC-18', 'GC-19', 'GC-20',
  'GC-21', 'GC-22'
]);

const CODE_EXT = Object.freeze(['.js', '.mjs', '.cjs', '.wasm', '.sh', '.py', '.exe', '.so', '.dylib', '.dll']);
const JS_EXT = Object.freeze(['.js', '.mjs']);
const ACCESS_RE = /^(identity|semantic|episodic|procedural|meta|working|doc:[A-Za-z0-9][A-Za-z0-9_./-]{0,80})$/;
const RANGE_RE = /^(>=|\^|~)?(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const VERSION_RE = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;

/** Core paths a GEM must not override. An entry fails when it equals one or starts with one plus a dot. */
export const PROTECTED_OVERRIDES = Object.freeze([
  'voice.not_modifiable',
  'voice.honesty',
  'voice.measured',
  'voice.epistemic_honesty',
  'voice.discipline',
  'voice.no_moralising',
  'engagement.answer_and_stop',
  'engagement.no_borrowed_hazards',
  'engagement.not_retired',
  'engagement.their_own_plan',
  'engagement.no_rapport_mirroring',
  'persistence.named_items',
  'corpus_discipline.judgment_gated',
  'corpus_discipline.name_the_weight',
  'corpus_discipline.equips_not_diagnoses',
  'corpus_discipline.lived_data_wins'
]);

/** The only override paths this revision allows. Anything else fails until a GEP adds it. */
export const MODIFIABLE_OVERRIDES = Object.freeze([
  'voice.composure', 'voice.directness', 'voice.concrete', 'voice.restraint', 'voice.priorities',
  'engagement.lead', 'engagement.one_question', 'engagement.path_forward', 'engagement.mentorship',
  'engagement.adapt', 'engagement.acknowledge', 'engagement.modifiable', 'engagement.goal_check'
]);

/**
 * Floor-negation lint. The list is the one in CONFORMANCE.md. Add a pattern
 * when a bypass is in front of you, not before.
 */
export const FLOOR_NEGATION = Object.freeze([
  /ignore the (core )?floor/i,
  /disregard the (core )?floor/i,
  /override the (core )?floor/i,
  /you may flatter/i,
  /flattery is (fine|welcome|encouraged)/i,
  /soften the truth/i,
  /do not verify/i,
  /skip verification/i,
  /verification is optional/i,
  /invent a cause/i,
  /do not name (their |the )?(items|named)/i,
  /skip named[_ ]items/i,
  /named[_ ]items (are|is) optional/i,
  /out of sight[\s\S]{0,40}(skip|ignore|do not name)/i,
  /the user does not need the truth/i
]);

const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |OPENSSH |EC |PRIVATE )?KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /mongodb(?:\+srv)?:\/\/[^\s/]+:[^\s/]+@/,
  /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^\s'"]{12,}/i
]);

const SECTION_KEY = /^[a-z][a-z0-9_]{0,40}$/;
const FORBIDDEN_SECTIONS = new Set(['voice', 'engagement', 'persistence', 'corpus_discipline', 'operating_discipline']);

export function schemaPath() {
  return resolveModulePath(import.meta.url, ['..', 'gem-library', 'gem.schema.json']);
}

export function trustStorePath() {
  return resolveModulePath(import.meta.url, ['..', 'gem-library', 'keys.json']);
}

let schemaCache = null;

function loadSchema(explicit) {
  if (explicit) return explicit;
  if (schemaCache) return schemaCache;
  const text = fs.readFileSync(schemaPath(), 'utf8');
  const parsed = JSON.parse(text);
  if (!parsed || parsed.$id !== 'https://github.com/dreamforgestudiollc/EMET-GEMs/raw/main/gem.schema.json') {
    throw new CodedError('schema id', { code: 'EMET-GEM-013' });
  }
  schemaCache = parsed;
  return schemaCache;
}

/**
 * One JSON value, with duplicate keys rejected. JSON.parse keeps the last
 * duplicate and would let a manifest hide a field under another. Comments
 * and trailing commas throw, because they are not JSON.
 */
export function parseStrictJson(text) {
  const s = String(text);
  const n = s.length;
  let i = 0;
  function skip() {
    while (i < n && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i++;
  }
  function parse() {
    skip();
    if (i >= n) throw new CodedError('unexpected end', { code: 'EMET-GEM-014' });
    const c = s[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === 't') return atom('true', true);
    if (c === 'f') return atom('false', false);
    if (c === 'n') return atom('null', null);
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    throw new CodedError('unexpected character', { code: 'EMET-GEM-015' });
  }
  function atom(word, value) {
    if (s.slice(i, i + word.length) !== word) throw new CodedError('unexpected token', { code: 'EMET-GEM-016' });
    i += word.length;
    return value;
  }
  function parseNumber() {
    const start = i;
    if (s[i] === '-') i++;
    if (s[i] === '0') i++;
    else if (s[i] >= '1' && s[i] <= '9') { while (i < n && s[i] >= '0' && s[i] <= '9') i++; }
    else throw new CodedError('bad number', { code: 'EMET-GEM-017' });
    if (i < n && s[i] === '.') {
      i++;
      if (i >= n || s[i] < '0' || s[i] > '9') throw new CodedError('bad number', { code: 'EMET-GEM-017' });
      while (i < n && s[i] >= '0' && s[i] <= '9') i++;
    }
    if (i < n && (s[i] === 'e' || s[i] === 'E')) {
      i++;
      if (s[i] === '+' || s[i] === '-') i++;
      if (i >= n || s[i] < '0' || s[i] > '9') throw new CodedError('bad number', { code: 'EMET-GEM-017' });
      while (i < n && s[i] >= '0' && s[i] <= '9') i++;
    }
    const lit = s.slice(start, i);
    if (/^0\d/.test(lit) || /^-0\d/.test(lit)) throw new CodedError('bad number', { code: 'EMET-GEM-017' });
    const num = JSON.parse(lit);
    if (typeof num !== 'number' || !Number.isFinite(num)) throw new CodedError('bad number', { code: 'EMET-GEM-017' });
    return num;
  }
  function parseString() {
    i++;
    let out = '';
    while (i < n) {
      const c = s[i];
      if (c === '\\') {
        const e = s[i + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (map[e] !== undefined) { out += map[e]; i += 2; continue; }
        if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        throw new CodedError('bad escape', { code: 'EMET-GEM-018' });
      }
      if (c === '"') { i++; return out; }
      if (c < ' ') throw new CodedError('raw control in string', { code: 'EMET-GEM-019' });
      out += c;
      i++;
    }
    throw new CodedError('unterminated string', { code: 'EMET-GEM-020' });
  }
  function parseArray() {
    i++;
    skip();
    const arr = [];
    if (s[i] === ']') { i++; return arr; }
    while (i < n) {
      arr.push(parse());
      skip();
      if (s[i] === ',') { i++; skip(); if (s[i] === ']') throw new CodedError('trailing comma', { code: 'EMET-GEM-021' }); continue; }
      if (s[i] === ']') { i++; return arr; }
      throw new CodedError('expected comma', { code: 'EMET-GEM-022' });
    }
    throw new CodedError('unterminated array', { code: 'EMET-GEM-023' });
  }
  function parseObject() {
    i++;
    skip();
    const obj = {};
    const seen = new Set();
    if (s[i] === '}') { i++; return obj; }
    while (i < n) {
      skip();
      if (s[i] !== '"') throw new CodedError('expected key', { code: 'EMET-GEM-024' });
      const key = parseString();
      if (seen.has(key)) throw new CodedError('duplicate key', { code: 'EMET-GEM-025' });
      seen.add(key);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new CodedError('forbidden key', { code: 'EMET-GEM-026' });
      skip();
      if (s[i] !== ':') throw new CodedError('expected colon', { code: 'EMET-GEM-027' });
      i++;
      const value = parse();
      Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
      skip();
      if (s[i] === ',') { i++; skip(); if (s[i] === '}') throw new CodedError('trailing comma', { code: 'EMET-GEM-021' }); continue; }
      if (s[i] === '}') { i++; return obj; }
      throw new CodedError('expected comma', { code: 'EMET-GEM-022' });
    }
    throw new CodedError('unterminated object', { code: 'EMET-GEM-028' });
  }
  if (s.charCodeAt(0) === 0xfeff) throw new CodedError('bom', { code: 'EMET-GEM-029' });
  const value = parse();
  skip();
  if (i !== n) throw new CodedError('trailing data', { code: 'EMET-GEM-030' });
  return value;
}

/** RFC 8785 for the values a manifest can hold. Non-integers fail closed. */
export function canonicalize(value) {
  return Buffer.from(jcs(value), 'utf8');
}

function jcs(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isSafeInteger(value)) throw new CodedError('number is not a safe integer', { code: 'EMET-GEM-031' });
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + jcs(value[k])).join(',') + '}';
  }
  throw new CodedError('unsupported value', { code: 'EMET-GEM-032' });
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function parseVer(text) {
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Grammar only. Returns null when the text is not a range this revision evaluates. */
export function parseEmetRange(text) {
  const m = RANGE_RE.exec(String(text));
  if (!m) return null;
  return { op: m[1] || '=', base: [Number(m[2]), Number(m[3]), Number(m[4])] };
}

/**
 * exact, >=, ^, ~ on MAJOR.MINOR.PATCH.
 * ^1.2.3 is >=1.2.3 <2.0.0. ~1.2.3 is >=1.2.3 <1.3.0.
 * A leading 0 uses the same shape as the usual caret rule: ^0.3.0 is >=0.3.0 <0.4.0,
 * and ^0.0.3 is >=0.0.3 <0.0.4.
 */
export function satisfiesEmetRange(version, rangeText) {
  const range = parseEmetRange(rangeText);
  const cur = parseVer(version);
  if (!range || !cur) return false;
  const { op, base } = range;
  if (op === '=') return cmpVer(cur, base) === 0;
  if (op === '>=') return cmpVer(cur, base) >= 0;
  let upper;
  if (op === '~') upper = [base[0], base[1] + 1, 0];
  else if (base[0] === 0 && base[1] === 0) upper = [0, 0, base[2] + 1];
  else if (base[0] === 0) upper = [0, base[1] + 1, 0];
  else upper = [base[0] + 1, 0, 0];
  return cmpVer(cur, base) >= 0 && cmpVer(cur, upper) < 0;
}

function pointer(base, key) {
  return base + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return null;
    node = node[part];
  }
  return node || null;
}

function schemaError(schema, data, at, root) {
  if (!schema || typeof schema !== 'object') return { path: at || '/', message: 'schema missing' };
  if (schema.$ref) {
    const next = resolveRef(root, schema.$ref);
    if (!next) return { path: at || '/', message: 'unresolved $ref' };
    return schemaError(next, data, at, root);
  }
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      const err = schemaError(sub, data, at, root);
      if (err) return err;
    }
  }
  if (schema.anyOf) {
    let matched = false;
    for (const sub of schema.anyOf) {
      if (!schemaError(sub, data, at, root)) { matched = true; break; }
    }
    if (!matched) return { path: at || '/', message: 'does not match' };
  }
  if (schema.if) {
    if (!schemaError(schema.if, data, at, root) && schema.then) {
      const err = schemaError(schema.then, data, at, root);
      if (err) return err;
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !sameJson(data, schema.const)) {
    return { path: at || '/', message: 'const mismatch' };
  }
  if (schema.enum && !schema.enum.some((item) => sameJson(item, data))) {
    return { path: at || '/', message: 'not in enum' };
  }
  if (schema.type) {
    const err = typeError(schema.type, data, at);
    if (err) return err;
  }
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && [...data].length < schema.minLength) return { path: at || '/', message: 'shorter than minLength' };
    if (schema.maxLength !== undefined && [...data].length > schema.maxLength) return { path: at || '/', message: 'longer than maxLength' };
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) return { path: at || '/', message: 'does not match pattern' };
  }
  if (typeof data === 'number' && schema.type === 'integer') {
    if (schema.minimum !== undefined && data < schema.minimum) return { path: at || '/', message: 'below minimum' };
    if (schema.maximum !== undefined && data > schema.maximum) return { path: at || '/', message: 'above maximum' };
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) return { path: at || '/', message: 'fewer than minItems' };
    if (schema.maxItems !== undefined && data.length > schema.maxItems) return { path: at || '/', message: 'more than maxItems' };
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const item of data) {
        const key = stable(item);
        if (seen.has(key)) return { path: at || '/', message: 'duplicate item' };
        seen.add(key);
      }
    }
    if (schema.items) {
      for (let n = 0; n < data.length; n++) {
        const err = schemaError(schema.items, data[n], pointer(at, n), root);
        if (err) return err;
      }
    }
  }
  if (isObject(data)) {
    const keys = Object.keys(data);
    if (schema.required) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) return { path: pointer(at, key), message: 'required property missing' };
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) return { path: pointer(at, key), message: 'unexpected property' };
      }
    }
    if (schema.properties) {
      for (const key of keys) {
        if (!schema.properties[key]) continue;
        const err = schemaError(schema.properties[key], data[key], pointer(at, key), root);
        if (err) return err;
      }
    }
  }
  return null;
}

function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return stable(a) === stable(b);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeError(type, data, at) {
  const where = at || '/';
  if (type === 'object' && !isObject(data)) return { path: where, message: 'must be object' };
  if (type === 'array' && !Array.isArray(data)) return { path: where, message: 'must be array' };
  if (type === 'string' && typeof data !== 'string') return { path: where, message: 'must be string' };
  if (type === 'boolean' && typeof data !== 'boolean') return { path: where, message: 'must be boolean' };
  if (type === 'integer' && !Number.isInteger(data)) return { path: where, message: 'must be integer' };
  if (type === 'number' && typeof data !== 'number') return { path: where, message: 'must be number' };
  return null;
}

function extname(rel) {
  const base = rel.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function inside(rootReal, candidateReal) {
  const rel = path.relative(rootReal, candidateReal);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function sha256File(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

/** Equal-length digests compared without an early exit. Unequal lengths fail closed. */
export function digestEqual(declared, actual) {
  const a = Buffer.from(String(declared));
  const b = Buffer.from(String(actual));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function readRaw(abs) {
  return fs.promises.readFile(abs);
}

function utf8Fatal(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(rootReal) {
  const found = [];
  async function walk(dir) {
    const ents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        const rel = path.relative(rootReal, abs).split(path.sep).join('/');
        if (rel === 'runes' || rel.startsWith('runes/')) {
          const err = new Error('symlink');
          err.code = 'SYMLINK';
          err.rel = rel;
          throw err;
        }
        const real = await fs.promises.realpath(abs);
        if (!inside(rootReal, real)) {
          const err = new Error('symlink escapes');
          err.code = 'ESCAPE';
          err.rel = path.relative(rootReal, abs).split(path.sep).join('/');
          throw err;
        }
        const st = await fs.promises.stat(real);
        if (st.isDirectory()) await walk(abs);
        else if (st.isFile()) found.push(path.relative(rootReal, abs).split(path.sep).join('/'));
        else {
          const err = new Error('not a regular file');
          err.rel = path.relative(rootReal, abs).split(path.sep).join('/');
          throw err;
        }
      } else if (ent.isDirectory()) {
        await walk(abs);
      } else if (ent.isFile()) {
        found.push(path.relative(rootReal, abs).split(path.sep).join('/'));
      } else {
        const err = new Error('unsupported file');
        err.rel = path.relative(rootReal, abs).split(path.sep).join('/');
        throw err;
      }
    }
  }
  await walk(rootReal);
  return found;
}

function pathSyntax(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return 'empty path';
  if (rel.startsWith('/') || rel.startsWith('\\')) return 'absolute path';
  if (rel.includes('\\')) return 'backslash';
  if (rel.split('/').some((part) => part === '..' || part === '.' || part === '')) return 'path segment';
  return null;
}

function stringsIn(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (isObject(value)) for (const item of Object.values(value)) stringsIn(item, out);
  return out;
}

function negationHit(text) {
  for (const re of FLOOR_NEGATION) if (re.test(text)) return true;
  return false;
}

function secretHit(text) {
  for (const re of SECRET_PATTERNS) if (re.test(text)) return true;
  return false;
}

class ScanRefuse extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

/**
 * Walk source as text for imports, literals, and the calls this revision
 * already named. Comments are not code. String literals are collected and
 * not executed. A template expression is scanned as its own span.
 * node --check is the syntax gate. refuseHostAccess then parses the same
 * source with acorn and refuses a host reach. A parse error fails closed.
 * Input over MAX_SOURCE_BYTES is refused before the walk.
 */
export function scanModuleSource(source, fromRel) {
  const specifiers = [];
  const literals = [];
  let dynamicImport = false;
  let network = false;
  const s = String(source);
  if (Buffer.byteLength(s) > MAX_SOURCE_BYTES) throw new ScanRefuse('too large');
  const n = s.length;
  let i = 0;

  function skipSpace() {
    while (i < n && /[ \t\r\n]/.test(s[i])) i++;
  }
  function skipGapIndex(from) {
    let j = from;
    for (;;) {
      while (j < n && /[ \t\r\n]/.test(s[j])) j++;
      if (s[j] === '/' && s[j + 1] === '/') { j += 2; while (j < n && s[j] !== '\n') j++; continue; }
      if (s[j] === '/' && s[j + 1] === '*') {
        j += 2;
        while (j < n && !(s[j] === '*' && s[j + 1] === '/')) j++;
        j = Math.min(n, j + 2);
        continue;
      }
      return j;
    }
  }
  function word(name) {
    if (!s.startsWith(name, i)) return false;
    const before = i > 0 ? s[i - 1] : '';
    const after = s[i + name.length] || '';
    if (before && /[A-Za-z0-9_$]/.test(before)) return false;
    if (after && /[A-Za-z0-9_$]/.test(after)) return false;
    return true;
  }
  function readQuoted() {
    const q = s[i];
    i++;
    let out = '';
    while (i < n) {
      const c = s[i];
      if (c === '\\') {
        const e = s[i + 1];
        const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', '`': '`' };
        if (map[e] !== undefined) { out += map[e]; i += 2; continue; }
        if (e === '\n') { i += 2; continue; }
        if (e === 'u' && /^[0-9a-fA-F]{4}/.test(s.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        if (e === 'x' && /^[0-9a-fA-F]{2}/.test(s.slice(i + 2, i + 4))) {
          out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
          i += 4;
          continue;
        }
        if (e === undefined) throw new ScanRefuse('bad escape');
        out += e;
        i += 2;
        continue;
      }
      if (c === q) { i++; literals.push(out); return out; }
      if (c === '\n' && q !== '`') throw new ScanRefuse('unterminated string');
      out += c;
      i++;
    }
    throw new ScanRefuse('unterminated string');
  }
  function readTemplate() {
    i++;
    let out = '';
    while (i < n) {
      if (s[i] === '\\') {
        out += s[i + 1] === '\n' ? '' : (s[i + 1] || '');
        i += 2;
        continue;
      }
      if (s[i] === '`') { i++; literals.push(out); return; }
      if (s[i] === '$' && s[i + 1] === '{') {
        literals.push(out);
        out = '';
        i += 2;
        const start = i;
        let depth = 1;
        while (i < n && depth > 0) {
          if (s[i] === "'" || s[i] === '"' || s[i] === '`') {
            const inner = scanSlice(i);
            i = inner;
            continue;
          }
          if (s[i] === '{') depth++;
          else if (s[i] === '}') depth--;
          if (depth > 0) i++;
        }
        if (s[i - 1] !== '}' && s[i] !== '}') throw new ScanRefuse('bad template');
        if (s[i] === '}') i++;
        const expr = s.slice(start, i - 1);
        const nested = scanModuleSource(expr, fromRel);
        specifiers.push(...nested.specifiers);
        literals.push(...nested.literals);
        continue;
      }
      out += s[i];
      i++;
    }
    throw new ScanRefuse('unterminated template');
  }
  function scanSlice(from) {
    const saved = i;
    i = from;
    if (s[i] === '`') readTemplate();
    else readQuoted();
    const end = i;
    i = saved;
    return end;
  }
  function noteSpecifier(value) {
    if (value === 'vm' || value === 'node:vm') throw new ScanRefuse('vm');
    specifiers.push(value);
  }
  function expectSpecifier(kind) {
    skipSpace();
    if (s[i] !== "'" && s[i] !== '"' && s[i] !== '`') throw new ScanRefuse('non-literal ' + kind);
    const value = s[i] === '`' ? (readTemplate(), literals[literals.length - 1]) : readQuoted();
    noteSpecifier(value);
  }
  function skipGap() {
    for (;;) {
      skipSpace();
      if (s[i] === '/' && s[i + 1] === '/') { i += 2; while (i < n && s[i] !== '\n') i++; continue; }
      if (s[i] === '/' && s[i + 1] === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i = Math.min(n, i + 2); continue; }
      return;
    }
  }
  function parseImport() {
    i += 'import'.length;
    skipGap();
    if (s[i] === '(') {
      i++;
      skipGap();
      if (s[i] !== "'" && s[i] !== '"') throw new ScanRefuse('computed import');
      const value = readQuoted();
      noteSpecifier(value);
      skipGap();
      if (s[i] !== ')') throw new ScanRefuse('computed import');
      i++;
      dynamicImport = true;
      return;
    }
    if (s[i] === "'" || s[i] === '"' || s[i] === '`') { expectSpecifier('import'); return; }
    let depth = 0;
    while (i < n) {
      const c = s[i];
      if (c === '/' && s[i + 1] === '/') { i += 2; while (i < n && s[i] !== '\n') i++; continue; }
      if (c === '/' && s[i + 1] === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
      if (c === "'" || c === '"') { readQuoted(); continue; }
      if (c === '`') { readTemplate(); continue; }
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (depth === 0 && word('from')) {
        i += 'from'.length;
        expectSpecifier('import');
        return;
      }
      if (depth <= 0 && (c === ';' || c === '\n')) { i++; return; }
      i++;
    }
  }

  while (i < n) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { i += 2; while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i = Math.min(n, i + 2); continue; }
    if (c === "'" || c === '"') { readQuoted(); continue; }
    if (c === '`') { readTemplate(); continue; }
    if (word('import')) { parseImport(); continue; }
    if (word('export')) {
      const look = s.slice(i, Math.min(n, i + 400));
      if (/\bfrom\b/.test(look)) {
        i += 'export'.length;
        let depth = 0;
        while (i < n) {
          if (s[i] === "'" || s[i] === '"') { readQuoted(); continue; }
          if (s[i] === '`') { readTemplate(); continue; }
          if (s[i] === '{') depth++;
          if (s[i] === '}') depth--;
          if (depth === 0 && word('from')) { i += 'from'.length; expectSpecifier('export'); break; }
          if (depth <= 0 && s[i] === ';') { i++; break; }
          i++;
        }
        continue;
      }
    }
    if (word('require')) {
      i += 'require'.length;
      skipSpace();
      if (s[i] === '(') { i++; expectSpecifier('require'); continue; }
    }
    if (word('eval')) {
      const at = i + 'eval'.length;
      let j = at;
      while (j < n && /[ \t]/.test(s[j])) j++;
      if (s[j] === '(') throw new ScanRefuse('eval');
    }
    if (word('Function') && s[skipGapIndex(i + 'Function'.length)] === '(') throw new ScanRefuse('Function');
    if (word('fetch') || word('WebSocket') || word('XMLHttpRequest')) network = true;
    if (word('process')) {
      let j = i + 'process'.length;
      while (j < n && /[ \t]/.test(s[j])) j++;
      if (s[j] === '.') {
        j++;
        while (j < n && /[ \t]/.test(s[j])) j++;
        if (s.startsWith('binding', j) || s.startsWith('dlopen', j)) throw new ScanRefuse('process binding');
      }
    }
    i++;
  }
  const gateOptions = { importMode: 'gc16' };
  if (typeof fromRel === 'string' && fromRel.length > 0) gateOptions.from = fromRel;
  refuseHostAccess(s, undefined, gateOptions);
  return { specifiers, literals, dynamicImport, network };
}

function specifierAllowed(spec, fileRel, listed, resolved) {
  return runeSpecifierReason(spec, fileRel, listed, 'gc16', resolved) == null;
}

/**
 * Real path of each relative import that lexically lands under runes/.
 * GC-04 refuses a symlink under runes/ before the scan, so checkGem does
 * not reach this with a link. This is the backstop: a real path outside
 * runes/ is recorded here, and runeSpecifierReason refuses it.
 */
export async function resolvedUnderRunes(rootReal, fileRel, specs) {
  const resolved = Object.create(null);
  for (const spec of specs) {
    if (typeof spec !== 'string' || (!spec.startsWith('./') && !spec.startsWith('../'))) continue;
    const norm = path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), spec));
    if (!norm.startsWith('runes/') || norm.split('/').includes('..')) continue;
    let real;
    try { real = await fs.promises.realpath(path.resolve(rootReal, ...norm.split('/'))); }
    catch { resolved[norm] = ''; continue; }
    if (!inside(rootReal, real)) { resolved[norm] = ''; continue; }
    resolved[norm] = path.relative(rootReal, real).split(path.sep).join('/');
  }
  return resolved;
}

async function moduleSyntaxOk(buf) {
  const tmp = path.join(os.tmpdir(), `emet-gem-check-${crypto.randomBytes(8).toString('hex')}.mjs`);
  try {
    await fs.promises.writeFile(tmp, buf, { mode: 0o600 });
    const checked = spawnSync(process.execPath, ['--check', tmp], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '' },
      windowsHide: true
    });
    return Boolean(checked && checked.status === 0);
  } catch {
    return false;
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

function lineOf(check) {
  if (check.status === 'pass') return `${check.id} pass`;
  if (check.status === 'skip') return `${check.id} skip: ${check.reason}`;
  return `${check.id} fail: ${check.reason}`;
}

function pass(id) { return { id, status: 'pass', reason: null }; }
function fail(id, reason) { return { id, status: 'fail', reason }; }
function skip(id, reason) { return { id, status: 'skip', reason }; }

async function loadTrust(options) {
  if (options.trustStore) return options.trustStore;
  if (options.trustStore === null) return null;
  try {
    const text = await fs.promises.readFile(trustStorePath(), 'utf8');
    return JSON.parse(text);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return { invalid: true };
  }
}

function verifySignature(manifest, store) {
  if (!store || store.invalid || !Array.isArray(store.keys) || store.keys.length === 0) return 'no trust store';
  const signature = manifest.signature;
  if (!signature || typeof signature !== 'object') return 'signature required';
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature.value || '')) return 'signature encoding';
  const sig = Buffer.from(signature.value, 'base64');
  if (sig.length !== 64) return 'signature length';
  const key = store.keys.find((k) => k && k.keyid === signature.keyid && k.alg === 'Ed25519');
  if (!key || typeof key.publicKey !== 'string') return 'unknown keyid';
  let raw;
  try { raw = Buffer.from(key.publicKey, 'base64'); } catch { return 'trust store invalid'; }
  if (raw.length !== 32) return 'trust store invalid';
  let message;
  try {
    const body = { ...manifest };
    delete body.signature;
    message = canonicalize(body);
  } catch {
    return 'cannot canonicalize';
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk'
    });
  } catch {
    return 'trust store invalid';
  }
  const ok = crypto.verify(null, message, publicKey, sig);
  return ok ? null : 'signature did not verify';
}

/**
 * Run every GC check on one GEM directory. Does not apply server refusals.
 * @param {string} dir
 * @param {{ emetVersion?: string, trustStore?: object|null, schema?: object }} [options]
 */
const gemCheckCache = new Map();

async function gemCacheKey(dir, options) {
  let st;
  try { st = await fs.promises.lstat(dir); }
  catch { return null; }
  // A symlink must not share the real directory's cache key. lstat of a
  // link is not a directory, so the symlink clause is what keeps the key empty.
  if (st.isSymbolicLink() || !st.isDirectory()) return null;
  let root;
  try { root = await fs.promises.realpath(dir); }
  catch { return null; }
  const gemPath = path.join(root, 'gem.json');
  let gemBuf;
  let manifest;
  try {
    gemBuf = await fs.promises.readFile(gemPath);
    manifest = JSON.parse(gemBuf.toString('utf8'));
  } catch { return null; }
  const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const schemaHash = hash(Buffer.from(JSON.stringify(options.schema || null)));
  // Content, not mtime: a same-size rewrite in the same millisecond must miss.
  const parts = [root, hash(gemBuf), options.emetVersion || '', schemaHash, JSON.stringify(options.trustStore || null)];
  const files = manifest && Array.isArray(manifest.files) ? manifest.files : [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string') { parts.push('bad'); continue; }
    try {
      parts.push(file.path, hash(await fs.promises.readFile(path.join(root, file.path))));
    } catch { parts.push(file.path, 'missing'); }
  }
  return parts.join('\0');
}

export async function checkGem(dir, options = {}) {
  const gemKey = await gemCacheKey(dir, options);
  if (gemKey && gemCheckCache.has(gemKey)) return structuredClone(gemCheckCache.get(gemKey));
  const result = await checkGemUncached(dir, options);
  if (gemKey) gemCheckCache.set(gemKey, result);
  return result;
}

async function checkGemUncached(dir, options = {}) {
  const ctx = {
    dir,
    rootReal: null,
    manifest: null,
    gemBuf: null,
    files: [],
    walked: [],
    bytes: new Map(),
    floor: null,
    floorBuf: null,
    floorTrusted: false,
    floorDigest: null,
    schema: null
  };
  const checks = [];
  async function run(id, fn) {
    try {
      checks.push(await fn());
    } catch (e) {
      const reason = e && e.reason ? e.reason : 'checker threw';
      checks.push(fail(id, reason));
    }
  }

  await run('GC-01', async () => {
    let st;
    try { st = await fs.promises.lstat(dir); } catch { return fail('GC-01', 'not a directory'); }
    if (st.isSymbolicLink()) return fail('GC-01', 'symlink');
    if (!st.isDirectory()) return fail('GC-01', 'not a directory');
    try { ctx.rootReal = await fs.promises.realpath(dir); } catch { return fail('GC-01', 'directory cannot be resolved'); }
    const gemPath = path.join(ctx.rootReal, 'gem.json');
    try { ctx.gemBuf = await readRaw(gemPath); } catch { return fail('GC-01', 'gem.json missing'); }
    if (!utf8Fatal(ctx.gemBuf)) return fail('GC-01', 'gem.json is not utf-8');
    try { ctx.manifest = parseStrictJson(ctx.gemBuf.toString('utf8')); }
    catch { return fail('GC-01', 'gem.json did not parse'); }
    if (!isObject(ctx.manifest)) return fail('GC-01', 'gem.json is not an object');
    return pass('GC-01');
  });

  await run('GC-02', async () => {
    if (!ctx.manifest) return fail('GC-02', 'gem.json did not parse');
    try { ctx.schema = loadSchema(options.schema); }
    catch { return fail('GC-02', 'schema missing from checker package'); }
    const err = schemaError(ctx.schema, ctx.manifest, '', ctx.schema);
    if (err) return fail('GC-02', `${err.path} ${err.message}`);
    return pass('GC-02');
  });

  await run('GC-03', async () => {
    if (!ctx.manifest) return fail('GC-03', 'gem.json did not parse');
    if (ctx.manifest.spec !== SPEC_REVISION) return fail('GC-03', 'spec is not ' + SPEC_REVISION);
    return pass('GC-03');
  });

  await run('GC-04', async () => {
    if (!ctx.manifest || !Array.isArray(ctx.manifest.files)) return fail('GC-04', 'files missing');
    const rels = ctx.manifest.files.map((f) => f && f.path);
    if (new Set(rels).size !== rels.length) return fail('GC-04', 'duplicate path');
    for (const rel of rels) {
      const why = pathSyntax(rel);
      if (why) return fail('GC-04', why);
    }
    try { ctx.walked = await walkFiles(ctx.rootReal); }
    catch (e) {
      if (e && e.code === 'ESCAPE') return fail('GC-04', 'symlink escapes');
      if (e && e.code === 'SYMLINK') return fail('GC-04', 'symlink');
      return fail('GC-04', 'cannot list files');
    }
    for (const rel of rels) {
      const abs = path.resolve(ctx.rootReal, rel);
      let real;
      try { real = await fs.promises.realpath(abs); } catch { return fail('GC-04', 'file missing'); }
      if (!inside(ctx.rootReal, real)) return fail('GC-04', 'path escapes');
      const st = await fs.promises.stat(real);
      if (!st.isFile()) return fail('GC-04', 'not a regular file');
    }
    if (!rels.includes(ctx.manifest.floor)) return fail('GC-04', 'floor is not listed');
    if (Array.isArray(ctx.manifest.guides)) {
      for (const g of ctx.manifest.guides) if (!rels.includes(g)) return fail('GC-04', 'guide is not listed');
    }
    const expected = new Set(rels);
    for (const rel of ctx.walked) {
      if (rel === 'gem.json') continue;
      if (!expected.has(rel)) return fail('GC-04', 'unlisted file');
    }
    if (ctx.walked.length - (ctx.walked.includes('gem.json') ? 1 : 0) !== rels.length) {
      return fail('GC-04', 'file list does not match the directory');
    }
    if (ctx.manifest.kind === 'gem') {
      for (const rel of rels) if (CODE_EXT.includes(extname(rel))) return fail('GC-04', 'code file on a prompt GEM');
    }
    ctx.files = rels;
    return pass('GC-04');
  });

  await run('GC-05', async () => {
    if (!ctx.files.length) return fail('GC-05', 'files missing');
    let floorTrusted = false;
    for (const entry of ctx.manifest.files) {
      const abs = path.resolve(ctx.rootReal, entry.path);
      const buf = await readRaw(abs);
      ctx.bytes.set(entry.path, buf);
      if (buf.length !== entry.size) return fail('GC-05', 'size mismatch');
      const digest = sha256File(buf);
      if (!digestEqual(entry.digest, digest)) return fail('GC-05', 'digest mismatch');
      if (entry.path === ctx.manifest.floor) {
        floorTrusted = true;
        ctx.floorBuf = buf;
        ctx.floorDigest = digest;
      }
    }
    ctx.floorTrusted = floorTrusted;
    return pass('GC-05');
  });

  await run('GC-06', async () => {
    if (!ctx.floorBuf) return fail('GC-06', 'floor missing');
    if (!utf8Fatal(ctx.floorBuf)) return fail('GC-06', 'floor is not utf-8');
    let floor;
    try { floor = parseStrictJson(ctx.floorBuf.toString('utf8')); }
    catch { return fail('GC-06', 'floor did not parse'); }
    if (!isObject(floor)) return fail('GC-06', 'floor is not an object');
    const keys = Object.keys(floor);
    if (keys.some((k) => k !== 'sections' && k !== 'reassertion')) return fail('GC-06', 'unexpected floor key');
    if (!isObject(floor.sections)) return fail('GC-06', 'sections missing');
    for (const [key, section] of Object.entries(floor.sections)) {
      if (!SECTION_KEY.test(key)) return fail('GC-06', 'section key');
      if (FORBIDDEN_SECTIONS.has(key)) return fail('GC-06', 'forbidden section');
      if (!isObject(section)) return fail('GC-06', 'section shape');
      const sk = Object.keys(section);
      if (sk.length !== 3 || !sk.includes('title') || !sk.includes('note') || !sk.includes('lines')) return fail('GC-06', 'section shape');
      if (typeof section.title !== 'string' || typeof section.note !== 'string' || !isObject(section.lines)) return fail('GC-06', 'section shape');
      for (const line of Object.values(section.lines)) if (typeof line !== 'string') return fail('GC-06', 'nested line');
    }
    if (!Array.isArray(floor.reassertion) || floor.reassertion.length < 1 || floor.reassertion.length > 24) return fail('GC-06', 'reassertion length');
    if (floor.reassertion.some((line) => typeof line !== 'string')) return fail('GC-06', 'reassertion shape');
    ctx.floor = floor;
    return pass('GC-06');
  });

  await run('GC-07', async () => {
    const guides = ctx.manifest && Array.isArray(ctx.manifest.guides) ? ctx.manifest.guides : null;
    if (!guides) return fail('GC-07', 'guides missing');
    if (guides.length > 16) return fail('GC-07', 'more than 16 guides');
    for (const rel of guides) {
      const buf = ctx.bytes.get(rel);
      if (!buf) return fail('GC-07', 'guide missing');
      if (buf.length > 65536) return fail('GC-07', 'guide exceeds 65536 bytes');
      if (buf.includes(0)) return fail('GC-07', 'guide contains NUL');
      if (!utf8Fatal(buf)) return fail('GC-07', 'guide is not utf-8');
    }
    return pass('GC-07');
  });

  await run('GC-08', async () => {
    if (!ctx.floorBuf) return fail('GC-08', 'floor missing');
    if (ctx.floorBuf.length > 8192) return fail('GC-08', 'floor exceeds 8192 bytes');
    return pass('GC-08');
  });

  await run('GC-09', async () => {
    if (!ctx.manifest || !Array.isArray(ctx.manifest.files)) return fail('GC-09', 'files missing');
    const sum = ctx.manifest.files.reduce((n, f) => n + (f && Number.isInteger(f.size) ? f.size : 0), 0);
    if (sum > 262144) return fail('GC-09', 'files exceed 262144 bytes');
    return pass('GC-09');
  });

  await run('GC-10', async () => {
    if (!ctx.manifest || !Array.isArray(ctx.manifest.runes)) return fail('GC-10', 'runes missing');
    const n = ctx.manifest.runes.length;
    if (ctx.manifest.kind === 'gem' && n !== 0) return fail('GC-10', 'prompt GEM has runes');
    if (ctx.manifest.kind === 'runed-gem' && (n < 1 || n > 16)) return fail('GC-10', 'rune count');
    const names = ctx.manifest.runes.map((r) => r && r.name);
    if (new Set(names).size !== names.length) return fail('GC-10', 'duplicate rune name');
    return pass('GC-10');
  });

  await run('GC-11', async () => {
    if (!ctx.manifest) return fail('GC-11', 'gem.json did not parse');
    if (ctx.walked.includes('keys.json') || ctx.files.includes('keys.json')) return fail('GC-11', 'keys.json inside GEM');
    const signature = ctx.manifest.signature;
    if (ctx.manifest.distribution === 'bundled' && (signature === undefined || signature === null)) return pass('GC-11');
    if (ctx.manifest.distribution === 'library' && (signature === undefined || signature === null)) return fail('GC-11', 'signature required');
    const store = await loadTrust(options);
    if (!store) return fail('GC-11', 'no trust store');
    const why = verifySignature(ctx.manifest, store);
    if (why) return fail('GC-11', why);
    return pass('GC-11');
  });

  await run('GC-12', async () => {
    if (!ctx.manifest || !Array.isArray(ctx.manifest.overrides)) return fail('GC-12', 'overrides missing');
    const allowed = new Set(MODIFIABLE_OVERRIDES);
    for (const entry of ctx.manifest.overrides) {
      if (typeof entry !== 'string') return fail('GC-12', 'override not modifiable');
      for (const blocked of PROTECTED_OVERRIDES) {
        if (entry === blocked || entry.startsWith(blocked + '.')) return fail('GC-12', 'override not modifiable');
      }
      if (!allowed.has(entry)) return fail('GC-12', 'override not modifiable');
    }
    return pass('GC-12');
  });

  await run('GC-13', async () => {
    if (!ctx.floor) return fail('GC-13', 'floor missing');
    const texts = stringsIn(ctx.floor, []);
    if (typeof ctx.manifest.description === 'string') texts.push(ctx.manifest.description);
    if (Array.isArray(ctx.manifest.runes)) {
      for (const rune of ctx.manifest.runes) if (rune && typeof rune.description === 'string') texts.push(rune.description);
    }
    for (const text of texts) if (negationHit(text)) return fail('GC-13', 'floor-negation pattern');
    return pass('GC-13');
  });

  await run('GC-14', async () => {
    const blobs = [];
    if (ctx.gemBuf) blobs.push(ctx.gemBuf.toString('latin1'));
    for (const rel of ctx.files) {
      const buf = ctx.bytes.get(rel);
      if (buf) blobs.push(buf.toString('latin1'));
    }
    if (!blobs.length) return fail('GC-14', 'nothing to scan');
    for (const text of blobs) if (secretHit(text)) return fail('GC-14', 'secret pattern');
    return pass('GC-14');
  });

  await run('GC-15', async () => {
    if (!ctx.rootReal) return fail('GC-15', 'directory missing');
    for (const name of ['node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
      try {
        await fs.promises.lstat(path.join(ctx.rootReal, name));
        return fail('GC-15', name);
      } catch (e) {
        if (e && e.code !== 'ENOENT') return fail('GC-15', name);
      }
    }
    let pkg = null;
    try { pkg = await fs.promises.lstat(path.join(ctx.rootReal, 'package.json')); }
    catch (e) { if (e && e.code !== 'ENOENT') return fail('GC-15', 'package.json'); }
    if (pkg && ctx.manifest && ctx.manifest.kind === 'gem') return fail('GC-15', 'package.json');
    if (pkg) {
      const buf = ctx.bytes.get('package.json') || await readRaw(path.join(ctx.rootReal, 'package.json'));
      let parsed;
      try { parsed = parseStrictJson(buf.toString('utf8')); }
      catch { return fail('GC-15', 'package.json'); }
      for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'bundledDependencies']) {
        if (parsed && parsed[key] && typeof parsed[key] === 'object' && Object.keys(parsed[key]).length > 0) {
          return fail('GC-15', 'dependencies');
        }
      }
    }
    return pass('GC-15');
  });

  await run('GC-16', async () => {
    if (!ctx.rootReal || !ctx.manifest) return fail('GC-16', 'files missing');
    for (const rel of ctx.files) {
      const why = runeExtensionReason(rel);
      if (why) return fail('GC-16', why);
    }
    const code = ctx.files.filter((rel) => CODE_EXT.includes(extname(rel)));
    const js = code.filter((rel) => JS_EXT.includes(extname(rel)) && rel.startsWith('runes/'));
    const foreign = code.filter((rel) => !JS_EXT.includes(extname(rel)));
    if (foreign.length) return fail('GC-16', 'unsupported code file');
    if (!js.length) return skip('GC-16', 'no code');
    for (const rel of js) {
      const buf = ctx.bytes.get(rel);
      if (!buf || buf.length > MAX_SOURCE_BYTES) return fail('GC-16', 'code file size');
      // Syntax-check a copy named .mjs. The GEM file is not the process
      // argument, and --check does not run it. A .js file outside this
      // package would otherwise be parsed as a script.
      if (!(await moduleSyntaxOk(buf))) return fail('GC-16', 'syntax');
      let scanned;
      try { scanned = scanModuleSource(buf.toString('utf8'), rel); }
      catch (e) { return fail('GC-16', e && e.reason ? e.reason : 'could not scan'); }
      const resolved = await resolvedUnderRunes(ctx.rootReal, rel, scanned.specifiers);
      for (const spec of scanned.specifiers) {
        if (!specifierAllowed(spec, rel, ctx.files, resolved)) return fail('GC-16', 'specifier not allowed');
      }
      for (const lit of scanned.literals) {
        if (/https?:\/\//.test(lit) || /mongodb(?:\+srv)?:\/\//.test(lit)) return fail('GC-16', 'url in code');
      }
    }
    return pass('GC-16');
  });

  await run('GC-17', async () => {
    if (!ctx.manifest || !Array.isArray(ctx.manifest.runes)) return fail('GC-17', 'runes missing');
    const hints = new Set(['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);
    for (const rune of ctx.manifest.runes) {
      if (!rune || typeof rune !== 'object') return fail('GC-17', 'rune shape');
      if (rune.network !== 'none') return fail('GC-17', 'network');
      const ann = rune.annotations;
      if (!isObject(ann)) return fail('GC-17', 'annotations');
      if (ann.openWorldHint !== false || ann.destructiveHint !== false) return fail('GC-17', 'annotations');
      for (const key of Object.keys(ann)) if (!hints.has(key)) return fail('GC-17', 'unknown annotation');
      if (!rune.inputSchema || rune.inputSchema.type !== 'object') return fail('GC-17', 'inputSchema');
      if (!Array.isArray(rune.reads) || !Array.isArray(rune.writes)) return fail('GC-17', 'access');
      for (const entry of [...rune.reads, ...rune.writes]) if (typeof entry !== 'string' || !ACCESS_RE.test(entry)) return fail('GC-17', 'access');
      if (ann.readOnlyHint === true && rune.writes.length !== 0) return fail('GC-17', 'read-only writes');
    }
    return pass('GC-17');
  });

  await run('GC-18', async () => {
    const js = ctx.files.filter((rel) => JS_EXT.includes(extname(rel)));
    const banned = ['MongoClient', 'mongoose', 'collection(', '.db(', 'getDb', 'databaseUrl'];
    for (const rel of js) {
      const buf = ctx.bytes.get(rel);
      if (!buf) return fail('GC-18', 'code file missing');
      const text = buf.toString('latin1');
      for (const token of banned) if (text.includes(token)) return fail('GC-18', 'raw database access');
    }
    return pass('GC-18');
  });

  await run('GC-19', async () => {
    if (!ctx.manifest || !Array.isArray(ctx.manifest.runes)) return fail('GC-19', 'runes missing');
    if (ctx.manifest.runes.length === 0 && ctx.manifest.kind !== 'runed-gem') return skip('GC-19', 'no runes');
    if (ctx.manifest.runes.length === 0) return fail('GC-19', 'no runes');
    const prior = checks.find((c) => c.id === 'GC-16');
    if (prior && prior.status === 'fail') return fail('GC-19', 'static analysis failed');
    const listed = new Map((ctx.manifest.files || []).filter((f) => f && f.path).map((f) => [f.path, f]));
    for (const rune of ctx.manifest.runes) {
      if (!rune || rune.execution !== 'client' || rune.version !== ctx.manifest.version) return fail('GC-19', 'manifest');
      if (!Array.isArray(rune.reads) || rune.reads.length || !Array.isArray(rune.writes) || rune.writes.length) return fail('GC-19', 'reads and writes empty');
      if (!rune.annotations || rune.annotations.readOnlyHint !== true || rune.network !== 'none') return fail('GC-19', 'permissions');
      const pin = listed.get(rune.artifact);
      const buf = typeof rune.artifact === 'string' ? ctx.bytes.get(rune.artifact) : null;
      if (!pin || !buf || !String(rune.artifact).startsWith('runes/')) return fail('GC-19', 'artifact');
      const actual = sha256File(buf);
      if (!digestEqual(rune.sha256, actual) || !digestEqual(pin.digest, actual)) return fail('GC-19', 'digest');
      let scanned;
      try { scanned = scanModuleSource(buf.toString('utf8'), rune.artifact); }
      catch (e) { return fail('GC-19', e && e.reason ? e.reason : 'load gate'); }
      if (scanned.specifiers.includes('emet/rune')) return fail('GC-19', 'emet/rune');
      if (scanned.dynamicImport) return fail('GC-19', 'dynamic import');
      if (scanned.network) return fail('GC-19', 'network');
    }
    return pass('GC-19');
  });

  await run('GC-20', async () => {
    const text = ctx.manifest && ctx.manifest.requires && ctx.manifest.requires.emet;
    if (typeof text !== 'string' || !parseEmetRange(text)) return fail('GC-20', 'requires.emet grammar');
    if (options.emetVersion && !satisfiesEmetRange(options.emetVersion, text)) {
      return fail('GC-20', 'requires.emet excludes this version');
    }
    return pass('GC-20');
  });

  await run('GC-21', async () => {
    if (!ctx.manifest || !Array.isArray(ctx.manifest.runes)) return fail('GC-21', 'runes missing');
    const hints = new Set(['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);
    for (const rune of ctx.manifest.runes) {
      if (!rune || !rune.inputSchema || rune.inputSchema.type !== 'object' || typeof rune.inputSchema.type !== 'string') {
        return fail('GC-21', 'inputSchema');
      }
      if (Object.prototype.hasOwnProperty.call(rune, 'outputSchema') && !isObject(rune.outputSchema)) {
        return fail('GC-21', 'outputSchema');
      }
      if (!isObject(rune.annotations)) return fail('GC-21', 'annotations');
      for (const key of Object.keys(rune.annotations)) if (!hints.has(key)) return fail('GC-21', 'unknown annotation');
    }
    return pass('GC-21');
  });

  await run('GC-22', async () => {
    if (!ctx.manifest) return fail('GC-22', 'gem.json did not parse');
    const listed = new Set(ctx.files);
    for (const rel of ctx.walked) {
      if (!CODE_EXT.includes(extname(rel))) continue;
      if (ctx.manifest.kind !== 'runed-gem') return fail('GC-22', 'code file on a prompt GEM');
      if (!rel.startsWith('runes/')) return fail('GC-22', 'code file outside runes/');
      if (!listed.has(rel)) return fail('GC-22', 'code file is not listed');
    }
    return pass('GC-22');
  });

  const lines = checks.map(lineOf);
  const first = checks.find((c) => c.status === 'fail') || null;
  return {
    ok: !first,
    exitCode: first ? 1 : 0,
    lines,
    checks,
    firstFailure: first ? first.id : null,
    firstDetail: first ? first.reason : null,
    manifest: ctx.manifest,
    floor: ctx.floor,
    floorBytes: ctx.floorTrusted ? ctx.floorBuf.length : 0,
    floorTrusted: ctx.floorTrusted,
    floorDigest: ctx.floorDigest
  };
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return import.meta.url === pathToFileURL(path.resolve(arg)).href; }
  catch { return false; }
}

async function cli() {
  const argv = process.argv.slice(2);
  let emetVersion = null;
  const position = [];
  for (let n = 0; n < argv.length; n++) {
    if (argv[n] === '--emet-version') {
      emetVersion = argv[++n];
      if (!emetVersion) {
        process.stderr.write('gem-check: --emet-version needs x.y.z\n');
        process.exit(2);
      }
    } else position.push(argv[n]);
  }
  if (position.length !== 1) {
    process.stderr.write('gem-check: one directory is required\n');
    process.exit(2);
  }
  let st;
  try { st = await fs.promises.stat(position[0]); }
  catch {
    process.stderr.write('gem-check: not a directory\n');
    process.exit(2);
  }
  if (!st.isDirectory()) {
    process.stderr.write('gem-check: not a directory\n');
    process.exit(2);
  }
  try {
    const result = await checkGem(path.resolve(position[0]), { emetVersion });
    process.stdout.write(result.lines.join('\n') + '\n');
    process.exit(result.exitCode);
  } catch {
    process.stdout.write('GC-01 fail: checker threw\n');
    process.exit(1);
  }
}

if (invokedDirectly()) cli();
