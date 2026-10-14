/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * The GEM socket. It seats bundled prompt GEMs from the release gems/
 * directory and nothing else. gems/neurendipity ships with this release
 * and is off unless the install lists its id in EMET_ACTIVE_GEMS.
 *
 * gem-library/examples/neurendipity is a shape, not an installed GEM.
 * It is not on this path and it is not loaded.
 *
 * RUNE code is not imported, not executed, and not given a database handle.
 * A refused GEM is one warning. It does not throw, and it does not stop
 * emet_initialize. An empty list logs nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { checkGem, satisfiesEmetRange } from './gem-check.js';
import { resolveModulePath } from './module-path.js';
import { setting } from './env.js';
import { EMET_VERSION } from './version.js';

export const MAX_INSTALLED = 16;
export const MAX_ACTIVE = 4;
export const MAX_ACTIVE_FLOOR_BYTES = 16384;

const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

/** The release gems/ directory, next to src/. Bundled GEMs live here. */
export function releaseGemsRoot() {
  return resolveModulePath(import.meta.url, ['..', 'gems']);
}

function inside(rootReal, candidateReal) {
  const rel = path.relative(rootReal, candidateReal);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function fallbackId(name, used) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 60);
  let id = cleaned.length >= 2 && /^[a-z]/.test(cleaned) ? cleaned : 'invalid';
  if (!used.has(id)) return id;
  let n = 2;
  while (used.has(`${id}-${n}`)) n++;
  const next = `${id}-${n}`;
  return next.length <= 64 ? next : next.slice(0, 64);
}

