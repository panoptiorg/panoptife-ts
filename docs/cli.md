# `pc-fe-ts` command-line reference

```text
pc-fe-ts build [<repo>] --repo <dir> --out <dir> [--repo-id <id>] [--schema <path>]...
               [--adapter <name>]... [--no-adapter <name>]... [--no-adapters]
               [--no-adapter-routes] [--no-library-writeback]
               [--no-jsx] [--no-jsx-components] [--no-jsx-facts]
               [--no-http-routes] [--no-http-calls] [--no-try-blocks]
               [--no-instance-names]
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
| `--no-adapter <name>` | off | Never load this adapter (repeatable), even when it is detected or another adapter includes it. `--no-adapter react` turns off the React hook and wrapper modelling. |
| `--no-adapters` | off | Load no adapters at all. |
| `--no-adapter-routes` | off | Do not generate HTTP endpoints from adapter `[[handler]] route` templates. |
| `--no-library-writeback` | off | Disable library write-back (see [how-it-works.md](how-it-works.md#library-write-back)). |
| `--no-jsx` | off | Do not walk JSX: attribute values and `{…}` children are skipped, `.jsx` and `.cjs` files are not read, and imports do not resolve to `.tsx`/`.jsx` files. Implies the next two. See [how-it-works.md](how-it-works.md#jsx-and-react). |
| `--no-jsx-components` | off | Do not emit a call site for a component element (`<Child …/>`), and keep the earlier rules for which function a wrapper call (`const X = wrap(…)`, `export default wrap(…)`) stands for. |
| `--no-jsx-facts` | off | Do not emit the `jsx:html` and `jsx:attr:*` call sites for host-element attributes. |
| `--no-http-routes` | off | Do not treat route files as endpoints (SvelteKit `+server` files then keep their previous directory-named endpoint) and emit no `HttpRoute` and no server-action endpoints. See [how-it-works.md](how-it-works.md#endpoints-and-routes). |
| `--no-http-calls` | off | Do not emit the synthetic `http:` call sites at HTTP client calls. See [how-it-works.md](how-it-works.md#http-client-calls). |
| `--no-try-blocks` | off | Do not walk `try` and `finally` bodies (only `catch`), the behaviour before this flag existed. |
| `--no-instance-names` | off | Name a method call on an instance of an imported class `.<method>` again, instead of `<module>.<Class>.<method>` (`pool.query` on `new Pool()` from `pg` is `pg.Pool.query`). See [how-it-works.md](how-it-works.md#functions-and-naming). |
| `--resolver checker\|syntactic` | `checker` | `syntactic` skips the TypeScript program and resolves through import tables only. It exists for comparison; it resolves less. Any other value exits 2. |
| `--no-type-anchors` | off | Disable type anchors (made only by the `checker` resolver; see [how-it-works.md](how-it-works.md#the-typescript-program-and-call-resolution)). |
| `--top-opaque <n>` | `0` | After the summary, print the `n` most frequent unresolved `callee_fqn` values. `0` prints nothing. |
| `--json-stats <file>` | off | Write run statistics as JSON: the summary counters, the full opaque-callee histogram (sorted by count) and up to 200 warnings. |
| `--quiet` | off | Suppress the first progress line. The summary line and `warning:` lines are always printed. |

A flag not in this table is a usage error (exit 2), with one quirk: if it comes
before the repository has been named, it is taken as the repository path.

Every flag from `--no-jsx` to `--no-instance-names`, and `--no-adapter react`,
switches off one addition and restores the earlier output for it: with all of
them, the output is byte-identical to the version before they existed.

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

`--no-adapter <name>` removes a name from whichever of these sets applies.

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

Before the summary, two census lines appear when there is something to count
(not under `--quiet`):

```text
http-routes: 6 routes (next-app=3 next-page=2 next-pages-api=1) actions=1
http-calls: 19 sites, resolved_path=19, dynamic_base=19, unknown_method=0
```

`http-routes` counts `HttpRoute` rows per convention and the server actions.
`http-calls` counts the synthetic client sites: `resolved_path` those whose
path has at least one literal segment, `dynamic_base` those whose path starts
with an unresolved base (`/{}/…`), `unknown_method` those whose method could
not be read. `--json-stats` has the same numbers (`httpRoutes`,
`httpRoutesByFramework`, `serverActions`, `httpCalls`, `httpCallsResolvedPath`,
`httpCallsDynamicBase`, `httpCallsUnknownMethod`), plus `jsxComponents`,
`jsxComponentsResolved`, `jsxFacts`, `reactMajor` and `nextjs`.

Two conditions add a `warning:` line (these do not change the exit code):

- No adapter was loaded (and `--no-adapters` was not given), but the repository
  looks like it uses GraphQL: a dependency or import specifier whose name
  matches `graphql`, `apollo`, `urql` or `relay`, or any `.graphql`/`.gql`
  file. Pass `--adapter <name>` or write an adapter.
- Zero endpoints and zero operations were emitted: no entry surface (route
  export, Next.js route file or server action, adapter handler route, GraphQL
  operation) was recognised, so no chain starts at an endpoint of this
  repository. Chains can still start at catalog sources in its code: a
  browser-only app (`fixtures/reactapp`) prints this warning and still has
  chains from `useSearchParams` and `location.*`.

Two other lines can appear: `schema-warn:` when a schema file does not parse
(it is skipped), and `proto-warn:` when the loaded `cgf.proto` has no
`CallSite.arg_names` (GraphQL calls are then written without argument names)
or no `CgfPackage.http_routes`/`CallSite.http_call` (routes and HTTP client
sites are then not emitted).

## Exit codes

| code | meaning |
|---|---|
| 0 | Success, including empty output and a `--repo` directory that does not exist (0 files, plus the second warning above). |
| 1 | Fatal error: unknown adapter, malformed adapter file, a `--schema` file that cannot be read, `proto/cgf.proto` not found, a message that fails protobuf verification (these print a stack trace), or `dist/` not built (one-line hint). |
| 2 | Usage error. |
