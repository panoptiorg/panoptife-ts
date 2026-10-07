# How `pc-fe-ts` works

`pc-fe-ts build` turns one repository into a set of CGF packages in six steps:
load the repository, lower Svelte files to TypeScript, build a TypeScript
program, cut the files into functions, compute each function's local data
flow, and write the result. This page describes each step and the choices that
affect the output. Source files are named in parentheses.

## Loading the repository

(`src/repo.ts`)

The walk starts at `src/` if the repository has one, otherwise at the root. It
reads `.ts`, `.tsx`, `.js`, `.mjs` and `.svelte` files in sorted order and
skips `node_modules`, `dist`, `build`, `coverage`, `.svelte-kit`, every other
dot-directory, `.d.ts` files, `*.test.*` and `*.spec.*` files, `__tests__/`,
`__mocks__/` and a top-level `tests/`.

Import aliases come from three places; the first declaration of a prefix wins:

1. `kit.alias` in `svelte.config.{js,ts,mjs}`, read as string literals (the
   config is never executed);
2. `compilerOptions.paths` in `tsconfig.json`, following relative `extends`
   up to five levels, including `.svelte-kit/tsconfig.json`;
3. the defaults `$lib` to `src/lib` and `$app` (always outside the repository).

`commit_sha` is `git rev-parse HEAD` of the repository, or empty.

## Svelte lowering

(`src/svelte.ts`)

Each `.svelte` file is parsed with `svelte/compiler` and rewritten as one
TypeScript unit: the module and instance `<script>` bodies, followed by one
synthetic statement per template construct that can move data.

| template | lowered to | call site in CGF |
|---|---|---|
| `{@html e}` | `__pc_html(e);` | `svelte:html` |
| `bind:value={v}` (dotted path only) | `v = __pc_bind();` | `svelte:bind` |
| `{e}`, `on:click={h}`, attribute expressions | `__pc_tpl(e);` | `svelte:tpl` |

Line numbers in the output are mapped back to the original `.svelte` file. The
whole component becomes one function, `<file>:$script`. Component props passed
to children, `{#each}` bindings and slots are not modelled. A file that fails
to parse contributes no code and one warning.

## The TypeScript program and call resolution

(`src/program.ts`, `src/analyze.ts`)

All files, with lowered Svelte units as virtual `.ts` files, go into one
`ts.Program` with a module resolver of its own that understands the aliases
above. The target's `node_modules` is optional; when it is present, its type
declarations resolve more calls. There are two modes:

- Untyped (the target has no `node_modules`): no standard library, no
  `@types`, and imports that do not land inside the repository resolve to
  nothing. This is fast and keeps every library call opaque.
- Typed (`node_modules` exists): the real `lib` and `@types` are loaded, and an
  external import is accepted only if it resolves to a `.d.ts` file, so
  library implementations are never pulled in. Types let calls through
  generic factories resolve.

In both modes the checker also gives type anchors: a value whose type is a
generated `<Op>QueryVariables` or `<Op>Mutation` alias is linked to that
operation even when its callee is unresolvable (`--no-type-anchors` turns this
off). Untyped, only aliases declared in the repository's own files are visible.

Every call target goes through the type checker (`getSymbolAtLocation`, then
alias resolution, which handles re-exports and renames) to a declaration, and
from there to the function emitted for it. The checker stops at values, so
these hops are followed by hand:

- object-literal properties (`export const api = { getX }`) and variables that
  only rename another value;
- factories: a returned function becomes `<factory>.$ret`, a returned object
  literal of closures becomes `<factory>.$ret.<prop>`, a returned framework
  handle (see adapter `[[handle_method]]`) becomes `<factory>.$ret.<method>`;
  a factory returning another factory's result is followed up to three hops;
- a nested function called by name in its own file becomes `<parent>.$<name>`;
- `() => import('./x')` resolves to that module's `default`, else its
  top-level code;
- identity-preserving wrappers (`debounce`, `throttle`, `memoize`, `memo`,
  `once`, plus adapter `[[identity_hof]]` names) resolve to the wrapped
  function.

A function emitted standalone this way also stays inlined in its parent, so
closures keep working in both places. `--resolver syntactic` skips the program
and resolves through import tables only; it exists for comparison.