function cmpId(a, b) {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function sameDigestSet(a, b) {
  const left = [...a].map(String).sort();
  const right = [...b].map(String).sort();
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

function hasConsent(consent, id, digests) {
  if (!Array.isArray(consent)) return false;
  return consent.some((row) => row && row.id === id && Array.isArray(row.digests) && sameDigestSet(row.digests, digests));
}

function onAcceptedList(accepted, id, digests) {
  if (!Array.isArray(accepted) || accepted.length === 0) return false;
  return accepted.some((row) => row && row.id === id && Array.isArray(row.digests) && sameDigestSet(row.digests, digests));
}

function emit(log, level, message, context) {
  if (log && typeof log[level] === 'function') {
    log[level](message, context);
    return;
  }
  if (level === 'warn' || level === 'error') console.error(`emet: ${message}`);
  else if (level === 'info') console.error(`emet: ${message}`);
}

function field(manifest, key, fallback) {
  const value = manifest && manifest[key];
  if (typeof fallback === 'string') return typeof value === 'string' ? value : fallback;
  if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;
  if (typeof fallback === 'number') return Number.isInteger(value) ? value : fallback;
  return value === undefined ? fallback : value;
}

function toCandidate(dirName, dirReal, result, used) {
  const manifest = result && result.manifest;
  const id = manifest && typeof manifest.id === 'string' && ID_RE.test(manifest.id)
    ? manifest.id
    : fallbackId(dirName, used);
  used.add(id);
  return {
    id,
    dirName,
    dirReal,
    manifest,
    name: field(manifest, 'name', id).slice(0, 80),
    description: field(manifest, 'description', '').slice(0, 400),
    version: field(manifest, 'version', '0.0.0'),
    kind: manifest && (manifest.kind === 'gem' || manifest.kind === 'runed-gem') ? manifest.kind : 'gem',
    spec: field(manifest, 'spec', ''),
    priority: field(manifest, 'priority', 0),
    distribution: manifest && manifest.distribution === 'library' ? 'library' : 'bundled',
    defaultOn: field(manifest, 'defaultOn', false),
    gcOk: Boolean(result && result.ok),
    gcReason: result && result.firstFailure ? result.firstFailure : 'GC-01',
    floor: result && result.floor,
    floorBytes: result && result.floorTrusted ? result.floorBytes : 0,
    floorTrusted: Boolean(result && result.floorTrusted),
    floorDigest: result && result.floorDigest,
    loadable: false,
    active: false,
    reason: result && result.firstFailure ? result.firstFailure : 'GC-01'
  };
}

function releaseCopy(candidate, releaseReal) {
  if (!releaseReal || !candidate.manifest || typeof candidate.manifest.id !== 'string') return false;
  const expected = path.join(releaseReal, candidate.manifest.id);
  let expectedReal;
  try { expectedReal = fs.realpathSync(expected); } catch { return false; }
  return expectedReal === candidate.dirReal;
}

/**
 * SR-01: a bundled GEM loads only from gems/<id>/ of this release.
 * A library GEM loads only when its id and digests are on the accepted list
 * shipped with the release. This release ships no accepted list.
 * distribution: bundled in the file is not evidence.
 */
function serverRefusal(candidate, ctx) {
  const manifest = candidate.manifest;
  const digests = manifest && Array.isArray(manifest.files) ? manifest.files.map((f) => f.digest) : [];
  const inRelease = releaseCopy(candidate, ctx.releaseReal);
  if (manifest.distribution === 'library') {
    if (!onAcceptedList(ctx.accepted, manifest.id, digests)) return 'SR-01';
  } else if (!inRelease) {
    return 'SR-01';
  }
  if (!satisfies(ctx.emetVersion, manifest.requires && manifest.requires.emet)) return 'SR-06';
  if (Array.isArray(manifest.overrides) && manifest.overrides.length > 0 && !hasConsent(ctx.consent, manifest.id, digests)) {
    return 'SR-05';
  }
  return null;
}

function satisfies(version, range) {
  return satisfiesEmetRange(version, range);
}

/**
 * GEM ids the install asked to turn on. EMET_ACTIVE_GEMS is a comma-separated
 * list. Unset means only a GEM with defaultOn true is active. options.asked,
 * when passed, replaces the setting for that call. This is not consent: a GEM
 * with overrides still needs consent bound to its digests.
 */
export function askedGemIds(options = {}) {
  const raw = options.asked !== undefined ? options.asked : setting('ACTIVE_GEMS', '');
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const ids = new Set();
  for (const item of list) {
    const id = String(item).trim();
    if (ID_RE.test(id)) ids.add(id);
  }
  return ids;
}

function publicAvailable(candidate) {
  const row = {
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    version: candidate.version,
    kind: candidate.kind,
    spec: candidate.spec,
    priority: candidate.priority,
    distribution: candidate.distribution,
    defaultOn: candidate.defaultOn,
    active: candidate.active === true,
    loadable: candidate.loadable === true,
    bytes: candidate.floorTrusted ? candidate.floorBytes : 0
  };
  if (!row.loadable) row.reason = candidate.reason;
  return row;
}

function publicActive(candidate) {
  const floor = candidate.floor && candidate.floor.sections ? candidate.floor.sections : {};
  const reassertion = candidate.floor && Array.isArray(candidate.floor.reassertion) ? candidate.floor.reassertion : [];
  return {
    id: candidate.manifest.id,
    version: candidate.manifest.version,
    priority: candidate.manifest.priority,
    floor_digest: candidate.floorDigest,
    floor,
    reassertion
  };
}

/**
 * Discover and validate GEMs.
 * root defaults to the release gems/ directory. Tests may pass another root
 * only together with the same releaseRoot when they are exercising a bundled copy.
 * There is no environment variable for this path.
 * options.db is ignored if a caller passes one. The socket never reads it.
 */
export async function seatGems(options = {}) {
  const releaseRoot = options.releaseRoot ? path.resolve(options.releaseRoot) : releaseGemsRoot();
  const root = options.root ? path.resolve(options.root) : releaseRoot;
  const emetVersion = options.emetVersion || EMET_VERSION;
  const consent = Array.isArray(options.consent) ? options.consent : [];
  const accepted = Array.isArray(options.accepted) ? options.accepted : [];
  const check = typeof options.check === 'function' ? options.check : checkGem;
  const log = options.log || null;
  const asked = askedGemIds(options);

  let releaseReal = null;
  try {
    const st = await fs.promises.stat(releaseRoot);
    if (st.isDirectory()) releaseReal = await fs.promises.realpath(releaseRoot);
  } catch { releaseReal = null; }

  let entries;
  try {
    const st = await fs.promises.lstat(root);
    if (!st.isDirectory() && !st.isSymbolicLink()) {
      return { gems_available: [], gems_active: [], refusals: [] };
    }
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { gems_available: [], gems_active: [], refusals: [] };
    emit(log, 'error', 'GEM socket failed closed');
    return { gems_available: [], gems_active: [], refusals: [] };
  }

  let rootReal;
  try { rootReal = await fs.promises.realpath(root); }
  catch {
    emit(log, 'error', 'GEM socket failed closed');
    return { gems_available: [], gems_active: [], refusals: [] };
  }

  const used = new Set();
  const candidates = [];
  for (const ent of entries) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const abs = path.join(root, ent.name);
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isDirectory()) continue;
      const dirReal = await fs.promises.realpath(abs);
      if (!inside(rootReal, dirReal)) {
        const row = toCandidate(ent.name, dirReal, { ok: false, firstFailure: 'GC-04', manifest: null }, used);
        row.gcOk = false;
        row.reason = 'GC-04';
        candidates.push(row);
        continue;
      }
      // GC-20 checks grammar. The running version is SR-06, so it is not passed here.
      const result = await check(abs, { trustStore: options.trustStore, schema: options.schema });
      candidates.push(toCandidate(ent.name, dirReal, result, used));
    } catch {
      const row = toCandidate(ent.name, abs, { ok: false, firstFailure: 'GC-01', manifest: null }, used);
      row.gcOk = false;
      row.reason = 'GC-01';
      candidates.push(row);
    }
  }

  candidates.sort(cmpId);
  const ctx = { releaseReal, emetVersion, consent, accepted };

  candidates.forEach((candidate, index) => {
    if (index >= MAX_INSTALLED) {
      candidate.loadable = false;
      candidate.active = false;
      candidate.reason = 'SR-03';
      return;
    }
    // This release does not execute RUNEs. A runed-gem that somehow passed
    // the checker is still refused. GC-19 is that refusal.
    if (candidate.kind === 'runed-gem' && candidate.gcOk) {
      candidate.gcOk = false;
      candidate.gcReason = 'GC-19';
    }
    if (!candidate.gcOk) {
      candidate.loadable = false;
      candidate.active = false;
      candidate.reason = candidate.gcReason || 'GC-01';
      return;
    }
    const sr = serverRefusal(candidate, ctx);
    if (sr) {
      candidate.loadable = false;
      candidate.active = false;
      candidate.reason = sr;
      return;
    }
    candidate.loadable = true;
    candidate.reason = null;
    candidate.wantsActive = candidate.defaultOn === true || asked.has(candidate.id);
  });

  let activeCount = 0;
  let activeBytes = 0;
  for (const candidate of candidates) {
    if (!candidate.loadable || !candidate.wantsActive) {
      if (candidate.loadable) candidate.active = false;
      continue;
    }
    const size = candidate.floorTrusted ? candidate.floorBytes : 0;
    if (activeCount + 1 > MAX_ACTIVE) {
      candidate.loadable = false;
      candidate.active = false;
      candidate.reason = 'SR-02';
      continue;
    }
    if (activeBytes + size > MAX_ACTIVE_FLOOR_BYTES) {
      candidate.loadable = false;
      candidate.active = false;
      candidate.reason = 'SR-04';
      continue;
    }
    candidate.active = true;
    activeCount += 1;
    activeBytes += size;
  }

  const gems_available = candidates.map(publicAvailable);
  const gems_active = candidates.filter((c) => c.active).map(publicActive)
    .sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const refusals = gems_available.filter((row) => row.loadable === false);

  for (const row of refusals) {
    emit(log, 'warn', `GEM refused: ${row.id} ${row.reason}`, { id: row.id, reason: row.reason });
  }
  // Empty mount stays silent. A seating summary is logged only when a GEM is installed.
  if (gems_available.length > 0) {
    emit(log, 'info', `GEMs seated: ${gems_available.length} installed, ${gems_active.length} active`, {
      installed: gems_available.length,
      active: gems_active.length
    });
  }
  const result = { gems_available, gems_active, refusals };
  if (options.floors) {
    const floors = Object.create(null);
    for (const candidate of candidates) {
      if (!candidate.loadable || !candidate.floor) continue;
      floors[candidate.id] = {
        sections: candidate.floor.sections || {},
        reassertion: Array.isArray(candidate.floor.reassertion) ? candidate.floor.reassertion : []
      };
    }
    result.floors = floors;
  }
  return result;
}
