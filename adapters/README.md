# Adapters

An adapter is a TOML file that tells `pc-fe-ts` how a client library turns a
GraphQL document into something the application calls, or what a UI library's
hooks and wrappers do with a value. The extractor itself knows TypeScript,
Svelte, JSX, the SvelteKit and Next.js file conventions and the common HTTP
clients, but no GraphQL client library: with `--no-adapters` it finds no
GraphQL operations at all. A test (`test/adapter.test.ts`) checks that none of
the `bff-gateway` example's names (such as `getClientHandler` or
`GatewayEndpoint`) appear in `src/`.

## Selecting adapters

```bash
pc-fe-ts build <repo> --out <dir>                                   # auto-detect
pc-fe-ts build <repo> --out <dir> --adapter apollo --adapter felte  # exactly these
pc-fe-ts build <repo> --out <dir> --no-adapters                     # none
pc-fe-ts build <repo> --out <dir> --no-adapter react                # auto-detect, minus one
```

Auto-detection loads every adapter whose `detect` list shares a name with the
target's `package.json` `dependencies`, `devDependencies` or
`peerDependencies`. `--adapter` replaces auto-detection and is repeatable. An
adapter's `include` list is loaded first, depth-first; each adapter is loaded
at most once. `--no-adapter <name>` (repeatable) keeps an adapter out even when
it is detected or included.

Adapters are looked up by file name (`--adapter apollo` reads
`adapters/apollo.toml`) in the `adapters/` directory of the installed package.
There is no flag for another directory: to add an adapter, put the file there.

## Shipped adapters

| adapter | detected by | models |
|---|---|---|
| `apollo` | `@apollo/client`, `@apollo/client-react-streaming`, `apollo-client`, `apollo-boost` | `const [m] = useMutation(DOC)`, `useQuery(DOC, { variables })`, `useSuspenseQuery`, `client.mutate({ mutation, variables })`, `client.query({ query, variables })` |
| `graphql-request` | `graphql-request` | `request(url, DOC, vars)`, `client.request(DOC, vars)`, `rawRequest`, codegen `getSdk(client).Op(vars)` |
| `tanstack-query` | `@tanstack/query-core` and the Svelte, React, Vue and Solid packages | callbacks stored by `createMutation`, `createQuery`, `fetchQuery`, `useMutation`; `mutationFn` invoked by `mutate`/`mutateAsync`, `queryFn` by `refetch` |
| `felte` | `felte`, `@felte/core`, `@felte/svelte`, `@felte/react` | `createForm({ onSubmit })` invoked by `handleSubmit` |
| `bff-gateway` | `@acme/gateway`, `@acme/mf-core` (placeholder names) | an example in-house gateway; includes `tanstack-query` and `felte` |
| `react` | `react`, `react-dom` | `useState`/`useReducer` setters write into their state, `useMemo` returns its callback's result, `startTransition` runs its callback; `forwardRef`, `useCallback` and `lazy` are identity wrappers |

`apollo`'s `mutate` and `query` rules match any `.mutate(...)` or `.query(...)`
call, but only apply when the named argument resolves to a document.

`bff-gateway` models a registry-style gateway: an endpoint file
`endpoints/<path>/index.ts` declares
``GatewayEndpoint.create({ gqlNode: gql`...`, mapper })`` and exports
`$gateway.getClientHandler('<path>')`, which the app calls as
`api.<name>.call(vars)`. Each handler also becomes an HTTP endpoint
`POST /api/<path>`. `fixtures/webapp` uses it; copy it when your gateway looks
similar.

## File format

A small TOML subset (`src/toml.ts`): `# comments`, root `key = value` pairs,
`[[name]]` arrays of tables, and values that are strings (`"..."` or
`'...'`), integers, booleans or single-line arrays of those. `[table]`
headers, dotted keys, inline tables, multi-line arrays, floats, dates and
duplicate keys are errors. A value of the wrong type (except `on_receiver`,
which is not checked), an invalid `kind` or `bind`, and a missing required key
are also errors. Loading a file with an error stops the run with exit code 1;
auto-detection skips a file it cannot parse.

Unknown keys and unknown `[[table]]` names are ignored without a warning, so
check spelling against the tables below.

### Root keys

| key | type | meaning |
|---|---|---|
| `name` | string | Adapter name used in the summary line. Defaults to the file name; set it to the file name. |
| `detect` | string array | Package names that switch the adapter on during auto-detection. |
| `include` | string array | Other adapters (by file name) to load with this one. |

### `[[operation]]`: where documents are

| key | type | meaning |
|---|---|---|
| `tags` | string array | Template tags that mark a document: `["gql", "graphql"]`. |
| `tag_suffix` | string array | Tag paths ending in these also count: `[".gql"]` matches `Apollo.gql`. |
| `mapper_prop` | string | Name of a sibling property, in the object literal holding the document, whose function is applied to the result. |

