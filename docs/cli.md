# `pc-fe-ts` command-line reference

```text
pc-fe-ts build [<repo>] --repo <dir> --out <dir> [--repo-id <id>] [--schema <path>]...
               [--adapter <name>]... [--no-adapters] [--no-adapter-routes]
               [--no-library-writeback]
               [--top-opaque <n>] [--json-stats <file>] [--quiet]
               [--resolver checker|syntactic] [--no-type-anchors]
```

`build` is the only subcommand. Running `pc-fe-ts` with no subcommand, or with
any other, prints the usage text (including the list of known adapters) and
exits 2.

## Flags

| flag | default | meaning |
|---|---|---|
| `--repo <dir>` | required | Repository to extract. The first bare argument after `build` is accepted instead. |
| `--out <dir>` | required | Output directory, created if missing. Every existing `*.pb` file in it is deleted before writing, so give each repository its own directory. |
| `--repo-id <id>` | base name of the repo directory | Written to `CgfPackage.repo` and hashed into every function and endpoint identifier. Keep it stable across runs. |
| `--schema <path>` | auto-discovered | GraphQL SDL file(s). Repeatable; paths are relative to the current directory. |
| `--adapter <name>` | auto-detected | Load exactly these adapters (repeatable) instead of auto-detecting. |
| `--no-adapters` | off | Load no adapters at all. |
| `--no-adapter-routes` | off | Do not generate HTTP endpoints from adapter `[[handler]] route` templates. |
| `--no-library-writeback` | off | Disable library write-back (see [how-it-works.md](how-it-works.md#library-write-back)). |
| `--resolver checker\|syntactic` | `checker` | `syntactic` skips the TypeScript program and resolves through import tables only. It exists for comparison; it resolves less. Any other value exits 2. |
| `--no-type-anchors` | off | Disable type anchors (made only by the `checker` resolver; see [how-it-works.md](how-it-works.md#the-typescript-program-and-call-resolution)). |
| `--top-opaque <n>` | `0` | After the summary, print the `n` most frequent unresolved `callee_fqn` values. `0` prints nothing. |
| `--json-stats <file>` | off | Write run statistics as JSON: the summary counters, the full opaque-callee histogram (sorted by count) and up to 200 warnings. |
| `--quiet` | off | Suppress the first progress line. The summary line and `warning:` lines are always printed. |

A flag not in this table is a usage error (exit 2), with one quirk: if it comes
before the repository has been named, it is taken as the repository path.

## Schema discovery

Without `--schema`, the tool looks in the repository root for
`schema.graphql`, `schema.gql` and `schema.graphqls` (all that exist are
loaded). If there is none, it scans `.graphqlrc.yml`, `.graphqlrc.yaml`,
`codegen.yaml` and `codegen.yml` for paths ending in `.graphql` or `.graphqls`
that exist in the repository. With no schema at all, only root-level fields of
an operation become remote calls, and each skipped deeper field produces a
`graphql-warn` entry.

## Adapter selection

1. `--no-adapters`: none.
2. `--adapter <name>`: exactly those, plus whatever they `include`.
3. Otherwise every `adapters/*.toml` whose `detect` list intersects the target
   repository's `package.json` `dependencies`, `devDependencies` and
   `peerDependencies`.

Adapters are read from the `adapters/` directory of the installed package;
there is no flag to point at another directory. An unknown name is a fatal
error (exit 1). See [../adapters/README.md](../adapters/README.md).

## Output

One `<package>.pb` file per repository directory that contains at least one
function, where the package is the file's repository-relative directory (`root`
for top-level files) and `/`, `\` and `:` in the name are replaced by `_`. Each
file is a binary `CgfPackage` message with `language = "ts"`. The CGF schema is
[`proto/cgf.proto`](../proto/cgf.proto), a copy of the engine's (described in
its [CGF reference](https://github.com/panoptiorg/panopticode/blob/master/docs/cgf.md)),
loaded at run time; the environment variable `PC_CGF_PROTO` overrides its
location.

Two runs over the same commit produce byte-identical output.

## Standard error

A progress line, then a summary line such as:

```text
pc-fe-ts: files=4 functions=9 callsites=16 invokes_remote=1 ops=1 gql_fields[sdl=1 fallback=0] handlers=1 endpoints=2 adapters=tanstack-query+felte+bff-gateway static=3 (18.8% via-checker=3) anchors=0 (on-opaque=0) resolver=checker typed=false program=0.0s warnings=0 wall=0.3s
```

`static` counts call sites resolved to a function in the repository;
`invokes_remote` counts GraphQL remote calls; `typed` says whether the
repository's `node_modules` was used.

Two conditions add a `warning:` line (these do not change the exit code):

- No adapter was loaded (and `--no-adapters` was not given), but the repository
  looks like it uses GraphQL: a dependency or import specifier whose name
  matches `graphql`, `apollo`, `urql` or `relay`, or any `.graphql`/`.gql`
  file. Pass `--adapter <name>` or write an adapter.
- Zero endpoints and zero operations were emitted. Nothing in the repository is
  an input surface the tool recognises, so no chain can start there.

Two other lines can appear: `schema-warn:` when a schema file does not parse
(it is skipped), and `proto-warn:` when the loaded `cgf.proto` has no
`CallSite.arg_names` (GraphQL calls are then written without argument names).

## Exit codes

| code | meaning |
|---|---|
| 0 | Success, including empty output and a `--repo` directory that does not exist (0 files, plus the second warning above). |
| 1 | Fatal error: unknown adapter, malformed adapter file, a `--schema` file that cannot be read, `proto/cgf.proto` not found, a message that fails protobuf verification (these print a stack trace), or `dist/` not built (one-line hint). |
| 2 | Usage error. |
