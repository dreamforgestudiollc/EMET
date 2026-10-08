/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * metadata: ONE place that knows the field has had two shapes.
 *
 * Until 2026-09-05 every layer entry stored `metadata` as a JSON STRING. Mongo
 * cannot see inside a string, so nothing in it was queryable or indexable -
 * `metadata.superseded_by` matched zero documents (probe, 2026-08-24). Two
 * fields that bit in practice, superseded_by and valid_until, were promoted to
 * top-level columns as a targeted fix; the provenance pointer was written
 * top-level from the start for the same reason. That fixed instances. This
 * fixes the class: metadata is now stored as a real subdocument, and the
 * corpus was migrated (scripts/migrate_metadata_to_subdocument.mjs).
 *
 * Readers still go through parseMetadata() rather than trusting the shape,
 * because a store that was never migrated - or one document a migration
 * skipped - must read correctly rather than throw. Tolerance on read is what
 * makes the write-side change safe to ship ahead of the migration.
 */

/**
 * Return metadata as an object whatever shape it was stored in.
 * - object  -> returned as-is
 * - string  -> JSON.parse; an unparseable string yields {} (the read must not
 *              throw over one bad row, and nothing is lost - the row is untouched)
 * - null / undefined / anything else -> {}
 */
export function parseMetadata(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

/** True when a stored metadata value is the pre-2026-09-05 JSON-string shape. */
export function isLegacyMetadataString(value) {
  return typeof value === 'string';
}

/**
 * Is this a column the SQL dialect may translate? Top-level columns come from
 * the caller's whitelist; metadata sub-paths are allowed because the field is a
 * subdocument now, provided the path is plain identifier segments - no operators,
 * no `$`, nothing that could be read by Mongo as anything but a field path.
 */
const METADATA_PATH = /^metadata(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
export function isMetadataPath(col) {
  return typeof col === 'string' && METADATA_PATH.test(col);
}

export default { parseMetadata, isLegacyMetadataString, isMetadataPath };