## Functions and naming

Each file yields functions named `<repo-relative file>:<symbol>`: declarations,
arrow functions, class methods and constructors (`Class.method`,
`Class.#private`, `Class.constructor`; a computed method name that is not a
literal becomes `Class.[computed]`), object-literal members (`obj.key`),
`default`, `$script` for a component, `$module` for leftover top-level code,
and the synthetic `$op` and handler functions described below. Duplicate names
get `$1`, `$2` suffixes. The package is the file's directory (`root` at the top level).

A call that does not resolve inside the repository is emitted as an opaque call
with a `callee_fqn` from a fixed vocabulary (`src/naming.ts`), which is what the
core's catalog matches against:

| form | example |
|---|---|
| `<module>.<name>` for an import | `$app/navigation.goto` |
| `<Type>.<method>` for a known receiver | `URLSearchParams.get`, `Map.set` |
| `<prop>.<method>` for a property receiver of no known type | `items.push` (for `this.items.push(x)`) |
| `.<method>` for any other unknown receiver | `.push` |
| `read:<path>` for an input read | `read:$page.url`, `read:location.search`, `read:route.params` (for `$page.params`) |
| `assign:<prop>` for a DOM write | `assign:innerHTML` |
| `svelte:html`, `svelte:bind`, `svelte:tpl` | template constructs |
| `graphql:<Type>.<field>` | remote GraphQL field |
| `<pkg>.<factory>.$ret` | result of a non-identity external factory |

Svelte 5 runes keep their names (`$state`, `$derived.by`), and `$props()` is a
zero-argument call named `read:page.data`.

## Endpoints

(`endpointNameFor` in `src/analyze.ts`)

These SvelteKit exports become HTTP endpoints: `load` in `+page.server.ts` and
`+layout.server.ts`, each member of `actions` in `+page.server.ts`
(`actions.default`), and `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` and
`OPTIONS` in `+server.ts` (the `.js` forms too). An endpoint is named
`"<export> <directory>"` (`load src/routes/search`), where the directory is the
file's repository-relative directory, not a URL. The function gets `binds_to`
pointing at the endpoint and `source_params = [0]`: its first parameter is
untrusted. Only exports under their own name count (`export function`,
`export const`, `export { load }`); a rename such as `export { handler as GET }`
is not followed. Any other file is never an endpoint: `+page.ts`,
`+layout.ts`, components, and server-only modules such as
`src/lib/db.server.ts`. Adapters can add endpoints through a `route` template, which also
names them (`POST /api/{path}` gives `POST /api/search` in `fixtures/webapp`);
`--no-adapter-routes` turns those off.

## GraphQL operations and the join with Go

(`src/gqlop.ts`, `src/sdl.ts`)

Adapters say which tagged templates hold a GraphQL document. Each document
becomes a function `<file>:$op` (`$op$0`, `$op$1` when a file holds several)
whose parameter 0 is `variables` and whose return value is the result.

The document is walked against the SDL (object and interface types, type
extensions, renamed root types in `schema { }`; fragments and inline fragments
use their type condition). Every field that takes arguments becomes one remote
call site:

