/**
 * Temp GEM directories for the conformance suites. Not a suite.
 * The example under gem-library/examples is copied, never modified in place.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../gem-library/examples/neurendipity');

export function sha256(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

export async function syncDigests(dir, manifest) {
  for (const entry of manifest.files) {
    const buf = await fs.promises.readFile(path.join(dir, ...entry.path.split('/')));
    entry.size = buf.length;
    entry.digest = sha256(buf);
  }
  await fs.promises.writeFile(path.join(dir, 'gem.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** A copy of the example. Directory name is neurendipity, which matches its id. */
export async function tempGem() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'emet-gem-'));
  const dir = path.join(root, 'neurendipity');
  await fs.promises.cp(EXAMPLE, dir, { recursive: true });
  const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'gem.json'), 'utf8'));
  return {
    root,
    dir,
    manifest,
    save: (sync = true) => (sync ? syncDigests(dir, manifest) : fs.promises.writeFile(path.join(dir, 'gem.json'), JSON.stringify(manifest, null, 2) + '\n')),
    cleanup: () => fs.promises.rm(root, { recursive: true, force: true })
  };
}

/**
 * A release-shaped gems/ root. Each id gets a copy of the example, retargeted
 * at >=0.2.4 so SR-06 is not the reason under test. alter() may change the
 * manifest or the files; digests are rewritten after it returns.
 */
export async function tempRelease(ids, alter) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'emet-gems-'));
  for (const id of ids) {
    const dir = path.join(root, id);
    await fs.promises.cp(EXAMPLE, dir, { recursive: true });
    const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'gem.json'), 'utf8'));
    manifest.id = id;
    manifest.name = id;
    manifest.requires = { emet: '>=0.2.4' };
    if (alter) await alter(manifest, dir, id);
    await syncDigests(dir, manifest);
  }
  return { root, cleanup: () => fs.promises.rm(root, { recursive: true, force: true }) };
}

/** A floor document of about `target` raw bytes, still a valid floor shape. */
export function floorDocument(target) {
  const body = {
    sections: { reading_people: { title: 'T', note: 'N', lines: { a: '' } } },
    reassertion: ['Stay.']
  };
  let lo = 0;
  let hi = target;
  let best = JSON.stringify(body);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    body.sections.reading_people.lines.a = 'x'.repeat(mid);
    const text = JSON.stringify(body);
    const n = Buffer.byteLength(text);
    if (n === target) return text;
    if (n < target) { best = text; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

export function rune(name, extra = {}) {
  return {
    name,
    description: 'Reads one layer and writes nothing.',
    inputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    reads: ['semantic'],
    writes: [],
    network: 'none',
    ...extra
  };
}
