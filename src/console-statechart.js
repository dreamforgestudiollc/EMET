/**
 * EMET Console doors.
 *
 * The owner signs in with the admin password. A key signs in through the
 * key door and cannot open an owner view. Remember this phone is opt-in.
 * Served on /statechart. The picture is docs/console-statechart.md.
 * The model is specs/tla/EmetConsole.tla.
 */

export const CONSOLE_SOURCE_TAG = 'emet-console';
export const CONSOLE_KEY_CODE = 'EMET-AUTH-046';

export const CONSOLE_MERMAID = `stateDiagram-v2
  [*] --> SignedOut
  SignedOut --> OwnerSession: admin password, remember unticked
  SignedOut --> OwnerRemembered: admin password, remember ticked
  SignedOut --> KeySession: key door
  SignedOut --> Refused: connect passphrase on the console scope
  OwnerSession --> OwnerView: open a view
  OwnerRemembered --> OwnerView: open a view
  OwnerView --> Note: add note tagged emet-console
  KeySession --> Refused: owner view, EMET-AUTH-046, nothing served
  OwnerRemembered --> OwnerSession: refresh, step-up stays unset
  OwnerRemembered --> Refused: stale password, bad signature, reuse, or expiry
  KeySession --> Refused: refresh row with no key id
  OwnerSession --> SignedOut: sign out or admin password rotated
  OwnerRemembered --> SignedOut: sign out, rotate, or break-glass
  KeySession --> SignedOut: sign out, revoke, or break-glass`;

export const CONSOLE_STEPS = Object.freeze([
  'SignedOut is the phone before a console login. The access token lasts 15 minutes. Without remember this phone, closing the app means signing in again.',
  'OwnerSession is the admin password, not the connect passphrase. The token is bound to this server\'s /console/api and to scope emet.console. An MCP token is refused here, and a console token is refused on /mcp.',
  'OwnerRemembered is the same owner session plus one refresh row for this phone. The box is unticked unless the person ticks it on the server\'s sign-in page. The row stores a hash of the refresh token and the device public key.',
  'A refresh signs the server nonce and the time with the device key, rotates the refresh token, and re-checks the admin-password version. It never sets step-up. A refused refresh deletes the row and returns nothing.',
  'KeySession is the key door with scope emet.console. Every owner route refuses it with EMET-AUTH-046 and serves nothing. A key-door refresh row with no key id is refused and deleted.',
  'Note is save_to_layer through dispatch.js. The source is emet-console. The person and the door come from the login. An unregistered emet-console tag is refused and nothing is written. STATE.md and HANDOFF.md stay read-only.',
  'Sign out, admin-password rotation, key revoke, and break-glass delete the console session and the refresh row together. A later call and a later refresh both fail.'
]);

export const CONSOLE_RULES = Object.freeze([
  'ConsoleIsOwnerOnly: an owner view is served only for an owner session whose admin-password version is current.',
  'KeySessionCannotReachOwnerViews: a key session never becomes an owner view.',
  'NoConsoleAfterLogoutOrRotate: after sign-out or password rotation the owner view is gone.',
  'ConsoleWriteAttributed: a console note is tagged emet-console and written by the owner.',
  'ConsoleNeverMintsAccess: phase 1 mints no key, invite, or approval.',
  'PrivilegedActionRequiresStepUp: a privileged action requires a password step-up. Phase 1 performs none.',
  'RevokeTakesEffectImmediately: revoking a key deletes its console token and its refresh row in the same step.',
  'RememberIsOptIn: a refresh row exists only after the remember box was ticked.',
  'StepUpOnlyByPassword: step-up is unset or was opened by the admin password. Refresh never opens it.',
  'NoOwnerRefreshAfterRotate: an owner refresh row still present carries the current admin-password version.',
  'SessionNeedsLiveCredential: an owner session matches the current password version. A key session names a live key.',
  'LogoutEndsRemember: after sign-out there is no session and no refresh row.',
  'ServerIsolation: a request for a server uses only the token that server issued.',
  'TokenBoundToIssuer: a token is refused by any server that did not mint it.',
  'NoMixedViews: the screen shows one server. Switching servers clears it.'
]);
