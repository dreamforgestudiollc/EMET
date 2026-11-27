/**
 * Key sign-in doors.
 *
 * Three consents:
 *   passphrase  — the primary owner, no sub-key
 *   owner_key   — the passphrase and a sub-key (a secondary owner)
 *   key_only    — a sub-key and its source tag (a bot, a member, or a guest)
 *
 * A key-only session and a secondary session write as the key's tag.
 * Neither has owner rights. The passphrase consent does not read a key.
 * Served on /statechart. The picture is docs/key-door-statechart.md.
 * The model is verification/key-door/KeyDoor.tla.
 */

export const KEY_DOOR_CODE = 'EMET-AUTH-046';

export const KEY_DOOR_MERMAID = `stateDiagram-v2
  [*] --> Passphrase: connect passphrase
  Passphrase --> PrimaryOwner: no sub-key on this consent
  PrimaryOwner --> OwnerRights: login tag is owner
  [*] --> OwnerAndKey: passphrase and sub-key
  OwnerAndKey --> Secondary: active key, tag registered, tag matches
  Secondary --> TagWriter: attribution is the key tag
  OwnerAndKey --> Refused: revoked, expired, unregistered, or a different tag
  [*] --> KeyOnly: sub-key and source tag
  KeyOnly --> KeyLogin: active key, tag registered, tag matches
  KeyLogin --> TagWriter: no owner rights
  KeyOnly --> Refused: revoked, expired, unregistered, or a different tag
  TagWriter --> Refused: revoke or expiry ends the consent
  TagWriter --> TagWriter: a later sign-in replaces that consent`;

export const KEY_DOOR_STEPS = Object.freeze([
  'Passphrase is the primary owner. The consent carries no sub-key. The login tag stays owner. Owner rights stay on that consent. A sub-key presented later on that login does not move the login tag.',
  'OwnerAndKey is the passphrase plus a sub-key. The key must be active, its tag must be registered, and the posted tag must be the tag on the key. The session writes as that tag. It does not receive owner rights.',
  'KeyOnly is a sub-key and its source tag, with no passphrase. The same key checks apply. The session writes as that tag. It does not receive owner rights. A bot, a member, and a guest use this consent.',
  'A revoked key, an expired key, a tag that is not registered, a posted tag that is not the tag on the key, and a missing key are refused. Nothing is granted. The message names the tag that failed.',
  'An empty consent grants nothing. The passphrase consent is the one that grants owner rights.',
  'A granted key consent is bound to that key. One key has one live consent. A later sign-in for the same key replaces the previous consent. Revoke and expiry end it. A write and a refresh after that are refused.'
]);

export const KEY_DOOR_SIGN_INS = Object.freeze(['passphrase', 'owner_key', 'key_only', 'absent']);
export const KEY_DOOR_KEYS = Object.freeze(['none', 'active', 'revoked', 'expired', 'unregistered', 'mismatch']);

/** Which sign-in the posted fields are. A passphrase with a key is owner_key. */
export function classifyKeySignIn({ passphrase, subkey } = {}) {
  const hasKey = typeof subkey === 'string' && subkey.trim().length > 0;
  const hasPass = typeof passphrase === 'string' && passphrase.trim().length > 0;
  if (hasKey && hasPass) return 'owner_key';
  if (hasKey) return 'key_only';
  if (hasPass) return 'passphrase';
  return 'absent';
}

/** The passphrase door and an empty post only pair with key none. */
export function keyDoorLegal(signIn, key) {
  if (signIn === 'passphrase' || signIn === 'absent') return key === 'none';
  return KEY_DOOR_SIGN_INS.includes(signIn) && KEY_DOOR_KEYS.includes(key);
}

/**
 * One cell. Passphrase ignores the key class and stays the primary owner.
 * owner_key and key_only grant a tag writer only for an active, registered, matching key.
 */
export function keyDoorOutcome({ signIn, key }) {
  if (signIn === 'passphrase') {
    return { signIn, key, role: 'primary', ownerRights: true, attribution: 'owner_login', granted: true };
  }
  if ((signIn === 'owner_key' || signIn === 'key_only') && key === 'active') {
    return {
      signIn,
      key,
      role: signIn === 'owner_key' ? 'secondary' : 'key',
      ownerRights: false,
      attribution: 'key_tag',
      granted: true
    };
  }
  return { signIn, key, role: 'refused', ownerRights: false, attribution: 'none', granted: false };
}

/** The legal rows. Fourteen. */
export function keyDoorRows() {
  const rows = [];
  for (const signIn of KEY_DOOR_SIGN_INS) {
    for (const key of KEY_DOOR_KEYS) {
      if (!keyDoorLegal(signIn, key)) continue;
      rows.push(keyDoorOutcome({ signIn, key }));
    }
  }
  return rows;
}

/**
 * After a live key consent. write is allowed only while the key is active.
 * revoke and expire close the consent. replace keeps one live consent.
 * A write on a closed consent is refused.
 */
export function keyConsentStep(state, event) {
  const live = state && state.phase === 'live' && state.granted === true && state.key === 'active'
    && (state.role === 'key' || state.role === 'secondary');
  if (!live) {
    return { ...state, phase: 'closed', granted: false, consents: 0, last: 'refused' };
  }
  if (event === 'write') return { ...state, phase: 'live', consents: 1, wrote: true, last: 'write' };
  if (event === 'replace') return { ...state, phase: 'live', consents: 1, last: 'replace' };
  if (event === 'revoke') return { ...state, phase: 'closed', key: 'revoked', granted: false, consents: 0, last: 'revoke' };
  if (event === 'expire') return { ...state, phase: 'closed', key: 'expired', granted: false, consents: 0, last: 'expire' };
  return { ...state, phase: 'closed', granted: false, consents: 0, last: 'refused' };
}
