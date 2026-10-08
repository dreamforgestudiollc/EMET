#!/usr/bin/env node
/**
 * Give EMET's database login the least-privilege role (docs/SETUP.md, Stage 1).
 *
 * The role is defined once, in src/atlas-role.js. This script only turns that
 * definition into MongoDB Atlas CLI calls. Default is a DRY RUN that prints the
 * commands; nothing changes until you pass --apply.
 *
 *   node scripts/atlas-role.mjs --project <projectId> --db <database> --user <dbUsername>
 *   node scripts/atlas-role.mjs ... --apply        create or update the role, move the user onto it
 *   node scripts/atlas-role.mjs ... --rollback     put the user back on readWrite@<database>
 *
 * Needs the Atlas CLI, signed in (`atlas auth login`). Set ATLAS_CLI to its path
 * if `atlas` is not on PATH. After --apply, prove it from the server:
 * emet_status with probe: true (write, read back, drop) must still pass.
 */

import { spawnSync } from 'child_process';
import { ATLAS_ROLE_NAME, atlasPrivileges } from '../src/atlas-role.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);
const project = opt('project'), db = opt('db'), user = opt('user');
const prefix = opt('prefix') || process.env.EMET_COLLECTION_PREFIX || 'emet_';
const apply = flag('apply'), rollback = flag('rollback');
if (!project || !db || !user) {
  console.error('usage: node scripts/atlas-role.mjs --project <projectId> --db <database> --user <dbUsername> [--apply | --rollback]');
  process.exit(2);
}
const CLI = process.env.ATLAS_CLI || 'atlas';

function run(argv, { mutate = false } = {}) {
  const shown = [CLI, ...argv].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  if (mutate && !apply && !rollback) { console.log(`[dry run] ${shown}`); return { status: 0, stdout: '', dry: true }; }
  console.log(`> ${shown}`);
  const r = spawnSync(CLI, argv, { encoding: 'utf8' });
  if (r.error) {
    console.error(r.error.code === 'ENOENT'
      ? `The Atlas CLI was not found as "${CLI}". Install it, or set ATLAS_CLI to its full path ` +
        `(Windows default: C:\\Program Files (x86)\\MongoDB Atlas CLI\\atlas.exe).`
      : r.error.message);
    process.exit(1);
  }
  if (r.status !== 0 && /not logged in|unauthorized/i.test(`${r.stdout}${r.stderr}`)) {
    console.error('The Atlas CLI is not signed in. Run `atlas auth login` in your own terminal first.');
    process.exit(1);
  }
  return r;
}

if (rollback) {
  const r = run(['dbusers', 'update', user, '--role', `readWrite@${db}`, '--projectId', project], { mutate: true });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  process.exit(r.status ?? 1);
}

const privileges = atlasPrivileges(db, prefix).join(',');
const exists = run(['customDbRoles', 'describe', ATLAS_ROLE_NAME, '--projectId', project, '--output', 'json']).status === 0;
const roleCmd = exists
  ? ['customDbRoles', 'update', ATLAS_ROLE_NAME, '--privilege', privileges, '--projectId', project]
  : ['customDbRoles', 'create', ATLAS_ROLE_NAME, '--privilege', privileges, '--projectId', project];
const r1 = run(roleCmd, { mutate: true });
process.stdout.write(r1.stdout || ''); process.stderr.write(r1.stderr || '');
if (r1.status !== 0) { console.error('role step failed - the user was not changed'); process.exit(1); }

// Custom roles live in the admin database in Atlas.
const r2 = run(['dbusers', 'update', user, '--role', `${ATLAS_ROLE_NAME}@admin`, '--projectId', project], { mutate: true });
process.stdout.write(r2.stdout || ''); process.stderr.write(r2.stderr || '');
if (r2.status !== 0) { console.error('user step failed - the role exists, the user is unchanged'); process.exit(1); }

console.log(apply
  ? `\nDone. Now prove it from the server: emet_status with probe: true. To undo: re-run with --rollback.`
  : `\nDry run only. Re-run with --apply to make these changes.`);
