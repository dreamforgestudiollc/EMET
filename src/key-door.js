/**
 * Mint a key consent. The decision table is src/key-door-statechart.js.
 * The sub-key check is verifyPresentedKey in src/subkeys.js.
 * Scopes are read and write. They are never the owner alias `emet`.
 */

import { ISSUED_VIA } from './grants.js';
import { ValidationError } from './validation.js';
import { KEY_DOOR_CODE, keyDoorOutcome } from './key-door-statechart.js';

export const KEY_SCOPES = Object.freeze(['emet.read', 'emet.write']);

/** Subject on a key consent. It is not the owner person and it is not "owner". */
export function keySubject(tag) {
  return `key:${tag}`;
}

export function keyDoorCode() {
  return KEY_DOOR_CODE;
}

/**
 * Issue the authorization code for a key that already passed verifyPresentedKey.
 * role is secondary (passphrase and key) or key (key only).
 */
export async function issueKeyLogin(provider, { client_id, redirect_uri, code_challenge, resource, role, tag, key_id, scopes, console_grant }) {
  const decision = keyDoorOutcome({ signIn: role === 'secondary' ? 'owner_key' : 'key_only', key: 'active' });
  if (!decision.granted || decision.ownerRights || decision.attribution !== 'key_tag') {
    const error = new Error('this key consent was refused. Nothing was granted.');
    error.emetCode = KEY_DOOR_CODE;
    throw error;
  }
  const issued_via = role === 'secondary' ? ISSUED_VIA.secondary : ISSUED_VIA.key;
  const granted = Array.isArray(scopes) && scopes.length ? scopes : [...KEY_SCOPES];
  return provider.createAuthorizationCode({
    client_id,
    redirect_uri,
    code_challenge,
    scopes: granted,
    resource: resource || null,
    subject: keySubject(tag),
    issued_via,
    source_tag: tag,
    key_id,
    ...(console_grant ? { console_grant: { ...console_grant, door: role === 'secondary' ? 'secondary' : 'key' } } : {})
  });
}

/** A key consent cannot mint an invite, member access, or a setup. */
export function refuseKeyOwnerTool(actor, tool) {
  if (actor && (actor.door === 'key' || actor.door === 'secondary')) {
    const error = new ValidationError(`${tool}: a key sign-in cannot call this. Nothing was changed.`, { code: 'EMET-AUTH-046' });
    throw error;
  }
}
