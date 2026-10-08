/**
 * EMET - the least-privilege MongoDB Atlas role for the server's own login
 * (2026-09-29; security audit question 9).
 *
 * The record is retained, never deleted (the owner's rule, 2026-09-08). Until
 * this role existed that rule lived only in the code: the server's login held
 * readWrite on its database, so the database itself would have allowed any
 * holder of the connection string to remove documents or drop collections.
 *
 * This is the one statement of what the server may do. scripts/atlas-role.mjs
 * builds the Atlas CLI commands from it, docs/ATLAS.md explains it, and
 * tests/atlas-role.test.js fails if the code ever deletes from a collection
 * this role does not allow - so a new delete forces a visible decision here
 * rather than a silent breakage in production.
 *
 * Deletes EMET performs, read from src/ on 2026-09-29, and why each is allowed:
 *   - emet_oauth_tokens: revoking a sign-in token (oauth-provider.js). Tokens
 *     are credentials, not the record.
 *   - _emet_verify: the status probe writes one document, reads it back, and
 *     deletes that document (setup.js verifyConnection). The collection stays.
 * Everything else - memory layers, documents, their history, transcripts - is
 * find / insert / update only.
 */

export const ATLAS_ROLE_NAME = 'emetRecordKeeper';

/** Actions on the whole EMET database (Atlas action names). No REMOVE, no DROP. */
export const DATABASE_ACTIONS = Object.freeze([
  'FIND', 'INSERT', 'UPDATE',
  'CREATE_COLLECTION', 'CREATE_INDEX',
  'LIST_COLLECTIONS', 'LIST_INDEXES', 'COLL_STATS', 'DB_STATS',
  // Added 2026-09-29 after the first apply: without it emet_status cannot name
  // the vector index (search itself needs only FIND and kept working).
  'LIST_SEARCH_INDEXES'
]);

/**
 * The only collections the server may delete from, and what it may do there.
 * `{prefix}` is the install's EMET_COLLECTION_PREFIX (default `emet_`): the
 * OAuth store is prefixed, the probe collection is not.
 */
export const DELETE_ALLOWED = Object.freeze({
  '{prefix}oauth_tokens': Object.freeze(['REMOVE']),
  _emet_verify: Object.freeze(['REMOVE'])
});

/** Privileges in the Atlas CLI form ACTION@db or ACTION@db.collection. */
export function atlasPrivileges(dbName, prefix = 'emet_') {
  if (!dbName || typeof dbName !== 'string' || /[\s@.]/.test(dbName)) throw new Error('database name must be a plain name');
  if (typeof prefix !== 'string' || /[\s@.]/.test(prefix)) throw new Error('prefix must be a plain name');
  const out = DATABASE_ACTIONS.map((a) => `${a}@${dbName}`);
  for (const [col, actions] of Object.entries(DELETE_ALLOWED)) {
    for (const a of actions) out.push(`${a}@${dbName}.${col.replace('{prefix}', prefix)}`);
  }
  return out;
}

export default { ATLAS_ROLE_NAME, DATABASE_ACTIONS, DELETE_ALLOWED, atlasPrivileges };
