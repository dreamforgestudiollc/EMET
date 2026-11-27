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
import { owlRetirementFailureLine } from './grants.js';
import { EMET_VERSION } from './version.js';


const db = await import('./database.js');
const t = await import('./tools.js');
const { dispatchTool } = await import('./dispatch.js');
const { MongoOAuthProvider, withCimdMetadata, revokeTokensForKey } = await import('./oauth-provider.js');
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
    const { runeToolList } = await import('./rune-registry.js');
    const tools = [...t.TOOLS, ...runeToolList()];
    return { tools: tools.filter((tool) => scopesAllow(scopes, tool.name, { http: true, authenticated: Boolean(auth), args: null })) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    const { actorStore, httpToolActor } = await import('./persons.js');
    const actor = httpToolActor(extra);
    const bucket = t.rateBucket(actor);
    const rl = rateLimiter.checkLimit(name, bucket);
    if (!rl.allowed) return actorStore.run(actor, () => t.handleError(new t.RateLimitError(rl.reason, rl.retryAfterMs), name, logger));
    rateLimiter.recordRequest(name, bucket);
    // Every tool call leaves one audit entry (H6). callTool never throws: it
    // returns either a success response or handleError's isError response.
    const t0 = Date.now();
    // Parameter NAMES, never values (the owner, 2026-09-27, code audit 1.6).
    const paramNames = Object.keys(args || {}).sort();
    try {
      const att = await import('./attribution.js');
      const { resolveTokenSubject } = await import('./persons.js');
      actor.ownerId = await resolveTokenSubject(dbManager.db).catch(() => null);
      await actorStore.run(actor, () => att.preflight({
        db: dbManager.db, prefix: provider.prefix, ownerId: actor.ownerId,
        deps: {
          ...t.approvalsDeps,
          endConsents: (keyId) => revokeTokensForKey(dbManager.db, provider.prefix, keyId)
        },
        layerCollections: ['episodic', 'semantic', 'procedural', 'meta', 'identity', 'working'].map((l) => { try { return dbManager.collectionFor(l); } catch { return null; } }).filter(Boolean),
        registry: t.sourceRegistry()
      }, actor, args, name));
    } catch (e) {
      const { preflightHttpCode } = await import('./subkey-lifecycle.js');
      const code = preflightHttpCode(e);
      if (code === 'EMET-SESS-014') {
        const { ValidationError } = await import('./validation.js');
        const err = new ValidationError('session_handle', e.message, { code: 'EMET-SESS-014' });
        const response = await actorStore.run(actor, () => t.handleError(err, name, logger));
        return attachSubkeyNotice(response, e.subkeyHold);
      }
      if (e && e.attributionRefusal) {
        const { ValidationError } = await import('./validation.js');
        const mapped = e.emetCode === 'EMET-AUTH-044' || e.emetCode === 'EMET-AUTH-046' ? e.emetCode : 'EMET-AUTH-039';
        const err = new ValidationError('source', e.message, { code: mapped });
        if (e.chooser) err.chooser = e.chooser;
        return actorStore.run(actor, () => t.handleError(err, name, logger));
      }
      throw e;
    }
    const result = await actorStore.run(actor, () => callTool(name, args));
    const noted = actor && actor.subkeyRenewal ? attachSubkeyNotice(result, actor.subkeyRenewal) : result;
    const { toolCallAuditDetails } = await import('./grants.js');
    logger.audit(AuditOperation.TOOL_CALL, toolCallAuditDetails(actor, { tool: name, success: noted.isError !== true, durationMs: Date.now() - t0, params: paramNames }));
    return noted;
  });
  return server;
}

