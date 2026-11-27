/**
 * Static host for EMET Console.
 * Sets the content security policy and serves the client metadata document.
 * It stores nothing.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

function publicOrigin(req) {
  const configured = String(process.env.EMET_CONSOLE_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  return `${proto}://${host}`;
}

function connectSrc() {
  const extra = String(process.env.EMET_CONSOLE_CONNECT_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  const allowed = [];
  for (const origin of extra) {
    try {
      const url = new URL(origin);
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) allowed.push(url.origin);
    } catch { /* skip a value that is not an origin */ }
  }
  return ["'self'", ...allowed].join(' ');
}

function securityHeaders() {
  return {
    'content-security-policy': [
      "default-src 'self'",
      `connect-src ${connectSrc()}`,
      "img-src 'self'",
      "style-src 'self'",
      "script-src 'self'",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY'
  };
}

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...securityHeaders(), ...extra });
  res.end(body);
}

function fileFor(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded === '/' ? '/index.html' : decoded;
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root)) return null;
  if (existsSync(full) && statSync(full).isFile()) return full;
  return null;
}

const server = createServer((req, res) => {
  const urlPath = req.url || '/';
  if (urlPath === '/health' || urlPath.startsWith('/health?')) {
    send(res, 200, JSON.stringify({ ok: true, service: 'emet-console' }), 'application/json; charset=utf-8');
    return;
  }
  if (urlPath.startsWith('/.well-known/emet-console-client.json')) {
    const origin = publicOrigin(req);
    const doc = {
      client_id: `${origin}/.well-known/emet-console-client.json`,
      client_name: 'EMET Console',
      redirect_uris: [`${origin}/callback`],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'emet.console'
    };
    send(res, 200, JSON.stringify(doc), 'application/json; charset=utf-8');
    return;
  }
  const file = fileFor(urlPath) || fileFor('/index.html');
  if (!file) {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return;
  }
  const ext = path.extname(file);
  const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': cache, ...securityHeaders() });
  createReadStream(file).pipe(res);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`emet-console listening ${port}`);
});
