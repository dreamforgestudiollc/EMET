#!/usr/bin/env node

/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Derived from CASCADE Memory System
 * Copyright (c) 2025-2026 CIPS Corp (C.I.P.S. LLC)
 * Licensed under the MIT License - see LICENSE
 *
 * https://github.com/For-Sunny/cascade-memory-enterprise
 *
 * MCP Server - 6-Layer Structured Memory Architecture
 *
 * REFACTORED: January 22, 2026
 * Split into modular architecture:
 * - database.js: Connection pool, schema, dual-write pattern
 * - tools.js: Tool definitions and handlers
 * - index.js: Thin entry point (this file)
 *
 * DUAL-WRITE Architecture:
 * - RAM disk for instant reads
 * - READ: RAM first (instant) -> Disk fallback
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { setting } from './env.js';
import { redactText } from './redact.js';
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from 'events';
import fs from 'fs';

// Import validation module
import {
  ValidationError,
  VALID_LAYERS,
  CONTENT_LIMITS,
  NUMERIC_LIMITS
} from './validation.js';

// Import database module
import {
  EmetDatabase,
  EmetError,
  DatabaseError,
  ConfigurationError,
  ErrorCodes,
  StatusCodes,
  DEBUG,
  MEMORY_LAYERS,
  sanitizeErrorMessage,
  sanitizeDetails
} from './database.js';

import { dispatchTool } from './dispatch.js';
// Import tools module (the per-tool handlers are reached through dispatch.js)
import {
  TOOLS,
  RateLimiter,
  rateBucket,
  RateLimitError,
  RATE_LIMIT_CONFIG,
  handleError,
  createSuccessResponse,
  getStatus
} from './tools.js';

// ============================================
// STRUCTURED LOGGING SYSTEM
// ============================================

// Extracted to ./logger.js on 2026-09-13 so the HTTP transport uses the same
// recorder instead of a stub. See that file for why.
import { LogLevel, AuditOperation, StructuredLogger } from './logger.js';
import { EMET_VERSION } from './version.js';

// ============================================
// INITIALIZATION
// ============================================

// Initialize logger
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.DEBUG === 'true' ? 'debug' : 'info');
const AUDIT_LOG_PATH = setting('AUDIT_LOG') || null;

const logger = new StructuredLogger({
  serviceName: 'emet',
  version: EMET_VERSION,
  minLevel: LOG_LEVEL,
  jsonOutput: process.env.LOG_FORMAT !== 'text',
  auditEnabled: true,
  auditLogPath: AUDIT_LOG_PATH
});

// Initialize database manager with dual-write paths
const dbManager = new EmetDatabase(logger);

// Initialize rate limiter
const rateLimiter = new RateLimiter(logger);

// ============================================
// MCP SERVER
// ============================================

/**
 * Initialize MCP Server
 */
const server = new Server(
  {
    name: "emet",
    version: EMET_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

/**
 * Handle tool calls with rate limiting and centralized error handling
 */
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const { actorStore, personFromAuth } = await import('./persons.js');
  const auth = extra && extra.authInfo;
  const actor = {
    personId: personFromAuth(extra),
    clientId: auth ? (auth.clientId || 'http:visitor') : 'stdio',
    scopes: (auth && auth.scopes) || [],
    transport: auth ? 'http' : 'stdio',
    authenticated: Boolean(auth)
  };
  const bucket = rateBucket(actor);

  // Rate limit check, per subject and client. Stdio is one bucket per process.
  const rateLimitCheck = rateLimiter.checkLimit(name, bucket);

  if (!rateLimitCheck.allowed) {
    logger.audit(AuditOperation.RATE_LIMIT_HIT, {
      tool: name,
      reason: rateLimitCheck.reason,
      retryAfterMs: rateLimitCheck.retryAfterMs,
      currentStatus: rateLimiter.getStatus(bucket)
    });

    logger.warn('Rate limit exceeded', {
      tool: name,
      reason: rateLimitCheck.reason,
      retryAfterMs: rateLimitCheck.retryAfterMs
    });

    const rateLimitError = new RateLimitError(rateLimitCheck.reason, rateLimitCheck.retryAfterMs);
    return actorStore.run(actor, () => handleError(rateLimitError, name, logger));
  }

  rateLimiter.recordRequest(name, bucket);

  // Every tool call leaves one audit entry (H6, 2026-09-19). callTool never
  // throws: it returns either a success response or handleError's response.
  const t0 = Date.now();
  // Parameter NAMES, never values (the owner, 2026-09-27, code audit 1.6): the next
  // audit can measure which parameters hosts use; nothing a host sent is stored.
  const paramNames = Object.keys(args || {}).sort();
  const result = await actorStore.run(actor, () => callTool(name, args));
  logger.audit(AuditOperation.TOOL_CALL, { tool: name, success: result.isError !== true, durationMs: Date.now() - t0, params: paramNames });
  return result;
});

async function callTool(name, args) {
  // One dispatch table for both transports - src/dispatch.js (audit 2026-09-27).
  return dispatchTool(name, args, { dbManager, logger, AuditOperation });
}

// ============================================
// SERVER STARTUP
// ============================================

/**
 * Start server
 */
