/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * A module URL is not a filesystem path. On Windows, `new URL(href).pathname`
 * is `/C:/...`. `path.resolve` against a working directory on `C:` then joins
 * that into `C:\C:\...`, and opening the file fails. `fileURLToPath` decodes
 * the URL first; `path.resolve` walks from that path's directory.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of a file URL, then any relative segments. A leading `..`
 * leaves the module's own directory.
 *
 * `opts.path` and `opts.toPath` exist so a test can pass `path.win32` and a
 * Windows `fileURLToPath` without running on Windows. Production callers omit
 * them and get the host path module.
 *
 * @param {string|URL} fileUrl
 * @param {string[]} [segments]
 * @param {{ path?: typeof path, toPath?: (url: string|URL) => string }} [opts]
 */
export function resolveModulePath(fileUrl, segments = [], opts = {}) {
  const pathImpl = opts.path || path;
  const toPath = opts.toPath || fileURLToPath;
  return pathImpl.resolve(pathImpl.dirname(toPath(fileUrl)), ...segments);
}
