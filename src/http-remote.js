#!/usr/bin/env node
/**
 * EMET remote MCP server — PRODUCTION entry (OAuth-protected).
 * ------------------------------------------------------------------
 * Streamable HTTP transport + full OAuth 2.1 (via the MCP SDK's mcpAuthRouter)
 * guarding /mcp with bearer auth. Shares tools.js and database.js with the
 * stdio entry point - one codebase, two transports.
 *
 * Required env for deploy:
 *   MONGODB_URI               Atlas connection string (scoped user recommended)
 *   PUBLIC_URL                the public https base URL of this host (issuer)
 *   EMET_OAUTH_PASSPHRASE  the consent passphrase (set by the user)
 * Optional:
 *   PORT (default 8849), HOST (default 0.0.0.0), EMET_SOURCE_TAG (e.g. "mobile"),
 *   The server trusts exactly one proxy hop (Railway). TRUST_PROXY is not read.
 *   EMET_CIMD (default on; set 0 to stop advertising Client ID Metadata Document
 *   support and fall back to Dynamic Client Registration only — a rollback that
 *   needs no redeploy; see oauth-provider.js)
 *
 * Configuration comes from the environment, or from a .env file in the repo root.
 * PUBLIC_URL defaults to http://127.0.0.1:PORT for local development.
 */
import './env.js';
import fs from 'fs';
import { setting } from './env.js';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EMET_VERSION } from './version.js';


const db = await import('./database.js');
const t = await import('./tools.js');
const { dispatchTool } = await import('./dispatch.js');
const { MongoOAuthProvider, withCimdMetadata } = await import('./oauth-provider.js');
const { requestLogger } = await import('./request-log.js');
const { securityHeaders } = await import('./security-headers.js');
const { ApproveThrottle } = await import('./approve-throttle.js');
const { StructuredLogger, AuditOperation } = await import('./logger.js');

const PORT = Number(process.env.PORT) || 8849;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const PASSPHRASE = setting('OAUTH_PASSPHRASE') || '';
// One hop only. A larger TRUST_PROXY would let a client spoof req.ip.
const TRUST_PROXY = 1;
const RESOURCE_URL = new URL(PUBLIC_URL + '/mcp');
const PRM_URL = getOAuthProtectedResourceMetadataUrl(RESOURCE_URL);

// This used to be a stub whose debug/info/warn/audit were empty functions, with
// AuditOperation a Proxy returning its own key names. Every audit call on this
// transport - and this is the transport a hosted install runs - was discarded,
// so the server reported an audit trail it did not keep. Both transports now
// construct the same recorder. Output goes to stderr, which the host captures.
const logger = new StructuredLogger({
  serviceName: 'emet',
  version: EMET_VERSION,
  minLevel: process.env.LOG_LEVEL || (process.env.DEBUG === 'true' ? 'debug' : 'info'),
  jsonOutput: process.env.LOG_FORMAT !== 'text',
  auditEnabled: true,
  auditLogPath: setting('AUDIT_LOG') || null
});

const dbManager = new db.EmetDatabase(logger);
const rateLimiter = new t.RateLimiter(logger);

// Over HTTP the source tag is the one bound at approval (auth.extra.sourceTag).
// Stdio still resolves the caller's tag inside saveMemory. A token with no
// bound tag may name a registered tag until it is refreshed; that refresh is
// refused so the next consent binds a tag.

