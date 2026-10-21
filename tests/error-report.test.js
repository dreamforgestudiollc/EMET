/**
 * Owner-only error report: no network, a mailto that fits, and a structured
 * email a calling assistant can hand to its own mail tool.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actorStore } from '../src/persons.js';
import { EMET_VERSION } from '../src/version.js';
import { ERROR_CODES } from '../src/error-codes.js';
import { useMemoryErrorLog, recordError, flushErrorLog } from '../src/error-log.js';
import {
  SEND_INSTRUCTION, DEFAULT_REPORT_EMAIL, reportEmailAddress,
  composeErrorReport, runErrorReport, fitReportEmail, plainReportAddress
} from '../src/error-report.js';
import { privateWordsIn } from './scrub-tokens.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = useMemoryErrorLog();
const priorEmail = process.env.EMET_REPORT_EMAIL;

function peopleDb(person) {
  return { collection() { return { findOne: async () => person }; } };
}

function restoreEmail() {
  if (priorEmail === undefined) delete process.env.EMET_REPORT_EMAIL;
  else process.env.EMET_REPORT_EMAIL = priorEmail;
}

function decodeMailto(link) {
  const url = new URL(link);
  return url.searchParams.get('body').replace(/\r\n/g, '\n');
}

function asStdio(fn) {
  return actorStore.run({ transport: 'stdio' }, fn);
}

const NET_MODULE = /^(node:)?(net|tls|dns|http|https|child_process|dgram|nodemailer)$/;

function stripJs(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth > 0) out += src[i];
            i++;
          }
          continue;
        }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function networkFindings(src) {
  const findings = [];
  for (const match of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    if (NET_MODULE.test(match[1])) findings.push(`import ${match[1]}`);
  }
  if (/\bimport\s*\(/.test(src)) findings.push('dynamic import');
  for (const match of src.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (NET_MODULE.test(match[1])) findings.push(`require ${match[1]}`);
  }
  if (/\[\s*['"]fetch['"]\s*\]/.test(src) || /\bfetch\b/.test(stripJs(src))) findings.push('fetch');
  if (/nodemailer|createTransport|\bsmtp\b|http\.request|https\.request|net\.connect/.test(src)) {
    findings.push('mail or socket call');
  }
  return findings;
}

const CLOSURE_ROOTS = ['error-report.js', 'error-log.js', 'error-codes.js', 'redact.js'];
const CLOSURE_NETWORK = [
  'gem-check.js import node:child_process',
  'mongo-connect.js import dns'
];

function localImportSpecs(src) {
  const specs = [];
  for (const re of [
    /from\s+['"](\.[^'"]+)['"]/g,
    /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /(?:^|[;\n])\s*import\s+['"](\.[^'"]+)['"]/g
  ]) {
    for (const match of src.matchAll(re)) specs.push(match[1]);
  }
  return specs;
}

function resolveLocal(fromFile, spec) {
  let rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  if (!path.posix.extname(rel)) rel += '.js';
  return rel;
}

function networkSpecHits(file, src) {
  const hits = [];
  const note = (kind, spec) => {
    if (NET_MODULE.test(spec)) hits.push(`${path.posix.basename(file)} ${kind} ${spec}`);
  };
  for (const match of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) note('import', match[1]);
  for (const match of src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) note('import', match[1]);
  for (const match of src.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) note('require', match[1]);
  for (const match of src.matchAll(/(?:^|[;\n])\s*import\s+['"]([^'"]+)['"]/g)) note('import', match[1]);
  return hits;
}

function mentionsFetch(src) {
  let i = 0;
  let expectRegex = true;
  let found = false;
  const identChar = (c) => /[A-Za-z0-9_$]/.test(c);
  const space = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const regexAfter = new Set(['return', 'throw', 'case', 'void', 'typeof', 'delete', 'await', 'yield', 'do', 'else', 'in', 'of', 'instanceof', 'new', 'extends', 'debugger']);

  function scanRegex() {
    i++;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') return;
      if (c === '[' && !inClass) inClass = true;
      else if (c === ']' && inClass) inClass = false;
      else if (c === '/' && !inClass) { i++; break; }
      else i++;
    }
    while (i < src.length && /[dgimsuy]/i.test(src[i])) i++;
  }

  function scanString(quote) {
    i++;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        scanBlock(true);
        continue;
      }
      if (src[i] === quote) { i++; return; }
      if (src[i] === '\n' && quote !== '`') return;
      i++;
    }
  }

  function scanBlock(inExpr) {
    let depth = inExpr ? 1 : 0;
    while (i < src.length) {
      const c = src[i];
      const next = src[i + 1];
      if (c === '/' && next === '/') { i += 2; while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && next === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(src.length, i + 2);
        continue;
      }
      if (space(c)) { i++; continue; }
      if (c === '/' && expectRegex) { scanRegex(); expectRegex = false; continue; }
      if (c === '"' || c === "'" || c === '`') { scanString(c); expectRegex = false; continue; }
      if (inExpr && c === '}') {
        depth--;
        i++;
        if (depth === 0) { expectRegex = false; return; }
        expectRegex = true;
        continue;
      }
      if (c === '{') {
        if (inExpr) depth++;
        expectRegex = true;
        i++;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        const start = i;
        i++;
        while (i < src.length && identChar(src[i])) i++;
        const word = src.slice(start, i);
        if (word === 'fetch') found = true;
        expectRegex = regexAfter.has(word);
        continue;
      }
      if (c >= '0' && c <= '9') {
        i++;
        while (i < src.length && /[0-9a-fA-FxXoObBn_.]/.test(src[i])) i++;
        expectRegex = false;
        continue;
      }
      if (c === '[') {
        let j = i + 1;
        while (j < src.length && space(src[j])) j++;
        const q = src[j];
        if ((q === '"' || q === "'") && src.startsWith('fetch', j + 1) && src[j + 6] === q) {
          let k = j + 7;
          while (k < src.length && space(src[k])) k++;
          if (src[k] === ']') found = true;
        }
        expectRegex = true;
        i++;
        continue;
      }
      if (c === ')' || c === ']') { expectRegex = false; i++; continue; }
      if (c === '/') { expectRegex = true; i++; continue; }
      if ('(,=;!&|?+-*%^~<>:'.includes(c)) { expectRegex = true; i++; continue; }
      if (c === '}') { expectRegex = true; i++; continue; }
      if (c === '.' && next === '.' && src[i + 2] === '.') { i += 3; expectRegex = true; continue; }
      expectRegex = false;
      i++;
    }
  }

  scanBlock(false);
  return found;
}

function closureNetworkHits(read, roots) {
  const seen = new Set();
  const hits = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = read(file);
    if (src == null) {
      hits.push(`missing ${file}`);
      return;
    }
    hits.push(...networkSpecHits(file, src));
    if (mentionsFetch(src)) hits.push(`${path.posix.basename(file)} fetch`);
    for (const spec of localImportSpecs(src)) walk(resolveLocal(file, spec));
  };
  for (const root of roots) walk(root);
  return hits.sort();
}

testGroup('error report', () => {
  test('a guest is refused and a local owner is not', async () => {
    delete process.env.EMET_REPORT_EMAIL;
    store.entries.length = 0;
    await assert.rejects(
      () => actorStore.run({ transport: 'http', personId: 'guest-1' }, () => runErrorReport({}, peopleDb({ person_id: 'guest-1', role: 'guest' }))),
      (err) => {
        assert.strictEqual(err.emetCode, 'EMET-AUTH-038');
        assert.strictEqual(err.message, 'The error report is owner-only.');
        return true;
      }
    );
    await assert.rejects(
      () => actorStore.run({ transport: 'http', personId: 'guest-1' }, () => runErrorReport({}, null)),
      (err) => err.emetCode === 'EMET-AUTH-038'
    );
    const owned = await actorStore.run(
      { transport: 'http', personId: 'owner-1' },
      () => runErrorReport({}, peopleDb({ person_id: 'owner-1', role: 'owner' }))
    );
    assert.match(owned.report, /^EMET error report /);
    const local = await asStdio(() => runErrorReport({}));
    assert.match(local.report, /^EMET error report /);
    assert.strictEqual(store.entries.length, 0);
  });

  test('a caller with no transport and no person id is not the owner', async () => {
    delete process.env.EMET_REPORT_EMAIL;
    store.entries.length = 0;
    await assert.rejects(
      () => runErrorReport({}),
      (err) => {
        assert.strictEqual(err.emetCode, 'EMET-AUTH-038');
        assert.strictEqual(err.message, 'The error report is owner-only.');
        return true;
      }
    );
    await recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: '0123456789abcdef'
    });
    await actorStore.run({ transport: 'stdio' }, () => recordError({
      emet_code: 'EMET-INT-001', class_code: 'INTERNAL_ERROR', tool: 'recall', correlation_id: 'fedcba9876543210'
    }));
    await flushErrorLog();
    const unidentified = store.entries.find((row) => row.correlation_id === '0123456789abcdef');
    const local = store.entries.find((row) => row.correlation_id === 'fedcba9876543210');
    assert.strictEqual(unidentified.role, 'guest');
    assert.strictEqual(local.role, 'owner');
  });

  test('the structured email is the shown report, redacted, with no content fields', async () => {
    delete process.env.EMET_REPORT_EMAIL;
    store.entries.length = 0;
    store.entries.push({
      t: '2026-10-20T12:00:00.000Z',
      emet_code: 'EMET-VAL-005',
      class_code: 'VALIDATION_ERROR',
      tool: 'recall',
      version: EMET_VERSION,
      transport: 'stdio',
      caller: 'token: emet_tok_abcdefghijklmnopqrstuvwxyz',
      role: 'owner',
      correlation_id: '0123456789abcdef',
      count: 1,
      content: 'SENTINEL_CONTENT',
      message: 'Query is required SENTINEL_CONTENT ada@example.com Ada Lovelace Finances',
      arguments: { query: 'SENTINEL_CONTENT' },
      memory: 'SENTINEL_CONTENT',
      document: 'SENTINEL_CONTENT',
      doc_id: 'SENTINEL_CONTENT',
      title: 'SENTINEL_CONTENT'
    });
    try {
      const result = await asStdio(() => runErrorReport({ include_messages: true }));
      assert.strictEqual(result.instruction, SEND_INSTRUCTION);
      assert.ok(result.instruction.includes('getting their OK'));
      assert.ok(!result.report.includes('getting their OK'));
      assert.strictEqual(result.email.body_text, result.report);
      assert.strictEqual(result.email.body, result.email.body_text);
      assert.strictEqual(result.email.to, DEFAULT_REPORT_EMAIL);
      assert.strictEqual(result.email.version, EMET_VERSION);
      assert.match(result.email.short_id, /^[0-9a-f]{6}$/);
      assert.strictEqual(result.email.subject, `EMET error report ${EMET_VERSION} ${result.email.short_id}`);
      assert.strictEqual(result.email.truncated, false);
      assert.strictEqual(decodeMailto(result.email.mailto), result.email.body);
      const banned = ['content', 'message', 'arguments', 'memory', 'document', 'doc_id', 'title', 'include_messages'];
      for (const key of banned) assert.ok(!(key in result.email), key);
      const raw = JSON.stringify(result);
      assert.ok(!raw.includes('SENTINEL'));
      assert.ok(!raw.includes('emet_tok_'));
      assert.ok(!raw.split(DEFAULT_REPORT_EMAIL).join('').includes('example.com'));
      assert.ok(!raw.includes('Ada'));
      assert.ok(!raw.includes('Finances'));
      assert.ok(!raw.includes('Query is required SENTINEL'));
      assert.ok(raw.includes('Query is required'));
      assert.ok(result.report.includes('*****'));
      assert.match(result.report, /Does not contain: memory, documents, arguments, names, tokens\./);
    } finally {
      restoreEmail();
    }
  });

  test('an empty EMET_REPORT_EMAIL returns the report and no email', async () => {
    process.env.EMET_REPORT_EMAIL = '';
    store.entries.length = 0;
    try {
      const result = await asStdio(() => runErrorReport({}));
      assert.strictEqual(result.email, null);
      assert.match(result.report, /^EMET error report /);
      assert.strictEqual(result.instruction, SEND_INSTRUCTION);
      assert.ok(!JSON.stringify(result).includes('mailto:'));
    } finally {
      restoreEmail();
    }
  });

  test('a correlation id is found even when since would exclude it', async () => {
    delete process.env.EMET_REPORT_EMAIL;
    store.entries.length = 0;
    store.entries.push({
      t: '2020-01-01T00:00:00.000Z',
      emet_code: 'EMET-INT-001',
      tool: 'recall',
      transport: 'stdio',
      caller: 'unregistered',
      role: 'owner',
      correlation_id: 'aaaaaaaaaaaaaaaa',
      count: 1
    });
    try {
      const result = await asStdio(() => runErrorReport({ correlation_id: 'aaaaaaaaaaaaaaaa', since: '2020-01-01' }));
      assert.match(result.report, /aaaaaaaaaaaaaaaa/);
      assert.match(result.report, /EMET-INT-001/);
    } finally {
      restoreEmail();
    }
  });

  test('the mailto link stays within 1800 characters and decodes', () => {
    delete process.env.EMET_REPORT_EMAIL;
    const codes = Object.keys(ERROR_CODES);
    assert.strictEqual(Math.max(...codes.map((code) => code.length)), 13);
    const caller = `registeredhosttag${'a'.repeat(40)}`;
    const rows = [];
    for (let i = 0; i < 200; i++) {
      rows.push({
        t: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - i * 1000).toISOString(),
        emet_code: 'EMET-TOOL-013',
        tool: 'emet_error_report',
        transport: 'http',
        caller,
        role: 'owner',
        correlation_id: i.toString(16).padStart(16, '0')
      });
    }
    const now = new Date('2026-10-20T12:00:00.000Z');
    const fitted = composeErrorReport(rows, { since: rows[rows.length - 1].t, now, shortId: '3f9a1c', limit: 200 });
    assert.ok(fitted.email.mailto.length <= 1800, fitted.email.mailto.length);
    assert.ok(fitted.email.truncated);
    assert.ok(fitted.email.entries_in_link < 200);
    assert.strictEqual(fitted.email.body_text, fitted.report);
    assert.ok(fitted.report.length > fitted.email.body.length);
    assert.ok(fitted.email.mailto.includes('%20'));
    assert.ok(fitted.email.mailto.includes('%0D%0A'));
    const decoded = decodeMailto(fitted.email.mailto);
    assert.strictEqual(decoded, fitted.email.body);
    assert.match(decoded, /^EMET error report /);
    assert.match(decoded, /Truncated:/);

    const many = codes.slice(0, 200).map((code, i) => ({
      t: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - i * 1000).toISOString(),
      emet_code: code,
      tool: 'recall',
      transport: 'http',
      caller,
      role: 'guest',
      correlation_id: (i + 1).toString(16).padStart(16, 'b')
    }));
    const wide = composeErrorReport(many, { since: many[many.length - 1].t, now, shortId: '3f9a1c', limit: 200 });
    assert.ok(wide.email.mailto.length <= 1800, wide.email.mailto.length);
    assert.strictEqual(decodeMailto(wide.email.mailto), wide.email.body);
    assert.strictEqual(wide.email.body_text, wide.report);
    assert.ok(wide.report.includes(codes[199]));
    restoreEmail();
  });

  test('a long address stays within 1800 characters or has no mailto link', async () => {
    process.env.EMET_REPORT_EMAIL = `${'a'.repeat(2400)}@example.com`;
    store.entries.length = 0;
    try {
      const result = await asStdio(() => runErrorReport({}));
      const link = result.email && result.email.mailto;
      assert.ok(link == null || link.length <= 1800, link && link.length);
      if (link == null) {
        assert.strictEqual(result.email.mailto, null);
        assert.strictEqual(result.email.reason, 'The mailto link would exceed 1800 characters.');
      }
    } finally {
      restoreEmail();
    }
  });

  test('the default report address is the project inbox and EMET_REPORT_EMAIL overrides it', async () => {
    assert.strictEqual(DEFAULT_REPORT_EMAIL, 'dreamforgestudio@mail.grokbot.com');
    assert.strictEqual(plainReportAddress(DEFAULT_REPORT_EMAIL), true);
    assert.deepStrictEqual(privateWordsIn(DEFAULT_REPORT_EMAIL), []);
    const label = DEFAULT_REPORT_EMAIL.split('@')[1].split('.')[1];
    assert.deepStrictEqual(privateWordsIn(label), [label]);
    store.entries.length = 0;
    try {
      delete process.env.EMET_REPORT_EMAIL;
      assert.strictEqual(reportEmailAddress(), DEFAULT_REPORT_EMAIL);
      const unset = await asStdio(() => runErrorReport({}));
      assert.strictEqual(unset.email.to, 'dreamforgestudio@mail.grokbot.com');
      assert.ok(unset.email.mailto.startsWith('mailto:dreamforgestudio@mail.grokbot.com?'));
      assert.ok(!JSON.stringify(unset).includes('email":null'));
      process.env.EMET_REPORT_EMAIL = 'reports@example.com';
      assert.strictEqual(reportEmailAddress(), 'reports@example.com');
      const overridden = await asStdio(() => runErrorReport({}));
      assert.strictEqual(overridden.email.to, 'reports@example.com');
      assert.ok(overridden.email.mailto.startsWith('mailto:reports@example.com?'));
      assert.notStrictEqual(overridden.email.to, DEFAULT_REPORT_EMAIL);
    } finally {
      restoreEmail();
    }
  });

  test('each bad address has one @ and one defect, and yields no email', async () => {
    const cases = [
      ['<', 'k<@x.com'],
      ['>', 'k>@x.com'],
      [' ', 'k @x.com'],
      ['#', 'k@x.com#frag'],
      ['?', 'k@x.com?bcc'],
      ['&', 'k@x.com&x'],
      [',', 'a@x.com,b'],
      ['%', 'k%@x.com'],
      ['\r', 'k@x.com\r'],
      ['\n', 'k@x.com\n'],
      ['"', 'k"@x.com'],
      ['display name', 'Alex <k@x.com>'],
      ['no dot', 'k@xcom']
    ];
    store.entries.length = 0;
    try {
      for (const [form, address] of cases) {
        assert.strictEqual(address.split('@').length, 2, form);
        assert.strictEqual(plainReportAddress(address), false, form);
        if (form === 'display name') {
          const inner = address.slice(address.indexOf('<') + 1, address.indexOf('>'));
          assert.strictEqual(plainReportAddress(inner), true, form);
        } else if (form === 'no dot') {
          const [local, domain] = address.split('@');
          assert.ok(!domain.includes('.'), form);
          assert.strictEqual(plainReportAddress(`${local}@${domain[0]}.${domain.slice(1)}`), true, form);
        } else {
          assert.strictEqual(plainReportAddress(address.split(form).join('')), true, JSON.stringify(form));
        }
        process.env.EMET_REPORT_EMAIL = address;
        const result = await asStdio(() => runErrorReport({}));
        assert.strictEqual(result.email, null, JSON.stringify(form));
        assert.ok(!JSON.stringify(result).includes('mailto:'), JSON.stringify(form));
      }
    } finally {
      restoreEmail();
    }
  });

  test('a mailto of 1800 characters is kept and 1801 is not', () => {
    const to = 'a@b.co';
    const subject = 'S';
    const fit = (caller) => fitReportEmail({
      to,
      subject,
      base: {
        version: '0.3.0',
        shortId: 'abcdef',
        generated: '2026-10-20T00:00:00Z',
        windowStart: '2026-10-20',
        windowEnd: '2026-10-20',
        nodeVersion: '22.0.0',
        totals: [],
        recent: [{
          t: '2026-10-20T00:00:00Z',
          emet_code: 'EMET-VAL-008',
          tool: 'recall',
          transport: 'stdio',
          caller,
          role: 'guest',
          correlation_id: '0123456789abcdef'
        }]
      }
    });
    const linkLength = (body) => {
      const text = String(body).replace(/\r?\n/g, '\r\n');
      return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`.length;
    };
    let exact = null;
    let pad = 0;
    for (; pad < 4000; pad++) {
      const fitted = fit('a'.repeat(pad));
      if (fitted.mailto && fitted.mailto.length === 1800 && fitted.truncated === false) {
        exact = fitted;
        break;
      }
    }
    assert.ok(exact, 'no untruncated mailto of 1800 characters');
    assert.strictEqual(linkLength(exact.report), 1800);
    assert.strictEqual(exact.mailto.length, 1800);

    const over = fit('a'.repeat(pad + 1));
    assert.strictEqual(linkLength(over.report), 1801);
    assert.ok(over.mailto == null || over.mailto.length <= 1800, over.mailto && over.mailto.length);
    assert.ok(over.truncated === true || over.mailto == null);

    const encoded = fit(`${'a'.repeat(pad - 1)}é`);
    assert.strictEqual(encoded.report.length, exact.report.length);
    assert.strictEqual(encodeURIComponent('é'), '%C3%A9');
    assert.ok(linkLength(encoded.report) > 1800);
    assert.ok(encoded.mailto == null || encoded.mailto.length <= 1800, encoded.mailto && encoded.mailto.length);
  });

  test('every mailto return path stays within 1800 characters', () => {
    const subject = 'S';
    const stamp = {
      version: '0.3.0',
      shortId: 'abcdef',
      generated: '2026-10-20T00:00:00Z',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-20',
      nodeVersion: '22.0.0'
    };
    const entry = (caller, i) => ({
      t: '2026-10-20T00:00:00Z',
      emet_code: 'EMET-VAL-008',
      tool: 'recall',
      transport: 'stdio',
      caller,
      role: 'guest',
      correlation_id: (i + 1).toString(16).padStart(16, '0')
    });
    const total = (i, summary) => ({
      emet_code: `EMET-VAL-${String((i % 46) + 1).padStart(3, '0')}`,
      summary,
      count: i + 1,
      tool: 'recall'
    });
    const pathOf = (result) => {
      if (result.mailto == null) return 'null';
      if (result.truncated === false) return 'full';
      if (result.entries_in_link > 0) return 'recent';
      if (result.body.includes('showing none') || result.body.includes('totals omit')) return 'totals';
      return 'minimal';
    };
    const seen = new Set();
    const sweep = (counts, caller, totals) => {
      for (const count of counts) {
        const recent = Array.from({ length: count }, (_, i) => entry(caller, i));
        for (let length = 8; length <= 1280; length += 1) {
          const to = `${'a'.repeat(length - 4)}@x.co`;
          const result = fitReportEmail({ to, subject, base: { ...stamp, totals, recent } });
          const taken = pathOf(result);
          seen.add(taken);
          if (result.mailto != null) {
            assert.ok(result.mailto.length <= 1800, `${taken} ${result.mailto.length} address ${length} entries ${count}`);
          }
        }
      }
    };
    sweep([0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24], 'tag', []);
    sweep([0, 1, 2, 3, 4], 'm'.repeat(80), Array.from({ length: 6 }, (_, i) => total(i, 'summary')));
    sweep([1, 2, 3], 'M'.repeat(240), Array.from({ length: 4 }, (_, i) => total(i, 'line '.repeat(12))));
    sweep([1], 'L'.repeat(700), Array.from({ length: 8 }, (_, i) => total(i, `total ${i}`)));
    for (const taken of ['full', 'recent', 'totals', 'minimal']) {
      assert.ok(seen.has(taken), `missed ${taken}; saw ${[...seen].sort().join(', ')}`);
    }
  });

  test('the report, log, registry, and redaction modules import no network or mail library', () => {
    const probes = [
      "const send = fetch; send('https://example.invalid')",
      "import { fetch as send } from 'node:undici';",
      "const { fetch: send } = globalThis;",
      "globalThis['fetch']('https://example.invalid')",
      "await import('node:net')",
      "await import('tls')",
      "const name = 'node:dns'; await import(name)",
      "require('node:http')",
      "require('https')",
      "require('child_process')",
      "require('node:child_process')",
      "require('dns')",
      "require('node:tls')"
    ];
    for (const probe of probes) assert.ok(networkFindings(probe).length > 0, probe);
    const safe = 'import { queryErrorLog } from "./error-log.js";\nconst row = { summary: "CIMD fetch rate limit" };';
    assert.deepStrictEqual(networkFindings(safe), []);
    for (const file of CLOSURE_ROOTS) {
      const src = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
      assert.deepStrictEqual(networkFindings(src), [], `${file} ${networkFindings(src).join(', ')}`);
    }
    const readSrc = (file) => {
      const abs = path.resolve(path.join(ROOT, 'src'), file);
      return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    };
    assert.deepStrictEqual(closureNetworkHits(readSrc, CLOSURE_ROOTS), CLOSURE_NETWORK);
    const virtual = new Map([
      ['error-report.js', "import { EMET_VERSION } from './version.js';\n"],
      ['version.js', "import https from 'node:https';\nexport const EMET_VERSION = '0.3.0';\n"]
    ]);
    const httpsHit = closureNetworkHits((file) => virtual.get(file) ?? null, ['error-report.js']);
    assert.deepStrictEqual(httpsHit, ['version.js import node:https']);
    const fetchSeen = [
      ["fetch('https://example.invalid')", true],
      ['const send = fetch;', true],
      ["obj.fetch('https://example.invalid')", true],
      ["globalThis['fetch']('https://example.invalid')", true],
      ["const s = `${fetch('https://example.invalid')}`;", true],
      ["const s = `fetch('https://example.invalid')`;", false],
      ['this._fetch(url)', false],
      ["const s = 'fetch(https://example.invalid)';", false],
      ["// fetch('https://example.invalid')\nconst a = 1;", false],
      ["if (word('fetch')) network = true;", false],
      ['const re = /fetch\\(/;', false],
      ['a / /fetch(/', false]
    ];
    for (const [probe, expected] of fetchSeen) assert.strictEqual(mentionsFetch(probe), expected, probe);
    const gemSrc = fs.readFileSync(path.join(ROOT, 'src', 'gem-check.js'), 'utf8');
    const gemLine = "if (word('fetch') || word('WebSocket') || word('XMLHttpRequest')) network = true;";
    const gemCall = gemSrc.replace(gemLine, `${gemLine}\n    fetch('https://example.invalid');`);
    assert.notStrictEqual(gemCall, gemSrc);
    assert.strictEqual(mentionsFetch(gemSrc), false);
    assert.strictEqual(mentionsFetch(gemCall), true);
    const fetchVirtual = new Map([
      ['error-report.js', "import { EMET_VERSION } from './version.js';\n"],
      ['version.js', "export const EMET_VERSION = '0.3.0';\nfetch('https://example.invalid');\n"]
    ]);
    const fetchHit = closureNetworkHits((file) => fetchVirtual.get(file) ?? null, ['error-report.js']);
    assert.deepStrictEqual(fetchHit, ['version.js fetch']);
  });

  test('a truncated mailto of 1800 characters is kept', () => {
    const subject = 'S';
    const stamp = {
      version: '0.3.0',
      shortId: 'abcdef',
      generated: '2026-10-20T00:00:00Z',
      windowStart: '2026-10-20',
      windowEnd: '2026-10-20',
      nodeVersion: '22.0.0'
    };
    const entry = (caller, i) => ({
      t: '2026-10-20T00:00:00Z',
      emet_code: 'EMET-VAL-008',
      tool: 'recall',
      transport: 'stdio',
      caller,
      role: 'guest',
      correlation_id: (i + 1).toString(16).padStart(16, '0')
    });
    const total = (i, summary) => ({
      emet_code: `EMET-VAL-${String(i + 1).padStart(3, '0')}`,
      summary,
      count: 10 - i,
      tool: 'recall'
    });
    const kind = (result) => {
      if (result.mailto == null) return 'null';
      if (result.truncated === false) return 'full';
      if (result.entries_in_link > 0) return 'recent';
      if (result.body.includes('showing none') || result.body.includes('totals omit')) return 'totals';
      return 'minimal';
    };
    const find = (name, build) => {
      for (let n = 1; n <= 1600; n++) {
        const result = build(n);
        if (result.mailto && result.mailto.length === 1800 && kind(result) === name) return result;
      }
      return null;
    };
    const recent = find('recent', (n) => fitReportEmail({
      to: 'a@b.co',
      subject,
      base: { ...stamp, totals: [], recent: [entry('a'.repeat(n), 0), entry('a'.repeat(n), 1)] }
    }));
    const totals = find('totals', (n) => fitReportEmail({
      to: `${'a'.repeat(n)}@b.co`,
      subject,
      base: {
        ...stamp,
        totals: [total(0, 'alpha-summary'), total(1, 'beta-summary-long')],
        recent: [entry('R'.repeat(400), 0)]
      }
    }));
    const minimal = find('minimal', (n) => fitReportEmail({
      to: `${'b'.repeat(n)}@b.co`,
      subject,
      base: {
        ...stamp,
        totals: [total(0, 'T'.repeat(400))],
        recent: [entry('R'.repeat(400), 0)]
      }
    }));
    assert.ok(recent, 'recent');
    assert.strictEqual(recent.mailto.length, 1800);
    assert.strictEqual(recent.truncated, true);
    assert.strictEqual(recent.entries_in_link, 1);
    assert.ok(recent.body.includes('0000000000000001'));
    assert.ok(!recent.body.includes('0000000000000002'));
    assert.ok(totals, 'totals');
    assert.strictEqual(totals.mailto.length, 1800);
    assert.strictEqual(totals.entries_in_link, 0);
    assert.ok(totals.body.includes('EMET-VAL-001'));
    assert.ok(totals.body.includes('EMET-VAL-002'));
    assert.ok(minimal, 'minimal');
    assert.strictEqual(minimal.mailto.length, 1800);
    assert.ok(minimal.body.includes('Truncated: the full report is in the tool output above.'));
    assert.ok(!minimal.body.includes('showing none'));
    assert.ok(!minimal.body.includes('totals omit'));
  });

  test('an address with a dot or hyphen in the wrong place yields no email', async () => {
    const odd = [
      ['k@-x.com', 'k@x.com'],
      ['k@x-.com', 'k@x.com'],
      ['k@x..com', 'k@x.com'],
      ['.k@x.com', 'k@x.com'],
      ['k.@x.com', 'k@x.com'],
      ['k@x.com.', 'k@x.com']
    ];
    const still = ['k.a@x.com', 'k+a@x.com', 'k_a@x.com', 'k-a@x.com', 'a@b.co'];
    store.entries.length = 0;
    try {
      for (const address of still) assert.strictEqual(plainReportAddress(address), true, address);
      process.env.EMET_REPORT_EMAIL = 'k.a@x.com';
      const kept = await asStdio(() => runErrorReport({}));
      assert.strictEqual(kept.email.to, 'k.a@x.com');
      assert.ok(kept.email.mailto.startsWith('mailto:k.a@x.com?'));
      for (const [address, repaired] of odd) {
        assert.strictEqual(address.split('@').length, 2, address);
        assert.strictEqual(plainReportAddress(address), false, address);
        assert.strictEqual(plainReportAddress(repaired), true, address);
        process.env.EMET_REPORT_EMAIL = address;
        const result = await asStdio(() => runErrorReport({}));
        assert.strictEqual(result.email, null, address);
        assert.ok(!JSON.stringify(result).includes('mailto:'), address);
      }
    } finally {
      restoreEmail();
    }
  });
});

summary('Error report');
