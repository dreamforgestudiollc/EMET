/**
 * Owner chooser hero. The portrait is the page background.
 * The npm package does not ship site/. A missing file does not stop startup.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { htmlPage, mountOwnerGraphic, OWNER_GRAPHIC_PATH, OWNER_PAGE_CSP, sendHtml } from '../src/owner-session.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

testGroup('owner page portrait', () => {
  test('the page wraps the body in a sheet and allows only a same-origin image', () => {
    const html = htmlPage('Owner', '<p>Continue</p>');
    assert.ok(html.includes('<div class="sheet">'));
    assert.ok(html.includes('</div>'));
    assert.ok(html.includes(OWNER_GRAPHIC_PATH));
    assert.ok(html.includes('rgba(18, 20, 26, 0.86)'));
    const headers = {};
    let body = '';
    sendHtml({
      status() {},
      setHeader(name, value) { headers[name] = value; },
      send(html) { body = html; }
    }, 200, '<p>Continue</p>', 'Owner');
    assert.strictEqual(headers['Content-Security-Policy'], OWNER_PAGE_CSP);
    assert.ok(body.includes('<div class="sheet">'));
  });

  test('a missing portrait file is caught and does not stop startup', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/owner-session.js'), 'utf8');
    assert.match(src, /err\.code === 'ENOENT'\) return null/);
    assert.match(src, /does not stop startup/);
  });

  test('the deploy image copies the portrait and the npm package does not', () => {
    const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(docker.includes('COPY site/assets/portrait.webp ./site/assets/portrait.webp'));
    assert.ok(!pkg.files.some((rel) => rel === 'site/' || rel.startsWith('site/')));
    assert.ok(fs.existsSync(path.join(ROOT, 'site/assets/portrait.webp')));
  });

  test('the owner route serves the portrait', async () => {
    const app = express();
    mountOwnerGraphic(app);
    const server = await listen(app);
    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}${OWNER_GRAPHIC_PATH}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('content-type'), /image\/webp/);
      assert.ok(bytes.length > 16);
      assert.strictEqual(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

summary('OWNER GRAPHIC');
