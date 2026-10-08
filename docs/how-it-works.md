# How `pc-fe-ts` works

`pc-fe-ts build` turns one repository into a set of CGF packages in six steps:
load the repository, lower Svelte files to TypeScript, build a TypeScript
program, cut the files into functions, compute each function's local data
flow, and write the result. This page describes each step and the choices that
affect the output. Source files are named in parentheses.

## Loading the repository

(`src/repo.ts`)

The walk starts at `src/` if the repository has one, otherwise at the root. In
a Next.js repository (see [endpoints and routes](#endpoints-and-routes)) a
top-level `app/` and `pages/` are walked as well, because Next.js serves them
even when `src/` exists. It reads `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`
and `.svelte` files in sorted order and skips `node_modules`, `dist`, `build`,
`coverage`, `.svelte-kit`, every other dot-directory, `.d.ts` files, `*.test.*`
and `*.spec.*` files, `__tests__/`, `__mocks__/` and a top-level `tests/`.
(`--no-jsx` drops `.jsx` and `.cjs`.)

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

## JSX and React

(`FnFlow.jsx` in `src/analyze.ts`, `adapters/react.toml`)

Every `.tsx`, `.jsx` and `.js` file can hold JSX, and JSX is walked like any
other expression: attribute values and `{…}` children are evaluated, and an
inline handler such as `onClick={() => { location.href = q }}` is inlined into
the component like any closure. Its return value is dropped, because React
never hands a handler's return back. Three kinds of fact come out of an
element:

| JSX | emitted |
|---|---|
| `<Child a={x} {...rest}>{kid}</Child>` | a `STATIC` call of `Child`, resolved like a call of that name, with one argument: the props object. Attributes, spreads and children all flow into it (flow is not field-sensitive, so they are all one value). An unresolved tag keeps the name a call would get (`@mui/material.Button` for an import), or is `jsx:<Name>`. |
| `<x dangerouslySetInnerHTML={{__html: e}}>` | a `jsx:html` call site whose argument is `e` |
| `<x href={e}>`, also `src`, `action`, `formAction`, `xlinkHref`, and `data` on `<object>` | `jsx:attr:<name>` or `jsx:attr-unsanitized:<name>` (below) |
| `<iframe srcDoc={e}>` | `jsx:attr:srcDoc` |

A host element (`<div>`, `<a>`) is not a call, and an element's value carries
nothing, a component's included: the component is called, but its result
(markup) does not flow on, so a child does not taint the props of the parent
that renders it. `{q}` as text is escaped by React and is no sink. An attribute fact is emitted
only when the value is not a literal and not a function (`<form action={fn}>`
is a React 19 form action, not a URL). Like the `assign:` sites, a fact has one
argument and no result.

React 19 (react-dom 19.x `sanitizeURL`) replaces a `javascript:` URL in `href`,
`src`, `action`, `formAction`, `xlinkHref` and `<object data>` with one that
throws; React 18 only warned. Which runtime renders the page is a fact about
the repository, so it is recorded in the name and the catalog decides the
class: `jsx:attr:<name>` when the repository's `react` is 19 or later,
`jsx:attr-unsanitized:<name>` when it is older or unknown. The version is the
lowest major the `package.json` range allows (`^18.3.0 || ^19.0.0` counts as
18); an installed `node_modules` is never read, so a commit extracts to the same
bytes everywhere. `srcDoc` and `dangerouslySetInnerHTML` are never sanitised and
have one name each.

Components resolve through the checker exactly as calls do, including
`memo(C)`, `React.memo(C)`, `memo(C, areEqual)`, `forwardRef(fn)`,
`export default memo(function C…)` and `lazy(() => import('./C'))`, which
resolves to `C`'s default export (or to `Named` for
`import('./C').then((m) => ({ default: m.Named }))`). A known wrapper always wraps
its first argument, never a later function such as a comparator.

The `react` adapter (auto-detected from a `react` or `react-dom` dependency)
adds what React does with a value inside one component:

- `const [s, setS] = useState(…)`: every call `setS(v)` in the same function
  (closures included) flows `v` into `s`; `setS(prev => f(prev))` reads `s` and
  writes `f`'s result. A call is matched to the setter's declaration, so a
  nested component's own `setS` or a local function that shadows the name
  writes nothing into `s`. `useReducer`'s `dispatch(action)` flows the action into
  the state; the reducer itself is not run.
- `useMemo(() => e, deps)` returns `e`; `startTransition(fn)` runs `fn`.
- `forwardRef`, `useCallback` and `lazy` are identity wrappers for call
  resolution.

Hook sources need no frontend support: `useSearchParams()` is an opaque call
named `react-router.useSearchParams` (or `react-router-dom.…`,
`next/navigation.…`), which the catalog marks as a source, and
`const [sp] = useSearchParams()` carries its result into `sp`. Note that the
naming is syntactic: `sp.get('q')` is named
`react-router.useSearchParams.$ret.sp.get` after the variable, and `axios.get`
is `.get`.

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
  function, also behind `export default` (`export default memo(C)`); a wrapper
  around an import thunk (`lazy(() => import('./C'))`) resolves to that module's
  default export. A top-level `const X = wrap(function …)` or
  `export default wrap(function …)` is itself the wrapped function: for a
  known identity wrapper only an inline first argument counts, and for any
  other call the first inline function argument counts unless the first
  argument is already a function reference (`rateLimit(handler, (r) => r.ip)`
  wraps `handler`).

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
| `<module>.<Class>.<method>` on an instance of an imported class | `pg.Pool.query` for `pool.query(q)`, `pool = new Pool()` with `Pool` from `pg`, in this or another file |
| `<prop>.<method>` for a property receiver of no known type | `items.push` (for `this.items.push(x)`) |
| `.<method>` for any other unknown receiver | `.push` |
| `read:<path>` for an input read | `read:$page.url`, `read:location.search`, `read:route.params` (for `$page.params`) |
| `assign:<prop>` for a DOM write | `assign:innerHTML` |
| `svelte:html`, `svelte:bind`, `svelte:tpl` | template constructs |
| `jsx:html`, `jsx:attr:<name>`, `jsx:attr-unsanitized:<name>` | JSX host-element sinks ([JSX and React](#jsx-and-react)) |
| `jsx:<Name>` | a component element whose tag does not resolve |
| `http:<METHOD> <path>` | an HTTP client request ([HTTP client calls](#http-client-calls)); `*` when the method is unknown |
| `graphql:<Type>.<field>` | remote GraphQL field |
| `<pkg>.<factory>.$ret` | result of a non-identity external factory |

Svelte 5 runes keep their names (`$state`, `$derived.by`), and `$props()` is a
zero-argument call named `read:page.data`.

## Endpoints and routes

(`endpointNameFor` in `src/analyze.ts`, `src/routes.ts`)

These SvelteKit exports become HTTP endpoints: `load` in `+page.server.ts` and
`+layout.server.ts`, each member of `actions` in `+page.server.ts`
(`actions.default`), and `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` and
`OPTIONS` in `+server.ts` (the `.js` forms too). A `load` or action endpoint is
named `"<export> <directory>"` (`load src/routes/search`), where the directory
is the file's repository-relative directory, not a URL. The function gets
`binds_to` pointing at the endpoint and `source_params = [0]`: its first
parameter is untrusted. Only exports under their own name count
(`export function`, `export const`, `export { load }`). Any other file is never
an endpoint: `+page.ts`, `+layout.ts`, components, and server-only modules
such as `src/lib/db.server.ts`. Adapters can add endpoints through a `route`
template, which also names them (`POST /api/{path}` gives `POST /api/search` in
`fixtures/webapp`); `--no-adapter-routes` turns those off.

### Route files

A route file is served at a URL its path determines, so its handlers become
routes. One table holds every convention the tool knows:

| convention | file | handlers | method | request params |
|---|---|---|---|---|
| SvelteKit | `src/routes/**/+server.{ts,js}` | verb exports | the verb | `[0]` (event) |
| Next.js App Router | `app/**/route.*` (or `src/app/…`) | verb exports, also `export { h as GET }` | the verb | `[0, 1]` (request, context) |
| Next.js Pages API | `pages/api/**` (or `src/pages/api/…`) | the default export | `*` (any) | `[0]` (req) |
| Next.js page | `app/**/page.*` | the default export | `GET` | `[0]` (`params`, `searchParams`) |

The default export is followed through `export default handler`,
`export { handler as default }` and a wrapper around a local handler
(`export default withAuth(handler)`; among several local functions handed to
the wrapper, the one with the handler's parameter count wins).

The URL comes from the directory: SvelteKit's under `src/routes`, Next.js's
under `app`/`pages`. A `(group)` segment and a Next.js `@slot` are dropped; a
Next.js `_private` folder and an intercepting route (`(.)photo`) are not
routable; `%5F` is a literal `_`; `index` is dropped from a Pages API file.
When both a root `app/` and `src/app/` exist, Next.js serves only the root one,
so `src/app/` files get no routes (the same for `pages/` and `src/pages/`).
`/api/users/[id]` is the display form; the route is keyed on the canonical
template (`/api/users/{}`; `[...x]` and `[[...x]]` become `{*}`), the form every
Panopticode frontend and the engine share.

Each route produces:

- an endpoint with `kind = HTTP`, untrusted input, name `<METHOD> <display>`
  (`GET /api/users/[id]`), whose identifier is the route's contract identifier
  `ContractIID("http:<METHOD> <canonical path>")`: the same key a client call to
  that URL carries, in any repository and any language;
- an `HttpRoute` with that identifier, method, canonical path, display path,
  the handler's identifier, the request parameters and the convention name
  (`sveltekit`, `next-app`, `next-pages-api`, `next-page`);
- on the handler, `binds_to` that endpoint and `source_params` the request
  parameters. Next.js 15 and later pass `params` and `searchParams` as
  Promises; `await` is transparent to the flow, so `const { id } = await params`
  carries the taint.

Next.js server actions are endpoints but not routes: a client component calls
one by importing it, which already resolves to a `STATIC` call. Every exported
function of a module that starts with `'use server'`, and every function whose
body starts with it (a nested one is emitted as `<parent>.$<name>` for this),
gets an endpoint named `action:<file>:<symbol>` and all of its parameters as
`source_params`.

The Next.js conventions and server actions apply only when the repository looks
like Next.js: a `next` dependency in `package.json` or a `next.config.*` at its
root. An `app/` folder in any other repository means nothing. `--no-http-routes`
turns all of this off; SvelteKit `+server` verbs then keep the
`"<export> <directory>"` endpoint they had before.

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

## HTTP client calls

(`FnFlow.httpSite` in `src/analyze.ts`, `src/http.ts`)

At a request made through `fetch` (also `window.fetch`), axios (`axios(…)`,
`axios.get/post/put/patch/delete/head/options/request`, the `*Form` variants,
and instances from `axios.create`), ky (`ky(…)`, `ky.get/…`, `ky.create`,
`ky.extend`) or ofetch (`ofetch(…)`, `$fetch(…)`, `ofetch.create`), a second,
synthetic call site is emitted next to the ordinary one:

- `kind = STATIC`, opaque, one argument and no result;
- `callee_fqn = "http:<METHOD> <path>"` and `http_call = {method, path}`;
- every data argument of the request (the URL, the body, the options object)
  flows into its argument.

With no result the site is inert unless the engine links it to a route, so a
repository whose calls match no route analyses as before. The ordinary call
site keeps its name, so catalog rules on it still apply.

Detection follows the binding of the callee, never its name: an import from
`axios`, `ky` or `ofetch`, the global `fetch` or `$fetch` (not a local or a
parameter of that name), or a variable initialised by a client's factory, in
the same file or imported from another (`export const api = axios.create(…)`,
then `api.get(…)`). The name alone could not tell them apart: `axios.get`,
`ky.get` and `api.get` are all named `.get`.

The path is recovered from string and template literals (each `${…}` is `{}`),
`+` concatenation and `new URL(path, base)`. A `${…}` or operand is replaced by
its value when the checker knows it as one string (`const BASE = '/api'`), and
a local `const url = …` by its initialiser. `import.meta.env.*`,
`process.env.*` and any other unknown value become `{}`, so an unknown base
URL becomes the leading `{}` segment: `` fetch(`${API}/users/${id}`) `` is
`GET /{}/users/{}`. A base URL (`baseURL`; `prefixUrl`, `prefix`, `baseUrl` for
ky) is prepended, also to a path starting with `/` (as axios does), from the
first of: the request's own config, the instance's config
(`axios.create(cfg)`, through a `const` config and spreads), and a repository-wide
`axios.defaults.baseURL = …`. A base the code sets but the tool cannot read (a
computed value, a config object it cannot see) is `{}`, never dropped. A path
that does not start with `/` and has no base (`ky.get('users')`) is relative to
something unseen, so it also gets the leading `{}`.
The result is canonicalised (no scheme, host, query or fragment). The method is
the verb, or the `method` of the options or config object (`GET` when there is
none, unknown when the object is not a literal).

## Flow extraction

(`src/flow.ts`)

Inside a function, flow is a name-based value graph: an assignment, a member
read, an object or array literal, `await`, `?.` and spread all carry taint, and
any part of a tainted object taints the whole (no field sensitivity). The graph
is flow-insensitive within one function. Every statement is walked, including
the bodies of `try`, `catch` and `finally` (`--no-try-blocks` restores the
earlier walk, which skipped `try` and `finally`). It is projected onto CGF vertices of
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
- endpoint `iid` = hash of (repo id, `""`, endpoint name, `"http"`), except
  for a route, whose endpoint `iid` is its contract `iid`;
- contract `iid` = hash of (`""`, `""`, contract name, `"grpc"`), where the
  contract name is `graphql:<Type>.<field>` or `http:<METHOD> <path>`;
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
- React: the props object is one value, so one tainted prop taints every prop
  a component reads. A setter passed down as a prop (`<Input onChange={setQ}/>`)
  or as a callback (`.then(setUser)`) is not followed (the same gap as
  `onChange?.(v)` below). Context (`createContext`/`useContext`) and stores
  (Redux, Zustand) are not modelled, so taint does not cross them. Class
  components are not resolved (`<Legacy/>` stays an opaque call), nor are a
  wrapper of a wrapper (`memo(forwardRef(…))`) and a component declared inside
  another one. `lazy(() => import('./X'))` also leaves a call into `X` in the
  file's top-level code. React Router and other client-side route tables are
  not endpoints.
- Next.js: `layout.*`, `generateMetadata`, `getServerSideProps`,
  `middleware.ts`/`proxy.ts` and an inline action
  (`action={async () => { 'use server'; … }}`) are not modelled. A verb
  exported as a wrapper call (`export const GET = withAuth(handler)`) gets no
  route, and a renamed export of a `'use server'` module is no action. An
  optional catch-all (`[[...slug]]`) gives one route, `{*}`.
- HTTP clients: only `fetch`, axios, ky and ofetch are recognised (not
  superagent, SWR keys or RTK Query endpoints), a URL built by a helper in
  another file is `{}`, and a SvelteKit `load({ fetch })` parameter is not the
  global `fetch`.
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
