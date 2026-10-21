/**
 * EMET - setup docs for the 0.3.0 error-log role privilege.
 *
 * Rotation deletes from error_log, so the database role needs REMOVE on that
 * collection. The setup docs and the upgrade note must say so, for the Atlas
 * UI and the Atlas CLI. REMOVE stays off every other collection: a
 * document-controlled collection cannot be deleted.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DELETE_ALLOWED, atlasPrivileges } from '../src/atlas-role.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PRIVILEGE = 'REMOVE@<db>.error_log';
const APPEND = 'atlas customDbRoles update emetRecordKeeper --privilege REMOVE@<db>.error_log --append --projectId <id>';
const BACKUP = 'atlas customDbRoles describe emetRecordKeeper --projectId <id> --output json > role-before.json';
const DESCRIBE = 'atlas customDbRoles describe emetRecordKeeper --projectId <id> --output json';
/** Whole command, role name emetRecordKeeper, privilege list exactly atlasPrivileges('<db>'). */
const CREATE = `atlas customDbRoles create emetRecordKeeper --privilege ${atlasPrivileges('<db>').join(',')} --projectId <id>`;
/** The only atlas customDbRoles commands the docs may show. Each entry is the whole command. */
const CANONICAL_ROLE_COMMANDS = new Set([APPEND, BACKUP, DESCRIBE, CREATE]);

const FORBIDDEN = [
  'documents',
  'documents_history',
  'transcripts',
  'exchanges',
  'oauth_tokens',
  '_emet_verify',
  'emet_episodic',
  'emet_semantic',
  'emet_procedural',
  'emet_meta',
  'emet_identity',
  'emet_working'
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'gems' || name === 'tests' || name === 'coverage' || name === '.git') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.md') || name === 'atlas-role.mjs') out.push(p);
  }
  return out;
}

