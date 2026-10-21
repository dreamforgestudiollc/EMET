# GEMs

A GEM is an add-on: knowledge and, when it is runed, tools the client runs. EMET seats a GEM only when its released flag is the boolean true. EMET does not run the GEM's computation. EMET verifies the record, not the computation. What is written back is checked the same way as any other write.

This feature has no tool of its own. `emet_floor` can read one GEM's floor without turning it on. `emet_status` reports each seated GEM's byte cost and does not include the floor text.

## Sub-features

- gem-seat: a GEM is seated at startup only when `released` is true, and only when you name it in the active list.
- gem-floor: `emet_floor` with `gem` reads that floor. Reading is not activation.
- gem-status: `emet_status` includes a `gems` object: installed, active, and any refusal. A socket failure is reported there and does not fail the status call.
- gem-client: a runed tool runs on the client. The server checks what comes back.

## How to get to it (user POV)

Bundled examples stay off until you ask. Set `EMET_ACTIVE_GEMS` to the id you want, restart, and call `emet_status` to see that it seated. Call `emet_floor` with `gem` set to that id to read its floor before you rely on it. The client runs any tool the GEM declares. You still save through the normal write tools.

## Driving it with verify-emet

```
npm run verify -- feature gems
npm run verify -- run emet_floor emet_status
```

`feature gems` does not call a tool, because there is nothing to call that belongs only here. The two commands above are how you see seating and the floor. Neither one turns a GEM on by itself.

## Gotchas

- A missing `released` flag is refused, except for a legacy manifest pinned by id, version, and file digests.
- A GEM ranks below the core floor. It cannot remove a protected floor line.
- Status stays successful when the socket fails closed. Read the `gems` field. Do not assume an empty active list means the call failed.