- kind `INVOKES_REMOTE`, `callee_fqn = "graphql:<ParentType>.<field>"`;
- `callee_iids = [ContractIID("graphql:<ParentType>.<field>")]`, the SHA-256
  identifier the [Go extractor](https://github.com/panoptiorg/panoptife-go)
  computes for the gqlgen resolver of the same field (`test/hash.test.ts` pins
  the digests);
- one argument port per argument, in the order the document writes them, with
  `arg_names` naming them; the core uses the names to line the ports up with
  the resolver's parameters. An argument port receives taint when its value
  contains a variable.

Without a schema only root fields are joined. Fields without arguments produce
no call site. Adapters then connect the `$op` to the code that calls it: a
handler function (`[[handler]]`), or a direct call carrying both document and
variables (`[[invoke]]`). See [../adapters/README.md](../adapters/README.md).

`fixtures/webapp` joins this way to `graphql:Query.searchByToken`, served by
panoptife-go's `federation` fixture. The two, with `backend` and `downstream`,
form the example system;
[The example system](https://github.com/panoptiorg/panopticode/blob/master/docs/example.md)
maps their code to the 18 findings they produce.

## Flow extraction

(`src/flow.ts`)

Inside a function, flow is a name-based value graph: an assignment, a member
read, an object or array literal, `await`, `?.` and spread all carry taint, and
any part of a tainted object taints the whole (no field sensitivity). The graph
is flow-insensitive within one function. It is projected onto CGF vertices of
four kinds: `IN_PARAM`, `CALL_ARG_PORT`, `CALL_RESULT_PORT`, `OUT_RETURN`. An
edge is emitted from each source vertex to every sink vertex reachable from it;
calls are barriers, so values reach a callee only through its argument ports.

### Library write-back

The core has no body for a library call and by default sends its inputs only
to its result. Calls such as `parts.push(x)` or `Object.assign(target, src)`
instead write into an argument. At a call with no in-repository target, every
argument that is a variable, or a property chain rooted at one (`this.items`
roots at `this`), gets an edge from its argument port back to that variable.
The receiver counts as argument 0. Globals such as `Object` and `JSON` are
skipped. Variables declared as `[]`, `T[]`, `Array<T>`, `new Map()` and similar
also give their method calls a typed name (`Array.push`, `Map.set`).

These edges have no effect unless the core's catalog has a `[[propagators]]`
rule for the call. `--no-library-writeback` disables both the edges and these
container names.

## Emission

(`src/cgf.ts`, `src/hash.ts`)

`proto/cgf.proto` is loaded at run time with protobufjs (`$PC_CGF_PROTO`, then
the package's `proto/`, then parent directories). One `CgfPackage` is written
per package with at least one function; existing `*.pb` files in `--out` are
deleted first.

Identifiers are SHA-256 over length-prefixed fields, byte-compatible with the
Go extractor:

- function `iid` = hash of (repo id, package, `<file>:<symbol>`, `"ts"`);
- endpoint `iid` = hash of (repo id, `""`, endpoint name, `"http"`);
- contract `iid` = hash of (`""`, `""`, contract name, `"grpc"`);
- `bid` = hash of the function's flow (including spans) and its callee
  identifiers, so moving a line changes `bid` but not `iid`.

The file walk, vertex numbering and edge order are deterministic, and two runs
over the same commit produce identical bytes.

## Known gaps

What the extraction misses or over-approximates. The engine has limits of its
own; see its [limitations](https://github.com/panoptiorg/panopticode/blob/master/docs/limitations.md).

- Only GraphQL fields that take arguments are joined. An argument-free field
  (`me { id }`) produces no call site, so nothing links it to the server.
- The join needs the repository's `schema.graphql` snapshot to use the same
  type names as the server. A stale snapshot loses the link without an error:
  a renamed type gives a key the server never computes, and a nested field
  missing from the snapshot is skipped with a `graphql-warn` that shows only in
  the `warnings=` count and in `--json-stats`. With no schema, only root fields
  are joined.
- Flow inside a function is flow-insensitive and not field-sensitive: taint on
  any part of an object taints all of it, and a variable anywhere in a nested
  GraphQL input object taints the whole argument
  ([flow extraction](#flow-extraction)).
- A callback reached through a function parameter (`onChange?.(v)`) is not
  resolved; the call stays opaque.
- `import(expr)` with a computed specifier stays opaque (`<dynamic>`).
- Without the target's `node_modules`, calls that need a library's types to
  resolve, such as calls through a generic factory, stay unresolved, and type
  anchors see only aliases declared in the repository
  ([call resolution](#the-typescript-program-and-call-resolution)).
- Only methods and constructors with a body in a named top-level class
  declaration become functions. Arrow-function properties, accessors and other property
  initialisers produce no code, and calls to them stay opaque.
- A `kit.alias` entry whose value is not a string literal is not seen; imports
  through it stay opaque unless `tsconfig.json` declares the same alias.
- In components, props passed to children, `{#each}` bindings and slots are not
  modelled, `bind:` is lowered only for a dotted path, and a file that fails to
  parse contributes no code ([Svelte lowering](#svelte-lowering)).
- A universal `load` in `+page.ts` or `+layout.ts` is not an endpoint, so its
  parameter is not marked untrusted ([endpoints](#endpoints)).