function removeGrants(text) {
  const grants = [];
  for (const m of text.matchAll(/REMOVE@([^\s,;`'"\\)]+)/g)) {
    grants.push(m[1].replace(/[.)]+$/, ''));
  }
  return grants;
}

/**
 * One logical line per shell command. Join a trailing `\`, a PowerShell
 * continuation backtick (preceded by whitespace, so a closing markdown
 * backtick stays put), or a cmd `^`. Then collapse whitespace and drop a
 * trailing `#` comment. Matching happens only after that.
 */
function continuationStem(line) {
  const t = line.replace(/[ \t]+$/, '');
  if (t.endsWith('\\') && !t.endsWith('\\\\')) return t.slice(0, -1);
  if (t.endsWith('^')) return t.slice(0, -1);
  if (t.endsWith('`') && /\s`$/.test(t)) return t.slice(0, -1);
  return null;
}

function normalizeLines(text) {
  const logical = [];
  let buf = '';
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const stem = continuationStem(line);
    if (stem !== null) {
      buf += `${stem.replace(/\s+$/, '')} `;
      continue;
    }
    buf += line;
    const collapsed = buf.replace(/\s+/g, ' ').trim().replace(/\s+#.*$/, '').trim();
    if (collapsed) logical.push(collapsed);
    buf = '';
  }
  if (buf.trim()) {
    const collapsed = buf.replace(/\s+/g, ' ').trim().replace(/\s+#.*$/, '').trim();
    if (collapsed) logical.push(collapsed);
  }
  return logical;
}

/** `--privilege X` and `--privilege=X`, including a comma-separated list in either form. */
function privilegeTokens(text) {
  const tokens = [];
  for (const line of normalizeLines(text)) {
    for (const m of line.matchAll(/--privilege(?:=|\s+)(\S+(?:\s*,\s*\S+)*)/g)) {
      for (let part of m[1].split(/\s*,\s*/)) {
        part = part.replace(/^[`'"]+|[`'"),.;]+$/g, '');
        if (/^[A-Za-z_][A-Za-z0-9_]*@.+$/.test(part)) tokens.push(part);
      }
    }
  }
  return tokens;
}

/** Privileges the role script would actually send, for the documented placeholders. */
function allowedPrivileges() {
  return new Set([
    ...atlasPrivileges('<db>'),
    ...atlasPrivileges('<db>', '<prefix>'),
    ...atlasPrivileges('emet'),
    ...atlasPrivileges('emet', '<prefix>')
  ]);
}

/** A token is allowed only when atlasPrivileges() lists it. DROP_* never is. */
function privilegeFaults(text) {
  const allowed = allowedPrivileges();
  const bad = [];
  for (const token of privilegeTokens(text)) {
    const action = token.slice(0, token.indexOf('@'));
    if (/^DROP_/i.test(action) || token.includes('*') || !allowed.has(token)) bad.push(token);
  }
  return bad;
}

/** Drop markdown code markers so a command inside inline code is still the command. */
function stripMarkdownCode(line) {
  return line.replace(/<\/?code>/gi, '').replace(/`+/g, '');
}

/** Commands on one logical line. An inline span is the whole span, not a prefix of it. */
function commandsOnLine(line) {
  const found = [];
  let rest = line;
  rest = rest.replace(/`+([^`]+)`+/g, (_, inner) => {
    const span = inner.replace(/\s+/g, ' ').trim();
    if (span.includes('atlas customDbRoles')) found.push(span);
    return ' ';
  });
  rest = rest.replace(/<code>([^<]*)<\/code>/gi, (_, inner) => {
    const span = inner.replace(/\s+/g, ' ').trim();
    if (span.includes('atlas customDbRoles')) found.push(span);
    return ' ';
  });
  const at = rest.indexOf('atlas customDbRoles');
  if (at >= 0 && (at === 0 || !/[A-Za-z0-9_]/.test(rest[at - 1]))) {
    const cmd = rest.slice(at).trim().replace(/[.;:!?]+$/, '').replace(/\s+/g, ' ').trim();
    found.push(cmd);
  }
  return found;
}

/**
 * Every documented `atlas customDbRoles` command, after continuations are
 * joined and whitespace is collapsed, must equal one canonical command.
 * The create form is the full atlasPrivileges('<db>') list on emetRecordKeeper.
 */
function nonCanonicalRoleCommands(text) {
  const bad = [];
  for (const line of normalizeLines(text)) {
    for (const command of commandsOnLine(line)) {
      if (!CANONICAL_ROLE_COMMANDS.has(command)) bad.push(command);
    }
  }
  return bad;
}

/** `--append` as its own token. Case, dash characters, and HTML entities are folded first. */
const APPEND_TOKEN = /(?<![A-Za-z0-9_-])--append(?![A-Za-z0-9_-])/i;

/**
 * Fold `--APPEND`, en-dash and em-dash spellings, and `&#45;` / named-dash
 * entities into ASCII `--append` so every spelling is the same token.
 * A single en dash or em dash before `append` is the Word conversion of `--`.
 */
function decodeAppendFlags(text) {
  let s = String(text);
  s = s.replace(/&ndash;|&#0*8211;|&#x0*2013;/gi, '\u2013');
  s = s.replace(/&mdash;|&#0*8212;|&#x0*2014;/gi, '\u2014');
  s = s.replace(/&minus;|&#0*8722;|&#x0*2212;/gi, '\u2212');
  s = s.replace(/&#0*45;|&#x0*2d;/gi, '-');
  s = s.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
  // A single dash before "append" is the Word conversion of `--`.
  s = s.replace(/(?<!-)-(?=append\b)/gi, '--');
  return s;
}

function hasAppend(text) {
  return APPEND_TOKEN.test(decodeAppendFlags(text));
}

const REMOVAL_WORD = /^(remove|removes|removed|removing|revoke|revokes|revoked|revoking|clear|clears|cleared|clearing|strip|strips|stripped|stripping|delete|deletes|deleted|deleting|drop|drops|dropped|dropping|eliminate|eliminates|eliminated|eliminating|purge|purges|purged|purging|undo|undoes|undid|undone|undoing|revert|reverts|reverted|reverting|disable|disables|disabled|disabling|cleanup|cleanups)$/i;
const CLAUSE = /^(so|because|if|when|while|which|where|but|then)$/i;
const DET = /^(the|a|an|this|that|these|those|stray|older|old|any|every|its|their|his|her|our|your|also|just|still|only|same|such|another|some|first)$/i;
const BOUND = /^[.,;:?!]$/;
const PASSIVE = /^(removed|cleared|dropped|deleted|stripped|revoked|eliminated|purged|undone|reverted|disabled)$/i;
const AUX = /^(is|are|was|were|been|be|gets|get)$/i;
const DIRECT_NEGATION = /^(?:not|never|cannot)$/i;

function tokensOf(text) {
  let s = decodeAppendFlags(text);
  s = s.replace(/\bdon't\b/gi, 'do not');
  s = s.replace(/\bcan't\b/gi, 'cannot');
  const tokens = [];
  const re = /[A-Za-z0-9_]+|[.,;:?!]/g;
  let match;
  while ((match = re.exec(s))) tokens.push(match[0]);
  return tokens;
}

/** How many tokens the removal verb occupies. `REMOVE` the action name is not a verb. `fix` and `reset` are not removal verbs. */
function verbSpan(tokens, i) {
  const word = tokens[i];
  if (word === 'REMOVE' || BOUND.test(word)) return 0;
  if (/^(?:take|takes|took|taking)$/i.test(word) && /^away$/i.test(tokens[i + 1] || '')) return 2;
  if (/^(?:take|takes|took|taking)$/i.test(word) && /^out$/i.test(tokens[i + 1] || '')) return 2;
  if (/^(?:clean|cleans|cleaned|cleaning)$/i.test(word) && /^up$/i.test(tokens[i + 1] || '')) return 2;
  if (/^(?:get|gets|getting|got)$/i.test(word) && /^rid$/i.test(tokens[i + 1] || '') && /^of$/i.test(tokens[i + 2] || '')) return 3;
  return REMOVAL_WORD.test(word) ? 1 : 0;
}

/** Privilege, grant, permission, role permission, access, or DROP_COLLECTION in any spelling. */
function isRemovalTarget(words) {
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (/^(?:privileges?|grants?|permissions?|access)$/i.test(word)) return true;
    if (/^drop_?collection$/i.test(word)) return true;
    if (/^drop$/i.test(word) && /^collection$/i.test(words[i + 1] || '')) return true;
    if (/^roles?$/i.test(word) && /^permissions?$/i.test(words[i + 1] || '')) return true;
  }
  return false;
}

/** `Do not remove`, `Don't drop`, and `never delete` govern the verb. `Don't skip this: remove` does not. */
function directlyNegated(tokens, i) {
  return DIRECT_NEGATION.test(tokens[i - 1] || '');
}

/**
 * A removal verb whose object is a privilege, grant, role permission, access,
 * or DROP_COLLECTION. The object scan stops at a sentence or clause boundary
 * (`. , ;` and a following clause). A negation that directly governs the verb
 * exempts that clause only.
 */
function hasRemovalTarget(text) {
  const tokens = tokensOf(text);
  for (let i = 0; i < tokens.length; i++) {
    const span = verbSpan(tokens, i);
    if (!span || directlyNegated(tokens, i)) continue;
    const object = [];
    let sawDeterminer = false;
    for (let j = i + span; j < tokens.length && object.length < 8; j++) {
      if (BOUND.test(tokens[j]) || CLAUSE.test(tokens[j])) break;
      if (DET.test(tokens[j]) && !object.some((word) => !DET.test(word))) {
        sawDeterminer = true;
        continue;
      }
      // "delete permission" is the name of a permission, not a verb plus an object.
      if (!sawDeterminer && object.length === 0 && /^(?:privileges?|grants?|permissions?|access)$/i.test(tokens[j])) break;
      object.push(tokens[j]);
      if (isRemovalTarget(object)) return true;
    }
    if (PASSIVE.test(tokens[i])) {
      const before = [];
      for (let k = i - 1; k >= 0 && before.length < 8; k--) {
        if (BOUND.test(tokens[k]) || CLAUSE.test(tokens[k])) break;
        before.unshift(tokens[k]);
      }
      if (before.some((word) => AUX.test(word)) && isRemovalTarget(before)) return true;
    }
  }
  return false;
}

function markdownListItems(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const items = [];
  let cur = null;
  for (const line of lines) {
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      if (cur) items.push(cur);
      cur = line;
      continue;
    }
    if (cur && line.trim() !== '' && /^\s+/.test(line)) {
      cur += `\n${line}`;
      continue;
    }
    if (cur) items.push(cur);
    cur = null;
  }
  if (cur) items.push(cur);
  return items;
}

function lineStartsCode(line) {
  return /^(?: {0,3})(?:`{3,}|~{3,})/.test(line) || /^(?: {4}|\t)\S/.test(line);
}

/**
 * Prose from the previous heading or code block up to `endExclusive`.
 * Blank lines stay in. The heading is included. The previous code block is not.
 */
function regionBefore(lines, endExclusive) {
  for (let i = endExclusive - 1; i >= 0; i--) {
    if (/^#{1,6}\s+/.test(lines[i])) return lines.slice(i, endExclusive).join('\n');
    if (lineStartsCode(lines[i])) return lines.slice(i + 1, endExclusive).join('\n');
  }
  return lines.slice(0, endExclusive).join('\n');
}

/**
 * A removal verb whose object is a privilege, grant, role permission, access,
 * or DROP_COLLECTION, anywhere in the intro before an `--append` (every
 * sentence and the heading, across blank lines, stopping at a sentence or
 * clause boundary) or anywhere in that list item. The canonical upgrade
 * command counts. `fix` and `reset` are not removal verbs.
 */
function removalAppendHits(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const hits = [];
  const inFence = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const fence = /^( {0,3})(`{3,}|~{3,})/.exec(lines[i]);
    if (!fence) continue;
    const marker = fence[2][0];
    const open = i;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^ {0,3}\\${marker}{3,}\\s*$`).test(lines[j])) {
      inFence[j] = true;
      j += 1;
    }
    const body = lines.slice(open + 1, j).join('\n');
    const intro = regionBefore(lines, open);
    if (hasAppend(body) && hasRemovalTarget(intro)) hits.push(intro.trim());
    i = j;
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '' || !/^(?: {4}|\t)/.test(lines[i + 1] || '') || inFence[i + 1]) continue;
    const start = i + 1;
    let j = start;
    const body = [];
    while (j < lines.length && (/^(?: {4}|\t)/.test(lines[j]) || (lines[j].trim() === '' && /^(?: {4}|\t)/.test(lines[j + 1] || '')))) {
      body.push(lines[j]);
      j += 1;
    }
    const intro = regionBefore(lines, start);
    if (hasAppend(body.join('\n')) && hasRemovalTarget(intro)) hits.push(intro.trim());
    i = j - 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i] || !hasAppend(lines[i])) continue;
    const region = regionBefore(lines, i + 1);
    if (hasRemovalTarget(region)) hits.push(region.trim());
  }
  for (const item of markdownListItems(text)) {
    if (hasAppend(item) && hasRemovalTarget(item)) hits.push(item.trim());
  }
  return hits;
}

function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const fence = /^( {0,3})(`{3,}|~{3,})/.exec(lines[i]);
    if (!fence) continue;
    const marker = fence[2][0];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^ {0,3}\\${marker}{3,}\\s*$`).test(lines[j])) {
      mask[j] = true;
      j += 1;
    }
    i = j;
  }
  return mask;
}

/**
 * Sections run from a level-2-or-deeper heading to the next heading of the
 * same or higher level. A file's top `#` heading is not a section boundary.
 * A heading inside a code fence is not a heading.
 */
function markdownSections(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const inFence = fenceMask(lines);
  const heads = [];
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    const m = /^ {0,3}(#{2,6})\s+/.exec(line);
    if (m) heads.push({ i, level: m[1].length });
  });
  if (!heads.length) return [lines.join('\n')];
  const sections = [];
  if (heads[0].i > 0) sections.push(lines.slice(0, heads[0].i).join('\n'));
  for (let h = 0; h < heads.length; h++) {
    let end = lines.length;
    for (let k = h + 1; k < heads.length; k++) {
      if (heads[k].level <= heads[h].level) { end = heads[k].i; break; }
    }
    sections.push(lines.slice(heads[h].i, end).join('\n'));
  }
  return sections;
}

/**
 * In a section that mentions DROP_COLLECTION, `--append` may appear only
 * before that first mention.
 */
function sectionAppendHits(text) {
  const hits = [];
  const token = /(?<![A-Za-z0-9_-])--append(?![A-Za-z0-9_-])/gi;
  for (const section of markdownSections(text)) {
    const decoded = decodeAppendFlags(section);
    const drop = /drop[\s_-]*collection/i.exec(decoded);
    if (!drop) continue;
    token.lastIndex = 0;
    let match;
    while ((match = token.exec(decoded))) {
      if (match.index > drop.index) {
        hits.push(decoded.slice(Math.max(0, drop.index - 40), match.index + match[0].length).replace(/\s+/g, ' ').trim());
        break;
      }
    }
  }
  return hits;
}

/**
 * The token `--append` may appear only inside the exact canonical upgrade
 * command. Every other occurrence, in prose or in a code span, is returned.
 * Removal context paired with any `--append`, including that command, is too.
 */
function strayAppends(text) {
  const normalized = normalizeLines(text).join('\n');
  const masked = normalized.split(APPEND).join(' '.repeat(APPEND.length));
  const bad = [];
  for (const line of decodeAppendFlags(masked).split('\n')) {
    if (hasAppend(line)) bad.push(line.trim());
  }
  bad.push(...removalAppendHits(text));
  bad.push(...sectionAppendHits(text));
  return bad;
}

/**
 * Documented `node scripts/atlas-role.mjs` invocations, in order.
 * A command is the script plus its `--flags` and flag values. It stops at
 * prose, a bracketed usage form such as `[--apply | --rollback]`, and
 * punctuation, so two commands on one line stay two commands.
 */
function scriptInvocations(text) {
  const out = [];
  const norm = normalizeLines(text).join('\n').replace(/`+/g, '');
  const re = /node scripts\/atlas-role\.mjs((?:[ \t]+--[A-Za-z][\w-]*)(?:[ \t]+(?!--)[^\s,;)\]`'.]+)?)*/g;
  for (const m of norm.matchAll(re)) out.push(m[0]);
  return out;
}

/** Each `--apply` is the immediately previous invocation plus ` --apply`. */
function assertDryRunPrecedesApply(invocations, rel) {
  for (let i = 0; i < invocations.length; i++) {
    const command = invocations[i];
    if (!/(?:^|\s)--apply\b/.test(command)) continue;
    assert.match(command, /(?:^|\s)--db\s+\S+/, `${rel}: ${command}`);
    assert.match(command, /(?:^|\s)--prefix\s+<prefix>/, `${rel}: ${command}`);
    const prev = invocations[i - 1];
    assert.strictEqual(prev, command.replace(/\s--apply\b/g, ''), `${rel}: dry run precedes --apply with the same flags`);
  }
}

/** The removal instruction itself names the Atlas UI, not the add-privilege screen. */
function clearsDropInAtlasUi(text) {
  return text.split('\n').some((line) =>
    /DROP_COLLECTION/.test(line) &&
    /Atlas UI/.test(line) &&
    (/clear\s+it\b/i.test(line) || /clear `DROP_COLLECTION`/.test(line)));
}

testGroup('setup docs and the 0.3.0 upgrade note grant REMOVE on error_log', () => {
  test('first-time setup uses the role script, then --apply', () => {
    for (const rel of ['docs/SETUP.md', 'docs/GUIDED-SETUP.md']) {
      const text = read(rel);
      assert.ok(text.includes(PRIVILEGE), rel);
      assert.match(text, /node scripts\/atlas-role\.mjs --project <projectId> --db \S+ --user emet_app --prefix <prefix>\n/);
      assert.match(text, /node scripts\/atlas-role\.mjs --project <projectId> --db \S+ --user emet_app --prefix <prefix> --apply/);
      assert.match(text, /Custom Roles/);
      assert.match(text, /`error_log`/);
      assert.match(text, /action `REMOVE`|enable `REMOVE`/);
    }
  });

  test('the role script comment carries the same privilege', () => {
    const text = read('scripts/atlas-role.mjs');
    assert.ok(text.includes(PRIVILEGE));
    assert.ok(text.includes('--append'));
  });

  test('the upgrade note has the append command and how to verify it', () => {
    for (const rel of ['docs/SETUP.md', 'CHANGELOG.md', 'docs/DEPLOY.md']) {
      const text = read(rel);
      assert.match(text, /Upgrading to 0\.3\.0/);
      assert.ok(text.includes(APPEND), rel);
      assert.ok(text.includes('error_log'), rel);
      assert.match(text, /10,000 entries or 90 days/);
      assert.match(text, /daily summaries/);
    }
    for (const rel of ['docs/SETUP.md', 'CHANGELOG.md', 'docs/DEPLOY.md']) {
      assert.ok(read(rel).includes(DESCRIBE), rel);
    }
    const setup = read('docs/SETUP.md');
    const upgradeAt = setup.indexOf('## Upgrading to 0.3.0');
    assert.ok(upgradeAt >= 0);
    const upgrade = setup.slice(upgradeAt, setup.indexOf('\n## ', upgradeAt + 1));
    assert.match(upgrade, /Atlas UI/);
    assert.match(upgrade, /That append command cannot remove a privilege/);
    assert.match(upgrade, /empty collection/);
    assert.match(upgrade, /ISO 9001 7\.5\.3 \/ ISO 13485 4\.2\.5 document-control wording is unchanged\./);
  });

  test('a documented atlas customDbRoles command is one of the canonical commands', () => {
    const bad = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      for (const line of nonCanonicalRoleCommands(fs.readFileSync(file, 'utf8'))) bad.push(`${rel}: ${line}`);
    }
    assert.deepStrictEqual(bad, []);
    for (const command of CANONICAL_ROLE_COMMANDS) assert.deepStrictEqual(nonCanonicalRoleCommands(command), []);
  });

  test('a wrapped, double-spaced, or comment-only --append update fails', () => {
    const wrapped = 'atlas customDbRoles update emetRecordKeeper \\\n--privilege REMOVE@<db>.error_log';
    const spaced = 'atlas customDbRoles  update emetRecordKeeper --privilege REMOVE@<db>.error_log';
    const commented = 'atlas customDbRoles update emetRecordKeeper --privilege REMOVE@<db>.error_log # --append';
    const tick = 'atlas customDbRoles update emetRecordKeeper `\n--privilege REMOVE@<db>.error_log';
    const caret = 'atlas customDbRoles update emetRecordKeeper ^\n--privilege REMOVE@<db>.error_log';
    for (const sample of [wrapped, spaced, commented, tick, caret]) {
      assert.ok(nonCanonicalRoleCommands(sample).length > 0, sample);
    }
    assert.deepStrictEqual(nonCanonicalRoleCommands(APPEND), []);
    assert.ok(nonCanonicalRoleCommands(`${APPEND} now`).length > 0);
  });

  test('anything outside the canonical commands fails', () => {
    const full = atlasPrivileges('<db>').join(',');
    const samples = [
      `atlas customDbRoles update emetRecordKeeper --privilege ${full}`,
      'atlas customDbRoles update emetRecordKeeper --privilege FIND@<db>,INSERT@<db>',
      `atlas customDbRoles update emetRecordKeeper --privilege ${full},DROP_COLLECTION@<db>._emet_verify`,
      `atlas customDbRoles create emetRecordKeeper --privilege ${full}`,
      `atlas customDbRoles create emetRecordKeeper --privilege ${PRIVILEGE}`,
      'atlas customDbRoles update emetRecordKeeper --privilege=REMOVE@<db>.error_log',
      'atlas customDbRoles update emetRecordKeeper --privilege=FIND@<db>,INSERT@<db>',
      `atlas customDbRoles update emetRecordKeeper --privilege=${full}`,
      'atlas customDbRoles update emetRecordKeeper --inheritedRole dbAdmin@<db> --append',
      'atlas customDbRoles update emetRecordKeeper -p REMOVE@<db>.error_log --append',
      'atlas customDbRoles update emetRecordKeeper --Privilege REMOVE@<db>.error_log --append',
      'atlas customDbRoles update emetRecordKeeper --privilege= REMOVE@<db>.error_log --append',
      'atlas customDbRoles update emetRecordKeeper --privilege=\tREMOVE@<db>.error_log --append',
      'atlas customDbRoles create emetrole --inheritedRole dbAdmin@<db>',
      'atlas customDbRoles create emet-role --inheritedRole dbAdmin@<db> --append',
      'atlas customDbRoles update emet-role --inheritedRole dbAdmin@<db> --append',
      'atlas customDbRoles create myrole --inheritedRole dbAdmin@<db>',
      'atlas customDbRoles create myrole --inheritedRole readWriteAnyDatabase@admin',
      'The dry run prints `atlas customDbRoles create`.'
    ];
    for (const sample of samples) assert.ok(nonCanonicalRoleCommands(sample).length > 0, sample);
    assert.deepStrictEqual(privilegeTokens('atlas customDbRoles update emetRecordKeeper --privilege=FIND@<db>,INSERT@<db>'), ['FIND@<db>', 'INSERT@<db>']);
    assert.deepStrictEqual(nonCanonicalRoleCommands(CREATE), []);
    assert.deepStrictEqual(nonCanonicalRoleCommands(`Run \`${CREATE}\` once.`), []);
  });

  test('every documented --privilege is one atlasPrivileges() grants, and none is DROP_*', () => {
    for (const token of allowedPrivileges()) assert.ok(!/^DROP_/i.test(token.slice(0, token.indexOf('@'))), token);
    const bad = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      for (const token of privilegeFaults(fs.readFileSync(file, 'utf8'))) bad.push(`${rel}: ${token}`);
    }
    assert.deepStrictEqual(bad, []);
    assert.ok(privilegeTokens(read('docs/SETUP.md')).includes(PRIVILEGE));
  });

  test('a documented DROP_COLLECTION append and a FIND@* append both fail', () => {
    const drop = 'atlas customDbRoles update emetRecordKeeper --privilege DROP_COLLECTION@<db>._emet_verify --append';
    const find = 'atlas customDbRoles update emetRecordKeeper --privilege FIND@* --append';
    const wrapped = 'atlas customDbRoles update emetRecordKeeper \\\n--privilege DROP_COLLECTION@<db>._emet_verify --append';
    assert.ok(privilegeFaults(drop).includes('DROP_COLLECTION@<db>._emet_verify'));
    assert.ok(privilegeFaults(find).includes('FIND@*'));
    assert.ok(privilegeFaults(wrapped).includes('DROP_COLLECTION@<db>._emet_verify'));
    const dropEq = 'atlas customDbRoles update emetRecordKeeper --privilege=DROP_COLLECTION@<db>._emet_verify --append';
    const findEq = 'atlas customDbRoles update emetRecordKeeper --privilege=FIND@* --append';
    const commaEq = 'atlas customDbRoles update emetRecordKeeper --privilege=DROP_COLLECTION@<db>._emet_verify,FIND@* --append';
    assert.ok(privilegeFaults(dropEq).includes('DROP_COLLECTION@<db>._emet_verify'));
    assert.ok(privilegeFaults(findEq).includes('FIND@*'));
    assert.deepStrictEqual(privilegeTokens(commaEq), ['DROP_COLLECTION@<db>._emet_verify', 'FIND@*']);
    assert.ok(privilegeFaults(commaEq).includes('DROP_COLLECTION@<db>._emet_verify'));
    assert.ok(privilegeFaults(commaEq).includes('FIND@*'));
    for (const sample of [drop, find, wrapped, dropEq, findEq, commaEq]) {
      assert.ok(nonCanonicalRoleCommands(sample).length > 0, sample);
    }
  });
});

testGroup('upgraders save the role and then prove DROP_COLLECTION is gone', () => {
  test('the upgrade note saves the role before the change', () => {
    for (const rel of ['docs/SETUP.md', 'CHANGELOG.md', 'docs/DEPLOY.md']) {
      const text = normalizeLines(read(rel)).join('\n');
      const backupAt = text.indexOf(BACKUP);
      const appendAt = text.indexOf(APPEND);
      assert.ok(backupAt !== -1, rel);
      assert.ok(appendAt > backupAt, rel);
    }
  });

  test('after the change, no DROP_COLLECTION may remain anywhere', () => {
    for (const rel of ['docs/SETUP.md', 'CHANGELOG.md', 'docs/DEPLOY.md']) {
      const text = read(rel);
      assert.match(text, /DROP_COLLECTION/, rel);
      assert.match(text, /must not (appear|contain)|must not appear anywhere|DROP_COLLECTION` must not appear/, rel);
    }
    const upgradeAt = read('docs/SETUP.md').indexOf('## Upgrading to 0.3.0');
    const upgrade = read('docs/SETUP.md').slice(upgradeAt, read('docs/SETUP.md').indexOf('\n## ', upgradeAt + 1));
    assert.ok(upgrade.includes(DESCRIBE));
    assert.match(upgrade, /DROP_COLLECTION` must not appear anywhere/);
  });

  test('a stray DROP_COLLECTION on the probe cannot be cleared by the append command', () => {
    for (const rel of ['docs/SETUP.md', 'CHANGELOG.md', 'docs/DEPLOY.md']) {
      const text = read(rel);
      assert.match(text, /DROP_COLLECTION` on `_emet_verify`/, rel);
      assert.match(text, /That append command cannot remove a privilege/, rel);
      assert.match(text, /node scripts\/atlas-role\.mjs --project <id> --db <db> --user <dbUsername> --prefix <prefix>/, rel);
      assert.match(text, /node scripts\/atlas-role\.mjs --project <id> --db <db> --user <dbUsername> --prefix <prefix> --apply/, rel);
      assert.ok(clearsDropInAtlasUi(text), rel);
    }
    const fenced = (prose) => `${prose}\n\n\`\`\`\n${APPEND}\n\`\`\`\n`;
    const safe = 'That append command cannot remove a privilege; use scripts/atlas-role.mjs --apply or the Atlas UI.';
    const rotation = fenced('Cleared entries are removed by rotation.');
    const entries = fenced('Rotation removes old entries, so the role needs one more privilege:');
    assert.deepStrictEqual(strayAppends(safe), []);
    assert.deepStrictEqual(strayAppends(rotation), []);
    assert.deepStrictEqual(strayAppends(entries), []);
    assert.deepStrictEqual(strayAppends(APPEND), []);
    for (const prose of [
      'Rotation removes entries. Grant the privilege that allows it:',
      'Do not remove any existing privilege. Append this one:',
      "Don't drop the grant.",
      'never delete the old privilege.',
      'This fixes the missing privilege:',
      'Rotation deletes old entries. Grant the new privilege with:',
      'Rotation needs delete permission on error_log. Run:',
      'To let rotation delete entries, grant the privilege:',
      'This was fixed in 0.3.0. Add the privilege:',
      'Fix the grant.',
      'Reset the privilege.'
    ]) assert.deepStrictEqual(strayAppends(fenced(prose)), [], prose);
    const leaks = [
      'Remove it with `--append`.',
      'If the role has a stray DROP_COLLECTION, clear it with `--append`.',
      'drop the grant with --append',
      'strip the privilege with --append',
      'take away the role with --append',
      'remove dropCollection with --append',
      'remove the stray role/access with --append',
      'delete the privilege with --append',
      "Don't skip this: remove the grant with --append",
      'Never forget to remove the grant with --append',
      'remove the grant with --append, not the UI',
      'An older stray `DROP_COLLECTION` on `_emet_verify` cannot be removed with `--append`.',
      'use --append to remove the DROP_COLLECTION privilege',
      'Use `--append` to remove the stray DROP_COLLECTION grant',
      'Use <code>--append</code> to remove the stray DROP_COLLECTION grant',
      'Remove the stray DROP_COLLECTION grant (--append).',
      'Remove the stray DROP_COLLECTION grant "--append".',
      "Remove the stray DROP_COLLECTION grant '--append'.",
      'do not use --append to remove',
      'do not use --append to remove the DROP_COLLECTION privilege',
      'Clear the cache before restart. Use `--append` to add REMOVE.',
      'Remove the DROP_COLLECTION grant.\n\n```\natlas customDbRoles update emetRecordKeeper --append\n```\n',
      'Clear the stray DROP_COLLECTION grant.\n\n    atlas customDbRoles update emetRecordKeeper --append\n',
      'Remove the DROP_COLLECTION privilege.\n\n~~~\natlas customDbRoles update emetRecordKeeper --append\n~~~\n',
      'Revoke the DROP_COLLECTION privilege.\n\n- then pass `--append`\n',
      `To remove the stray DROP_COLLECTION grant, run:\n\n\`\`\`\n${APPEND}\n\`\`\`\n`,
      `To remove the stray DROP_COLLECTION grant, run:\n\n~~~\n${APPEND}\n~~~\n`,
      `To remove the stray DROP_COLLECTION grant, run:\n\n    ${APPEND}\n`,
      `- To remove the stray DROP_COLLECTION grant, run:\n  ${APPEND}\n`,
      `To remove the stray DROP_COLLECTION grant, run: ${APPEND}`,
      `## To remove the stray DROP_COLLECTION grant\n\n\`\`\`\n${APPEND}\n\`\`\`\n`,
      APPEND.replace('--append', '--APPEND'),
      `drop the grant with ${'\u2013\u2013'}append`,
      `strip the privilege with ${'\u2014\u2014'}append`,
      `take away the role with ${'\u2014'}append`,
      'delete the privilege with &#45;&#45;append',
      'remove the grant with &#x2d;&#x2d;APPEND',
      'remove the privilege with &ndash;&ndash;append',
      'remove the grant with &mdash;append',
      `To remove the stray DROP_COLLECTION grant:\n\n1. Run \`${APPEND}\`\n`,
      `Remove the stray DROP_COLLECTION grant first. Then run:\n\n\`\`\`\n${APPEND}\n\`\`\`\n`,
      `### Removing a stray DROP_COLLECTION\n\n\`\`\`\n${APPEND}\n\`\`\`\n`,
      `1. Remove the grant. 2. Run ${APPEND}`,
      `Get rid of the privilege.\n\n\`\`\`\n${APPEND}\n\`\`\`\n`,
      `Eliminate the grant.\n\n\`\`\`\n${APPEND}\n\`\`\`\n`,
      `### Removing a stray DROP_COLLECTION\n\nRun this from a terminal:\n\n\`\`\`\n${APPEND}\n\`\`\`\n`,
      `To remove the stray DROP_COLLECTION grant, use the append command. Run it from a terminal:\n\n\`\`\`\n${APPEND}\n\`\`\`\n`,
      `1. Remove the stray DROP_COLLECTION grant.\n2. Run \`${APPEND}\`.\n`,
      fenced('To fix the stray DROP_COLLECTION grant, run:'),
      fenced('To get rid of the stray DROP_COLLECTION, run:'),
      fenced('To eliminate the stray DROP_COLLECTION grant, run:'),
      fenced('To reset the stray DROP_COLLECTION privilege, run:'),
      fenced("Don't skip this: remove the grant."),
      fenced('Never forget to remove the grant.'),
      fenced('To revoke the old access, run:'),
      fenced('To clean up the grant, run:'),
      fenced('To purge the privilege, run:'),
      fenced('To take out the grant, run:'),
      fenced('To undo the privilege, run:'),
      fenced('To revert the grant, run:'),
      fenced('To disable the privilege, run:'),
      fenced('To remove the stray role/access, run:'),
      `## Repair\n\nDROP_COLLECTION is on _emet_verify.\n\nRemove it:\n\n\`\`\`\n${APPEND}\n\`\`\`\n`
    ];
    for (const sample of leaks) assert.ok(strayAppends(sample).length > 0, sample);
    const bad = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      for (const line of strayAppends(fs.readFileSync(file, 'utf8'))) bad.push(`${rel}: ${line}`);
    }
    assert.deepStrictEqual(bad, []);
  });

  test('every atlas-role.mjs --apply has --db and --prefix and follows a dry run', () => {
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      assertDryRunPrecedesApply(scriptInvocations(fs.readFileSync(file, 'utf8')), rel);
    }
    const dry = 'node scripts/atlas-role.mjs --project <id> --db <db> --user <dbUsername> --prefix <prefix>';
    const other = 'node scripts/atlas-role.mjs --project <projectId> --db <database> --user emet_app --prefix <prefix>';
    assert.doesNotThrow(() => assertDryRunPrecedesApply([dry, `${dry} --apply`, other, `${other} --apply`], 'pairs'));
    assert.throws(() => assertDryRunPrecedesApply([dry, `${dry} --apply`, `${dry} --apply`], 'second apply'));
    assert.throws(() => assertDryRunPrecedesApply([other, `${dry} --apply`], 'different flags'));
    for (const rel of ['docs/SETUP.md', 'docs/GUIDED-SETUP.md', 'docs/DEPLOY.md', 'CHANGELOG.md', 'scripts/atlas-role.mjs']) {
      const text = read(rel);
      assert.match(text, /--prefix <prefix>/, rel);
      assert.match(text, /EMET_COLLECTION_PREFIX/, rel);
      assert.match(text, /`--prefix` overrides `EMET_COLLECTION_PREFIX`/, rel);
      assert.match(text, /effective prefix is `--prefix`, or else the env/, rel);
      assert.match(text, /Re-applying replaces prefixed privilege names if the effective prefix doesn't match the install/, rel);
      assert.match(text, /read-only `atlas customDbRoles describe emetRecordKeeper --projectId <id> --output json`/, rel);
      assert.match(text, /needs Atlas auth and changes nothing/, rel);
    }
  });

  test('a placeholder argument is rejected', () => {
    const run = (args) => spawnSync(process.execPath, ['scripts/atlas-role.mjs', ...args], { encoding: 'utf8', cwd: ROOT });
    for (const args of [
      ['--project', 'p', '--db', 'emet', '--user', 'u', '--prefix', '<prefix>'],
      ['--project', 'p', '--db', '<db>', '--user', 'u', '--prefix', 'emet_'],
      ['--project', '<projectId>', '--db', 'emet', '--user', 'u'],
      ['--prefix', '<database>']
    ]) {
      const result = run(args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, /placeholder/i, args.join(' '));
    }
  });

  test('deleting the dry run precedes --apply assertion fails the suite', () => {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const needle = "assert.strictEqual(prev, command.replace(/\\s--apply\\b/g, ''), `${rel}: dry run precedes --apply with the same flags`)";
    assert.ok(src.includes(needle));
  });

  test('the section rule flags an append after DROP_COLLECTION and ignores a top-level heading', () => {
    const repairFence = `## Repair\n\nFor a stray DROP_COLLECTION on _emet_verify, run:\n\n\`\`\`\n${APPEND}\n\`\`\`\n`;
    const repairInline = `## Repair\n\nIf describe still shows DROP_COLLECTION, run \`${APPEND}\`.\n`;
    const upgrade = `## Upgrade\n\n\`\`\`\n${APPEND}\n\`\`\`\n\nThen confirm DROP_COLLECTION is absent.\n`;
    assert.strictEqual(hasRemovalTarget(repairFence), false);
    assert.strictEqual(hasRemovalTarget(repairInline), false);
    assert.ok(sectionAppendHits(repairFence).length > 0);
    assert.ok(sectionAppendHits(repairInline).length > 0);
    assert.ok(strayAppends(repairFence).length > 0);
    assert.ok(strayAppends(repairInline).length > 0);
    assert.deepStrictEqual(sectionAppendHits(upgrade), []);
    assert.deepStrictEqual(strayAppends(upgrade), []);

    const fixProbe = `To fix the stray DROP_COLLECTION grant, run:\n\n\`\`\`\n${APPEND}\n\`\`\`\n`;
    const resetProbe = `To reset the stray DROP_COLLECTION privilege, run:\n\n\`\`\`\n${APPEND}\n\`\`\`\n`;
    assert.strictEqual(hasRemovalTarget('To fix the stray DROP_COLLECTION grant, run:'), false);
    assert.strictEqual(hasRemovalTarget('To reset the stray DROP_COLLECTION privilege, run:'), false);
    assert.ok(sectionAppendHits(fixProbe).length > 0);
    assert.ok(sectionAppendHits(resetProbe).length > 0);
    assert.ok(strayAppends(fixProbe).length > 0);
    assert.ok(strayAppends(resetProbe).length > 0);

    const removeIt = `## Repair\n\nDROP_COLLECTION is on _emet_verify.\n\nRemove it:\n\n\`\`\`\n${APPEND}\n\`\`\`\n`;
    assert.strictEqual(hasRemovalTarget('Remove it:'), false);
    assert.ok(sectionAppendHits(removeIt).length > 0);
    assert.ok(strayAppends(removeIt).length > 0);

    const fencedHeading = [
      '## Repair',
      '',
      'A stray DROP_COLLECTION remains.',
      '',
      '```',
      '# comment',
      '## Not a heading',
      '```',
      '',
      `Run \`${APPEND}\`.`
    ].join('\n');
    assert.ok(sectionAppendHits(fencedHeading).length > 0, 'a heading inside a fence must not reset the section');

    const realSplit = [
      '## Repair',
      '',
      'A stray DROP_COLLECTION remains.',
      '',
      '## Upgrade',
      '',
      '```',
      APPEND,
      '```'
    ].join('\n');
    assert.deepStrictEqual(sectionAppendHits(realSplit), []);

    const topLevel = [
      '# Guide',
      '',
      '## Intro',
      '',
      'DROP_COLLECTION is mentioned here.',
      '',
      '## Upgrade',
      '',
      '```',
      APPEND,
      '```'
    ].join('\n');
    assert.deepStrictEqual(sectionAppendHits(topLevel), []);

    assert.strictEqual(hasRemovalTarget('To revoke the old access, run:'), true);
    assert.strictEqual(hasRemovalTarget('To remove the stray role/access, run:'), true);
    assert.strictEqual(hasRemovalTarget('To undo the privilege, run:'), true);
    assert.strictEqual(hasRemovalTarget('To revert the grant, run:'), true);
    assert.strictEqual(hasRemovalTarget('To disable the privilege, run:'), true);
  });

  test('deleting the sectionAppendHits call fails the suite', () => {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const needle = 'bad.push(...sectionAppendHits(' + 'text))';
    assert.strictEqual(src.split(needle).length - 1, 1);
  });

  test('the role definition matches the documented privilege', () => {
    assert.deepStrictEqual([...DELETE_ALLOWED.error_log], ['REMOVE']);
    assert.ok(atlasPrivileges('emet').includes('REMOVE@emet.error_log'));
    assert.ok(!atlasPrivileges('emet', 'abc_').includes('REMOVE@emet.abc_error_log'));
  });
});

testGroup('no doc grants REMOVE on any other collection', () => {
  const files = walk(ROOT);

  test('the doc set is the one under review', () => {
    const rels = files.map((p) => path.relative(ROOT, p));
    for (const rel of ['README.md', 'CHANGELOG.md', 'docs/SETUP.md', 'docs/GUIDED-SETUP.md', 'docs/DEPLOY.md', 'docs/PERMISSIONS.md', 'scripts/atlas-role.mjs']) {
      assert.ok(rels.includes(rel), rel);
    }
  });

  test('every REMOVE@ privilege is collection-scoped to error_log', () => {
    const bad = [];
    for (const file of files) {
      for (const resource of removeGrants(fs.readFileSync(file, 'utf8'))) {
        if (!/^[^.\s]+\.error_log$/.test(resource)) bad.push(`${path.relative(ROOT, file)}: REMOVE@${resource}`);
      }
    }
    assert.deepStrictEqual(bad, []);
  });

  test('a REMOVE line does not name another collection', () => {
    const bad = [];
    const named = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`);
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/\bREMOVE\b/.test(lines[i])) continue;
        if (named.test(lines[i])) bad.push(`${path.relative(ROOT, file)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
    assert.deepStrictEqual(bad, []);
  });

  test('a privilege table does not give REMOVE to any other collection', () => {
    const bad = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      let inRoleTable = false;
      for (let i = 0; i < lines.length; i++) {
        if (/^\|\s*On\s*\|\s*Allowed\s*\|/.test(lines[i])) { inRoleTable = true; continue; }
        if (inRoleTable && !lines[i].startsWith('|')) { inRoleTable = false; continue; }
        if (!inRoleTable || /^\|\s*-+/.test(lines[i])) continue;
        const row = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(lines[i]);
        if (!row || !/\bREMOVE\b/.test(row[2])) continue;
        if (/error_log/.test(row[1])) continue;
        if (/\bNot\b/.test(row[2])) continue;
        bad.push(`${path.relative(ROOT, file)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
    assert.deepStrictEqual(bad, []);
  });

  test('the role source does not allow REMOVE on a controlled collection', () => {
    const controlled = FORBIDDEN.filter((c) => c !== 'oauth_tokens' && c !== '_emet_verify');
    for (const c of Object.keys(DELETE_ALLOWED)) {
      assert.ok(!controlled.includes(c), c);
      assert.deepStrictEqual([...DELETE_ALLOWED[c]], ['REMOVE']);
    }
    const granted = atlasPrivileges('emet').filter((p) => p.startsWith('REMOVE@')).map((p) => p.slice(p.lastIndexOf('.') + 1));
    assert.deepStrictEqual(granted.sort(), ['_emet_verify', 'emet_oauth_tokens', 'error_log']);
    for (const c of controlled) assert.ok(!granted.includes(c), c);
  });
});

summary('error-log role docs');