function buildServer() {
  const server = new Server({ name: 'emet', version: EMET_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const { scopesAllow } = await import('./scopes.js');
    const auth = extra && extra.authInfo;
    const scopes = (auth && auth.scopes) || [];
    return { tools: t.TOOLS.filter((tool) => scopesAllow(scopes, tool.name, { http: true, authenticated: Boolean(auth), args: null })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    const { actorStore, personFromAuth } = await import('./persons.js');
    const auth = extra && extra.authInfo;
    const clientId = (auth && auth.clientId) || 'http:visitor';
    const actor = {
      personId: personFromAuth(extra),
      clientId,
      scopes: (auth && auth.scopes) || [],
      transport: 'http',
      sourceTag: (auth && auth.extra && auth.extra.sourceTag) || null,
      authenticated: Boolean(auth)
    };
    const bucket = t.rateBucket(actor);
    const rl = rateLimiter.checkLimit(name, bucket);
    if (!rl.allowed) return actorStore.run(actor, () => t.handleError(new t.RateLimitError(rl.reason, rl.retryAfterMs), name, logger));
    rateLimiter.recordRequest(name, bucket);
    // Every tool call leaves one audit entry (H6). callTool never throws: it
    // returns either a success response or handleError's isError response.
    const t0 = Date.now();
    // Parameter NAMES, never values (the owner, 2026-09-27, code audit 1.6).
    const paramNames = Object.keys(args || {}).sort();
    const result = await actorStore.run(actor, () => callTool(name, args));
    logger.audit(AuditOperation.TOOL_CALL, { tool: name, success: result.isError !== true, durationMs: Date.now() - t0, params: paramNames });
    return result;
  });
  return server;
}

async function callTool(name, args) {
  // One dispatch table for both transports - src/dispatch.js (audit 2026-09-27).
  return dispatchTool(name, args, { dbManager, logger, AuditOperation });
}

const provider = new MongoOAuthProvider(() => dbManager.db, { passphrase: PASSPHRASE, issuerUrl: PUBLIC_URL });
// Failed passphrase attempts per client address (audit finding H4, 2026-09-19).
// The tool-call limiter sits behind bearer auth; this is the one gate in front of it.
const approveThrottle = new ApproveThrottle();

const app = express();
app.set('trust proxy', TRUST_PROXY);

// On every response, including /mcp, the OAuth metadata routes, errors, and
// the consent page. The consent page still sets its own content security policy.
app.use(securityHeaders);

// One redacted line per OAuth/MCP request and per 4xx/5xx anywhere (H4,
// 2026-09-07). EMET_REQUEST_LOG=0 silences it. See request-log.js.
app.use(requestLogger({ enabled: process.env.EMET_REQUEST_LOG !== '0' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'emet', tools: t.TOOLS.length, cimd: provider.cimdEnabled }));

// OAuth 2.1 authorization server + protected-resource metadata:
//   /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/mcp,
//   /register, /authorize, /token, /revoke
const AUTH_OPTIONS = {
  provider,
  issuerUrl: new URL(PUBLIC_URL),
  resourceServerUrl: RESOURCE_URL,
  scopesSupported: ['emet.read', 'emet.write'],
  resourceName: 'EMET Memory',
};

// Authorization-server metadata, served AHEAD of the SDK router so it can carry
// `client_id_metadata_document_supported` (SDK 1.30.0 builds this object
// internally with no option to extend it). Everything else in the document is
// the SDK's own; only the CIMD flag is added, and DCR stays advertised.
const AS_METADATA = withCimdMetadata(createOAuthMetadata(AUTH_OPTIONS), provider.cimdEnabled);
app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(AS_METADATA);
});

app.use(mcpAuthRouter(AUTH_OPTIONS));

