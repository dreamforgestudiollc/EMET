/**
 * EMET - persons
 *
 * A person is who logged in. A host-tag is which door they used.
 * Tokens used to carry subject: "owner" for every connection. That cannot
 * scale to a second human. This module is the first cut: one owner person
 * in a `persons` collection, and a subject resolver the token issuer calls.
 *
 * Invitation, membership, and scopes on dispatch are later cuts.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const COLLECTION = 'persons';
/** Stdio has no login. Every local write is stamped with this one subject. */
export const LOCAL_SUBJECT = 'local';
export const actorStore = new AsyncLocalStorage();
export function currentActor() {
  const s = actorStore.getStore();
  if (typeof s === 'string' && s.trim()) return { personId: s.trim(), scopes: [] };
  if (s && typeof s === 'object') {
    return {
      personId: s.personId || null,
      clientId: s.clientId || null,
      scopes: Array.isArray(s.scopes) ? s.scopes : [],
      transport: s.transport || null,
      authenticated: s.authenticated === true
    };
  }
  return { personId: null, clientId: null, scopes: [], transport: null, authenticated: false };
}
export function currentPersonId() {
  return currentActor().personId;
}
export function currentClientId() {
  const s = actorStore.getStore();
  if (!s || typeof s === 'string') return 'stdio';
  return s.clientId === undefined ? 'stdio' : s.clientId;
}

/** Server stamp only. A caller value is never read. Stdio is one fixed local subject. */
export function writerStamp() {
  const s = actorStore.getStore();
  if (!s || typeof s === 'string') {
    const id = typeof s === 'string' && s.trim() ? s.trim() : LOCAL_SUBJECT;
    return { person_id: id, client_id: 'stdio' };
  }
  if (s.transport === 'http') {
    return { person_id: s.personId || null, client_id: s.clientId === undefined ? null : s.clientId };
  }
  return { person_id: s.personId || LOCAL_SUBJECT, client_id: s.clientId === undefined ? 'stdio' : s.clientId };
}

/**
 * HTTP binds a source tag at approval. Returns that tag (or null when none
 * was bound). Returns undefined on stdio, where the caller tag is checked
 * against EMET_SOURCE_TAGS instead.
 */
export function boundSourceTag() {
  const s = actorStore.getStore();
  if (!s || typeof s !== 'object' || s.transport !== 'http') return undefined;
  const tag = typeof s.sourceTag === 'string' ? s.sourceTag.trim() : '';
  return tag || null;
}

export function displayNameFromUserDoc(text) {
  const heading = String(text || '').match(/^#\s+User Profile\s+[\u2014\u2013-]\s+(.+)$/im);
  if (heading) return heading[1].trim();
  return null;
}

export function slugPersonId(name) {
  const s = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'owner';
}

export async function ensureOwnerPerson(db, { display_name } = {}) {
  const col = db.collection(COLLECTION);
  const existing = await col.findOne({ role: 'owner' });
  if (existing) return existing;
  const person_id = slugPersonId(display_name);
  const row = {
    person_id,
    display_name: String(display_name || person_id).trim() || person_id,
    role: 'owner',
    created_at: new Date()
  };
  await col.insertOne(row);
  return row;
}

/** Subject stamped on new tokens. Falls back to "owner" if the table is empty. */
export async function resolveTokenSubject(db) {
  if (!db) return 'owner';
  const owner = await db.collection(COLLECTION).findOne({ role: 'owner' });
  return owner?.person_id || 'owner';
}

/** Person on this request, from the bearer token. Host-tags stay separate. */
export function personFromAuth(extra) {
  const info = extra && extra.authInfo;
  const s = (info && info.extra && info.extra.subject) || (info && info.subject);
  if (typeof s === 'string' && s.trim()) return s.trim();
  return null;
}

export async function getPerson(db, person_id) {
  if (!db || !person_id) return null;
  return db.collection(COLLECTION).findOne({ person_id });
}