async function main() {
  const startTime = Date.now();

  logger.info('============================================');
  logger.info(`EMET Memory MCP Server v${EMET_VERSION}`);
  logger.info('============================================');

  logger.info('Server configuration loaded', {
    debugMode: DEBUG,
    logLevel: LOG_LEVEL,
    auditLogPath: AUDIT_LOG_PATH
  });

  logger.info('Validation configuration', {
    maxContentLength: CONTENT_LIMITS.MAX_CONTENT_LENGTH,
    maxQueryLength: CONTENT_LIMITS.MAX_QUERY_LENGTH,
    validLayers: VALID_LAYERS,
    limitRange: `${NUMERIC_LIMITS.MIN_LIMIT}-${NUMERIC_LIMITS.MAX_LIMIT}`
  });

  logger.info('Rate limiting configuration', {
    globalLimit: RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS,
    globalWindowMs: RATE_LIMIT_CONFIG.GLOBAL_WINDOW_MS,
    toolLimits: RATE_LIMIT_CONFIG.TOOL_MAX_REQUESTS,
    cleanupIntervalMs: RATE_LIMIT_CONFIG.CLEANUP_INTERVAL_MS
  });

  logger.info('Logging configuration', {
    sessionId: logger.sessionId,
    logLevel: LOG_LEVEL,
    jsonOutput: logger.jsonOutput,
    auditEnabled: logger.auditEnabled,
    auditLogPath: AUDIT_LOG_PATH
  });

  // Connect stdio transport immediately so MCP handshake completes before DB init
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Initialize all databases
  const initializedLayers = [];
  const failedLayers = [];

  for (const layer of Object.keys(MEMORY_LAYERS)) {
    try {
      await dbManager.getConnection(layer);
      initializedLayers.push(layer);

      logger.audit(AuditOperation.CONNECTION_OPEN, {
        layer,
        success: true
      });
    } catch (e) {
      failedLayers.push({ layer, error: e.message });
      logger.error('Failed to initialize layer', {
        layer,
        error: e
      });

      logger.audit(AuditOperation.CONNECTION_OPEN, {
        layer,
        success: false,
        errorMessage: e.message
      });
    }
  }

  const startupDurationMs = Date.now() - startTime;

  logger.audit(AuditOperation.SERVER_START, {
    initializedLayers,
    failedLayers: failedLayers.length > 0 ? failedLayers : undefined,
    startupDurationMs,
    configuration: {
      rateLimitingEnabled: true,
      auditLoggingEnabled: logger.auditEnabled
    },
    success: failedLayers.length === 0
  });

  logger.info('============================================');
  logger.info(`EMET v${EMET_VERSION} ready!`, {
    startupDurationMs,
    layersInitialized: initializedLayers.length,
    layersFailed: failedLayers.length,
    sessionId: logger.sessionId
  });
  logger.info('DoS protection ENGAGED!');
  logger.info('Centralized error handling ACTIVE!');
  logger.info('Structured logging ACTIVE!');
  logger.info('Audit trail ENABLED!');
  logger.info('============================================');
}

// ============================================
// CRASH LOGGING
// ============================================

const CRASH_LOG_PATH = process.env.EMET_CRASH_LOG || null;

function writeCrashLog(type, err) {
  try {
    if (!CRASH_LOG_PATH) return;   // opt-in: set EMET_CRASH_LOG to a writable path
    const entry = `[${new Date().toISOString()}] ${type}: ${err?.stack || err?.message || String(err)}\n`;
    fs.appendFileSync(CRASH_LOG_PATH, entry, 'utf8');
  } catch (_) {}
}

process.on('uncaughtException', (err) => {
  writeCrashLog('UNCAUGHT_EXCEPTION', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  writeCrashLog('UNHANDLED_REJECTION', reason instanceof Error ? reason : new Error(String(reason)));
  // Don't exit Ã¢â‚¬â€ log and continue; unhandled rejections are often recoverable
});

process.on('exit', (code) => {
  if (code !== 0) {
    writeCrashLog('EXIT', new Error(`Process exiting with code ${code}`));
  }
});

// ============================================
// SHUTDOWN HANDLERS
// ============================================

process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal - initiating shutdown');

  logger.audit(AuditOperation.SERVER_STOP, {
    signal: 'SIGINT',
    auditStats: logger.getAuditStats()
  });

  rateLimiter.stop();
  await logger.shutdown();
  await dbManager.closeAll();

  logger.info('Shutdown complete');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal - initiating shutdown');

  logger.audit(AuditOperation.SERVER_STOP, {
    signal: 'SIGTERM',
    auditStats: logger.getAuditStats()
  });

  rateLimiter.stop();
  await logger.shutdown();
  await dbManager.closeAll();

  logger.info('Shutdown complete');
  process.exit(0);
});

// Start the server
main().catch((error) => {
  logger.audit(AuditOperation.SERVER_STOP, {
    signal: 'FATAL_ERROR',
    success: false,
    errorMessage: error?.message || 'Unknown fatal error'
  });

  logger.error('Fatal server error', {
    error,
    message: error?.message || 'Unknown fatal error'
  });

  process.exit(1);
});

// ============================================
// EXPORTS (for external use)
// ============================================

export {
  // Logger
  logger,
  StructuredLogger,
  LogLevel,
  AuditOperation,

  // Error classes
  EmetError,
  DatabaseError,
  ConfigurationError,
  ErrorCodes,
  StatusCodes,

  // Utilities
  sanitizeErrorMessage,
  handleError,
  createSuccessResponse
};
