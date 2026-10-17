# Authoring a GEM (Golem Expertise Module)

Read [SPEC.md](SPEC.md) and [CONFORMANCE.md](CONFORMANCE.md) first. This page is the short path. The specification wins if they disagree.

A GEM is a folder. The folder name is the `id`. You may write one. You may not change the standard, the schema, or the socket rules. Those change only by a GEP that Alex accepts.

## 1. Choose the id and the kind

- `kind` `gem`: engagement lines and guides. No tools, no code.
- `kind` `runed-gem`: the same, plus one or more RUNED directives (declared, registered tools).

`id` is lowercase letters, digits, and hyphens, starting with a letter. The reference id is `neurendipity`.

## 2. Write floor.json

Shape:

```json
{
  "sections": {
    "your_section": {
      "title": "Short title",
      "note": "One sentence on when these lines apply.",
      "lines": {
        "your_line": "One rule, in plain words."
      }
    }
  },
  "reassertion": ["The short form of the lines worth re-reading."]
}
```

Use your own section keys. Do not use `voice`, `engagement`, `persistence`, `corpus_discipline`, or `operating_discipline`. Those are core. A GEM adds lines. It does not replace the core object.

Leave `overrides` empty unless the GEM changes a modifiable default (pace, how much is explained, a voice style line that is not a protection). Naming a core protection path is a failed check. Text that tells the model to drop a protection fails the floor-negation lint. See the pattern list in [CONFORMANCE.md](CONFORMANCE.md).

The floor file is served at startup when the GEM is on. Keep it under 8,192 bytes. Put method and background in a guide.

## 3. Add guides

Put markdown under `guides/`. One file is at most 64 KiB. At most 16 guides. Guides are read on demand. They are not part of startup.

Text files use LF line endings. The digest is of those exact bytes.

## 4. Declare RUNED directives, if this is a RUNED GEM

Each entry in `runes` has:

- `name`, `description`, `execution` (`client`), `artifact` (a `runes/*.js` file listed in `files`), `sha256`, `version` (the GEM semver), `runtime`, `inputSchema` (a JSON Schema with `"type": "object"`), and `outputSchema`
- `annotations.readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, all present. EMET does not fill in MCP's defaults. `readOnlyHint` is `true`. `destructiveHint` is `false` (EMET does not delete). `openWorldHint` is `false`. `network` is `none`.
- `reads` and `writes`: both empty. A client RUNE does not touch the store.

Code, if you ship any, lives under `runes/` and is listed in `files`. A client RUNE does not import `emet/rune`. Another file inside the same GEM is allowed only when it is also listed. No database client, no network, no `fs`, no dynamic import, no runtime dependencies, no lockfile, no `node_modules`. `reads` and `writes` are empty.

A prompt GEM has `"runes": []` and no code files.

The socket does not execute RUNED code. A client RUNE is a pure function of the inputs the caller passes in. [CONFORMANCE.md](CONFORMANCE.md) GC-19 checks the artifact hash and the manifest, and scans the code at load. The client runs the code, and only while that GEM is on. See [GEP-0003](proposals/GEP-0003-client-side-execution.md). Declaring the directive is required, so the shape stays stable.

## 5. Write gem.json

Match [gem.schema.json](gem.schema.json). Set `spec` to `2026-10-12`. Set `distribution` to `bundled` only if the GEM will ship inside an EMET release. A GEM you submit for other people to use is `library`, and it needs a signature (below). `changelog` is optional. `update` is optional: an object describing how this version relates to the previous one. `class` `initial` means the first release. The socket does not read either field.

`defaultOn` for Neurendipity is `false`. Follow that unless Alex has accepted a GEP that says otherwise for your GEM. `priority` is an integer from 0 to 100.

`files` lists every content file except `gem.json`, each with `digest` and `size`.

Digest and size, from the GEM directory:

```bash
node -e "const fs=require('fs');const c=require('crypto');const b=fs.readFileSync(process.argv[1]);console.log('sha256:'+c.createHash('sha256').update(b).digest('hex'), b.length)" floor.json
```

Repeat for each guide and each rune file. If you edit a file, recompute. A mismatch fails the check.

## 6. Sign a library GEM

Bundled GEMs in an EMET release are pinned by the hashes and by living in that release's `gems/` directory. A library GEM also carries `signature`:

1. Drop the `signature` member.
2. Serialize the rest with RFC 8785 (JSON Canonicalization Scheme).
3. Sign those UTF-8 bytes with Ed25519.
4. Set `alg` to `Ed25519`, `keyid` to a key in the checker's trust store, and `value` to the standard base64 of the 64-byte signature.

Do not put `keys.json` in the GEM. The trust store ships with `gem-check`. Alex holds the keys. A signature you make with a key you invented will not verify.

## 7. Check it

Until `gem-check` exists, walk [CONFORMANCE.md](CONFORMANCE.md) by hand. When it exists:

```bash
gem-check path/to/your-gem
```

Exit 0 is required and is not acceptance.

## 8. How it reaches a running EMET

- **Bundled, including Neurendipity.** It ships in an EMET release under `gems/<id>/`, after Alex accepts the change. The example in `examples/neurendipity/` is a shape to copy, not the folder the server loads.
- **Anyone else's GEM.** When the public submission repository exists, open a pull request there with the GEM folder. `gem-check` runs on the pull request. Alex reviews after it passes. EMET loads it only once that acceptance is on the library list the release trusts.

There is no way to point a running server at a folder on disk, a document in the store, or a URL.
