/**
 * EMET structured logging.
 *
 * WHY THIS IS ITS OWN MODULE. This lived inside index.js, which is the stdio
 * entry point. The HTTP transport - the one a hosted install actually runs -
 * could not reach it without importing the stdio server, so it substituted a
 * stub whose debug/info/warn/audit were empty functions. The result was that
 * fifteen audit calls, every memory save, recall and query among them, were
 * discarded on the only transport in use, while the server reported an audit
 * trail it did not keep. A claim the system cannot honour is worse than no
 * claim. Extracted 2026-09-13 so both transports use the same recorder.
 *
 * Output goes to stderr, which hosted platforms capture.
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import { redactText } from './redact.js';
import { EMET_VERSION } from './version.js';

// ============================================
// STRUCTURED LOGGING SYSTEM
// ============================================

/**
 * Log levels with numeric priority for filtering
 */
const LogLevel = Object.freeze({
  DEBUG: { name: 'debug', priority: 10, color: '\x1b[36m' },
  INFO: { name: 'info', priority: 20, color: '\x1b[32m' },
  WARN: { name: 'warn', priority: 30, color: '\x1b[33m' },
  ERROR: { name: 'error', priority: 40, color: '\x1b[31m' },
  AUDIT: { name: 'audit', priority: 50, color: '\x1b[35m' }
});

/**
 * Operation types for audit logging
 */
const AuditOperation = Object.freeze({
  // One entry per tool call, every tool, both transports - tool name, outcome,
  // duration; never the arguments (audit finding H6, 2026-09-19). The
  // per-operation entries below stay where they are; this is the floor.
  TOOL_CALL: 'TOOL_CALL',
  MEMORY_SAVE: 'MEMORY_SAVE',
  MEMORY_RECALL: 'MEMORY_RECALL',
  MEMORY_QUERY: 'MEMORY_QUERY',
  MEMORY_DELETE: 'MEMORY_DELETE',
  LAYER_ACCESS: 'LAYER_ACCESS',
  CONNECTION_OPEN: 'CONNECTION_OPEN',
  CONNECTION_CLOSE: 'CONNECTION_CLOSE',
  RATE_LIMIT_HIT: 'RATE_LIMIT_HIT',
  VALIDATION_FAIL: 'VALIDATION_FAIL',
  SERVER_START: 'SERVER_START',
  SERVER_STOP: 'SERVER_STOP',
  CONFIG_CHANGE: 'CONFIG_CHANGE'
});

/**
 * Structured Logger Class
 */
class StructuredLogger extends EventEmitter {
  constructor(options = {}) {
    super();
    this.serviceName = options.serviceName || 'emet';
    this.version = options.version || EMET_VERSION;
    this.minLevel = this._parseLevel(options.minLevel || (process.env.LOG_LEVEL || 'info'));
    this.jsonOutput = options.jsonOutput !== false;
    this.colorOutput = options.colorOutput !== false && process.stderr.isTTY;
    this.includeTimestamp = options.includeTimestamp !== false;
    this.includeContext = options.includeContext !== false;

    this.auditEnabled = options.auditEnabled !== false;
    this.auditLogPath = options.auditLogPath || null;
    this.auditBuffer = [];
    this.auditBufferSize = options.auditBufferSize || 100;
    this.auditFlushInterval = options.auditFlushInterval || 30000;

    this.sessionId = this._generateSessionId();
    this.requestCounter = 0;

    if (this.auditLogPath) {
      this._startAuditFlushTimer();
    }
  }

  _parseLevel(level) {
    if (typeof level === 'object' && level.priority !== undefined) {
      return level;
    }
    const levelName = String(level).toLowerCase();
    const found = Object.values(LogLevel).find(l => l.name === levelName);
    return found || LogLevel.INFO;
  }

