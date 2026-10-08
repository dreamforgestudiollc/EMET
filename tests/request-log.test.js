/**
 * EMET - request/auth logging tests (work list H4).
 *
 * The regression these guard against is silence: a failed authorization that
 * leaves no line, or a line that carries a secret. Both directions are tested -
 * what must appear, and what must never appear.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { shouldLog, requestLogEntry, formatRequestLog, requestLogger, LOGGED_PATH } from '../src/request-log.js';
import { MASK } from '../src/redact.js';


testGroup('What gets a line', () => {
  test('OAuth and MCP paths are always logged', () => {
    for (const p of ['/authorize', '/token', '/register', '/revoke', '/oauth/approve', '/mcp', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
      assert.ok(shouldLog(p, 200), p);
    }
  });
  test('a 404 anywhere is logged - the root-URL mistake of 2026-09-07 becomes visible', () => {
    assert.ok(shouldLog('/', 404));
    assert.ok(shouldLog('/anything', 500));
  });
  test('/health and other successful unrelated paths are not logged', () => {
    assert.ok(!shouldLog('/health', 200));
    assert.ok(!shouldLog('/', 200));
  });
  test('LOGGED_PATH does not match by prefix alone', () => {
    assert.ok(!LOGGED_PATH.test('/mcpx'));
    assert.ok(!LOGGED_PATH.test('/tokens'));
  });
});

testGroup('What the line carries', () => {
  test('an /authorize request carries client_id, response_type, resource, redirect host', () => {
    const e = requestLogEntry({ method: 'GET', path: '/authorize', statusCode: 200, ms: 12.6, ip: '1.2.3.4',
      query: { client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', response_type: 'code', resource: 'https://x.example/mcp', redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', state: 'abc' } });
    assert.strictEqual(e.req, 'GET /authorize');
    assert.strictEqual(e.status, 200);
    assert.strictEqual(e.ms, 13);
    assert.strictEqual(e.client, 'https://claude.ai/oauth/mcp-oauth-client-metadata');
    assert.strictEqual(e.response_type, 'code');
    assert.strictEqual(e.resource, 'https://x.example/mcp');
    assert.strictEqual(e.redirect_host, 'claude.ai');
    assert.ok(!('code_challenge' in e) && !('state' in e), 'code_challenge and state are not logged');
  });
  test('a /token request carries grant_type and client_id but never the code, verifier or tokens', () => {
    const e = requestLogEntry({ method: 'POST', path: '/token', statusCode: 200, ms: 40,
      body: { grant_type: 'authorization_code', client_id: 'abc123', code: 'SECRETCODE', code_verifier: 'SECRETVERIFIER', refresh_token: 'SECRETRT' } });
    assert.strictEqual(e.grant, 'authorization_code');
    assert.strictEqual(e.client, 'abc123');
    const line = formatRequestLog(e);
    assert.ok(!line.includes('SECRETCODE') && !line.includes('SECRETVERIFIER') && !line.includes('SECRETRT'));
  });
  test('an /oauth/approve request never carries the passphrase, and carries the handler reason', () => {
    const e = requestLogEntry({ method: 'POST', path: '/oauth/approve', statusCode: 401, ms: 3,
      body: { client_id: 'c1', passphrase: 'TopSecretPhrase!' }, reason: 'bad_passphrase' });
    assert.strictEqual(e.reason, 'bad_passphrase');
    assert.ok(!formatRequestLog(e).includes('TopSecretPhrase'));
  });
  test('an /mcp call carries the JSON-RPC method and tool name, not the arguments', () => {
    const e = requestLogEntry({ method: 'POST', path: '/mcp', statusCode: 200, ms: 120,
      body: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'save_to_layer', arguments: { content: 'PRIVATE CONTENT' } } } });
    assert.strictEqual(e.rpc, 'tools/call');
    assert.strictEqual(e.tool, 'save_to_layer');
    assert.ok(!formatRequestLog(e).includes('PRIVATE CONTENT'));
  });
  // 2026-09-27 (code audit 1.6, the owner): parameter NAMES are logged so their use can be measured; values never.
  test('an /mcp tool call carries the parameter names, sorted, and none of the values', () => {
    const e = requestLogEntry({ method: 'POST', path: '/mcp', statusCode: 200, ms: 5,
      body: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'save_to_layer', arguments: { metadata: { source: 'SECRET-HOST' }, content: 'PRIVATE CONTENT', layer: 'working' } } } });
    assert.deepStrictEqual(e.params, ['content', 'layer', 'metadata']);
    const line = formatRequestLog(e);
    assert.ok(!line.includes('PRIVATE CONTENT') && !line.includes('SECRET-HOST') && !line.includes('working'), line);
  });
  test('a tool call with no arguments object carries no params field', () => {
    const e = requestLogEntry({ method: 'POST', path: '/mcp', statusCode: 200, ms: 5,
      body: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'emet_status' } } });
    assert.strictEqual('params' in e, false);
  });
  test('a batched /mcp body is summarised by count', () => {
    const e = requestLogEntry({ method: 'POST', path: '/mcp', statusCode: 200, ms: 1, body: [{ method: 'a' }, { method: 'b' }] });
    assert.strictEqual(e.rpc, 'batch(2)');
  });
  test('a 401 on /mcp takes its reason from WWW-Authenticate when the handler set none', () => {
    const e = requestLogEntry({ method: 'POST', path: '/mcp', statusCode: 401, ms: 1,
      wwwAuthenticate: 'Bearer error="invalid_token", error_description="Missing Authorization header"' });
    assert.strictEqual(e.reason, 'invalid_token');
    assert.ok(!('rpc' in e), 'no body was parsed before the 401');
  });
  test('an invalid redirect_uri is reported, not thrown', () => {
    const e = requestLogEntry({ method: 'GET', path: '/authorize', statusCode: 400, ms: 1, query: { redirect_uri: 'not a url' } });
    assert.strictEqual(e.redirect_host, 'invalid');
  });
  test('values are clipped so a hostile query cannot flood the log', () => {
    const e = requestLogEntry({ method: 'GET', path: '/authorize', statusCode: 400, ms: 1, query: { client_id: 'x'.repeat(5000) } });
    assert.ok(e.client.length <= 160);
  });
});

testGroup('The rendered line is scrubbed regardless', () => {
  test('a secret that reaches the entry by any route is masked in the line', () => {
    const e = requestLogEntry({ method: 'GET', path: '/authorize', statusCode: 400, ms: 1,
      query: { client_id: 'mongodb+srv://u:LeakedPass123@h.example/db' } });
    const line = formatRequestLog(e);
    assert.ok(line.startsWith('[emet][req] {'));
    assert.ok(line.includes(`mongodb+srv://${MASK}:${MASK}@h.example/db`));
    assert.ok(!line.includes('LeakedPass123'));
  });
});

testGroup('The middleware', () => {
  function fakeReqRes({ method = 'POST', path = '/', statusCode = 404, body, query = {}, headers = {} } = {}) {
    const handlers = {};
    const res = {
      statusCode, locals: {},
      on(ev, fn) { handlers[ev] = fn; },
      getHeader(name) { return headers[name.toLowerCase()]; },
      finish() { handlers.finish && handlers.finish(); }
    };
    const req = { method, path, url: path, ip: '9.9.9.9', body, query };
    return { req, res };
  }
  test('logs a 404 POST to the root - the exact failure of 2026-09-07', () => {
    const lines = [];
    const mw = requestLogger({ write: (l) => lines.push(l) });
    const { req, res } = fakeReqRes({ method: 'POST', path: '/', statusCode: 404 });
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    res.finish();
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('"req":"POST /"') && lines[0].includes('"status":404'));
  });
  test('uses the ORIGINAL url, so a sub-router that strips the mount path cannot hide /authorize', () => {
    const lines = [];
    const mw = requestLogger({ write: (l) => lines.push(l) });
    const { req, res } = fakeReqRes({ method: 'GET', path: '/', statusCode: 200, query: { client_id: 'c1' } });
    req.originalUrl = '/authorize?client_id=c1&state=s';   // what express leaves after a mounted router ran
    req.path = '/'; req.url = '/?client_id=c1&state=s';
    mw(req, res, () => {});
    res.finish();
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('"req":"GET /authorize"'), lines[0]);
    assert.ok(!lines[0].includes('state=s'), 'the query string is not logged');
  });
  test('is silent on a successful /health', () => {
    const lines = [];
    const mw = requestLogger({ write: (l) => lines.push(l) });
    const { req, res } = fakeReqRes({ method: 'GET', path: '/health', statusCode: 200 });
    mw(req, res, () => {});
    res.finish();
    assert.strictEqual(lines.length, 0);
  });
  test('can be disabled', () => {
    const lines = [];
    const mw = requestLogger({ enabled: false, write: (l) => lines.push(l) });
    const { req, res } = fakeReqRes({ method: 'POST', path: '/mcp', statusCode: 401 });
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    res.finish();
    assert.ok(nextCalled);
    assert.strictEqual(lines.length, 0);
  });
  test('a logging failure never breaks the request', () => {
    const lines = [];
    const mw = requestLogger({ write: (l) => lines.push(l) });
    const { req, res } = fakeReqRes({ method: 'POST', path: '/mcp', statusCode: 500 });
    res.getHeader = () => { throw new Error('boom'); };
    mw(req, res, () => {});
    res.finish();
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('log failed'));
  });
});

summary('Request Log Test Summary');
