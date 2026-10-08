/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Request / auth logging for the HTTP transport (work list H4, 2026-09-07).
 *
 * Why: on 2026-09-07 a connector was added at the wrong URL, the browser
 * authorization ran to completion, the client then POSTed to `/` and got a 404,
 * and the user saw "an error". Railway's logs held three startup lines and
 * nothing else. A server that cannot say what it answered cannot be diagnosed
 * without reproducing the failure by hand - which is what happened.
 *
 * What is logged: one line per request on the OAuth and MCP paths, plus any
 * request anywhere that ends 4xx/5xx (so a POST to a path that does not exist
 * is visible). Fields: method, path, status, latency, client ip, and the
 * identifying-but-not-secret parts of the exchange - client_id (a CIMD URL or
 * an opaque registration id), grant_type, response_type, resource, the JSON-RPC
 * method, tool name and the NAMES of the tool's parameters on /mcp (never their
 * values - added 2026-09-27 so parameter use can be measured), and a reason on failures.
 *
 * What is never logged: request or response bodies, authorization codes,
 * tokens, code verifiers, passphrases, or query strings as a whole. The line
 * is still passed through the redaction scrubber before it is written -
 * belt and braces; a control that depends on the author remembering is a rule.
 */

import { redactText } from './redact.js';

// Paths always logged, whatever the status.
export const LOGGED_PATH = /^\/(?:authorize|token|register|revoke|oauth\/approve|mcp|\.well-known\/[^\s]*)$/;

const CLIP = 160;
const clip = (v) => String(v).slice(0, CLIP);

/** Whether a finished request should produce a log line. */
export function shouldLog(path, statusCode) {
  return LOGGED_PATH.test(path) || statusCode >= 400;
}

/**
 * Builds the log entry for one finished request. Pure: takes the request
 * fields it needs rather than the request object, so it is testable without
 * express. `body` is whatever the parser left on req.body (may be undefined
 * on a 401 that stopped before parsing), `query` is req.query.
 */
export function requestLogEntry({ method, path, statusCode, ms, ip, query = {}, body, wwwAuthenticate, reason }) {
  const entry = { t: new Date().toISOString(), req: `${method} ${path}`, status: statusCode, ms: Math.round(ms) };
  if (ip) entry.ip = ip;

  const q = (query && typeof query === 'object') ? query : {};
  const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};

  const clientId = q.client_id ?? b.client_id;
  if (clientId !== undefined) entry.client = clip(clientId);
  if (b.grant_type) entry.grant = clip(b.grant_type);
  if (q.response_type) entry.response_type = clip(q.response_type);
  const resource = q.resource ?? b.resource;
  if (resource !== undefined && resource !== null && resource !== '') entry.resource = clip(resource);
  if (q.redirect_uri ?? b.redirect_uri) {
    try { entry.redirect_host = new URL(q.redirect_uri ?? b.redirect_uri).host; } catch { entry.redirect_host = 'invalid'; }
  }

  if (path === '/mcp') {
    if (Array.isArray(body)) entry.rpc = `batch(${body.length})`;
    else if (b.method) {
      entry.rpc = clip(b.method);
      if (b.method === 'tools/call' && b.params && b.params.name) {
        entry.tool = clip(b.params.name);
        // Parameter NAMES only (the owner, 2026-09-27, code audit 1.6) - values never.
        const a = b.params.arguments;
        if (a && typeof a === 'object' && !Array.isArray(a)) entry.params = Object.keys(a).sort().map(clip);
      }
    }
  }

  if (reason) entry.reason = clip(reason);
  else if (statusCode === 401 && wwwAuthenticate) {
    const m = String(wwwAuthenticate).match(/error="([^"]+)"/);
    if (m) entry.reason = m[1];
  }

  return entry;
}

/** The rendered line. Scrubbed even though nothing secret should be in it. */
export function formatRequestLog(entry) {
  return '[emet][req] ' + redactText(JSON.stringify(entry));
}

/**
 * Express middleware. Installed before the auth router so it sees every
 * request; logs on `finish`, when the status and any parsed body are known.
 */
export function requestLogger({ enabled = true, write = (line) => console.error(line) } = {}) {
  return function emetRequestLog(req, res, next) {
    if (!enabled) return next();
    const t0 = process.hrtime.bigint();
    // Capture the path NOW. The SDK's auth router mounts /authorize, /token,
    // /register and the well-known documents as sub-routers, and express
    // strips the mount prefix from req.path while a sub-router is handling
    // the request - at `finish` it can read as '/' with status 200, which the
    // filter would then skip. Found live on the first deploy (2026-09-07): the
    // /.well-known line was the one missing from the log.
    const path = String(req.originalUrl || req.url || '/').split('?')[0] || '/';
    res.on('finish', () => {
      try {
        if (!shouldLog(path, res.statusCode)) return;
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const entry = requestLogEntry({
          method: req.method, path, statusCode: res.statusCode, ms, ip: req.ip,
          query: req.query, body: req.body,
          wwwAuthenticate: res.getHeader && res.getHeader('www-authenticate'),
          reason: res.locals && res.locals.reason
        });
        write(formatRequestLog(entry));
      } catch (e) {
        write('[emet][req] log failed: ' + (e && e.message));
      }
    });
    next();
  };
}
