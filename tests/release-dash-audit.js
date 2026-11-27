/**
 * Dash and public-surface helpers for the release content audit.
 * This module does not call git. The baseline is a checked-in file.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DASH = /[\u2013\u2014]/;

/**
 * Historical strings this follow-up did not rewrite. They keep their
 * dashes. Everything else must be in the checked-in baseline or have
 * no dash.
 */
export const DASH_ALLOWLIST = [
  'EMET — MCP memory server',
  '# EMET — Next Steps and Proposed Features',
  'EMET 0.3.8 — Enduring Memory & Epistemic Tiers.',
];

export const SETUP_TOKEN = 'EMET_ADMIN_SETUP_TOKEN';

export const BASELINE_REL = 'tests/fixtures/legacy-dash-lines.json';

const SURFACE_EXTS = new Set(['.md', '.html', '.xml', '.css', '.js', '.txt', '.example', '.json']);

export function stripAllowed(text, allowlist = DASH_ALLOWLIST) {
  let rest = text;
  for (const allowed of allowlist) rest = rest.split(allowed).join('');
  return rest;
}

/** Original lines that still contain an em or en dash after the allowlist is removed. */
export function dashedLines(text, allowlist = DASH_ALLOWLIST) {
  return text.split('\n').filter((line) => DASH.test(stripAllowed(line, allowlist)));
}

function walkDir(dir, out, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(abs, out, rel);
    else if (SURFACE_EXTS.has(path.extname(entry.name)) || entry.name === '.env.example') out.push(rel);
  }
  return out;
}

export function publicSurfaceRels(root) {
  const rels = [];
  for (const name of fs.readdirSync(root)) {
    const abs = path.join(root, name);
    if (!fs.statSync(abs).isFile()) continue;
    const isNotes = name.startsWith('RELEASE_NOTES') && name.endsWith('.md');
    if (name === 'README.md' || name === 'CHANGELOG.md' || name === '.env.example' || isNotes) rels.push(name);
  }
  if (fs.existsSync(path.join(root, 'docs'))) walkDir(path.join(root, 'docs'), rels, 'docs');
  if (fs.existsSync(path.join(root, 'site'))) walkDir(path.join(root, 'site'), rels, 'site');
  return rels.sort();
}

export function loadSurfaceFiles(root) {
  const files = {};
  for (const rel of publicSurfaceRels(root)) {
    files[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
  }
  return files;
}

export function loadBaseline(root) {
  const abs = path.join(root, BASELINE_REL);
  if (!fs.existsSync(abs)) {
    throw new Error(
      'legacy dash baseline is missing: expected tests/fixtures/legacy-dash-lines.json with a "lines" map. Check that file in. The dash check does not use git.',
    );
  }
  const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !parsed.lines || typeof parsed.lines !== 'object' || Array.isArray(parsed.lines)) {
    throw new Error(
      'legacy dash baseline is missing: expected tests/fixtures/legacy-dash-lines.json with a "lines" map. Check that file in. The dash check does not use git.',
    );
  }
  return parsed;
}

function bag(lines) {
  const map = new Map();
  for (const line of lines) map.set(line, (map.get(line) || 0) + 1);
  return map;
}

/**
 * Compare current surface files to the checked-in baseline.
 * newDashes: dashed lines (by exact text, with multiplicity) not in the baseline.
 * staleBaseline: baseline entries that are no longer present, so the baseline must shrink.
 */
export function reportDashes(fileMap, baseline, allowlist = DASH_ALLOWLIST) {
  if (!baseline || typeof baseline !== 'object' || !baseline.lines || typeof baseline.lines !== 'object' || Array.isArray(baseline.lines)) {
    throw new Error(
      'legacy dash baseline is missing: expected tests/fixtures/legacy-dash-lines.json with a "lines" map. Check that file in. The dash check does not use git.',
    );
  }
  const newDashes = [];
  const staleBaseline = [];
  const files = new Set([...Object.keys(fileMap), ...Object.keys(baseline.lines)]);
  for (const rel of [...files].sort()) {
    const actual = dashedLines(fileMap[rel] ?? '', allowlist);
    const expected = Array.isArray(baseline.lines[rel]) ? baseline.lines[rel] : [];
    const actualBag = bag(actual);
    const expectedBag = bag(expected);
    for (const line of new Set([...actualBag.keys(), ...expectedBag.keys()])) {
      const have = actualBag.get(line) || 0;
      const want = expectedBag.get(line) || 0;
      for (let i = 0; i < have - want; i++) newDashes.push({ file: rel, text: line });
      for (let i = 0; i < want - have; i++) staleBaseline.push({ file: rel, text: line });
    }
  }
  return { newDashes, staleBaseline };
}

export function setupTokenHitsFrom(fileMap) {
  return Object.entries(fileMap)
    .filter(([, text]) => text.includes(SETUP_TOKEN))
    .map(([rel]) => rel)
    .sort();
}

export function buildBaseline(fileMap, allowlist = DASH_ALLOWLIST) {
  const lines = {};
  for (const rel of Object.keys(fileMap).sort()) {
    const found = dashedLines(fileMap[rel], allowlist);
    if (found.length) lines[rel] = found;
  }
  return {
    description:
      'Exact existing em or en dash lines per public surface. New dashed lines are refused. When a listed line is rewritten without a dash, remove that entry so the baseline only shrinks. This file is the baseline; the check does not use git.',
    lines,
  };
}
