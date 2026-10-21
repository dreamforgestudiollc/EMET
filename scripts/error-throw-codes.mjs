#!/usr/bin/env node
/**
 * Regenerate tests/fixtures/error-throw-codes.json from the coded throw sites.
 *
 *   node scripts/error-throw-codes.mjs
 *   node scripts/error-throw-codes.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codedThrowSites } from '../tests/error-scan.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'tests/fixtures/error-throw-codes.json');
const next = `${JSON.stringify(codedThrowSites(root), null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.readFileSync(file, 'utf8');
  if (current !== next) {
    console.error('tests/fixtures/error-throw-codes.json is stale. Run: node scripts/error-throw-codes.mjs');
    process.exit(1);
  }
} else {
  fs.writeFileSync(file, next);
}
