#!/usr/bin/env node
/**
 * EMET - metadata migration: JSON string -> subdocument (2026-09-05)
 *
 * Every layer entry written before 2026-09-05 stores `metadata` as a JSON
 * string. This rewrites each such entry so `metadata` is a real subdocument.
 * Nothing else on the row is touched: content, timestamps, promoted columns,
 * provenance and sha256 all stay exactly as they were.
 *
 * Rows whose metadata is NULL (72 of them, written by the Telegram bridge in
 * April 2026 and carrying no metadata at all) are normalised to {} under the
 * same backup and read-back, and counted separately. Null held nothing; {}
 * holds nothing; the difference is that every row now has one shape.
 *
 * SAFETY, in order:
 *   1. Dry-run by default. Pass --apply to write.
 *   2. Before the first write to a layer, every row that will change is copied
 *      whole into <prefix><layer>_metadata_backup_<stamp>. Rollback is a $set
 *      of `metadata` from that backup, per _id - recoverable by construction.
 *   3. A string that does not parse to a plain object is SKIPPED and reported,
 *      never guessed at. The row keeps its string; parseMetadata() reads it
 *      as {} at query time, which is what it did before this script existed.
 *   4. After writing, every migrated row is read back and its stored object
 *      deep-compared to the parse of the original string. Rows carrying a
 *      sha256 column are additionally checked digest(content) == sha256, so a
 *      touch that somehow altered content would be caught.
 *   5. Exit non-zero if any verification fails.
 *
 * Environment: MONGODB_URI, MONGODB_DB, EMET_COLLECTION_PREFIX - the same three
 * the server uses. Connects through EmetDatabase so the public-DNS fallback
 * for refused SRV lookups applies.
 */

import { EmetDatabase, COLLECTION_PREFIX, MONGODB_DB } from '../src/database.js';
import { VALID_LAYERS } from '../src/validation.js';
import { digest } from '../src/aleph.js';
import { isDeepStrictEqual } from 'util';

const APPLY = process.argv.includes('--apply');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function parseStrict(str) {
  try {
    const v = JSON.parse(str);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

async function main() {
  const dbm = new EmetDatabase(null);
  const db = await dbm.ensureClient();
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} - database ${MONGODB_DB}, prefix ${COLLECTION_PREFIX}`);

  const report = [];
  let failures = 0;

  for (const layer of VALID_LAYERS) {
    const name = `${COLLECTION_PREFIX}${layer}`;
    const col = db.collection(name);
    const total = await col.countDocuments({});
    const legacy = await col.find({ metadata: { $type: 'string' } }).toArray();
    const nulls = await col.find({ metadata: { $type: 'null' } }).toArray();
    const alreadyObject = await col.countDocuments({ metadata: { $type: 'object' } });
    const other = total - legacy.length - nulls.length - alreadyObject;

    const plan = [];
    const skipped = [];
    for (const doc of legacy) {
      const parsed = parseStrict(doc.metadata);
      if (parsed === null) skipped.push({ id: doc.id, _id: String(doc._id), reason: 'metadata string does not parse to a plain object' });
      else plan.push({ _id: doc._id, id: doc.id, original: doc.metadata, parsed, sha256: doc.sha256 || null, from: 'string' });
    }
    for (const doc of nulls) {
      plan.push({ _id: doc._id, id: doc.id, original: null, parsed: {}, sha256: doc.sha256 || null, from: 'null' });
    }

    const row = { layer, total, legacy_strings: legacy.length, null_to_empty: nulls.length, already_object: alreadyObject, other_shape: other,
                  to_migrate: plan.length, skipped: skipped.length };

    if (APPLY && plan.length) {
      // 2. backup, whole rows, before any write
      const backupName = `${name}_metadata_backup_${STAMP}`;
      const backup = db.collection(backupName);
      const ids = plan.map(p => p._id);
      const rows = await col.find({ _id: { $in: ids } }).toArray();
      if (rows.length !== plan.length) throw new Error(`${name}: backup read returned ${rows.length} of ${plan.length}`);
      await backup.insertMany(rows.map(r => ({ ...r, _backup_of: name, _backup_at: new Date() })), { ordered: false });
      const backedUp = await backup.countDocuments({});
      if (backedUp !== plan.length) throw new Error(`${name}: backup holds ${backedUp}, expected ${plan.length}`);
      row.backup_collection = backupName;

      // write
      const ops = plan.map(p => ({ updateOne: { filter: { _id: p._id, metadata: { $type: p.from } }, update: { $set: { metadata: p.parsed } } } }));
      const res = await col.bulkWrite(ops, { ordered: false });
      row.modified = res.modifiedCount;
      if (res.modifiedCount !== plan.length) { failures++; row.error = `modified ${res.modifiedCount}, expected ${plan.length}`; }

      // 4. read back every migrated row
      const after = await col.find({ _id: { $in: ids } }).toArray();
      const byId = new Map(after.map(d => [String(d._id), d]));
      let mismatched = 0, digestBad = 0;
      for (const p of plan) {
        const d = byId.get(String(p._id));
        if (!d || typeof d.metadata !== 'object' || !isDeepStrictEqual(d.metadata, p.parsed)) mismatched++;
        if (p.sha256 && d && digest(d.content) !== p.sha256) digestBad++;
      }
      row.readback_mismatch = mismatched;
      row.digest_mismatch = digestBad;
      row.strings_remaining = await col.countDocuments({ metadata: { $type: 'string' } });
      row.nulls_remaining = await col.countDocuments({ metadata: { $type: 'null' } });
      row.objects_now = await col.countDocuments({ metadata: { $type: 'object' } });
      if (mismatched || digestBad || row.strings_remaining !== skipped.length || row.nulls_remaining !== 0 || row.objects_now + skipped.length !== total) failures++;
    }

    if (skipped.length) row.skipped_ids = skipped;
    report.push(row);
  }

  console.table(report.map(({ skipped_ids, ...r }) => r));
  for (const r of report) if (r.skipped_ids) console.log(`SKIPPED in ${r.layer}:`, JSON.stringify(r.skipped_ids));
  await dbm.closeAll();

  if (failures) { console.error(`\nVERIFICATION FAILED in ${failures} layer(s).`); process.exit(1); }
  console.log(APPLY ? '\nMigration applied and verified.' : '\nDry run only - nothing written. Re-run with --apply.');
}

main().catch(e => { console.error(e); process.exit(2); });