  _generateSessionId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}`;
  }

  _generateRequestId() {
    return `${this.sessionId}-${++this.requestCounter}`;
  }

  _formatTimestamp() {
    return new Date().toISOString();
  }

  _buildLogEntry(level, message, context = {}) {
    const entry = {
      timestamp: this._formatTimestamp(),
      level: level.name,
      service: this.serviceName,
      version: this.version,
      sessionId: this.sessionId,
      message: message
    };

    if (context && Object.keys(context).length > 0) {
      entry.context = context;
    }

    if (context.error instanceof Error) {
      entry.error = {
        name: context.error.name,
        message: context.error.message,
        code: context.error.code || undefined,
        stack: context.error.stack ?
          context.error.stack.split('\n').slice(0, 5).map(l => l.trim()) :
          undefined
      };
      delete entry.context.error;
    }

    return entry;
  }

  _formatOutput(entry, level) {
    if (this.jsonOutput) {
      return JSON.stringify(entry);
    }

    let output = '';

    if (this.colorOutput) {
      output += level.color;
    }

    output += `[${entry.timestamp}] `;
    output += `[${entry.level.toUpperCase().padEnd(5)}] `;
    output += `[${entry.service}] `;
    output += entry.message;

    if (entry.context && Object.keys(entry.context).length > 0) {
      output += ` | ${JSON.stringify(entry.context)}`;
    }

    if (this.colorOutput) {
      output += '\x1b[0m';
    }

    return output;
  }

  _write(level, message, context = {}) {
    if (level.priority < this.minLevel.priority) {
      return;
    }

    const entry = this._buildLogEntry(level, message, context);
    // Logs leave the process (Railway captures stderr). Scrub the rendered
    // line, not the entry: listeners still get the structured entry.
    const output = redactText(this._formatOutput(entry, level));

    console.error(output);
    this.emit('log', entry, level);

    return entry;
  }

  debug(message, context = {}) {
    return this._write(LogLevel.DEBUG, message, context);
  }

  info(message, context = {}) {
    return this._write(LogLevel.INFO, message, context);
  }

  warn(message, context = {}) {
    return this._write(LogLevel.WARN, message, context);
  }

  error(message, context = {}) {
    return this._write(LogLevel.ERROR, message, context);
  }

  audit(operation, details = {}) {
    const entry = {
      timestamp: this._formatTimestamp(),
      level: 'audit',
      service: this.serviceName,
      sessionId: this.sessionId,
      requestId: details.requestId || this._generateRequestId(),
      operation: operation,
      details: {
        ...details,
        requestId: undefined
      },
      durationMs: details.durationMs || undefined,
      success: details.success !== false,
      errorCode: details.errorCode || undefined
    };

    Object.keys(entry).forEach(key => entry[key] === undefined && delete entry[key]);
    Object.keys(entry.details).forEach(key => entry.details[key] === undefined && delete entry.details[key]);

    this._write(LogLevel.AUDIT, `AUDIT: ${operation}`, entry.details);

    if (this.auditEnabled) {
      this.auditBuffer.push(entry);

      if (this.auditBuffer.length >= this.auditBufferSize) {
        this._flushAuditBuffer();
      }
    }

    this.emit('audit', entry);

    return entry;
  }

  _startAuditFlushTimer() {
    this.auditFlushTimer = setInterval(() => {
      this._flushAuditBuffer();
    }, this.auditFlushInterval);

    if (this.auditFlushTimer.unref) {
      this.auditFlushTimer.unref();
    }
  }

  async _flushAuditBuffer() {
    if (!this.auditLogPath || this.auditBuffer.length === 0) {
      return;
    }

    const entries = [...this.auditBuffer];
    this.auditBuffer = [];

    try {
      const content = entries.map(e => redactText(JSON.stringify(e))).join('\n') + '\n';
      await fs.promises.appendFile(this.auditLogPath, content, 'utf8');
    } catch (error) {
      this.auditBuffer.unshift(...entries);
      this.error('Failed to flush audit buffer', { error, entriesLost: entries.length });
    }
  }

  child(context = {}) {
    const childLogger = Object.create(this);
    childLogger.defaultContext = { ...this.defaultContext, ...context };

    ['debug', 'info', 'warn', 'error'].forEach(method => {
      const original = this[method].bind(this);
      childLogger[method] = (message, ctx = {}) => {
        return original(message, { ...childLogger.defaultContext, ...ctx });
      };
    });

    return childLogger;
  }

  log(level, ...args) {
    const message = args.join(' ');
    const levelObj = this._parseLevel(level);
    return this._write(levelObj, message);
  }

  getAuditStats() {
    return {
      sessionId: this.sessionId,
      requestCount: this.requestCounter,
      pendingAuditEntries: this.auditBuffer.length,
      auditEnabled: this.auditEnabled,
      auditLogPath: this.auditLogPath
    };
  }

  async shutdown() {
    if (this.auditFlushTimer) {
      clearInterval(this.auditFlushTimer);
      this.auditFlushTimer = null;
    }

    await this._flushAuditBuffer();

    this.info('Logger shutdown complete');
  }
}

export { LogLevel, AuditOperation, StructuredLogger };