// Passphrase approval -> mint authorization code -> redirect back to the client
app.post('/oauth/approve', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { client_id, redirect_uri, code_challenge, state, scopes, resource, passphrase, invite_code } = req.body || {};
    const throttle = approveThrottle.check(req.ip);
    if (!throttle.allowed) {
      res.locals.reason = 'throttled';
      res.status(429).setHeader('Retry-After', String(throttle.retryAfterS));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">Too many attempts. Try again later.</p>');
    }
    let inviteSubject = null;
    let inviteScopes = null;
    let inviteDoor = null;
    let sourceTag = null;
    if (invite_code && String(invite_code).trim()) {
      await dbManager.getConnection('working');
      const { redeemInvite } = await import('./invites.js');
      const redeemed = await redeemInvite(dbManager.db, invite_code);
      if (!redeemed.ok) {
        approveThrottle.recordFailure(req.ip);
        res.locals.reason = 'bad_invite';
        res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">That invite code is not valid. Go back and try again.</p>');
      }
      inviteSubject = redeemed.person_id;
      inviteDoor = redeemed.door === 'member' ? 'member' : 'guest';
      sourceTag = redeemed.source_tag || null;
      // An empty scope list is owner access; a guest must never get it
      // (security audit 2026-09-29).
      const { guestScopesOrNull } = await import('./scopes.js');
      inviteScopes = guestScopesOrNull(redeemed.scopes);
      if (!inviteScopes) {
        res.locals.reason = 'invite_without_scopes';
        res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">That invite grants no access. Ask for a new one.</p>');
      }
    } else if (!provider.checkPassphrase(passphrase || '')) {
      approveThrottle.recordFailure(req.ip);
      res.locals.reason = 'bad_passphrase';
      res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">Incorrect passphrase. Go back and try again.</p>');
    } else {
      const requested = String((req.body && req.body.source) || '').trim();
      const { registeredSourceTags } = await import('./setup.js');
      const registry = registeredSourceTags();
      if (registry.length && !registry.includes(requested)) {
        res.locals.reason = 'bad_source';
        return res.status(400).end('source tag is not registered');
      }
      sourceTag = requested || null;
    }
    const client = await provider.clientsStore.getClient(client_id);
    if (!client) { res.locals.reason = 'unknown_client'; return res.status(400).end('unknown client'); }
    // Same rule the SDK's /authorize applies: exact match, except that loopback
    // redirects (localhost / 127.0.0.1 / [::1]) match with the port ignored, per
    // RFC 8252 §7.3 — Claude Code binds an ephemeral port on every run.
    if (!(client.redirect_uris || []).some((registered) => redirectUriMatches(redirect_uri, registered))) {
      res.locals.reason = 'redirect_uri_not_registered';
      return res.status(400).end('redirect_uri not registered');
    }
    approveThrottle.recordSuccess(req.ip);
    res.locals.reason = client.cimd ? 'approved_cimd' : 'approved_dcr';
    const requestedScopes = inviteScopes || (scopes ? String(scopes).split(' ').filter(Boolean) : []);
    // A passphrase approval with no requested scopes is the owner. Store that
    // as the full-access alias so an empty HTTP scope list never means owner.
    const grantedScopes = inviteSubject ? requestedScopes : (requestedScopes.length ? requestedScopes : ['emet']);
    const code = await provider.createAuthorizationCode({
      client_id, redirect_uri, code_challenge,
      scopes: grantedScopes,
      resource: resource || null,
      subject: inviteSubject || null,
      // The door rides on the token: 'member' for EMET Member Access, 'invite' for EMET Guest Access.
      issued_via: inviteSubject ? (inviteDoor === 'member' ? 'member' : 'invite') : null,
      source_tag: sourceTag,
    });
    const u = new URL(redirect_uri);
    u.searchParams.set('code', code);
    if (state) u.searchParams.set('state', state);
    res.redirect(302, u.href);
  } catch (e) {
    console.error('[emet] approve error', e);
    res.locals.reason = 'approve_error';
    res.status(500).end('approve failed');
  }
});

// Protected MCP endpoint (bearer required -> body parse -> streamable HTTP)
app.post('/mcp', requireBearerAuth({ verifier: provider, resourceMetadataUrl: PRM_URL }), express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { try { transport.close(); } catch {} try { server.close(); } catch {} });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[emet] mcp error', e);
    res.locals.reason = 'mcp_error';
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});

(async () => {
  if (!PASSPHRASE) console.error('[emet] WARNING: EMET_OAUTH_PASSPHRASE unset — all authorization attempts will be rejected.');
  try { await dbManager.ensureClient(); console.error('[emet] Mongo connected'); }
  catch (e) { console.error('[emet] Mongo connect FAILED:', e.message); }
  app.listen(PORT, HOST, () => console.error(`[emet] listening ${PUBLIC_URL} (bind ${HOST}:${PORT}); /mcp OAuth-protected; PRM ${PRM_URL}`));
})();
