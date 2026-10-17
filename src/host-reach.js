/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * The RUNE load gate lives in verification/load-gate/load-gate.mjs so
 * EMET-GEMs can vendor that file and its corpus byte-for-byte. This module
 * is the import path gem-check already uses. There is no second scan.
 */

export {
  refuseHostAccess,
  scanSource,
  hostRules,
  runeSpecifierReason,
  runeExtensionReason,
  MAX_SOURCE_BYTES,
  HOST_GLOBALS,
  OBJECT_METHODS,
  MEMBER_NAMES,
  MATH_MEMBERS
} from '../verification/load-gate/load-gate.mjs';
