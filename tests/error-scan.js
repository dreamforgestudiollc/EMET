/**
 * Reads throw sites and the returned error strings the error-code snapshot locks.
 * Not a suite (the runner only executes *.test.js).
 */
import fs from 'node:fs';
import path from 'node:path';

function scanString(src, i, q) {
  if (q !== '`') {
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === q) return i + 1;
      i++;
    }
    return i;
  }
  let expr = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (expr === 0 && c === '`') return i + 1;
    if (expr === 0 && c === '$' && src[i + 1] === '{') { expr = 1; i += 2; continue; }
    if (expr > 0) {
      if (c === '{') expr++;
      else if (c === '}') { expr--; i++; continue; }
      else if (c === '"' || c === "'" || c === '`') { i = scanString(src, i + 1, c); continue; }
    }
    i++;
  }
  return i;
}

function matchParen(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = scanString(src, i + 1, c); continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n + 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  throw new Error(`unbalanced paren at ${openIdx}`);
}

export function stripCodedThrow(statement) {
  let text = statement.trim();
  const wrapped = text.match(/^throw\s+assignCode\(/);
  if (wrapped) {
    const open = text.indexOf('(');
    const close = matchParen(text, open);
    const inner = text.slice(open + 1, close);
    const codeAt = inner.lastIndexOf(", 'EMET-");
    const call = codeAt >= 0 ? inner.slice(0, codeAt).trim() : inner.trim();
    text = `throw ${call}`;
  }
  text = text.replace(/throw\s+new\s+CodedError\(/, 'throw new Error(');
  text = text.replace(/,\s*\{\s*code:\s*'EMET-[A-Z]{2,5}-\d{3}'\s*\}/g, '');
  return text.replace(/\s+/g, ' ').trim();
}

export function throwStatements(src) {
  const out = [];
  const re = /throw\s+(?:new\s+[A-Za-z0-9_]+\s*\(|assignCode\s*\()/g;
  let match;
  while ((match = re.exec(src))) {
    const open = src.indexOf('(', match.index);
    const close = matchParen(src, open);
    const text = src.slice(match.index, close + 1);
    const line = src.slice(0, match.index).split('\n').length;
    out.push({ line, className: (text.match(/new\s+([A-Za-z0-9_]+)/) || [])[1] || '', text, stripped: stripCodedThrow(text) });
    re.lastIndex = close + 1;
  }
  return out;
}

const RETURNED_FILES = new Set(['floor.js', 'dispatch.js', 'session-graph.js', 'validation.js']);

export function returnedErrorTexts(file, src) {
  if (!RETURNED_FILES.has(file)) return [];
  const out = [];
  if (file === 'validation.js' && src.includes("error: 'ValidationError'")) out.push("error: 'ValidationError'");
  const re = /error:\s*(`(?:\\`|[^`])*`|'(?:\\'|[^'])*')/g;
  let match;
  while ((match = re.exec(src))) {
    if (match[1] === "'ValidationError'") continue;
    out.push(`error: ${match[1]}`);
  }
  return out;
}

export function codedThrowSites(root) {
  const dir = path.join(root, 'src');
  const out = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const row of throwStatements(src)) {
      if (row.className === 'ScanRefuse') continue;
      const codes = [...row.text.matchAll(/'(EMET-[A-Z]{2,5}-\d{3})'/g)].map((match) => match[1]);
      out.push({ file, message: row.stripped, code: codes.length === 1 ? codes[0] : codes.join('+') });
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.message.localeCompare(b.message) || a.code.localeCompare(b.code));
  return out;
}

export function scanSource(root) {
  const dir = path.join(root, 'src');
  const throws = [];
  const returned = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const row of throwStatements(src)) {
      if (row.className === 'ScanRefuse') continue;
      throws.push(`${file} ${row.stripped}`);
    }
    for (const text of returnedErrorTexts(file, src)) returned.push(`${file} ${text}`);
  }
  return { throws, returned };
}
