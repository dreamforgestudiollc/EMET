# EMET - remote (HTTP) transport.
# The stdio transport does not need a container; this is for hosted deployment.

FROM node:22-alpine
WORKDIR /app

# Dependencies first, for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

# The controlled documents ship WITH the release, and the server reads them from
# here rather than from an install's store (CHARTER.md section 9; templates/
# STANDARD.md section 9a, L1). Leaving them out does not fail loudly: every
# template resolves as "not present in this release", every record gates to
# `ungated`, and validation silently marks nothing. Verified live on the first
# deploy after the validator shipped, which is the only way it would have been
# found - `emet_initialize` reported present_in_release: false.
COPY CHARTER.md ./
COPY templates ./templates
COPY guides ./guides
# Bundled GEMs (gems/<id>/) are read by the GEM socket from next to src/.
COPY gems ./gems
# The GEM checker reads gem.schema.json and keys.json from gem-library/; without it every GEM fails GC-02.
COPY gem-library ./gem-library
# src/host-reach.js imports the RUNE load gate. Leaving this directory out
# crashes startup: ERR_MODULE_NOT_FOUND .../verification/load-gate/load-gate.mjs
COPY verification ./verification

# Hosts inject PORT; the app honours it. 8080 is only the fallback.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/http-remote.js"]
