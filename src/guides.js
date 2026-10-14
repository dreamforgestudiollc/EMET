/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Shipped guides.
 *
 * Reference documents that ship with the release and are read on demand with
 * read_doc('guides/<NAME>.md') - never pasted into emet_initialize. The floor
 * carries the rules; a guide carries the understanding and method behind them.
 * Like the charter, the shipped copy governs: an install's store cannot
 * overwrite or lose it, and a brand-new store can read it before any setup.
 *
 * Only a bare file name under guides/ is accepted, so a doc_id cannot walk out
 * of the folder.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveModulePath } from './module-path.js';

export const GUIDES_DIR = resolveModulePath(import.meta.url, ['..', 'guides']);
const GEMS_DIR = resolveModulePath(import.meta.url, ['..', 'gems']);
const GUIDE_ID = /^guides\/([A-Za-z0-9_-]+\.md)$/;

/**
 * One release: the old neurodivergent guide id resolves to the Neurendipity
 * copy. There is one file. This map is not a second copy of the text.
 */
const GUIDE_ALIAS = Object.freeze({
  'guides/NEURODIVERGENT_SUPPORT.md': resolveModulePath(import.meta.url, ['..', 'gems', 'neurendipity', 'guides', 'NEURODIVERGENT_SUPPORT.md'])
});

/** The shipped guide for this doc_id, or null when it is not a shipped guide. */
export function readShippedGuide(doc_id, { dir = GUIDES_DIR } = {}) {
  const m = typeof doc_id === 'string' ? GUIDE_ID.exec(doc_id) : null;
  if (!m) return null;
  const file = Object.prototype.hasOwnProperty.call(GUIDE_ALIAS, doc_id) ? GUIDE_ALIAS[doc_id] : path.join(dir, m[1]);
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch {
    // A bundled GEM's own guide (2026-10-12: Neurendipity's floor points to
    // read_doc('guides/AUTISTIC_BURNOUT.md'), which no folder served). Only the
    // default shipped dir falls through, and only to bundled gems/<id>/guides/.
    if (dir !== GUIDES_DIR) return null;
    content = null;
    let gems = [];
    try { gems = fs.readdirSync(GEMS_DIR).filter((g) => /^[a-z0-9-]+$/.test(g)).sort(); } catch { gems = []; }
    for (const g of gems) {
      try { content = fs.readFileSync(path.join(GEMS_DIR, g, 'guides', m[1]), 'utf8'); break; } catch { /* next */ }
    }
    if (content === null) return null;
  }
  return {
    doc_id,
    content,
    sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    size: content.length,
    source: 'release',
    governed_by: 'the copy shipped with this release',
    note: 'A shipped guide: read on demand, never loaded at startup. The release copy governs.'
  };
}

/** Names of the guides this release ships. The one-release alias is included. */
export function shippedGuides({ dir = GUIDES_DIR } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => /\.md$/.test(f)).map(f => `guides/${f}`); }
  catch { names = []; }
  for (const id of Object.keys(GUIDE_ALIAS)) {
    if (!names.includes(id) && fs.existsSync(GUIDE_ALIAS[id])) names.push(id);
  }
  return names.sort();
}
