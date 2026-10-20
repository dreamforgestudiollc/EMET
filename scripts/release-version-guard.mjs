#!/usr/bin/env node
/**
 * Fail unless the release tag is vX.Y.Z and names the same version as package.json.
 *
 *   RELEASE_TAG=v0.2.5 node scripts/release-version-guard.mjs
 *   node scripts/release-version-guard.mjs v0.2.5 [package.json]
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Empty when the tag is exactly v plus an X.Y.Z package version. Otherwise the reason to fail. */
export function releaseTagMismatch(tag, version) {
  const versionText = typeof version === 'string' ? version : '';
  const expected = `v${versionText}`;
  if (/^\d+\.\d+\.\d+$/.test(versionText) && tag === expected) return '';
  return `release tag ${JSON.stringify(tag ?? '')} does not match package.json version ${JSON.stringify(versionText)} (expected ${expected})`;
}

/** Empty when the tag is missing or names HEAD. Otherwise the reason to fail. */
export function releaseTagCommitFault(tagCommit, head) {
  const at = typeof tagCommit === 'string' ? tagCommit.trim() : '';
  const here = typeof head === 'string' ? head.trim() : '';
  if (!at) return '';
  if (at === here) return '';
  return `release tag is at ${at}, which is not HEAD ${here}`;
}

function gitOut(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function main() {
  const tag = process.argv[2] ?? process.env.RELEASE_TAG ?? '';
  const pkgPath = process.argv[3] ?? path.join(ROOT, 'package.json');
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch (err) {
    console.error(`could not read package.json version from ${pkgPath}: ${err.message}`);
    process.exit(1);
  }
  const fault = releaseTagMismatch(tag, version);
  if (fault) {
    console.error(fault);
    process.exit(1);
  }
  if (!process.argv[3]) {
    const server = JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8'));
    const glama = JSON.parse(fs.readFileSync(path.join(ROOT, 'glama.json'), 'utf8'));
    const listed = server.packages && server.packages[0] ? server.packages[0].version : '';
    if (server.version !== version || listed !== version || glama.version !== version) {
      console.error(`package.json ${version}, server.json ${server.version}/${listed} and glama.json ${glama.version} do not agree`);
      process.exit(1);
    }
  }
  const repo = process.env.EMET_GUARD_REPO || ROOT;
  const commitFault = releaseTagCommitFault(gitOut(repo, ['rev-list', '-n1', tag]), gitOut(repo, ['rev-parse', 'HEAD']));
  if (commitFault) {
    console.error(commitFault);
    process.exit(1);
  }
  console.log(`release tag ${tag} matches package.json ${version}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
