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
const GUIDE_ID = /^guides\/([A-Za-z0-9_-]+\.md)$/;

/** The shipped guide for this doc_id, or null when it is not a shipped guide. */
export function readShippedGuide(doc_id, { dir = GUIDES_DIR } = {}) {
  const m = typeof doc_id === 'string' ? GUIDE_ID.exec(doc_id) : null;
  if (!m) return null;
  let content;
  try { content = fs.readFileSync(path.join(dir, m[1]), 'utf8'); } catch { return null; }
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

/** Names of the guides this release ships. */
export function shippedGuides({ dir = GUIDES_DIR } = {}) {
  try { return fs.readdirSync(dir).filter(f => /\.md$/.test(f)).map(f => `guides/${f}`).sort(); }
  catch { return []; }
}
