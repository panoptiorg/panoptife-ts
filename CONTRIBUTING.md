# Contributing

You need Node.js 22 or newer and bash. A change to flags, output or extraction
behaviour updates [`docs/`](docs/) in the same pull request; a change to an
adapter updates [`adapters/README.md`](adapters/README.md).

## Build and test

```bash
npm ci && npm run build              # compile src/ to dist/; bin/pc-fe-ts runs dist/
npm test                             # vitest over test/**/*.test.ts
npx tsc --noEmit -p tsconfig.json    # type-check src/ without writing dist/
./scripts/extract-fixture.sh         # extract fixtures/webapp twice, check the outputs are identical
```

`npm test` imports `src/` directly, so it needs no build. `extract-fixture.sh`
runs `npm install` when `node_modules` is missing, builds, extracts
[`fixtures/webapp`](fixtures/webapp/) with `--adapter bff-gateway` into
`$OUT/webapp` and `$OUT/webapp-again` (default `out`, replaced on every run),
fails unless the two are byte-identical, and prints the run statistics.
`REPO_ID` overrides the repository id.

A new adapter needs a fixture and a test; see
[Writing an adapter](adapters/README.md#writing-an-adapter).

## Protobuf

`proto/cgf.proto` is a vendored copy of the engine's canonical
`proto/cgf.proto`. It is loaded at run time, so nothing is generated from it.
`proto/PROTO_VERSION` records the engine commit it was copied from.

```bash
scripts/check-proto.sh                       # compare with ../panopticode/proto/cgf.proto
PC_PROTO_SRC=<path> scripts/check-proto.sh   # compare with another copy
```

On any difference, comments included, `check-proto.sh` prints a diff and exits
1. When the canonical file does not exist it prints a skip line and exits 0. To
re-vendor, copy the engine's `proto/cgf.proto` over `proto/cgf.proto` and write
the engine's short commit to `proto/PROTO_VERSION`.

## CI

[`ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and every
pull request, on Ubuntu with Node.js 22: `npm ci`, `npm run build` (which is
also the type check), `npm test` and `scripts/extract-fixture.sh`. CI runs no
drift check; run `scripts/check-proto.sh` locally before changing `proto/`.