Each document becomes a function `<file>:$op` (`$op$0`, `$op$1` when a file has
several). Its parameter 0 is the variables, its return value the result, and
each argument-taking field is a remote call `graphql:<ParentType>.<field>`
whose arguments are named as in the document. See
[../docs/how-it-works.md](../docs/how-it-works.md#graphql-operations-and-the-join-with-go).

### `[[handler]]`: a callable made from a document

| key | type | default | meaning |
|---|---|---|---|
| `kind` | `"path"`, `"doc"` or `"sdk"` | `"path"` | How the factory names its operation (below). |
| `factories` | string array | | Factory names, matched on the last name of the callee (`gw.getClientHandler` matches `getClientHandler`). |
| `on_receiver` | boolean | `false` | Only match factory calls made on a receiver (`x.factory(...)`). |
| `path_arg` | integer | 0 | `path`: argument holding the path string. |
| `op_dir_regex` | string | | `path`: JavaScript regular expression over the repository-relative file path of an operation; capture group 1 is the path it is registered under. |
| `doc_arg` | integer | 0 | `doc`: argument holding the document. |
| `bind` | `"value"` or `"array0"` | `"value"` | `doc`: the call result is the callable, or element 0 of it (`const [m] = useMutation(DOC)`). |
| `methods` | string array | | Methods that invoke the callable (`h.call(v)`); calling it directly also works. |
| `vars_prop` | string | | At the call, the variables are this property of argument 0 (`m({ variables })`). |
| `vars_arg` | integer | 0 | `sdk`: argument of `sdk.Op(...)` holding the variables. |
| `route` | string | | Endpoint name template, e.g. `"POST /api/{path}"`. `{path}` is the registered path, `{name}` the handler's symbol. Handlers where a placeholder cannot be filled get no endpoint. |

- `path`: `factory('<path>')` refers to the operation whose file matches
  `op_dir_regex` with that path.
- `doc`: `factory(DOC)` refers to the document passed in.
- `sdk`: `const s = factory(client); s.Login(vars)` refers to the operation
  named `Login` in the repository's documents.

A handler with a `route` becomes an HTTP endpoint with untrusted input: the
handler function gets `binds_to` pointing at it and `source_params = [0]`.
`--no-adapter-routes` turns this off.

### `[[invoke]]`: a call with both document and variables

| key | type | meaning |
|---|---|---|
| `callee` | string, required | Last name of the callee (`request`, `useQuery`). |
| `doc_arg` | integer | Argument holding the document... |
| `doc_prop` | string | ...or this property of that argument (`{ mutation: DOC }`). |
| `vars_arg` | integer | Argument holding the variables... |
| `vars_prop` | string | ...or this property of that argument (`{ variables }`). |

Rules with the same `callee` are tried in file order; the first whose document
resolves applies. If none does, the call is resolved normally. This is how
`request(url, DOC, vars)` and `client.request(DOC, vars)` share one name.

### `[[callback_factory]]` and `[[handle_method]]`

| table | key | meaning |
|---|---|---|
| `[[callback_factory]]` | `name` (required) | A library function that stores callbacks passed in an object literal (`createForm({ onSubmit })`) and calls them later. The callbacks' parameters receive the calling function's `bind:` values and the factory's other arguments. |
| `[[handle_method]]` | `prop` (required), `methods` | When a function returns a callback factory's result, the callback under `prop` is also emitted as `<function>.$ret.<method>` for each method, so `h.mutate(v)` resolves to it. |

### `[[source]]` and `[[identity_hof]]`

| table | keys | meaning |
|---|---|---|
| `[[source]]` | `call`, `fqn` (both required) | A plain call `call(...)` is emitted as a zero-argument call named `fqn`, e.g. `read:route.params`, for the core's catalog to treat as a source. |
| `[[identity_hof]]` | `name` (required) | A wrapper that returns the function it was given, so `const v = wrap(fn)` makes `v(...)` a call of `fn`. `debounce`, `throttle`, `memoize`, `memo` and `once` are built in. Do not list wrappers that change behaviour. |

### `[[state_hook]]` and `[[thunk_hof]]`

| table | keys | meaning |
|---|---|---|
| `[[state_hook]]` | `name` (required), `state` (default 0), `setter` (default 1) | A hook returning a tuple with a state value and its setter: `const [s, setS] = useState(…)`. In the function that destructures it (closures included), `setS(v)` flows `v` into `s`, and `setS(prev => f(prev))` flows `s` into `prev` and `f`'s result into `s`. The indices are the tuple positions. |
| `[[thunk_hof]]` | `name` (required), `fn_arg` (default 0) | A call that runs the function at argument `fn_arg` and returns its result: `useMemo(() => e, deps)` is `e`. Only an inline function argument is followed. Do not list it as an `[[identity_hof]]`: it does not return the function. |

`adapters/react.toml` uses both; see
[../docs/how-it-works.md](../docs/how-it-works.md#jsx-and-react).

### Parsed keys with no effect

`result_prop` (in `[[operation]]` and `[[invoke]]`) and `body` (in
`[[handler]]`) are read and type-checked but not used: flow is not
field-sensitive, so the result property and the body parameter make no
difference to the output. The shipped files still set them as annotations.

## Writing an adapter

1. Find the document. If it is a tagged template, add an `[[operation]]` with
   its tag.
2. Find the callable. If the document goes into a factory whose result is
   called later, add a `[[handler]]`; if the document and variables are passed
   in the same call, add an `[[invoke]]`.
3. Say where the variables are at the call: an argument index, a property, or
   both.
4. Add `detect` with the package name so auto-detection finds it.
5. Put the file in `adapters/`, add a fixture under `test/fixtures/<name>/`
   (`package.json`, `schema.graphql`, and a URL parameter reaching a variable)
   and assert the `graphql:<Type>.<field>` call in `test/adapter.test.ts`, as
   the `apollo` and `graphql-request` fixtures do.

Check the result with `--top-opaque 20`: calls into your client that still show
up there are not modelled yet.
