#!/usr/bin/env bash
# Drift check for the vendored CGF contract.
#
# `proto/cgf.proto` here is a COPY. The canonical file lives in the panopticode
# core repo; `proto/PROTO_VERSION` records the commit it was taken from. When a
# checkout of that repo sits next to this one, diff the two.
#
#   scripts/check-proto.sh                 # ../panopticode/proto/cgf.proto
#   PC_PROTO_SRC=<path> scripts/check-proto.sh
#
# Exit 0 = identical (or no sibling checkout to compare against), 1 = drift.
# Note: comments in the canonical file may still carry pre-release example
# strings; a comment-only diff is drift too — re-vendor and re-record the sha.
set -euo pipefail
cd "$(dirname "$0")/.."

MINE=proto/cgf.proto
SRC=${PC_PROTO_SRC:-../panopticode/proto/cgf.proto}

if [ ! -f "$SRC" ]; then
  echo "check-proto: no canonical proto at $SRC — skipping (vendored copy is $(cat proto/PROTO_VERSION))"
  exit 0
fi

if diff -u "$MINE" "$SRC"; then
  echo "check-proto: OK — $MINE matches $SRC (vendored at $(cat proto/PROTO_VERSION))"
else
  echo "check-proto: DRIFT — $MINE differs from $SRC" >&2
  echo "  update the copy and write the new short sha into proto/PROTO_VERSION" >&2
  echo "  (a comment-only diff means the canonical file has not been re-vendored yet)" >&2
  exit 1
fi
