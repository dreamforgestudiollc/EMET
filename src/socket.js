/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * The GEM socket. It seats bundled GEMs from the release gems/ directory
 * and nothing else. gems/neurendipity and gems/fieldnote ship with this
 * release and are off unless the install lists the id in EMET_ACTIVE_GEMS.
 *
 * gem-library/examples/neurendipity is a shape, not an installed GEM.
 * It is not on this path and it is not loaded.
 *
 * The socket does not run RUNE code. While a GEM is active, each RUNE is
 * one read-only tool that serves the code. A refused GEM is one warning.
 * It does not throw, and it does not stop emet_initialize. An empty list
 * logs nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { checkGem, satisfiesEmetRange } from './gem-check.js';
import { bindRunes, runeToolName } from './rune-registry.js';
import { noteArtifact } from './rune-dispatch.js';
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

/** What gems_available and emet_status show. A checker failure stays the check id. */
export function refusalText(result) {
  if (!result || !result.firstFailure) return 'GC-01';
  return result.firstFailure;
}

function schemaList(schema) {
  const props = schema && schema.properties;
  if (props && typeof props === 'object') {
    const keys = Object.keys(props);
    if (keys.length) return keys.join(',');
  }
  return 'object';
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
    gcReason: refusalText(result),
    floor: result && result.floor,
    floorBytes: result && result.floorTrusted ? result.floorBytes : 0,
    floorTrusted: Boolean(result && result.floorTrusted),
    floorDigest: result && result.floorDigest,
    loadable: false,
    active: false,
    reason: refusalText(result)
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
 * A missing `released` field is allowed only for these ids, at this version,
 * with every pinned file present at its digest. A shorter file list does not
 * match. The pin is the id, the version, and the file digests. It does not
 * cover every other manifest field, including defaultOn, priority, requires,
 * description, name, authors, license, rune description, schemas, the guides
 * list, distribution, coverage, and rune metadata other than the version.
 * overrides still needs SR-05 consent. A rune execution of server and
 * distribution library are refused by GC-02. gem.json is not hashed: anyone
 * who can edit it can already add released: true, so hashing it would grant
 * nothing extra. The list is fixed in source. Nothing is read to decide
 * whether SR-08 runs, so a missing or corrupt manifest cannot turn the check off.
 */
export const RELEASED_LEGACY = Object.freeze([
  Object.freeze({
    id: 'neurendipity',
    version: '1.2.3',
    digests: Object.freeze({
      'floor.json': 'sha256:484dd159ccfec5d4fd85a764aea6db687b9c2355e1b7a11532f044fc350eca01',
      'guides/NEURODIVERGENT_SUPPORT.md': 'sha256:aa64c1f125960da7822970a87926bd042fcb4f8ba6d84e392a29dfb12321c809',
      'guides/AUTISTIC_BURNOUT.md': 'sha256:657810094cdde539648c7d06767072e71b8c712aee73a60e7e8040ac83df40e2'
    })
  }),
  Object.freeze({
    id: 'fieldnote',
    version: '1.0.1',
    digests: Object.freeze({
      'floor.json': 'sha256:11af3724b165beb3e9a49a681f1f07cb742bcb4535206f714a0dc689067f32d6',
      'runes/fieldnote.js': 'sha256:cfb62b669f67c69f53989ed2621a40bfbfa60a744f1b4040e5b8496755598a35'
    })
  })
]);

function legacyDigests(manifest, pin) {
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const keys = Object.keys(pin.digests);
  if (files.length !== keys.length) return false;
  for (const file of files) {
    if (!file || pin.digests[file.path] !== file.digest) return false;
  }
  return true;
}

function legacyReleased(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  const pin = RELEASED_LEGACY.find((row) => row.id === manifest.id);
  if (!pin || manifest.version !== pin.version || !legacyDigests(manifest, pin)) return false; // legacy-pin
  return true;
}

/** Null when the manifest may seat. Otherwise the log line that says why. */
export function releasedReason(manifest) {
  if (manifest && manifest.released === true) return null;
  const missing = !manifest || typeof manifest !== 'object' || !Object.prototype.hasOwnProperty.call(manifest, 'released');
  if (missing) {
    if (legacyReleased(manifest)) return null;
    const base = 'released is missing; boolean true is required';
    // Exact and case-sensitive. neurendipity-x, xneurendipity, and Fieldnote are not pins.
    const id = manifest && typeof manifest.id === 'string' ? manifest.id : '';
    const pinned = RELEASED_LEGACY.some((row) => row.id === id);
    return pinned ? `${base} (legacy pin mismatch: version/digests)` : base;
  }
  const value = manifest.released;
  if (typeof value === 'string') return `released must be boolean true, got string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `released must be boolean true, got number ${value}`;
  if (typeof value === 'boolean') return `released must be boolean true, got boolean ${value}`;
  return `released must be boolean true, got ${value === null ? 'null' : typeof value}`;
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
  if (row.active && candidate.manifest && Array.isArray(candidate.manifest.runes) && candidate.manifest.runes.length) {
    row.runes = candidate.manifest.runes.map((rune) => ({
      name: rune.name,
      runtime: rune.runtime,
      inputs: schemaList(rune.inputSchema),
      outputs: schemaList(rune.outputSchema),
      sha256: rune.sha256
    }));
  }
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
      if (!st.isDirectory()) {
        if (!ent.isSymbolicLink()) continue;
        const row = toCandidate(ent.name, abs, { ok: false, firstFailure: 'GC-01', manifest: null }, used);
        row.gcOk = false;
        row.reason = 'GC-01';
        candidates.push(row);
        continue;
      }
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
    if (!candidate.gcOk) {
      candidate.loadable = false;
      candidate.active = false;
      candidate.reason = candidate.gcReason || 'GC-01';
      return;
    }
    const why = releasedReason(candidate.manifest); // sr-08-always
    if (why) {
      candidate.loadable = false;
      candidate.active = false;
      candidate.reason = 'SR-08';
      candidate.releasedWhy = why;
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
  const refusals = gems_available.filter((row) => row.loadable === false);
  const gems_active = candidates.filter((c) => c.active).map(publicActive)
    .sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const candidate of candidates) {
    if (candidate.loadable) continue;
    const why = candidate.reason === 'SR-08' ? candidate.releasedWhy : null;
    const message = why
      ? `GEM refused: ${candidate.id} ${candidate.reason}: ${why}`
      : `GEM refused: ${candidate.id} ${candidate.reason}`;
    emit(log, 'warn', message, { id: candidate.id, reason: candidate.reason, ...(why ? { detail: why } : {}) });
  }
  // Empty mount stays silent. Each seated GEM is named, then the summary.
  // A refused GEM is not a seat line.
  if (gems_available.length > 0) {
    for (const row of gems_available) {
      if (!row.loadable) continue;
      emit(log, 'info', `GEM seated: ${row.id}`, { id: row.id });
    }
    emit(log, 'info', `GEMs seated: ${gems_available.length} installed, ${gems_active.length} active`, {
      installed: gems_available.length,
      active: gems_active.length
    });
  }
  const production = options.root === undefined && options.releaseRoot === undefined;
  if (production || options.bindRunes === true) {
    const bound = [];
    for (const candidate of candidates) {
      if (!candidate.active || !candidate.manifest || !Array.isArray(candidate.manifest.runes)) continue;
      for (const rune of candidate.manifest.runes) {
        noteArtifact({ sha256: rune.sha256, gem: candidate.id, rune: rune.name, version: rune.version });
        bound.push({
          name: rune.name,
          description: rune.description,
          inputSchema: rune.inputSchema,
          outputSchema: rune.outputSchema,
          runtime: rune.runtime,
          sha256: rune.sha256,
          artifact: rune.artifact,
          version: rune.version,
          annotations: rune.annotations,
          reads: rune.reads,
          writes: rune.writes,
          network: rune.network,
          gemId: candidate.id,
          gemVersion: candidate.version,
          gemDir: candidate.dirReal,
          tool: runeToolName(candidate.id, rune.name)
        });
      }
    }
    bindRunes(bound);
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

/**
 * Socket PR 4 (docs/ROADMAP.md): each GEM's byte cost, for emet_status.
 * Read-only: built from a seatGems() result, never from the store. The caps
 * are the ones seatGems already enforces; this only makes them visible, so an
 * install can see what a GEM costs its startup before it asks for one.
 * Bytes are the trusted floor bytes the socket counts toward
 * MAX_ACTIVE_FLOOR_BYTES (0 for a GEM whose floor was not trusted).
 */
export function gemCost(seated) {
  const available = seated && Array.isArray(seated.gems_available) ? seated.gems_available : [];
  const perGem = available.map((row) => {
    const out = {
      id: row.id,
      version: row.version,
      kind: row.kind,
      active: row.active === true,
      loadable: row.loadable === true,
      bytes: Number.isFinite(row.bytes) ? row.bytes : 0
    };
    if (!out.loadable && row.reason) out.reason = row.reason;
    return out;
  });
  const active = perGem.filter((g) => g.active);
  const activeBytes = active.reduce((sum, g) => sum + g.bytes, 0);
  return {
    installed: perGem.length,
    active: active.length,
    active_floor_bytes: activeBytes,
    headroom_bytes: Math.max(0, MAX_ACTIVE_FLOOR_BYTES - activeBytes),
    caps: {
      max_installed: MAX_INSTALLED,
      max_active: MAX_ACTIVE,
      max_active_floor_bytes: MAX_ACTIVE_FLOOR_BYTES
    },
    per_gem: perGem
  };
}
