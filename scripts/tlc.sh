#!/usr/bin/env sh
# Run the EMET Console TLA+ models and the condense model with TLC 1.7.4.
# Fails on any invariant violation. -workers 1 -deadlock.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
JAR="${TLC_JAR:-$ROOT/.tlc/tla2tools.jar}"
URL="https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
SHA="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"

if ! command -v java >/dev/null 2>&1; then
  echo "java is required (Temurin 21)" >&2
  exit 1
fi

mkdir -p "$(dirname "$JAR")"
if [ ! -f "$JAR" ]; then
  echo "downloading tla2tools.jar v1.7.4"
  curl -fsSL -o "$JAR.download" "$URL"
  mv "$JAR.download" "$JAR"
fi

actual="$(sha256sum "$JAR" | awk '{print $1}')"
if [ "$actual" != "$SHA" ]; then
  echo "tla2tools.jar sha256 mismatch" >&2
  echo "expected $SHA" >&2
  echo "actual   $actual" >&2
  exit 1
fi

run() {
  spec="$1"
  cfg="$2"
  dir="${3:-$ROOT/specs/tla}"
  meta="$(mktemp -d)"
  echo "TLC $spec -config $cfg"
  java -jar "$JAR" -workers 1 -deadlock -metadir "$meta" -config "$dir/$cfg" "$dir/$spec"
  rm -rf "$meta"
}

run EmetConsole.tla EmetConsole-phase1.cfg
run EmetConsole.tla EmetConsole.cfg
run EmetConsoleServers.tla EmetConsoleServers.cfg
run CondenseApproval.tla CondenseApproval.cfg "$ROOT/verification/condense-approval"
echo "TLC: console configs and the condense model finished with no violation"
