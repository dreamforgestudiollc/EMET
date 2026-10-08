/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Environment loading.
 *
 * The install instructions say to copy .env.example to .env. Nothing was reading
 * it. Rather than add a dependency for twenty lines, this parses it directly.
 * Real environment variables always win, so a deployment that sets them on the
 * host is unaffected by a stray .env in the working directory.
 */

import fs from 'fs';
import path from 'path';
import { resolveModulePath } from './module-path.js';

const ROOT = resolveModulePath(import.meta.url, ['..']);

export function loadEnv(file = path.join(ROOT, '.env')) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { loaded: false, keys: [] }; }

  const keys = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;      // a real env var always wins
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value === '') continue;
    process.env[key] = value;
    keys.push(key);
  }
  return { loaded: true, keys };
}

/**
 * Reads a setting, accepting the legacy CASCADE_-prefixed name as a fallback so
 * an existing upstream deployment keeps working after upgrading. New installs
 * should only ever use the EMET_ form.
 */
export function setting(name, fallbackDefault = undefined) {
  return process.env[`EMET_${name}`] ?? process.env[`CASCADE_${name}`] ?? fallbackDefault;
}

loadEnv();
