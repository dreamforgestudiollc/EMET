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
const DEFAULT_ENV_FILE = path.join(ROOT, '.env');

/** Active KEY=value lines. Commented lines are skipped. Later lines win. */
export function parseEnvAssignments(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value === '') continue;
    out[key] = value;
  }
  return out;
}

const HOSTED_PLATFORM_MARKERS = [
  'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID',
  'FLY_APP_NAME', 'RENDER', 'RENDER_SERVICE_ID', 'DYNO', 'K_SERVICE'
];

/** What the startup load of the default .env file actually applied. */
const startupEnv = { loaded: false, keys: [], file: DEFAULT_ENV_FILE };

/** The .env path loadEnv reads at startup. Setup refuses a pepper write against this file when it was not the config source. */
export function defaultEnvFile() {
  return DEFAULT_ENV_FILE;
}

export function loadEnv(file = DEFAULT_ENV_FILE, env = process.env) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch {
    const missed = { loaded: false, keys: [], file };
    if (env === process.env && path.resolve(file) === path.resolve(startupEnv.file)) Object.assign(startupEnv, missed);
    return missed;
  }
  const keys = [];
  for (const [key, value] of Object.entries(parseEnvAssignments(raw))) {
    if (env[key] !== undefined) continue;      // a real env var always wins
    env[key] = value;
    keys.push(key);
  }
  const result = { loaded: true, keys, file };
  if (env === process.env && path.resolve(file) === path.resolve(startupEnv.file)) Object.assign(startupEnv, result);
  return result;
}

/** A platform injects the process environment (Railway and the same shape). */
export function platformEnv(env = process.env) {
  return HOSTED_PLATFORM_MARKERS.some((key) => env[key] !== undefined && String(env[key]).length > 0);
}

/**
 * True when this process did not take its settings from .env. A real env var
 * wins over the file, and a hosted deploy rebuilds the container, so a pepper
 * written there would not be the one the next process verifies.
 */
export function realEnvIsConfigSource(env = process.env, startup = startupEnv) {
  if (platformEnv(env)) return true;
  if (!startup.loaded) return true;
  if (startup.keys.length === 0) return true;
  return false;
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