/** Put a renewal or wrap-up notice on a tool result. The tool body is unchanged when it is not JSON. */
function attachSubkeyNotice(result, notice) {
  if (!notice || !result || !Array.isArray(result.content) || !result.content[0] || typeof result.content[0].text !== 'string') return result;
  try {
    const data = JSON.parse(result.content[0].text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return result;
    data.session_renewal = notice;
    if (notice.wrap_up_notice && !data.wrap_up_notice) data.wrap_up_notice = notice.wrap_up_notice;
    result.content[0].text = JSON.stringify(data);
  } catch { /* a non-JSON tool body stays as the tool wrote it */ }
  return result;
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

app.get('/statechart', async (_req, res) => {
  const { statechartBody } = await import('./access-statechart.js');
  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>EMET statechart</title></head><body>${statechartBody()}</body></html>`);
});

// Chooser, break-glass, and the retired owner-approvals pointer. The passphrase
// and the per-address lockout are the same ones /oauth/approve uses. A member
// or guest grant is not a session. Sub-key tools still follow EMET_SUBKEYS;
// the human pages stay mounted either way so a refusal link has somewhere to open.
{
  const { setChooserPublicUrl, breakGlassStartupLine } = await import('./deep-links.js');
  const { rotateStartupLine } = await import('./rotate.js');
  const { createOwnerGate } = await import('./owner-session.js');
  const { mountChooser } = await import('./chooser.js');
  const { mountBreakGlass } = await import('./break-glass.js');
  const { mountOwnerApprovals } = await import('./owner-approvals.js');
  const { mountAdminPassword } = await import('./admin-password-page.js');
  const { verifyAdminPassword, adminPasswordIsSet, setAdminPasswordRotatedHook } = await import('./admin-password.js');
  const { deleteOwnerConsoleSessions } = await import('./oauth-provider.js');
  const { resolveTokenSubject } = await import('./persons.js');
  setChooserPublicUrl(PUBLIC_URL);
  const human = {
    checkPassphrase: (input) => provider.checkPassphrase(input),
    throttle: approveThrottle,
    deps: t.approvalsDeps,
    ownerId: () => resolveTokenSubject(dbManager.db),
    db: () => dbManager.db,
    prefix: provider.prefix,
    provider,
    rateLimiter,
    logger
  };
  human.checkAdminPassword = (input) => verifyAdminPassword(dbManager.db, input);
  human.gate = createOwnerGate(human);
  app.use(async (req, res, next) => {
    const pathName = req.path || '';
    const settings = pathName === '/owner/chooser' || pathName.startsWith('/owner/chooser/')
      || pathName === '/owner/break-glass' || pathName.startsWith('/owner/break-glass/')
      || pathName === '/owner/approvals' || pathName.startsWith('/owner/approvals/');
    if (!settings) return next();
    if (req.query && typeof req.query.d === 'string' && req.query.d) return next();
    if (human.gate.sessionOf(req)) return next();
    try {
      if (!await adminPasswordIsSet(dbManager.db)) {
        res.redirect(303, '/owner/admin-password');
        return;
      }
    } catch (err) {
      next(err);
      return;
    }
    next();
  });
  setAdminPasswordRotatedHook((db) => deleteOwnerConsoleSessions(db, provider.prefix));
  mountAdminPassword(app, human);
  mountChooser(app, human);
  mountBreakGlass(app, human);
  mountOwnerApprovals(app, human);
  app.locals.breakGlassStartupLine = breakGlassStartupLine;
  app.locals.rotateStartupLine = rotateStartupLine;
}

// OAuth 2.1 authorization server + protected-resource metadata:
//   /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/mcp,
//   /register, /authorize, /token, /revoke
const AUTH_OPTIONS = {
  provider,
  issuerUrl: new URL(PUBLIC_URL),
  resourceServerUrl: RESOURCE_URL,
  scopesSupported: ['emet.read', 'emet.write', 'emet.console'],
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
    const postedSource = String((req.body && req.body.source) || '').trim();
    const postedKey = String((req.body && req.body.subkey) || '').trim();
    const wantsInvite = Boolean(invite_code && String(invite_code).trim());
    const { CONSOLE_SCOPE, consoleAudience, parseDeviceKey, deviceIdForKey } = await import('./console-session.js');
    const scopeList = scopes ? String(scopes).split(' ').filter(Boolean) : [];
    const consoleScope = scopeList.includes(CONSOLE_SCOPE);
    const consoleOwner = consoleScope && !wantsInvite && !postedKey;
    let keySignIn = null;
    if (wantsInvite) {
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
    } else if (postedKey && String(passphrase || '').trim()) {
      if (!provider.checkPassphrase(passphrase || '')) {
        approveThrottle.recordFailure(req.ip);
        res.locals.reason = 'bad_passphrase';
        res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">The connect passphrase does not match. Nothing was granted.</p>');
      }
      keySignIn = 'secondary';
    } else if (postedKey) {
      keySignIn = 'key';
    } else if (!consoleOwner && !provider.checkPassphrase(passphrase || '')) {
      approveThrottle.recordFailure(req.ip);
      res.locals.reason = 'bad_passphrase';
      res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">Incorrect passphrase. Go back and try again.</p>');
    } else if (!consoleOwner) {
      const requested = postedSource;
      const { registeredSourceTags } = await import('./setup.js');
      const registry = registeredSourceTags();
      if (requested && registry.length && !registry.includes(requested)) {
        res.locals.reason = 'bad_source';
        return res.status(400).end('source tag is not registered');
      }
      const { isLegacyBoundHostSpelling } = await import('./bound-door.js');
      if (isLegacyBoundHostSpelling(requested)) {
        res.locals.reason = 'legacy_bound_tag';
        return res.status(400).end('use bound-host (EMET-AUTH-045)');
      }
      sourceTag = requested || 'owner';
    }
    const { isOwlIdentity } = await import('./owl.js');
    if (isOwlIdentity(client_id) || isOwlIdentity(sourceTag)) {
      res.locals.reason = 'owl_retired';
      res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">This owl MCP clone account was retired by R6. the owner decides a new writer on /owner/chooser. Nothing was granted.</p>');
    }
    const client = await provider.clientsStore.getClient(client_id);
    if (!client) { res.locals.reason = 'unknown_client'; return res.status(400).end('unknown client'); }
    if (isOwlIdentity(client)) {
      res.locals.reason = 'owl_retired';
      res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">This owl MCP clone account was retired by R6. the owner decides a new writer on /owner/chooser. Nothing was granted.</p>');
    }
    // Same rule the SDK's /authorize applies: exact match, except that loopback
    // redirects (localhost / 127.0.0.1 / [::1]) match with the port ignored, per
    // RFC 8252 §7.3 — Claude Code binds an ephemeral port on every run.
    if (!(client.redirect_uris || []).some((registered) => redirectUriMatches(redirect_uri, registered))) {
      res.locals.reason = 'redirect_uri_not_registered';
      return res.status(400).end('redirect_uri not registered');
    }
    if (consoleScope && (scopeList.length !== 1 || wantsInvite)) {
      res.locals.reason = 'console_scope';
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">The console asks only for emet.console. Nothing was granted.</p>');
    }
    if (consoleOwner) {
      const { verifyAdminPassword, adminPasswordIsSet, adminPasswordVersion, ADMIN_PASSWORD_URL } = await import('./admin-password.js');
      const postedPassword = String((req.body && req.body.password) || '');
      const postedPassphrase = String(passphrase || '');
      if (!(await adminPasswordIsSet(dbManager.db))) {
        res.locals.reason = 'admin_password_unset';
        res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(`<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">The admin password is not set. Set it at <a href="${ADMIN_PASSWORD_URL}">${ADMIN_PASSWORD_URL}</a>. The connect passphrase does not open the console. Nothing was granted.</p>`);
      }
      if (postedPassphrase && !postedPassword) {
        approveThrottle.recordFailure(req.ip);
        res.locals.reason = 'console_passphrase';
        res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">The connect passphrase does not open the console. Use the admin password. Nothing was granted.</p>');
      }
      const passwordOk = await verifyAdminPassword(dbManager.db, postedPassword);
      if (!passwordOk && provider.checkPassphrase(postedPassword)) {
        approveThrottle.recordFailure(req.ip);
        res.locals.reason = 'console_passphrase';
        res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">The connect passphrase does not open the console. Use the admin password. Nothing was granted.</p>');
      }
      if (!passwordOk) {
        approveThrottle.recordFailure(req.ip);
        res.locals.reason = 'bad_admin_password';
        res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">The admin password does not match. Nothing was granted.</p>');
      }
      const remember = String((req.body && req.body.remember) || '') === '1';
      const deviceKey = remember ? parseDeviceKey(String((req.body && req.body.device_key) || '')) : null;
      if (remember && !deviceKey) {
        res.locals.reason = 'console_device_key';
        res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">Remember this phone needs the device key from the console. Nothing was granted.</p>');
      }
      approveThrottle.recordSuccess(req.ip);
      res.locals.reason = 'approved_console';
      const version = await adminPasswordVersion(dbManager.db);
      const ownerCode = await provider.issueConsoleOwnerCode({
        client_id, redirect_uri, code_challenge,
        resource: consoleAudience(PUBLIC_URL),
        admin_password_version: version,
        remember,
        device_public_key: deviceKey,
        device_id: deviceKey ? deviceIdForKey(deviceKey) : null
      });
      const ownerUrl = new URL(redirect_uri);
      ownerUrl.searchParams.set('code', ownerCode);
      if (state) ownerUrl.searchParams.set('state', state);
      return res.redirect(302, ownerUrl.href);
    }
    if (keySignIn) {
      try {
        const { verifyPresentedKey } = await import('./subkeys.js');
        const { issueKeyLogin } = await import('./key-door.js');
        const { registeredSourceTags } = await import('./setup.js');
        const { approvalsDeps } = await import('./tools.js');
        const verified = await verifyPresentedKey(approvalsDeps, {
          token: postedKey,
          tag: postedSource,
          registry: registeredSourceTags()
        });
        if (isOwlIdentity(verified.tag)) {
          res.locals.reason = 'owl_retired';
          res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">This owl MCP clone account was retired by R6. the owner decides a new writer on /owner/chooser. Nothing was granted.</p>');
        }
        const remember = consoleScope && String((req.body && req.body.remember) || '') === '1';
        const deviceKey = remember ? parseDeviceKey(String((req.body && req.body.device_key) || '')) : null;
        if (consoleScope && remember && !deviceKey) {
          res.locals.reason = 'console_device_key';
          res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end('<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">Remember this phone needs the device key from the console. Nothing was granted.</p>');
        }
        approveThrottle.recordSuccess(req.ip);
        res.locals.reason = keySignIn === 'secondary' ? 'approved_secondary' : 'approved_key';
        const keyCode = await issueKeyLogin(provider, {
          client_id,
          redirect_uri,
          code_challenge,
          resource: consoleScope ? consoleAudience(PUBLIC_URL) : (resource || null),
          role: keySignIn === 'secondary' ? 'secondary' : 'key',
          tag: verified.tag,
          key_id: verified.key_id,
          ...(consoleScope ? {
            scopes: [CONSOLE_SCOPE],
            console_grant: {
              remember,
              device_public_key: deviceKey,
              device_id: deviceKey ? deviceIdForKey(deviceKey) : null,
              admin_password_version: null
            }
          } : {})
        });
        const keyUrl = new URL(redirect_uri);
        keyUrl.searchParams.set('code', keyCode);
        if (state) keyUrl.searchParams.set('state', state);
        return res.redirect(302, keyUrl.href);
      } catch (err) {
        approveThrottle.recordFailure(req.ip);
        res.locals.reason = 'key_refused';
        const message = err && err.message ? String(err.message) : 'This key was refused. Nothing was granted.';
        const safe = message.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(`<p style="font-family:system-ui;background:#12141a;color:#e8e6e0;padding:24px">${safe}</p>`);
      }
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
      // The door rides on the token: 'member', 'invite' (guest), or 'owner' (passphrase).
      issued_via: inviteSubject ? (inviteDoor === 'member' ? 'member' : 'invite') : 'owner',
      source_tag: sourceTag,
    });
    if (sourceTag) {
      const { recordBoundHostCredential, CLAIM_TAG } = await import('./bound-door.js');
      // A new consent lists the door only for the current tag. The previous
      // spelling is refused above, before a token is issued.
      if (sourceTag === CLAIM_TAG) {
        try {
          const door = inviteSubject ? (inviteDoor === 'member' ? 'member' : 'guest') : 'owner';
          await recordBoundHostCredential(t.approvalsDeps, { client_id, door, grant_id: null, by: 'consent' });
        } catch {
          console.error('[emet] bound door listing was not written');
        }
      }
    }
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

const { mountConsole, consoleTokenOnMcp } = await import('./console-api.js');
const { AuditOperation: consoleAudit } = await import('./logger.js');
mountConsole(app, {
  provider,
  db: () => dbManager.db,
  dbManager,
  publicUrl: PUBLIC_URL,
  dispatchTool,
  AuditOperation: consoleAudit,
  throttle: approveThrottle
});

// Protected MCP endpoint (bearer required -> body parse -> streamable HTTP)
app.post('/mcp', requireBearerAuth({ verifier: provider, resourceMetadataUrl: PRM_URL }), express.json({ limit: '256kb' }), async (req, res) => {
  try {
    if (consoleTokenOnMcp(req.auth)) {
      res.locals.reason = 'console_token';
      res.status(401).json({ error: 'invalid_token', emet_code: 'EMET-AUTH-024', message: 'A console token cannot call /mcp.' });
      return;
    }
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

export { app, dbManager };

// EMET_HTTP_LISTEN=0 lets a test import this module and POST /oauth/approve
// without binding the production port. Production does not set it.
if (process.env.EMET_HTTP_LISTEN !== '0') (async () => {
  if (!PASSPHRASE) console.error('[emet] WARNING: EMET_OAUTH_PASSPHRASE unset — all authorization attempts will be rejected.');
  try { await dbManager.ensureClient(); console.error('[emet] Mongo connected'); }
  catch (e) { console.error('[emet] Mongo connect FAILED:', e.message); }
  try {
    if (dbManager.db) {
      const { runStartupChecks } = await import('./owl.js');
      await runStartupChecks(dbManager.db, { prefix: provider.prefix, log: (line) => console.error(line) });
    }
  } catch {
    console.error(owlRetirementFailureLine());
  }
  try {
    const { proofStartupLine } = await import('./proof-run.js');
    console.error(proofStartupLine());
  } catch {
    console.error('[emet] proof-run status=not_run rung=R7');
  }
  try {
    const { seatGems } = await import('./socket.js');
    const seated = await seatGems({ log: logger });
    // The structured line keeps the id in the middle of a JSON object. This
    // line ends with the id so the image boot can anchor it.
    for (const row of seated.gems_available || []) {
      if (row.loadable) console.error(`GEM seated: ${row.id}`);
    }
  }
  catch (e) { console.error('[emet] GEM socket failed closed'); }
  app.listen(PORT, HOST, () => {
    console.error(`[emet] listening ${PUBLIC_URL} (bind ${HOST}:${PORT}); /mcp OAuth-protected; PRM ${PRM_URL}`);
    console.error(app.locals.breakGlassStartupLine());
    console.error(app.locals.rotateStartupLine());
  });
  import('./subkeys.js').then((m) => m.startFlagOffSweep((msg) => console.error(`[emet] ${msg}`))).catch(() => console.error('[emet] sub-key flag-off sweep failed'));
  import('./subkeys.js').then((m) => m.startStrandedSweep((msg) => console.error(`[emet] ${msg}`), dbManager)).catch(() => console.error('[emet] sub-key sweep failed'));
  import('./error-log.js').then((m) => m.startErrorLogRotation()).catch(() => {});
})();
