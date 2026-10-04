#!/usr/bin/env bash
# Build the extractor, run it twice over `fixtures/webapp`, and prove the two
# outputs are byte-identical: CGF emission is a pure function of the facts, so a
# re-extract of an unchanged repo must not move a single byte.
#
#   scripts/extract-fixture.sh          # OUT=out
#   OUT=/tmp/x scripts/extract-fixture.sh
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=${OUT:-out}
REPO_ID=${REPO_ID:-gitlab.example.com/acme/webapp}
FIX=fixtures/webapp

echo "== build =="
[ -d node_modules ] || npm install --no-audit --no-fund
npm run --silent build

# The fixture declares no gateway dependency (it has no node_modules at all), so
# auto-detection cannot see one and the adapter is named explicitly.
ADAPTER=(--adapter bff-gateway)

rm -rf "$OUT/webapp" "$OUT/webapp-again"
mkdir -p "$OUT"

echo "== extract =="
./bin/pc-fe-ts build --repo "$FIX" --repo-id "$REPO_ID" --out "$OUT/webapp" \
  "${ADAPTER[@]}" --json-stats "$OUT/stats.json"

echo "== determinism: double-extract must be byte-identical =="
./bin/pc-fe-ts build --repo "$FIX" --repo-id "$REPO_ID" --out "$OUT/webapp-again" \
  "${ADAPTER[@]}" --quiet
diff -r "$OUT/webapp" "$OUT/webapp-again" > /dev/null \
  || { echo "FAIL: re-extract not byte-identical"; exit 1; }
echo "OK: $(ls "$OUT/webapp" | wc -l | tr -d ' ') file(s), identical across two runs"

echo "== stats =="
cat "$OUT/stats.json"
echo
