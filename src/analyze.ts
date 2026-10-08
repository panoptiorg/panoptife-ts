// Per-repo extraction: files -> FnSpecs -> LocalFlow -> CgfPackages.
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import { CallKind, EndpointKind, SCHEMA_VERSION, VertexKind, type CgfCodec } from './cgf.js';
import { FlowBuilder } from './flow.js';
import { analyzeDocument, type OpDoc } from './gqlop.js';
import { contractIID, endpointIID, field, fnIID, hex } from './hash.js';
import {
  canonPath,
  HTTP_CLIENTS,
  HTTP_METHODS,
  httpContractIID,
  httpContractName,
  isAbsoluteUrl,
  joinBase,
  verbMethod,
  type HttpClientLib,
} from './http.js';
import type { CallSite, CgfPackage, Endpoint, Fn, HttpRoute, Span } from './model.js';
import { loadAdapters, repoDeps, AdapterSet, type HandlerRule, type InvokeRule } from './adapter.js';
import {
  assignSinkName,
  CTOR_TYPES,
  GLOBALS,
  IDENTITY_HOFS,
  isIntrinsicTag,
  jsxFactName,
  pathText,
  receiverName,
  ROUTE_SOURCE_CALLS,
  RUNE_ROOTS,
  sourceReadName,
  unwrap,
} from './naming.js';
import { createRepoProgram, virtualName, type SourceUnit } from './program.js';
import { loadRepo, resolveImport, type RepoInfo } from './repo.js';
import {
  hasDirective,
  looksLikeNext,
  nextRoots,
  routeDecl,
  routeFileOf,
  type NextRoots,
  type RouteDecl,
} from './routes.js';
import { loadSdl, type Sdl } from './sdl.js';
import { lowerSvelte, mapSveltePos, type SvelteMap } from './svelte.js';
import { createHash } from 'node:crypto';

type SpecKind = 'fn' | 'script' | 'op' | 'handler' | 'module';

interface FnSpec {
  sym: string;
  kind: SpecKind;
  params: ts.ParameterDeclaration[];
  body: ts.Node | null;
  pos: number;
  /** kind === 'op' */
  op?: { doc: OpDoc; mapper: ts.Expression | null };
  /** kind === 'handler', rule kind 'path': the string the op is registered under */
  handlerPath?: string;
  /** kind === 'handler', rule kind 'doc': the document expression it was built from */
  handlerDoc?: ts.Expression;
  /** kind === 'handler': the adapter rule that created it */
  handlerRule?: HandlerRule;
  /** kind === 'handler': at CALL time the variables are this property of arg 0 */
  varsProp?: string;
  /** SvelteKit server endpoint this function implements */
  endpoint?: string;
  /** coverage wave 1 §3.3 — the file-system routes this function serves */
  routes?: RouteDecl[];
  /** coverage wave 1 §3.3 — a Next.js server action: every parameter is request data */
  action?: boolean;
  /** the declaration node the checker will hand back for this function */
  decl?: ts.Node;
  /** this function RETURNS the result of this call — `useShowFail` is
   *  `() => useOverlay({…})`, so its `$ret` is `useOverlay`'s `$ret`. */
  retCall?: ts.CallExpression;
}

interface ImportBinding {
  spec: string;
  imported: string;
}

interface FileUnit {
  rel: string;
  pkg: string;
  sf: ts.SourceFile;
  imports: Map<string, ImportBinding>;
  specs: FnSpec[];
  /** exported/top-level symbol -> spec (for cross-file STATIC resolution) */
  byName: Map<string, FnSpec>;
  /** .svelte only: lowered offset -> original offset (call shape 7) */
  smap?: SvelteMap;
  /** locals bound to a codegen SDK object (`const sdk = getSdk(client)`) */
  sdkVars: Set<string>;
}

export interface Stats {
  files: number;
  functions: number;
  callsites: number;
  invokesRemote: number;
  ops: number;
  opFieldsViaSdl: number;
  opFieldsFallback: number;
  handlers: number;
  endpoints: number;
  /** call sites that resolved STATIC to an in-repo declaration */
  resolved: number;
  /** of those, the ones only the checker found */
  resolvedByChecker: number;
  resolver: string;
  programMs: number;
  /** the repo's node_modules was present, so the program carries real types */
  typed: boolean;
  externalFiles: number;
  /** type-anchored links into a `$op` (checker resolution, codegen'd __queryTypes) */
  anchors: number;
  /** … of those, on a call site the checker could NOT bind */
  anchorsOnOpaque: number;
  opaque: Map<string, number>;
  warnings: string[];
  /** adapters in effect (adapters); empty === `--no-adapters` */
  adapters: string[];
  /** coverage wave 1 §3.1 — component elements emitted as call sites … */
  jsxComponents: number;
  /** … of those, bound STATIC to an in-repo component */
  jsxComponentsResolved: number;
  /** intrinsic-element sink facts (`jsx:html`, `jsx:attr:*`) */
  jsxFacts: number;
  /** the repo's react major (installed, else the package.json range's minimum); null = unknown */
  reactMajor: number | null;
  /** coverage wave 1 §3.3 — the repo looks like Next.js, so its conventions apply */
  nextjs: boolean;
  /** HttpRoute rows emitted, in total and per convention */
  httpRoutes: number;
  httpRoutesByFramework: Record<string, number>;
  /** Next.js server actions (Endpoint, every parameter untrusted, no route) */
  serverActions: number;
  /** coverage wave 1 §3.4 — synthetic HTTP client sites … */
  httpCalls: number;
  /** … whose path has at least one literal segment */
  httpCallsResolvedPath: number;
  /** … whose path starts with an unresolved base (`{}`) */
  httpCallsDynamicBase: number;
  /** … whose method is unknown */
  httpCallsUnknownMethod: number;
}

export interface BuildOpts {
  repoDir: string;
  repoId?: string;
  outDir: string;
  schemas?: string[];
  codec: CgfCodec;
  quiet?: boolean;
  /** 'checker' (default) uses ts.Program symbol resolution; 'syntactic' is the
   *  pre-checker import-table resolver, kept for A/B measurement. */
  resolver?: 'checker' | 'syntactic';
  /** type-anchored `$op` links (default on; checker resolver only) */
  typeAnchors?: boolean;
  /** explicit `--adapter <name>`… ; overrides auto-detection from package.json */
  adapters?: string[];
  /** `--no-adapters`: run the core alone (no client-library knowledge at all) */
  noAdapters?: boolean;
  /** `--no-adapter-routes`: keep the adapters but emit no generated HTTP routes */
  adapterRoutes?: boolean;
  /** `--no-adapter <name>`: never load these adapters, even when detected or included */
  excludeAdapters?: string[];
  /** override the adapters/ directory (tests) */
  adaptersDir?: string;
  /**
   * Library write-back (default on). At a call with no in-repo target, an
   * argument that names a variable — `parts` in `parts.push(x)`, `target` in
   * `Object.assign(target, src)` — gets its arg port wired back into that
   * variable, so a core-side `[[propagators]]` rule that writes the port reaches
   * the variable's later uses. Also names the receiver type of built-in
   * containers (`[]` / `T[]` → Array, `new Map()` → Map, `new Set()` → Set), so a
   * rule can select `Array.push` rather than every `.push`. Inert on its own.
   * `false` (`--no-library-writeback`) reproduces the previous emission.
   */
  libraryWriteback?: boolean;
  /**
   * Walk JSX (coverage wave 1 §3.1, default on): attribute initializers and
   * `{…}` children are not `Expression` children of an element, so before this
   * every `onClick={() => …}` body in a `.tsx` was invisible. Also joins `.jsx`
   * and `.cjs` to the walk and `.tsx`/`.jsx` to import resolution. `false`
   * (`--no-jsx`) reproduces the previous emission and implies the two below off.
   */
  jsx?: boolean;
  /** `<Child …/>` is a STATIC call of `Child` with the props object as arg 0
   *  (§3.1, default on; `--no-jsx-components`) */
  jsxComponents?: boolean;
  /** intrinsic-element sink facts `jsx:html`, `jsx:attr:<name>` (§3.1, default
   *  on; `--no-jsx-facts`) */
  jsxFacts?: boolean;
  /**
   * File-system routes (coverage wave 1 §3.3, default on): SvelteKit `+server`
   * verbs and the Next.js conventions become `Endpoint{HTTP}` keyed on the
   * route's contract iid, plus an `HttpRoute`; Next server actions become
   * endpoints with every parameter untrusted. `false` (`--no-http-routes`)
   * reproduces the previous emission.
   */
  httpRoutes?: boolean;
  /**
   * HTTP client sites (coverage wave 1 §3.4, default on): at a `fetch`, axios,
   * ky or ofetch request, a synthetic `http:<METHOD> <path>` site (argc 1,
   * resultc 0, `http_call` set) in ADDITION to the ordinary call site, every
   * data argument flowing into its port 0. Unlinked it is inert. `false`
   * (`--no-http-calls`) reproduces the previous emission.
   */
  httpCalls?: boolean;
  /**
   * Walk `try { … }` and `finally { … }` bodies (default on). `ts.isStatement`
   * is false for a Block whose parent is a TryStatement, so the generic
   * statement walk never entered them — only `catch` was walked, and every call
   * inside a `try` was invisible (found running coverage wave 1 on real React
   * code: a third of the HTTP calls sit in a `try`). `false` (`--no-try-blocks`)
   * reproduces the previous emission.
   */
  tryBlocks?: boolean;
  /**
   * Name a method call on an instance of an imported class after the class
   * (default on): `const pool = new Pool()` with `import { Pool } from 'pg'`
   * makes `pool.query(q)` — here or in any file importing `pool` — the opaque
   * call `pg.Pool.query` instead of `.query`, which no catalog rule can target
   * without also matching every other `.query`. `false` (`--no-instance-names`)
   * reproduces the previous emission.
   */
  instanceNames?: boolean;
}

// ---------------------------------------------------------------------------
// pass A — parse
// ---------------------------------------------------------------------------

function collectImports(sf: ts.SourceFile): Map<string, ImportBinding> {
  const m = new Map<string, ImportBinding>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.importClause?.isTypeOnly) continue;
    const spec = st.moduleSpecifier.text;
    const c = st.importClause;
    if (!c) continue;
    if (c.name) m.set(c.name.text, { spec, imported: 'default' });
    const nb = c.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) m.set(nb.name.text, { spec, imported: '*' });
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue;
        m.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text });
      }
    }
  }
  return m;
}

function fnLike(e: ts.Expression | undefined): ts.FunctionExpression | ts.ArrowFunction | null {
  if (!e) return null;
  const u = unwrap(e);
  if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) return u;
  return null;
}

/** `gatewayLoad([a, b], async () => {…})` — the real body is the callback. */
function callbackBody(e: ts.Expression): ts.FunctionExpression | ts.ArrowFunction | null {
  const u = unwrap(e);
  if (!ts.isCallExpression(u)) return null;
  for (const a of u.arguments) {
    const f = fnLike(a);
    if (f) return f;
  }
  return null;
}

/** trailing name of a callee expression: `client.fetchQuery` -> `fetchQuery` */
function lastName(e: ts.Expression): string {
  const n = unwrap(e);
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  return '';
}

/** the function a factory RETURNS: `() => (params) => …` / `{ return (p) => … }` */
function returnedFn(body: ts.Node): ts.FunctionExpression | ts.ArrowFunction | null {
  if (ts.isBlock(body)) {
    for (const st of body.statements) {
      if (ts.isReturnStatement(st) && st.expression) {
        const f = fnLike(st.expression);
        if (f) return f;
      }
    }
    return null;
  }
  return ts.isExpression(body as ts.Expression) ? fnLike(body as ts.Expression) : null;
}

/** the object literal bound to `name` inside `scope` (`const manager = {…}`) */
function findLocalObj(scope: ts.Node, name: string): ts.ObjectLiteralExpression | null {
  let hit: ts.ObjectLiteralExpression | null = null;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      const e = n.initializer ? unwrap(n.initializer) : null;
      if (e && ts.isObjectLiteralExpression(e)) {
        hit = e;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(scope, visit);
  return hit;
}

/** the OBJECT LITERAL a factory returns: `() => ({a, b})` / `{ return {a,b}; }`
 *  — including the `const manager = {…}; return manager;` spelling. */
function returnedObject(body: ts.Node): ts.ObjectLiteralExpression | null {
  const of = (e0: ts.Expression): ts.ObjectLiteralExpression | null => {
    const e = unwrap(e0);
    if (ts.isObjectLiteralExpression(e)) return e;
    return ts.isIdentifier(e) ? findLocalObj(body, e.text) : null;
  };
  if (ts.isBlock(body)) {
    for (const st of body.statements) {
      if (ts.isReturnStatement(st) && st.expression) {
        const e = of(st.expression);
        if (e) return e;
      }
    }
    return null;
  }
  return of(body as ts.Expression);
}

/** the CALL a factory returns: `() => createMutation(() => ({mutationFn}))` */
function returnedCall(body: ts.Node): ts.CallExpression | null {
  if (ts.isBlock(body)) {
    for (const st of body.statements) {
      if (ts.isReturnStatement(st) && st.expression) {
        const e = unwrap(st.expression);
        if (ts.isCallExpression(e)) return e;
      }
    }
    return null;
  }
  const e = unwrap(body as ts.Expression);
  return ts.isCallExpression(e) ? e : null;
}

/** the property NAME of an object-literal member, or "" */
function propName(pr: ts.ObjectLiteralElementLike): string {
  const n = pr.name;
  if (!n) return '';
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return '';
}

/** a class method's name as written (`find`, `#check`, `'find-by-name'`, `42`,
 *  `['by-id']`); any other computed name is `[computed]` */
function memberName(n: ts.PropertyName): string {
  if (ts.isComputedPropertyName(n)) {
    return ts.isStringLiteralLike(n.expression) || ts.isNumericLiteral(n.expression)
      ? n.expression.text
      : '[computed]';
  }
  return n.text;
}

interface FnShape {
  params: readonly ts.ParameterDeclaration[];
  body: ts.Node;
  decl: ts.Node;
}

/**
 * The nearest function bound to `name` inside `scope` — the shorthand case of
 * `const push = …; return { push }` (call shape 1). Syntactic on
 * purpose: this runs in pass A, before the checker index exists.
 */
function findLocalFn(scope: ts.Node, name: string): FnShape | null {
  let hit: FnShape | null = null;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      const f = fnLike(n.initializer);
      if (f && f.body) {
        hit = { params: f.parameters, body: f.body, decl: n };
        return;
      }
    }
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) {
      hit = { params: n.parameters, body: n.body, decl: n };
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(scope, visit);
  return hit;
}

/** the function standing behind one property of a returned object literal */
function propFn(pr: ts.ObjectLiteralElementLike, scope: ts.Node): FnShape | null {
  if (ts.isPropertyAssignment(pr)) {
    const f = fnLike(pr.initializer);
    if (f && f.body) return { params: f.parameters, body: f.body, decl: pr };
    const id = unwrap(pr.initializer);
    if (ts.isIdentifier(id)) {
      const l = findLocalFn(scope, id.text);
      if (l) return { params: l.params, body: l.body, decl: pr };
    }
    return null;
  }
  if (ts.isShorthandPropertyAssignment(pr)) {
    const l = findLocalFn(scope, pr.name.text);
    return l ? { params: l.params, body: l.body, decl: pr } : null;
  }
  if (ts.isMethodDeclaration(pr) && pr.body) {
    return { params: pr.parameters, body: pr.body, decl: pr };
  }
  if (ts.isGetAccessorDeclaration(pr) && pr.body) {
    return { params: [], body: pr.body, decl: pr };
  }
  return null;
}

/** names called as a BARE identifier anywhere in the file (shape 3 filter) */
function calledIdents(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const c = unwrap(n.expression);
      if (ts.isIdentifier(c)) out.add(c.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** `{…}`, `() => ({…})` or `() => { return {…}; }` — the options-object shape */
function objectArg(e: ts.Expression): ts.ObjectLiteralExpression | null {
  const n = unwrap(e);
  if (ts.isObjectLiteralExpression(n)) return n;
  const f = fnLike(n);
  if (!f || !f.body) return null;
  if (!ts.isBlock(f.body)) {
    const b = unwrap(f.body);
    return ts.isObjectLiteralExpression(b) ? b : null;
  }
  for (const st of f.body.statements) {
    if (ts.isReturnStatement(st) && st.expression) {
      const b = unwrap(st.expression);
      if (ts.isObjectLiteralExpression(b)) return b;
    }
  }
  return null;
}

function gqlTextOf(n: ts.Node, ad: AdapterSet): string | null {
  if (!ts.isTaggedTemplateExpression(n)) return null;
  const tag = pathText(n.tag);
  if (!ad.gqlTags.has(tag) && !ad.gqlTagSuffix.some((x) => tag.endsWith(x))) return null;
  const t = n.template;
  if (ts.isNoSubstitutionTemplateLiteral(t)) return t.text;
  // `${FRAGMENT}` interpolations: keep the literal spans, drop the holes
  return [t.head.text, ...t.templateSpans.map((s) => s.literal.text)].join('\n');
}

function findGql(root: ts.Node, ad: AdapterSet): ts.TaggedTemplateExpression[] {
  const out: ts.TaggedTemplateExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(n) && gqlTextOf(n, ad) !== null) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** Fill an adapter route template. `{path}` is the handler's registered path;
 *  a template with an unfillable placeholder generates no route. */
function routeNameFor(tpl: string, spec: FnSpec): string | undefined {
  let bad = false;
  const out = tpl.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = k === 'path' ? spec.handlerPath : k === 'name' ? spec.sym : undefined;
    if (!v) bad = true;
    return v ?? '';
  });
  return bad ? undefined : out;
}

/** Names the file exports under their own name: `export function f`,
 *  `export const f = …`, `export { f }`. A rename (`export { h as GET }`) and a
 *  re-export from another module are not included. */
function exportedNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const exported = (st: ts.FunctionDeclaration | ts.VariableStatement) =>
    st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && exported(st)) out.add(st.name.text);
    else if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.add(d.name.text);
      }
    } else if (
      ts.isExportDeclaration(st) &&
      !st.isTypeOnly &&
      !st.moduleSpecifier &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements) {
        if (el.isTypeOnly) continue;
        if (!el.propertyName || el.propertyName.text === el.name.text) out.add(el.name.text);
      }
    }
  }
  return out;
}

/** The HTTP endpoint a function is, if any. SvelteKit serves these exports:
 *  `load` in `+page.server` and `+layout.server`, each member of `actions` in
 *  `+page.server`, and the HTTP method handlers in `+server` (`.ts` or `.js`).
 *  Other files, server-only `*.server.ts` modules included, have none. */
function endpointNameFor(
  rel: string,
  sym: string,
  exported: ReadonlySet<string>,
): string | undefined {
  const m = /^\+(page\.server|layout\.server|server)\.[jt]s$/.exec(path.posix.basename(rel));
  if (!m) return undefined;
  const dot = sym.indexOf('.');
  if (!exported.has(dot < 0 ? sym : sym.slice(0, dot))) return undefined;
  const ok =
    m[1] === 'server'
      ? HTTP_METHODS.has(sym)
      : sym === 'load' || (m[1] === 'page.server' && /^actions\.[^.$][^.]*$/.test(sym));
  return ok ? `${sym} ${path.posix.dirname(rel)}` : undefined;
}

/** BuildOpts switches pass A needs (coverage wave 1) */
interface ParseFlags {
  /** §3.1 component resolution: `export default wrap(function C…)` is a function,
   *  `const X = lazy(() => import(…))` is NOT one (the wrapper is walked through) */
  jsxComponents: boolean;
  /** §3.3: a nested function with a `'use server'` directive is an action, so it
   *  is emitted as `<parent>.$<name>` even when nothing calls it by name */
  serverActions: boolean;
  /** to tell a function REFERENCE among a wrapper's arguments (`wrappedBody`) */
  checker: ts.TypeChecker | null;
}

/**
 * `() => import('./x')` / `() => { return import('./x'); }` — the specifier and
 * the export it stands for: `default`, or the member a `.then` picks
 * (`import('./x').then((m) => ({ default: m.Named }))`, `.then((m) => m.Named)`).
 */
function importThunkSpec(e: ts.Expression): { spec: ts.StringLiteral; member: string } | null {
  const f = fnLike(e);
  if (!f || f.parameters.length || !f.body) return null;
  let body: ts.Node = f.body;
  if (ts.isBlock(body)) {
    const ret = body.statements.length === 1 ? body.statements[0] : undefined;
    if (!ret || !ts.isReturnStatement(ret) || !ret.expression) return null;
    body = ret.expression;
  }
  let call = unwrap(body as ts.Expression);
  let member = 'default';
  if (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'then'
  ) {
    const pick = thenMember(call.arguments[0]);
    if (!pick) return null;
    member = pick;
    call = unwrap(call.expression.expression);
  }
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const a0 = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
  return a0 && ts.isStringLiteral(a0) ? { spec: a0, member } : null;
}

/** the module member a `.then((m) => …)` callback selects, or null */
function thenMember(e: ts.Expression | undefined): string | null {
  const f = e ? fnLike(e) : null;
  if (!f || !f.body || ts.isBlock(f.body)) return null;
  let v = unwrap(f.body);
  if (ts.isObjectLiteralExpression(v)) {
    const d = propValue(v, 'default');
    if (!d) return null;
    v = unwrap(d);
  }
  if (ts.isPropertyAccessExpression(v)) return v.name.text; // m.Named
  // ({ Named }) => ({ default: Named })
  return ts.isIdentifier(v) && f.parameters[0] && ts.isObjectBindingPattern(f.parameters[0].name)
    ? v.text
    : null;
}

/** an argument that is a function REFERENCE (not an inline function) */
function isFunctionRef(e: ts.Expression, ch: ts.TypeChecker | null): boolean {
  const n = unwrap(e);
  if (!ch || !(ts.isIdentifier(n) || ts.isPropertyAccessExpression(n))) return false;
  try {
    return ch.getTypeAtLocation(n).getCallSignatures().length > 0;
  } catch {
    return false;
  }
}

/**
 * The function `X = wrap(…)` / `export default wrap(…)` is (coverage wave 1):
 *  - a known identity wrapper (`memo`, `forwardRef`, adapter `[[identity_hof]]`)
 *    wraps ARG 0: that inline function, or nothing here when arg 0 is a
 *    reference or an import thunk (resolution walks those) — never a later
 *    argument (`memo(Comp, areEqual)` is Comp, not the comparator);
 *  - any other call wraps its first inline function, unless arg 0 is already a
 *    function reference (`rateLimit(handler, (r) => r.ip)` wraps `handler`).
 */
function wrappedBody(
  call: ts.CallExpression,
  ad: AdapterSet,
  flags: ParseFlags,
): ts.FunctionExpression | ts.ArrowFunction | null {
  const hof = lastName(call.expression);
  const a0 = call.arguments[0];
  if (IDENTITY_HOFS.has(hof) || ad.identityHofs.has(hof)) {
    return a0 && !importThunkSpec(a0) ? fnLike(a0) : null;
  }
  if (a0 && isFunctionRef(a0, flags.checker)) return null;
  return callbackBody(call);
}

function parseFile(
  rel: string,
  sf: ts.SourceFile,
  svelte: boolean,
  sdl: Sdl,
  stats: Stats,
  ad: AdapterSet,
  flags: ParseFlags,
  smap?: SvelteMap,
): FileUnit | null {
  const unit: FileUnit = {
    rel,
    pkg: path.posix.dirname(rel) === '.' ? 'root' : path.posix.dirname(rel),
    sf,
    imports: collectImports(sf),
    specs: [],
    byName: new Map(),
    smap,
    sdkVars: new Set(),
  };

  // --- GraphQL operations: one $op per document in the file --------------
  // WHICH tagged templates carry a document, and where the result mapper sits,
  // are `[[operation]]` rows of the loaded adapters (adapters). With
  // `--no-adapters` this loop finds nothing and the repo has no operations.
  const tags = findGql(sf, ad);
  const docs: Array<{
    doc: OpDoc;
    mapper: ts.Expression | null;
    pos: number;
    decl?: ts.Node;
  }> = [];
  for (const tag of tags) {
    const txt = gqlTextOf(tag, ad)!;
    // mapper: the sibling property of the object literal carrying the document
    let mapper: ts.Expression | null = null;
    for (let p: ts.Node | undefined = tag; p; p = p.parent) {
      if (ts.isObjectLiteralExpression(p)) {
        for (const pr of p.properties) {
          const nm = pr.name && ts.isIdentifier(pr.name) ? pr.name.text : '';
          if (!ad.mapperProps.includes(nm)) continue;
          if (ts.isPropertyAssignment(pr)) mapper = pr.initializer;
          else if (ts.isShorthandPropertyAssignment(pr)) mapper = pr.name;
        }
        break;
      }
    }
    // `const LOGIN = gql`…`` — the const IS the document, so the checker can
    // bind `useMutation(LOGIN)` straight to this `$op`. Only registered when an
    // adapter actually binds callables to documents, so a shop whose documents
    // are only ever reached through a path string emits exactly as before.
    let decl: ts.Node | undefined;
    if (ad.needsDocIndex) {
      const par = tag.parent;
      if (par && ts.isVariableDeclaration(par) && par.initializer === tag) decl = par;
    }
    for (const doc of analyzeDocument(txt, sdl)) {
      for (const w of doc.warnings) stats.warnings.push(`${rel}: ${w}`);
      docs.push({ doc, mapper, pos: tag.getStart(sf), decl });
    }
  }
  docs.forEach((d, i) => {
    const sym = docs.length === 1 ? '$op' : `$op$${i}`;
    const spec: FnSpec = {
      sym,
      kind: 'op',
      params: [],
      body: null,
      pos: d.pos,
      op: { doc: d.doc, mapper: d.mapper },
      decl: d.decl,
    };
    unit.specs.push(spec);
    unit.byName.set(sym, spec);
  });

  const consumed = new Set<ts.Statement>();
  const exported = svelte ? new Set<string>() : exportedNames(sf);

  const symSeen = new Map<string, number>();
  const addSpec = (
    sym0: string,
    kind: SpecKind,
    params: readonly ts.ParameterDeclaration[],
    body: ts.Node | null,
    pos: number,
    extra?: Partial<FnSpec>,
  ): FnSpec => {
    // fqn -> iid must be injective: two same-named declarations in one file
    // (overloads, a re-declared const, a repeated object key) would otherwise
    // collide and the second silently replace the first in the core's index.
    const n = symSeen.get(sym0) ?? 0;
    symSeen.set(sym0, n + 1);
    const sym = n === 0 ? sym0 : `${sym0}$${n}`;
    const s: FnSpec = {
      sym,
      kind,
      params: [...params],
      body,
      pos,
      endpoint: endpointNameFor(rel, sym, exported),
      ...extra,
    };
    // An adapter `[[handler]] route = "POST /api/{path}"` says this callable IS
    // the repo's BFF surface: generate the HTTP endpoint it is reached through,
    // so a chain can START at the route instead of at whatever page happens to
    // call it (adapters).
    if (kind === 'handler' && ad.routes && s.handlerRule?.route && !s.endpoint) {
      const route = routeNameFor(s.handlerRule.route, s);
      if (route) s.endpoint = route;
    }
    unit.specs.push(s);
    if (!unit.byName.has(sym)) unit.byName.set(sym, s);
    return s;
  };

  if (svelte) {
    // the whole <script> pair is ONE function (the flow model)
    addSpec('$script', 'script', [], sf, 0);
  }

  for (const st of svelte ? [] : sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.body) {
      const nm =
        st.name?.text ??
        (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : null);
      if (nm) {
        addSpec(nm, 'fn', st.parameters, st.body, st.getStart(sf), { decl: st });
        consumed.add(st);
        continue;
      }
    }
    if (ts.isClassDeclaration(st) && st.name) {
      for (const m of st.members) {
        if ((ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) && m.body) {
          const nm = ts.isConstructorDeclaration(m) ? 'constructor' : memberName(m.name);
          addSpec(`${st.name.text}.${nm}`, 'fn', m.parameters, m.body, m.getStart(sf), {
            decl: m,
          });
        }
      }
      consumed.add(st);
      continue;
    }
    if (ts.isVariableStatement(st)) {
      let handled = false;
      for (const d of st.declarationList.declarations) {
        if (!d.initializer) continue;
        // `const [mutate] = useMutation(DOC)` — an adapter `[[handler]]` with
        // `bind = "array0"`: the callable is element 0 of the destructured
        // result and the document names the op (adapters).
        if (ts.isArrayBindingPattern(d.name)) {
          const initA = unwrap(d.initializer);
          if (!ts.isCallExpression(initA)) continue;
          const ruleA = ad.handlerFactories.get(lastName(initA.expression));
          if (!ruleA || ruleA.kind !== 'doc' || ruleA.bind !== 'array0') continue;
          const el = d.name.elements[0];
          if (!el || !ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
          const docA = initA.arguments[ruleA.docArg];
          if (!docA) continue;
          addSpec(el.name.text, 'handler', [], null, el.getStart(sf), {
            handlerDoc: docA,
            handlerRule: ruleA,
            varsProp: ruleA.varsProp,
            decl: el,
          });
          stats.handlers++;
          handled = true;
          continue;
        }
        if (!ts.isIdentifier(d.name)) continue;
        const name = d.name.text;
        const init = unwrap(d.initializer);
        const f = fnLike(init);
        if (f) {
          addSpec(name, 'fn', f.parameters, f.body, d.getStart(sf), { decl: d });
          handled = true;
          continue;
        }
        if (ts.isCallExpression(init)) {
          const callee = unwrap(init.expression);
          const rule = ad.handlerFactories.get(lastName(init.expression));
          if (rule && (!rule.onReceiver || ts.isPropertyAccessExpression(callee))) {
            if (rule.kind === 'path') {
              const a0 = init.arguments[rule.pathArg];
              const p = a0 && ts.isStringLiteral(a0) ? a0.text : '';
              addSpec(name, 'handler', [], null, d.getStart(sf), {
                handlerPath: p,
                handlerRule: rule,
                varsProp: rule.varsProp,
                decl: d,
              });
              stats.handlers++;
              handled = true;
              continue;
            }
            if (rule.kind === 'doc' && rule.bind === 'value') {
              const dc = init.arguments[rule.docArg];
              if (dc) {
                addSpec(name, 'handler', [], null, d.getStart(sf), {
                  handlerDoc: dc,
                  handlerRule: rule,
                  varsProp: rule.varsProp,
                  decl: d,
                });
                stats.handlers++;
                handled = true;
                continue;
              }
            }
            if (rule.kind === 'sdk') unit.sdkVars.add(name);
          }
          const cb = flags.jsxComponents ? wrappedBody(init, ad, flags) : callbackBody(init);
          if (cb) {
            addSpec(name, 'fn', cb.parameters, cb.body, d.getStart(sf), { decl: d });
            handled = true;
            continue;
          }
        }
        if (ts.isObjectLiteralExpression(init)) {
          // `export const actions = { default: async ({request}) => … }`
          for (const pr of init.properties) {
            const nm = pr.name && (ts.isIdentifier(pr.name) || ts.isStringLiteral(pr.name))
              ? pr.name.text
              : null;
            if (!nm) continue;
            const pf =
              ts.isPropertyAssignment(pr) ? fnLike(pr.initializer)
              : ts.isMethodDeclaration(pr) ? pr
              : null;
            if (pf && pf.body) {
              addSpec(`${name}.${nm}`, 'fn', pf.parameters, pf.body, pr.getStart(sf), {
                decl: pr,
              });
              handled = true;
              continue;
            }
            // a REGISTRY of handlers: `export const endpoints = { getX: <factory>('x') }`
            if (ts.isPropertyAssignment(pr)) {
              const pi = unwrap(pr.initializer);
              if (ts.isCallExpression(pi)) {
                const pc = unwrap(pi.expression);
                const prule = ad.handlerFactories.get(lastName(pi.expression));
                if (
                  prule &&
                  prule.kind === 'path' &&
                  (!prule.onReceiver || ts.isPropertyAccessExpression(pc))
                ) {
                  const a0 = pi.arguments[prule.pathArg];
                  addSpec(`${name}.${nm}`, 'handler', [], null, pr.getStart(sf), {
                    handlerPath: a0 && ts.isStringLiteral(a0) ? a0.text : '',
                    handlerRule: prule,
                    varsProp: prule.varsProp,
                    decl: pr,
                  });
                  stats.handlers++;
                  handled = true;
                }
              }
            }
          }
        }
      }
      if (handled) consumed.add(st);
      continue;
    }
    if (ts.isExportAssignment(st)) {
      const f = fnLike(st.expression);
      if (f) {
        addSpec('default', 'fn', f.parameters, f.body, st.getStart(sf), { decl: st });
        consumed.add(st);
        continue;
      }
      // coverage wave 1 §3.1: `export default memo(function Panel(…) {…})` — the
      // same wrapper rule a `const X = wrap(fn)` gets
      const call = unwrap(st.expression);
      const cb = flags.jsxComponents && ts.isCallExpression(call) ? wrappedBody(call, ad, flags) : null;
      if (cb) {
        addSpec('default', 'fn', cb.parameters, cb.body, st.getStart(sf), { decl: st });
        consumed.add(st);
      }
      continue;
    }
  }

  // A factory that RETURNS a closure — `export const useFetch = () => (params,
  // opts) => client.fetchQuery({queryFn: () => getHandle(params)})` — is how a
  // large fleet writes every query/mutation hook, and `const f = useFetch(); f(x)`
  // is unresolvable while the closure only exists inlined in its parent. Emit it
  // as its own `<sym>.$ret` (checker resolution); the inlined copy stays, so captures
  // keep working in the parent.
  const base = [...unit.specs];
  for (const spec of base) {
    if (spec.kind !== 'fn' || !spec.body || spec.sym.includes('.$')) continue;
    const ret = returnedFn(spec.body);
    if (!ret || !ret.body) continue;
    addSpec(`${spec.sym}.$ret`, 'fn', ret.parameters, ret.body, ret.getStart(sf), { decl: ret });
  }

  // call shape 1 — a factory returning an OBJECT LITERAL of closures
  // (`const push = …; return {push, replace, pop}`) is the other half of the
  // hook idiom: `const router = useRouter(); router.push(url)`. Emit every
  // property as its own `<sym>.$ret.<prop>` so the member call binds. Getters
  // count (`get ticker() {…}`), and a shorthand is chased to the local const.
  for (const spec of base) {
    if (spec.kind !== 'fn' || !spec.body || spec.sym.includes('.$')) continue;
    const obj = returnedObject(spec.body);
    if (obj) {
      for (const pr of obj.properties) {
        const nm = propName(pr) || (ts.isShorthandPropertyAssignment(pr) ? pr.name.text : '');
        if (!nm) continue;
        const f = propFn(pr, spec.body);
        if (!f) continue;
        addSpec(`${spec.sym}.$ret.${nm}`, 'fn', f.params, f.body, pr.getStart(sf), {
          decl: f.decl,
        });
      }
      continue;
    }
    // …and the framework HANDLE: `return createMutation(() => ({mutationFn}))`
    // hands back an object whose `mutate`/`mutateAsync` invoke the callback.
    const call = returnedCall(spec.body);
    if (!call) continue;
    if (!ad.callbackFactories.has(lastName(call.expression))) {
      // a factory that returns ANOTHER factory's result: remember the call so
      // resolution can chase `$ret` (and `$ret.<prop>`) one hop further.
      spec.retCall = call;
      continue;
    }
    for (const a of call.arguments) {
      const opts = objectArg(a);
      if (!opts) continue;
      for (const pr of opts.properties) {
        const methods = ad.handleMethods.get(propName(pr));
        if (!methods) continue;
        const f = propFn(pr, spec.body);
        if (!f) continue;
        for (const m of methods) {
          addSpec(`${spec.sym}.$ret.${m}`, 'fn', f.params, f.body, pr.getStart(sf), {
            decl: undefined,
          });
        }
      }
    }
  }

  // adapter `[[handler]] kind = "doc"` INSIDE a function body. A hook —
  // `const [mutate] = useMutation(LOGIN)` — is not a module-level registry: it
  // lives in the component that uses it, so it is emitted as `<parent>.$<name>`
  // and the checker's binding-element resolution finds it from the call site.
  if (ad.needsDocIndex) {
    for (const spec of base) {
      if ((spec.kind !== 'fn' && spec.kind !== 'script') || !spec.body) continue;
      if (spec.sym.includes('.$')) continue;
      const visitDoc = (n: ts.Node): void => {
        if (ts.isVariableDeclaration(n) && n.initializer) {
          const init = unwrap(n.initializer);
          if (ts.isCallExpression(init)) {
            const rule = ad.handlerFactories.get(lastName(init.expression));
            const recvOk =
              !rule?.onReceiver || ts.isPropertyAccessExpression(unwrap(init.expression));
            if (rule && rule.kind === 'doc' && recvOk) {
              const doc = init.arguments[rule.docArg];
              let nm: ts.Identifier | undefined;
              let decl: ts.Node | undefined;
              if (rule.bind === 'array0' && ts.isArrayBindingPattern(n.name)) {
                const el = n.name.elements[0];
                if (el && ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                  nm = el.name;
                  decl = el;
                }
              } else if (rule.bind === 'value' && ts.isIdentifier(n.name)) {
                nm = n.name;
                decl = n;
              }
              if (doc && nm && decl) {
                addSpec(`${spec.sym}.$${nm.text}`, 'handler', [], null, n.getStart(sf), {
                  handlerDoc: doc,
                  handlerRule: rule,
                  varsProp: rule.varsProp,
                  decl,
                });
                stats.handlers++;
              }
            }
          }
        }
        ts.forEachChild(n, visitDoc);
      };
      visitDoc(spec.body);
    }
  }

  // call shape 3 — a nested local function called BY NAME in the same
  // file (`const show = () => …; …; show()`). It is inlined into its parent, so
  // the call itself has no target; emit it as `<parent>.$<name>` as well. Only
  // names that are actually called bare in this file are emitted, which is
  // exactly the set that can resolve (a local cannot be called from elsewhere).
  const called = calledIdents(sf);
  for (const spec of base) {
    if ((spec.kind !== 'fn' && spec.kind !== 'script') || !spec.body) continue;
    if (spec.sym.includes('.$')) continue;
    const seen = new Set<string>();
    const visit = (n: ts.Node): void => {
      let shape: FnShape | null = null;
      let nm = '';
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const f = fnLike(n.initializer);
        if (f && f.body) {
          nm = n.name.text;
          shape = { params: f.parameters, body: f.body, decl: n };
        }
      } else if (ts.isFunctionDeclaration(n) && n.name && n.body) {
        nm = n.name.text;
        shape = { params: n.parameters, body: n.body, decl: n };
      }
      const action =
        flags.serverActions &&
        !!shape &&
        ts.isBlock(shape.body) &&
        hasDirective(shape.body.statements, 'use server');
      if (shape && nm && (called.has(nm) || action) && !seen.has(nm) && !unit.byName.has(nm)) {
        seen.add(nm);
        addSpec(`${spec.sym}.$${nm}`, 'fn', shape.params, shape.body, n.getStart(sf), {
          decl: shape.decl,
        });
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(spec.body, visit);
  }
  if (svelte) return unit;

  // Everything left at module level (side-effecting top-level code, gql
  // sub-expressions, store wiring) gets one $module function.
  const rest = sf.statements.filter(
    (s) =>
      !consumed.has(s) &&
      !ts.isImportDeclaration(s) &&
      !ts.isInterfaceDeclaration(s) &&
      !ts.isTypeAliasDeclaration(s) &&
      !ts.isExportDeclaration(s) &&
      !ts.isEnumDeclaration(s),
  );
  if (rest.length) {
    const spec = addSpec('$module', 'module', [], sf, 0);
    (spec as FnSpec & { stmts?: ts.Statement[] }).stmts = rest;
  }
  return unit;
}

// ---------------------------------------------------------------------------
// pass A' — file-system routes (coverage wave 1 §3.3)
// ---------------------------------------------------------------------------

/** a top-level function by local name, through `const GET = handler` */
function localSpec(unit: FileUnit, name: string): FnSpec | undefined {
  const own = unit.byName.get(name);
  if (own) return own;
  for (const st of unit.sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue;
      const e = unwrap(d.initializer);
      return ts.isIdentifier(e) && e.text !== name ? unit.byName.get(e.text) : undefined;
    }
  }
  return undefined;
}

/** The function a module default-exports: `export default function h`,
 *  `export default h`, `export default withAuth(h)`, `export { h as default }`.
 *  Through an unknown wrapper, the argument that is a local function with the
 *  handler's `arity` wins (`rateLimit(handler, keyOf)` is `handler`); else the
 *  first local function among the arguments. */
function defaultExportSpec(unit: FileUnit, arity = 0): FnSpec | undefined {
  for (const st of unit.sf.statements) {
    if (
      ts.isFunctionDeclaration(st) &&
      st.body &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      st.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      return unit.byName.get(st.name?.text ?? 'default');
    }
    if (ts.isExportAssignment(st) && !st.isExportEquals) {
      const own = unit.byName.get('default');
      if (own) return own;
      // a wrapper around a local handler (middleware): the local functions it is handed
      const cands: FnSpec[] = [];
      const collect = (e0: ts.Expression, depth: number): void => {
        const e = unwrap(e0);
        if (ts.isIdentifier(e)) {
          const sp = localSpec(unit, e.text);
          if (sp) cands.push(sp);
        } else if (ts.isCallExpression(e) && depth < 3) {
          for (const a of e.arguments) collect(a, depth + 1);
        }
      };
      collect(st.expression, 0);
      return cands.find((c) => arity > 0 && c.params.length === arity) ?? cands[0];
    }
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text === 'default') return localSpec(unit, (el.propertyName ?? el.name).text);
      }
    }
  }
  return undefined;
}

/** verb -> handler for a route file: own-name exports (`export function GET`,
 *  `export const GET = …`) and renames (`export { handler as GET, handler as POST }`) */
function verbHandlers(unit: FileUnit): Array<[string, FnSpec]> {
  const out: Array<[string, FnSpec]> = [];
  const exported = exportedNames(unit.sf);
  for (const v of HTTP_METHODS) {
    const sp = exported.has(v) ? localSpec(unit, v) : undefined;
    if (sp) out.push([v, sp]);
  }
  for (const st of unit.sf.statements) {
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier || st.isTypeOnly) continue;
    if (!st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    for (const el of st.exportClause.elements) {
      if (!el.propertyName || !HTTP_METHODS.has(el.name.text) || el.propertyName.text === el.name.text) continue;
      const sp = localSpec(unit, el.propertyName.text);
      if (sp) out.push([el.name.text, sp]);
    }
  }
  return out;
}

/**
 * Mark the functions a route file serves (`spec.routes`) and the Next server
 * actions (`spec.action`). A SvelteKit `+server` verb was already an endpoint by
 * name (`GET src/routes/x`); with routes on it becomes the route's contract
 * endpoint instead, so one route is one endpoint whichever framework serves it.
 */
function markRoutes(unit: FileUnit, next: boolean, roots: NextRoots): void {
  const rf = routeFileOf(unit.rel, next, roots);
  if (rf) {
    const add = (sp: FnSpec, method: string): void => {
      (sp.routes ??= []).push(routeDecl(rf, method));
      sp.endpoint = undefined;
    };
    if (rf.handlers === 'verbs') for (const [v, sp] of verbHandlers(unit)) add(sp, v);
    else {
      const sp = defaultExportSpec(unit, rf.arity);
      if (sp) add(sp, rf.method);
    }
  }
  if (!next) return;
  // `'use server'` at the top of the module: every exported function is an action
  if (hasDirective(unit.sf.statements, 'use server')) {
    for (const nm of exportedNames(unit.sf)) {
      const sp = localSpec(unit, nm);
      if (sp && sp.kind === 'fn') sp.action = true;
    }
    const def = defaultExportSpec(unit);
    if (def) def.action = true;
  }
  // …or at the top of one function's body
  for (const sp of unit.specs) {
    if (sp.kind === 'fn' && sp.body && ts.isBlock(sp.body) && hasDirective(sp.body.statements, 'use server')) {
      sp.action = true;
    }
  }
}

// ---------------------------------------------------------------------------
// pass B — flow
// ---------------------------------------------------------------------------

interface Resolved {
  kind: number;
  calleeIids: Uint8Array[];
  calleeFqn: string;
  opaque: boolean;
  arg0IsReceiver: boolean;
  /** extra arg values prepended (the receiver) */
  receiver?: ts.Expression;
  argNames?: string[];
  /** synthetic zero-arg source call site: ignore the real arguments */
  dropArgs?: boolean;
  /** resolution came from the type checker, not the import table */
  viaChecker?: boolean;
  /** adapter-declared: these expressions ARE the argument list */
  argsOverride?: ts.Expression[];
  /** adapter-declared: the variables are this property of argument 0 */
  varsProp?: string;
}

class Emitter {
  readonly units = new Map<string, FileUnit>();
  readonly stats: Stats = {
    files: 0,
    functions: 0,
    callsites: 0,
    invokesRemote: 0,
    ops: 0,
    opFieldsViaSdl: 0,
    opFieldsFallback: 0,
    handlers: 0,
    endpoints: 0,
    resolved: 0,
    resolvedByChecker: 0,
    resolver: 'checker',
    programMs: 0,
    typed: false,
    externalFiles: 0,
    anchors: 0,
    anchorsOnOpaque: 0,
    opaque: new Map(),
    warnings: [],
    adapters: [],
    jsxComponents: 0,
    jsxComponentsResolved: 0,
    jsxFacts: 0,
    reactMajor: null,
    nextjs: false,
    httpRoutes: 0,
    httpRoutesByFramework: {},
    serverActions: 0,
    httpCalls: 0,
    httpCallsResolvedPath: 0,
    httpCallsDynamicBase: 0,
    httpCallsUnknownMethod: 0,
  };
  /** "endpoints/<path>" -> rel of the file declaring its $op */
  readonly endpointDirs = new Map<string, string>();

  /** declaration node -> the function we emitted for it (checker resolution) */
  readonly declIndex = new Map<ts.Node, { unit: FileUnit; spec: FnSpec }>();
  /** program file name -> the unit, to read a DECLARING file's import table */
  readonly unitByFile = new Map<string, FileUnit>();
  /** GraphQL OPERATION name -> its `$op`, for codegen'd `<X>QueryVariables` */
  readonly opByName = new Map<string, { unit: FileUnit; spec: FnSpec }>();
  /** codegen'd variables/result TYPE -> the `$op` it belongs to (by identity:
   *  `GetSecurityQueryVariables = Exact<{…}>` loses its alias NAME once it is
   *  instantiated as a type argument, but stays the same `ts.Type` object) */
  readonly opByType = new Map<ts.Type, { unit: FileUnit; spec: FnSpec }>();
  anchorsOn = false;
  /** BuildOpts.libraryWriteback */
  libWriteback = true;
  /** BuildOpts.jsx / jsxComponents / jsxFacts (coverage wave 1 §3.1); the
   *  identity-wrapper additions component resolution needs (`export default
   *  memo(C)`, `lazy(() => import(…))`) are part of jsxComponents */
  jsx = true;
  jsxComponents = true;
  jsxFacts = true;
  /** the repo renders with react-dom >= 19, which neutralises `javascript:` URLs */
  reactSanitizesUrls = false;
  /** BuildOpts.httpCalls (coverage wave 1 §3.4) */
  httpCalls = true;
  /** BuildOpts.tryBlocks */
  tryBlocks = true;
  /** BuildOpts.instanceNames */
  instanceNames = true;
  /** HTTP client library -> the base every request gets from a repo-wide
   *  `axios.defaults.baseURL = …` (null: none), computed on first use */
  readonly defaultBases = new Map<string, string | null>();

  constructor(
    readonly repo: RepoInfo,
    readonly codec: CgfCodec,
    readonly checker: ts.TypeChecker | null,
    readonly ad: AdapterSet,
  ) {
    this.stats.adapters = [...ad.names];
  }

  indexDecls(): void {
    for (const unit of this.units.values()) {
      this.unitByFile.set(unit.sf.fileName, unit);
      for (const spec of unit.specs) {
        if (spec.decl && !this.declIndex.has(spec.decl)) {
          this.declIndex.set(spec.decl, { unit, spec });
        }
        const nm = spec.kind === 'op' ? spec.op?.doc.name : '';
        if (nm && !this.opByName.has(nm)) this.opByName.set(nm, { unit, spec });
      }
      this.indexOpTypes(unit);
    }
  }

  /** A GraphQL codegen names one `<Op>Query`/`<Op>MutationVariables` alias per
   *  document and passes it as a TYPE ARGUMENT at the operation's declaration
   *  site; register the declared types against that file's `$op`. */
  private indexOpTypes(unit: FileUnit): void {
    const ch = this.checker;
    if (!ch) return;
    const op = unit.specs.find((s) => s.kind === 'op');
    if (!op) return;
    const hit = { unit, spec: op };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.typeArguments) {
        for (const ta of n.typeArguments) {
          if (!ts.isTypeReferenceNode(ta) || !ts.isIdentifier(ta.typeName)) continue;
          if (!/(Query|Mutation|Subscription)(Variables)?$/.test(ta.typeName.text)) continue;
          try {
            const sym = ch.getSymbolAtLocation(ta.typeName);
            if (!sym) continue;
            const t = ch.getDeclaredTypeOfSymbol(sym);
            if (t && !this.opByType.has(t)) this.opByType.set(t, hit);
          } catch {
            /* unresolvable type reference */
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(unit.sf);
  }

  /**
   * Type anchors. The gateway codegen emits one
   * `<Operation>QueryVariables` / `<Operation>MutationVariables` alias per
   * document and the handler's `.call(v)` parameter is typed with it, so a value
   * whose (contextual) type carries that name IS the operation's variables
   * object — a link that holds even when the callee itself is unresolvable.
   */
  anchorOf(node: ts.Node, contextualFirst: boolean): { unit: FileUnit; spec: FnSpec } | null {
    const ch = this.checker;
    if (!ch || !this.anchorsOn || !this.opByName.size) return null;
    for (const t of typesOf(ch, node, contextualFirst)) {
      const byType = this.opByType.get(t);
      if (byType) return byType;
    }
    for (const nm of typeNames(ch, node, contextualFirst)) {
      const m = /^(.+?)(Query|Mutation|Subscription)(Variables)?$/.exec(nm);
      if (!m) continue;
      const hit = this.opByName.get(m[1]!);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * The checker-backed resolver (checker resolution). `getSymbolAtLocation` +
   * `getAliasedSymbol` follow barrel re-exports and renames for free; the extra
   * hops below walk the two value-level indirections the alias chain stops at:
   *   - a property of an object literal (`export const endpoints = { … }`,
   *     `registry.getX`) — shorthand or `k: v`;
   *   - a variable that is just another name (`export const client = endpoints`).
   */
  resolveNode(node: ts.Node, depth = 0): { unit: FileUnit; spec: FnSpec } | null {
    const ch = this.checker;
    if (!ch) return null;
    let sym: ts.Symbol | undefined;
    try {
      sym = ch.getSymbolAtLocation(node);
    } catch {
      return null;
    }
    return this.resolveSymbol(sym, depth) as { unit: FileUnit; spec: FnSpec } | null;
  }

  /**
   * The symbol walk shared by every resolution mode. `mode`:
   *   - `'fn'` — the emitted function behind the symbol (declIndex, a factory
   *     `$ret`, a destructured `<factory>.$ret.<prop>`);
   *   - `'ns'` — the NAMESPACE a member call can be looked up in
   *     (`const router = useRouter()` -> `useRouter.$ret`);
   *   - `'ext'` — the external factory an in-repo const was produced by, so the
   *     opaque name says `<pkg>.<factory>.$ret` instead of an in-repo-looking
   *     module path (call shape 6).
   */
  private resolveSymbol(
    sym0: ts.Symbol | undefined,
    depth: number,
    mode: 'fn' | 'ns' | 'ext' = 'fn',
  ): { unit: FileUnit; spec: FnSpec } | { unit: FileUnit; prefix: string } | string | null {
    const ch = this.checker;
    if (!ch || depth > 3) return null;
    let sym = sym0;
    const seen = new Set<ts.Symbol>();
    for (let hop = 0; sym && hop < 12; hop++) {
      if (seen.has(sym)) return null;
      seen.add(sym);
      if (sym.flags & ts.SymbolFlags.Alias) {
        let a: ts.Symbol | undefined;
        try {
          a = ch.getAliasedSymbol(sym);
        } catch {
          a = undefined;
        }
        if (a && a !== sym && !seen.has(a)) {
          sym = a;
          continue;
        }
      }
      const decls = sym.declarations ?? [];
      if (mode === 'fn') {
        for (const d of decls) {
          const hit = this.declIndex.get(d);
          if (hit) return hit;
        }
      }
      for (const d of decls) {
        if (mode === 'ext' && this.instanceNames && ts.isVariableDeclaration(d) && d.initializer) {
          // `const pool = new Pool(…)`: an instance of an imported class
          const nw = unwrap(d.initializer);
          const nm = ts.isNewExpression(nw) ? this.externalCtorName(nw) : null;
          if (nm) return nm;
        }
        const init = callInitializerOf(d);
        if (!init) continue;
        if (mode === 'ns') {
          const t = this.resolveNode(unwrap(init.expression), depth + 1);
          if (t) return t;
        } else if (mode === 'ext') {
          const nm = this.externalCalleeName(init);
          if (nm) return ts.isBindingElement(d) ? `${nm}.$ret.${bindingMember(d)}` : `${nm}.$ret`;
        } else if (ts.isBindingElement(d)) {
          // shape 1b: `const {initStore, useStore} = useCreateContext(fn)`
          const t = this.resolveNode(unwrap(init.expression), depth + 1);
          const m = t?.unit.byName.get(`${t.spec.sym}.$ret.${bindingMember(d)}`);
          if (t && m) return { unit: t.unit, spec: m };
        }
      }
      let next: ts.Symbol | undefined;
      for (const d of decls) {
        try {
          if (ts.isShorthandPropertyAssignment(d)) {
            next = ch.getShorthandAssignmentValueSymbol(d);
          } else if (ts.isPropertyAssignment(d)) {
            next = symbolOfRef(ch, d.initializer);
          } else if (ts.isVariableDeclaration(d) && d.initializer) {
            next = symbolOfRef(ch, d.initializer);
            if (!next) {
              const call = unwrap(d.initializer);
              if (ts.isCallExpression(call)) {
                // shape 5: an identity-preserving HOF is walked THROUGH
                const hof = lastName(call.expression);
                if ((IDENTITY_HOFS.has(hof) || this.ad.identityHofs.has(hof)) && call.arguments.length) {
                  next = symbolOfRef(ch, call.arguments[0]!);
                  if (!next && mode === 'fn' && this.jsxComponents) {
                    const lazy = this.importThunkTarget(call.arguments[0]!);
                    if (lazy) return lazy;
                  }
                }
                if (!next && mode === 'fn') {
                  const ret = this.factoryResult(call, depth);
                  if (ret) return ret;
                }
              }
            }
          } else if (ts.isPropertyDeclaration(d) && d.initializer) {
            next = symbolOfRef(ch, d.initializer);
          } else if (ts.isExportAssignment(d)) {
            next = symbolOfRef(ch, d.expression);
            // coverage wave 1 §3.1: `export default memo(Child)` is the other
            // half of the component idiom; walk the wrapper as for a const
            const call = unwrap(d.expression);
            if (!next && this.jsxComponents && ts.isCallExpression(call) && call.arguments.length) {
              const hof = lastName(call.expression);
              if (IDENTITY_HOFS.has(hof) || this.ad.identityHofs.has(hof)) {
                next = symbolOfRef(ch, call.arguments[0]!);
                if (!next && mode === 'fn') {
                  const lazy = this.importThunkTarget(call.arguments[0]!);
                  if (lazy) return lazy;
                }
              }
            }
          }
        } catch {
          next = undefined;
        }
        if (next) break;
      }
      sym = next;
    }
    return null;
  }

  /** The `$op` a document EXPRESSION names — an inline tagged template in
   *  `unit`, or an identifier the checker places on a `const X = gql\`…\``. */
  docSpecOf(unit: FileUnit, e: ts.Expression): { unit: FileUnit; spec: FnSpec } | null {
    const n = unwrap(e);
    if (ts.isTaggedTemplateExpression(n)) {
      const pos = n.getStart(unit.sf);
      const hit = unit.specs.find((sp) => sp.kind === 'op' && sp.pos === pos);
      return hit ? { unit, spec: hit } : null;
    }
    const t = this.resolveNode(n);
    return t && t.spec.kind === 'op' ? t : null;
  }

  /** adapter `[[handler]] kind = "sdk"` — the rule whose factory produced the
   *  value this identifier is bound to, walking imports through the checker. */
  sdkRuleOf(id: ts.Identifier): HandlerRule | null {
    const ch = this.checker;
    if (!ch || !this.ad.sdkFactories.size) return null;
    let sym: ts.Symbol | undefined;
    try {
      sym = ch.getSymbolAtLocation(id);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = ch.getAliasedSymbol(sym);
    } catch {
      return null;
    }
    for (const d of sym?.declarations ?? []) {
      const init = callInitializerOf(d);
      if (init) {
        const r = this.ad.sdkFactories.get(lastName(init.expression));
        if (r) return r;
      }
    }
    return null;
  }

  /** `const f = useFetch()` -> the `useFetch.$ret` closure, when there is one */
  private factoryResult(
    call: ts.CallExpression,
    depth: number,
  ): { unit: FileUnit; spec: FnSpec } | null {
    let t = this.resolveNode(unwrap(call.expression), depth + 1);
    for (let hop = 0; t && hop < 3; hop++) {
      const ret = t.unit.byName.get(`${t.spec.sym}.$ret`);
      if (ret) return { unit: t.unit, spec: ret };
      if (!t.spec.retCall) return null;
      t = this.resolveNode(unwrap(t.spec.retCall.expression), depth + 1);
    }
    return null;
  }

  /**
   * call shape 1 — `recv.<m>()` where `recv`'s initialiser is an in-repo
   * factory CALL: look `<factory>.$ret.<m>` up in the factory's own unit.
   */
  resolveMember(base: ts.Expression, name: string): { unit: FileUnit; spec: FnSpec } | null {
    const ch = this.checker;
    if (!ch) return null;
    let sym: ts.Symbol | undefined;
    try {
      sym = ch.getSymbolAtLocation(unwrap(base));
    } catch {
      return null;
    }
    let t = this.resolveSymbol(sym, 0, 'ns') as { unit: FileUnit; spec: FnSpec } | null;
    for (let hop = 0; t && hop < 3; hop++) {
      const spec = t.unit.byName.get(`${t.spec.sym}.$ret.${name}`);
      if (spec) return { unit: t.unit, spec };
      if (!t.spec.retCall) return null;
      t = this.resolveNode(unwrap(t.spec.retCall.expression), 1);
    }
    return null;
  }

  /** `<pkg>.<factory>` for a call whose callee is an EXTERNAL import, else null */
  private externalCalleeName(call: ts.CallExpression): string | null {
    const c = unwrap(call.expression);
    const id = ts.isIdentifier(c) ? c : ts.isPropertyAccessExpression(c) ? c.name : null;
    if (!id) return null;
    const sf = c.getSourceFile();
    const u = this.unitByFile.get(sf.fileName);
    if (!u) return null;
    const root = ts.isIdentifier(c) ? c.text : pathText(c).split('.')[0]!;
    const b = u.imports.get(root);
    if (!b) return null;
    // an IN-REPO factory we simply failed to model must keep its own name
    if (resolveImport(this.repo, u.rel, b.spec, (r) => this.hasFile(r))) return null;
    const head = b.imported === '*' || b.imported === 'default' ? root : b.imported;
    return ts.isIdentifier(c) ? `${b.spec}.${head}` : `${b.spec}.${head}.${id.text}`;
  }

  /** `<module>.<Class>` for `new X(…)` / `new ns.X(…)` whose X is an EXTERNAL
   *  import — the receiver name a method call on the instance gets */
  private externalCtorName(nw: ts.NewExpression): string | null {
    const c = unwrap(nw.expression);
    const u = this.unitByFile.get(c.getSourceFile().fileName);
    const p = pathText(c);
    if (!u || !p) return null;
    const root = p.split('.')[0]!;
    const b = u.imports.get(root);
    if (!b) return null;
    // an in-repo class keeps the naming it has always had
    if (resolveImport(this.repo, u.rel, b.spec, (r) => this.hasFile(r))) return null;
    const rest = p.slice(root.length); // `.Pool` in `new pg.Pool()`
    if (b.imported !== '*' && b.imported !== 'default') return `${b.spec}.${b.imported}${rest}`;
    return rest ? `${b.spec}${rest}` : `${b.spec}.${root}`;
  }

  /** call shape 6: the external factory an in-repo export came from */
  externalFactoryFqn(node: ts.Node): string | null {
    const ch = this.checker;
    if (!ch) return null;
    let sym: ts.Symbol | undefined;
    try {
      sym = ch.getSymbolAtLocation(node);
    } catch {
      return null;
    }
    const r = this.resolveSymbol(sym, 0, 'ext');
    return typeof r === 'string' ? r : null;
  }

  /** coverage wave 1 §3.1: `lazy(() => import('./X'))` — an identity wrapper
   *  handed an import THUNK stands for the module's entry function, so
   *  `<X a={v}/>` binds to X's default export instead of to the thunk. */
  importThunkTarget(arg: ts.Expression): { unit: FileUnit; spec: FnSpec } | null {
    const t = importThunkSpec(arg);
    const unit = this.unitByFile.get(arg.getSourceFile().fileName);
    if (!t || !unit) return null;
    if (t.member === 'default') return this.resolveModuleCall(unit, t.spec);
    // `.then((m) => ({ default: m.Named }))`: that export of the module
    const ch = this.checker;
    if (ch) {
      try {
        const msym = ch.getSymbolAtLocation(t.spec);
        const ex = msym ? ch.tryGetMemberInModuleExports(t.member, msym) : undefined;
        const hit = ex ? (this.resolveSymbol(ex, 0) as { unit: FileUnit; spec: FnSpec } | null) : null;
        if (hit) return hit;
      } catch {
        /* not a module literal */
      }
    }
    const rel = resolveImport(this.repo, unit.rel, t.spec.text, (r) => this.hasFile(r));
    const u2 = rel ? this.units.get(rel) : undefined;
    const sp = u2?.byName.get(t.member);
    return u2 && sp ? { unit: u2, spec: sp } : null;
  }

  /** call shape 4: `import('$apps/X')` -> that module's entry function */
  resolveModuleCall(
    unit: FileUnit,
    arg: ts.StringLiteral,
  ): { unit: FileUnit; spec: FnSpec } | null {
    const ch = this.checker;
    if (ch) {
      try {
        const msym = ch.getSymbolAtLocation(arg);
        if (msym) {
          const def = ch.tryGetMemberInModuleExports('default', msym);
          const hit = def
            ? (this.resolveSymbol(def, 0) as { unit: FileUnit; spec: FnSpec } | null)
            : null;
          if (hit) return hit;
        }
      } catch {
        /* not a module literal */
      }
    }
    const rel = resolveImport(this.repo, unit.rel, arg.text, (r) => this.hasFile(r));
    const u2 = rel ? this.units.get(rel) : undefined;
    if (!u2) return null;
    const spec = u2.byName.get('default') ?? u2.byName.get('$module');
    return spec ? { unit: u2, spec } : null;
  }

  iidOf(rel: string, sym: string): Uint8Array {
    const pkg = path.posix.dirname(rel) === '.' ? 'root' : path.posix.dirname(rel);
    return fnIID(this.repo.repoId, pkg, `${rel}:${sym}`);
  }

  hasFile(rel: string): boolean {
    return this.units.has(rel);
  }

  /** module specifier + name -> in-repo spec, or null */
  lookupImport(unit: FileUnit, name: string): { unit: FileUnit; spec: FnSpec } | null {
    const b = unit.imports.get(name);
    if (b) {
      const rel = resolveImport(this.repo, unit.rel, b.spec, (r) => this.hasFile(r));
      if (!rel) return null;
      const u2 = this.units.get(rel);
      if (!u2) return null;
      const s = u2.byName.get(b.imported === 'default' ? 'default' : b.imported);
      return s ? { unit: u2, spec: s } : null;
    }
    const own = unit.byName.get(name);
    return own ? { unit, spec: own } : null;
  }

  opaqueName(unit: FileUnit, name: string): string | null {
    const b = unit.imports.get(name);
    if (!b) return null;
    return b.imported === '*' || b.imported === 'default'
      ? `${b.spec}.${name}`
      : `${b.spec}.${b.imported}`;
  }
}

/** the contextual and/or declared type of a node, plus its awaited form. */
function typesOf(ch: ts.TypeChecker, node: ts.Node, contextualFirst: boolean): ts.Type[] {
  const out: ts.Type[] = [];
  const awaited = (ch as unknown as { getAwaitedType?: (x: ts.Type) => ts.Type | undefined })
    .getAwaitedType;
  const push = (t: ts.Type | undefined): void => {
    if (!t) return;
    out.push(t);
    let a: ts.Type | undefined;
    try {
      a = awaited ? awaited.call(ch, t) : undefined;
    } catch {
      a = undefined;
    }
    if (a && a !== t) out.push(a);
  };
  const ctx = (): ts.Type | undefined => {
    try {
      return ts.isExpression(node as ts.Expression)
        ? ch.getContextualType(node as ts.Expression)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const own = (): ts.Type | undefined => {
    try {
      return ch.getTypeAtLocation(node);
    } catch {
      return undefined;
    }
  };
  if (contextualFirst) push(ctx());
  push(own());
  return out;
}

/** candidate type NAMES of a node: alias, symbol, printed form. */
function typeNames(ch: ts.TypeChecker, node: ts.Node, contextualFirst: boolean): string[] {
  const out: string[] = [];
  const push = (t: ts.Type | undefined): void => {
    if (!t) return;
    const awaited = (ch as unknown as { getAwaitedType?: (x: ts.Type) => ts.Type | undefined })
      .getAwaitedType;
    for (const u of [t, awaited ? awaited.call(ch, t) : undefined]) {
      if (!u) continue;
      const a = u.aliasSymbol?.name;
      if (a) out.push(a);
      const sy = u.getSymbol()?.name;
      if (sy && sy !== '__type' && sy !== '__object') out.push(sy);
    }
  };
  const ctx = (): ts.Type | undefined => {
    try {
      return ts.isExpression(node as ts.Expression)
        ? ch.getContextualType(node as ts.Expression)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const own = (): ts.Type | undefined => {
    try {
      return ch.getTypeAtLocation(node);
    } catch {
      return undefined;
    }
  };
  if (contextualFirst) {
    push(ctx());
    push(own());
  } else {
    push(own());
  }
  return out;
}

/** the CALL an initialiser is, for a variable or a destructured binding */
function callInitializerOf(d: ts.Declaration): ts.CallExpression | null {
  if (ts.isVariableDeclaration(d) && d.initializer) {
    const c = unwrap(d.initializer);
    return ts.isCallExpression(c) ? c : null;
  }
  if (ts.isBindingElement(d)) {
    let p: ts.Node = d.parent;
    for (let i = 0; i < 4 && p && !ts.isVariableDeclaration(p); i++) p = p.parent;
    if (p && ts.isVariableDeclaration(p) && p.initializer) {
      const c = unwrap(p.initializer);
      return ts.isCallExpression(c) ? c : null;
    }
  }
  return null;
}

/** the SOURCE property name of a destructured binding (`{a: b}` -> `a`) */
function bindingMember(d: ts.BindingElement): string {
  const n = d.propertyName ?? d.name;
  return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : '';
}

/** symbol of an expression that is just a reference (`x`, `a.b`, `x!`) */
function symbolOfRef(ch: ts.TypeChecker, e: ts.Expression): ts.Symbol | undefined {
  const n = unwrap(e);
  if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) return ch.getSymbolAtLocation(n);
  return undefined;
}

interface FnCtx {
  em: Emitter;
  unit: FileUnit;
  fb: FlowBuilder;
  /** local variable -> a "type" name, for receiver naming */
  varType: Map<string, string>;
  calleeIids: Uint8Array[];
  depth: number;
  /** function expressions the framework table says are invoked with form /
   *  mutation values — their params alias the enclosing function's bound set */
  cbFns: Set<ts.Node>;
  /** lazily created aggregate of everything this function binds (`bind:` results,
   *  non-callback arguments of a framework factory) */
  boundAgg: number;
  /** return targets of closures being inlined with their returns CAPTURED
   *  (innermost last); empty == returns reach the function's own OUT_RETURN,
   *  the inlining rule every closure followed before coverage wave 1 */
  retTo: number[];
  /** adapter `[[state_hook]]` setter BINDING -> its state variable, for this
   *  function and every closure inlined into it (coverage wave 1 §3.2). Keyed
   *  by declaration so a shadowing `const setV = …` or a nested component's own
   *  `setX` never writes into the wrong state; by name only without a checker. */
  setters: Map<ts.Node | string, string>;
}

function spanOf(unit: FileUnit, pos: number): Span {
  const p = Math.max(0, Math.min(pos, unit.sf.end));
  // call shape 7 — a .svelte callsite's position is in the LOWERED
  // script; map it back so a chain reports the line the reader can open.
  const sm = unit.smap;
  if (sm && sm.segs.length) {
    const o = mapSveltePos(sm, p);
    const ls = sm.lineStarts;
    let lo = 0;
    let hi = ls.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ls[mid]! <= o) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return { file: unit.rel, line: best + 1, col: o - ls[best]! + 1 };
  }
  const lc = unit.sf.getLineAndCharacterOfPosition(p);
  return { file: unit.rel, line: lc.line + 1, col: lc.character + 1 };
}

function bindNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) bindNames(el.name, out);
  }
}

/** `window.fetch`, `globalThis.fetch`, `self.fetch` */
const GLOBAL_SCOPES = new Set(['window', 'globalThis', 'self']);

function isImportBinding(d: ts.Declaration): boolean {
  return ts.isImportClause(d) || ts.isImportSpecifier(d) || ts.isNamespaceImport(d) || ts.isImportEqualsDeclaration(d);
}

/** the value of property `k` of an object literal (`{k: v}` / `{k}`) */
function propValue(o: ts.ObjectLiteralExpression, k: string): ts.Expression | undefined {
  for (const p of o.properties) {
    if (propName(p) !== k) continue;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
  }
  return undefined;
}

/** a constant: carries no attacker data whatever sink it reaches */
function isLiteralExpr(e: ts.Expression): boolean {
  const n = unwrap(e);
  return (
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isNumericLiteral(n) ||
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword ||
    n.kind === ts.SyntaxKind.NullKeyword
  );
}

function noteOpaque(stats: Stats, fqn: string): void {
  stats.opaque.set(fqn, (stats.opaque.get(fqn) ?? 0) + 1);
}

class FnFlow {
  constructor(private readonly c: FnCtx) {}

  private get fb(): FlowBuilder {
    return this.c.fb;
  }

  // ---- expressions -----------------------------------------------------

  expr(e: ts.Expression | undefined): number {
    if (!e) return this.fb.val();
    if (this.c.depth > 400) return this.fb.val();
    const n = unwrap(e);

    if (ts.isIdentifier(n)) return this.fb.varVal(n.text);
    if (n.kind === ts.SyntaxKind.ThisKeyword) return this.fb.varVal('this');
    if (
      ts.isStringLiteral(n) ||
      ts.isNumericLiteral(n) ||
      n.kind === ts.SyntaxKind.TrueKeyword ||
      n.kind === ts.SyntaxKind.FalseKeyword ||
      n.kind === ts.SyntaxKind.NullKeyword
    ) {
      return this.fb.val();
    }
    if (ts.isPropertyAccessExpression(n)) {
      const src = sourceReadName(n);
      if (src) return this.readCallsite(n, src);
      const v = this.fb.val();
      this.fb.flow(this.expr(n.expression), v);
      return v;
    }
    if (ts.isElementAccessExpression(n)) {
      const v = this.fb.val();
      this.fb.flow(this.expr(n.expression), v);
      this.expr(n.argumentExpression);
      return v;
    }
    if (ts.isCallExpression(n)) return this.call(n);
    if (ts.isNewExpression(n)) {
      // constructors are transparent: `new URL(location.href)` must carry taint
      const v = this.fb.val();
      for (const a of n.arguments ?? []) this.fb.flow(this.expr(a), v);
      return v;
    }
    if (ts.isTaggedTemplateExpression(n)) return this.expr(n.template as ts.Expression);
    if (ts.isTemplateExpression(n)) {
      const v = this.fb.val();
      for (const s of n.templateSpans) this.fb.flow(this.expr(s.expression), v);
      return v;
    }
    if (ts.isObjectLiteralExpression(n)) {
      const v = this.fb.val();
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) this.fb.flow(this.expr(p.initializer), v);
        else if (ts.isShorthandPropertyAssignment(p)) this.fb.flow(this.fb.varVal(p.name.text), v);
        else if (ts.isSpreadAssignment(p)) this.fb.flow(this.expr(p.expression), v);
        else if (ts.isMethodDeclaration(p) && p.body)
          this.inlineFn(p.parameters, p.body, this.c.cbFns.has(p));
      }
      return v;
    }
    if (ts.isArrayLiteralExpression(n)) {
      const v = this.fb.val();
      for (const el of n.elements) this.fb.flow(this.expr(el), v);
      return v;
    }
    if (ts.isSpreadElement(n)) return this.expr(n.expression);
    if (ts.isAwaitExpression(n) || ts.isYieldExpression(n)) return this.expr(n.expression);
    if (ts.isBinaryExpression(n)) return this.binary(n);
    if (ts.isConditionalExpression(n)) {
      const v = this.fb.val();
      this.expr(n.condition);
      this.fb.flow(this.expr(n.whenTrue), v);
      this.fb.flow(this.expr(n.whenFalse), v);
      return v;
    }
    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
      return this.expr(n.operand as ts.Expression);
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      // Closures are INLINED into the enclosing function: the value graph is
      // name-based, so a capture of an outer variable resolves for free.
      this.inlineFn(n.parameters, n.body, this.c.cbFns.has(n));
      return this.fb.val();
    }
    if (ts.isTypeOfExpression(n) || ts.isVoidExpression(n) || ts.isDeleteExpression(n)) {
      this.expr(n.expression);
      return this.fb.val();
    }
    if (
      this.c.em.jsx &&
      (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n))
    ) {
      return this.jsx(n);
    }
    // anything else: union of child expressions
    const v = this.fb.val();
    ts.forEachChild(n, (ch) => {
      if (ts.isExpression(ch)) this.fb.flow(this.expr(ch), v);
    });
    return v;
  }

  private binary(n: ts.BinaryExpression): number {
    const op = n.operatorToken.kind;
    const isAssign =
      op === ts.SyntaxKind.EqualsToken ||
      (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment);
    if (isAssign) {
      const rhs = this.expr(n.right);
      this.assignTo(n.left, rhs);
      return rhs;
    }
    const v = this.fb.val();
    this.fb.flow(this.expr(n.left), v);
    this.fb.flow(this.expr(n.right), v);
    return v;
  }

  private assignTo(lhs: ts.Expression, rhs: number): void {
    const l = unwrap(lhs);
    if (ts.isIdentifier(l)) {
      this.fb.flow(rhs, this.fb.varVal(l.text));
      return;
    }
    const sink = assignSinkName(l);
    if (sink) {
      const cs = this.fb.addCallsite({
        kind: CallKind.STATIC,
        opaque: true,
        calleeFqn: sink,
        argc: 1,
        resultc: 0,
        span: spanOf(this.c.unit, l.getStart(this.c.unit.sf)),
        dispatchConfidence: 1.0,
      });
      noteOpaque(this.c.em.stats, sink);
      this.c.em.stats.callsites++;
      const port = this.fb.addVertex(VertexKind.CALL_ARG_PORT, 0, cs);
      this.fb.sink(rhs, port);
      if (ts.isPropertyAccessExpression(l)) this.expr(l.expression);
      return;
    }
    if (ts.isPropertyAccessExpression(l) || ts.isElementAccessExpression(l)) {
      // aggregate: writing a member taints the whole object
      this.fb.flow(rhs, this.expr(l.expression));
      return;
    }
  }

  /** synthetic zero-arg call site for a source-bearing property READ */
  private readCallsite(n: ts.PropertyAccessExpression, fqn: string): number {
    const cs = this.fb.addCallsite({
      kind: CallKind.STATIC,
      opaque: true,
      calleeFqn: fqn,
      argc: 0,
      resultc: 1,
      span: spanOf(this.c.unit, n.getStart(this.c.unit.sf)),
      dispatchConfidence: 1.0,
    });
    noteOpaque(this.c.em.stats, fqn);
    this.c.em.stats.callsites++;
    const port = this.fb.addVertex(VertexKind.CALL_RESULT_PORT, 0, cs);
    const v = this.fb.val();
    this.fb.source(v, port);
    // the base object still flows in (`get(store)?.searchParams`)
    this.fb.flow(this.expr(n.expression), v);
    return v;
  }

  // ---- JSX (coverage wave 1 §3.1) ---------------------------------------

  /**
   * A JSX element. Attribute initializers and `{…}` children are not
   * `Expression` children of an element, so the generic fallback never reached
   * them. Each attribute value and child is walked like any expression (closures
   * inlined); for a COMPONENT the values also flow into one props object — k=0,
   * so attributes, spreads and `children` are all just members — which is arg 0
   * of a STATIC call of the component. An element's value is fresh, a
   * component's included: markup carries nothing back out, and letting it flow
   * would smear one child's taint over every ancestor's props.
   */
  private jsx(n: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment): number {
    const em = this.c.em;
    const unit = this.c.unit;
    const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxFragment(n) ? null : n;
    const tag = open?.tagName;
    const host = tag && isIntrinsicTag(tag) ? tag.getText(unit.sf) : '';
    let cs = -1;
    let port = -1;
    if (tag && !host && em.jsxComponents) {
      const r = this.jsxCallee(tag);
      cs = this.fb.addCallsite({
        kind: r.kind,
        calleeIids: r.calleeIids.length ? r.calleeIids : undefined,
        opaque: r.opaque || undefined,
        calleeFqn: r.calleeFqn,
        argc: 1,
        resultc: 1,
        span: spanOf(unit, n.getStart(unit.sf)),
        dispatchConfidence: 1.0,
      });
      em.stats.callsites++;
      em.stats.jsxComponents++;
      if (r.opaque) noteOpaque(em.stats, r.calleeFqn);
      else {
        em.stats.resolved++;
        em.stats.jsxComponentsResolved++;
        if (r.viaChecker) em.stats.resolvedByChecker++;
      }
      for (const iid of r.calleeIids) this.c.calleeIids.push(iid);
      port = this.fb.addVertex(VertexKind.CALL_ARG_PORT, 0, cs);
    }
    const props = this.fb.val();
    for (const a of open?.attributes.properties ?? []) {
      if (ts.isJsxSpreadAttribute(a)) {
        this.fb.flow(this.expr(a.expression), props);
        continue;
      }
      const init = a.initializer;
      // `disabled` and `href="/x"` carry nothing; `attr=<El/>` is a value too
      const e = !init || ts.isStringLiteral(init) ? undefined : ts.isJsxExpression(init) ? init.expression : init;
      if (!e) continue;
      const attr = ts.isIdentifier(a.name) ? a.name.text : a.name.getText(unit.sf);
      const fact = host && em.jsxFacts ? jsxFactName(host, attr, em.reactSanitizesUrls) : null;
      // a literal is not attacker data; `action={fn}` is a React 19 form action, not a URL
      if (!fact || isLiteralExpr(e) || this.isFunctionValue(e)) {
        this.fb.flow(this.jsxValue(e), props);
        continue;
      }
      const { value, arg } = fact === 'jsx:html' ? this.htmlValue(e) : { value: this.expr(e), arg: -1 };
      this.fb.flow(value, props);
      this.jsxFact(fact, a, arg >= 0 ? arg : value);
    }
    for (const ch of ts.isJsxSelfClosingElement(n) ? [] : n.children) {
      if (ts.isJsxText(ch)) continue;
      const e = ts.isJsxExpression(ch) ? ch.expression : ch;
      if (e) this.fb.flow(this.jsxValue(e), props);
    }
    if (cs < 0) return this.fb.val();
    this.fb.sink(props, port);
    // the component's result is markup like a host element's: the call is made,
    // but what it returns must not flow on — as a child it would land in the
    // parent's props and taint every prop the parent reads (k=0)
    const rport = this.fb.addVertex(VertexKind.CALL_RESULT_PORT, 0, cs);
    this.fb.source(this.fb.val(), rport);
    return this.fb.val();
  }

  /** an inline function, or a value the checker types as callable */
  private isFunctionValue(e: ts.Expression): boolean {
    if (fnLike(e)) return true;
    const ch = this.c.em.checker;
    if (!ch) return false;
    try {
      return ch.getTypeAtLocation(e).getCallSignatures().length > 0;
    } catch {
      return false;
    }
  }

  /** an attribute value or child. An inline handler / render prop is walked with
   *  its returns captured — React never hands an event handler's return back,
   *  and letting it reach the component's OUT_RETURN would taint every element
   *  the component renders. The function value itself carries nothing. */
  private jsxValue(e: ts.Expression): number {
    const f = fnLike(e);
    if (!f) return this.expr(e);
    this.inlineCaptured(f);
    return this.fb.val();
  }

  /** `dangerouslySetInnerHTML={{__html: e}}`: the sink argument is `e`, not the
   *  wrapper; any other spelling (`={html}`) hands over the whole value */
  private htmlValue(e: ts.Expression): { value: number; arg: number } {
    const o = unwrap(e);
    if (!ts.isObjectLiteralExpression(o)) return { value: this.expr(e), arg: -1 };
    const value = this.fb.val();
    let arg = -1;
    for (const p of o.properties) {
      let pv = -1;
      if (ts.isPropertyAssignment(p)) pv = this.expr(p.initializer);
      else if (ts.isShorthandPropertyAssignment(p)) pv = this.fb.varVal(p.name.text);
      else if (ts.isSpreadAssignment(p)) pv = this.expr(p.expression);
      if (pv < 0) continue;
      this.fb.flow(pv, value);
      if (!ts.isSpreadAssignment(p) && propName(p) === '__html') arg = pv;
    }
    return { value, arg };
  }

  /** a synthetic intrinsic-element sink: one arg, nothing comes back (`assign:` shape) */
  private jsxFact(fqn: string, at: ts.Node, v: number): void {
    const em = this.c.em;
    const cs = this.fb.addCallsite({
      kind: CallKind.STATIC,
      opaque: true,
      calleeFqn: fqn,
      argc: 1,
      resultc: 0,
      span: spanOf(this.c.unit, at.getStart(this.c.unit.sf)),
      dispatchConfidence: 1.0,
    });
    noteOpaque(em.stats, fqn);
    em.stats.callsites++;
    em.stats.jsxFacts++;
    const port = this.fb.addVertex(VertexKind.CALL_ARG_PORT, 0, cs);
    this.fb.sink(v, port);
  }

  /** The component a tag names — resolved exactly like a call of that name
   *  (checker, identity wrappers, factory results). Unresolved, an imported tag
   *  keeps the module-qualified name a call would get (`@ui/kit.Button`); any
   *  other is `jsx:<Name>`. */
  private jsxCallee(tag: ts.JsxTagNameExpression): Resolved {
    const em = this.c.em;
    const unit = this.c.unit;
    const mk = (fqn: string): Resolved => ({
      kind: CallKind.STATIC,
      calleeIids: [],
      calleeFqn: fqn,
      opaque: true,
      arg0IsReceiver: false,
    });
    const e = tag as ts.Expression;
    const direct = this.target(e);
    if (direct) return this.staticTo(direct);
    if (ts.isPropertyAccessExpression(e)) {
      const mem = em.resolveMember(e.expression, e.name.text);
      if (mem) return this.staticTo({ ...mem, viaChecker: true });
    }
    const p = pathText(e) || tag.getText(unit.sf);
    if (ts.isIdentifier(e)) {
      const ext = em.externalFactoryFqn(e) ?? em.opaqueName(unit, e.text);
      if (ext) return mk(ext);
    } else {
      const root = p.split('.')[0]!;
      const b = unit.imports.get(root);
      if (b) return mk(`${b.imported === '*' ? b.spec : em.opaqueName(unit, root)}${p.slice(root.length)}`);
    }
    return mk(`jsx:${p}`);
  }

  // ---- calls -----------------------------------------------------------

  /** in-repo target of an expression, checker first then the import table */
  target(e: ts.Expression): { unit: FileUnit; spec: FnSpec; viaChecker: boolean } | null {
    const em = this.c.em;
    const byChecker = em.resolveNode(e);
    if (byChecker) return { ...byChecker, viaChecker: true };
    const n = unwrap(e);
    if (ts.isIdentifier(n)) {
      const r = em.lookupImport(this.c.unit, n.text);
      if (r) return { ...r, viaChecker: false };
    }
    return null;
  }

  private staticTo(t: { unit: FileUnit; spec: FnSpec; viaChecker: boolean }): Resolved {
    return {
      kind: CallKind.STATIC,
      calleeIids: [this.c.em.iidOf(t.unit.rel, t.spec.sym)],
      calleeFqn: `${t.unit.rel}:${t.spec.sym}`,
      opaque: false,
      arg0IsReceiver: false,
      viaChecker: t.viaChecker,
      varsProp: t.spec.varsProp,
    };
  }

  /** The `$op` a document EXPRESSION stands for: an inline tagged template, or
   *  an identifier the checker can place on a `const X = gql\`…\`` anywhere in
   *  the repo. Returns null when the expression is not a document, which is how
   *  overlapping `[[invoke]]` rules discriminate themselves. */
  private docSpec(e: ts.Expression | undefined): { unit: FileUnit; spec: FnSpec } | null {
    return e ? this.c.em.docSpecOf(this.c.unit, e) : null;
  }

  /** the variables expression an adapter rule points at */
  private varsOf(
    args: readonly ts.Expression[],
    idx: number | undefined,
    prop: string | undefined,
  ): ts.Expression | null {
    const a = idx === undefined ? undefined : args[idx];
    if (!a) return null;
    if (!prop) return a;
    const o = unwrap(a);
    if (!ts.isObjectLiteralExpression(o)) return a;
    for (const pr of o.properties) {
      if (propName(pr) !== prop) continue;
      if (ts.isPropertyAssignment(pr)) return pr.initializer;
      if (ts.isShorthandPropertyAssignment(pr)) return pr.name;
    }
    return null;
  }

  /** adapter `[[invoke]]`: a call that carries the document AND the variables. */
  private invokeOp(n: ts.CallExpression, callee: ts.Expression): Resolved | null {
    const rules = this.c.em.ad.invokes.get(lastName(callee));
    if (!rules) return null;
    for (const r of rules) {
      const holder = r.docArg === undefined ? undefined : n.arguments[r.docArg];
      const doc = this.docSpec(r.docProp ? this.varsOf(n.arguments, r.docArg, r.docProp) ?? undefined : holder);
      if (!doc) continue;
      const vars = this.varsOf(n.arguments, r.varsArg, r.varsProp);
      return {
        ...this.staticTo({ ...doc, viaChecker: true }),
        argsOverride: vars ? [vars] : [],
      };
    }
    return null;
  }

  /** adapter `[[handler]] kind = "sdk"`: `getSdk(client).OpName(variables)` —
   *  the MEMBER NAME is the operation name in the document. */
  private sdkOp(n: ts.CallExpression, callee: ts.Expression): Resolved | null {
    const em = this.c.em;
    if (!em.ad.sdkFactories.size || !ts.isPropertyAccessExpression(callee)) return null;
    const base = unwrap(callee.expression);
    if (!ts.isIdentifier(base)) return null;
    const rule = this.c.unit.sdkVars.has(base.text)
      ? [...em.ad.sdkFactories.values()][0]!
      : em.sdkRuleOf(base);
    if (!rule) return null;
    const hit = em.opByName.get(callee.name.text);
    if (!hit) return null;
    const vars = n.arguments[rule.varsArg];
    return { ...this.staticTo({ ...hit, viaChecker: true }), argsOverride: vars ? [vars] : [] };
  }

  private resolveCallee(n: ts.CallExpression): Resolved {
    const em = this.c.em;
    const unit = this.c.unit;
    const callee = unwrap(n.expression);
    const mk = (fqn: string): Resolved => ({
      kind: CallKind.STATIC,
      calleeIids: [],
      calleeFqn: fqn,
      opaque: true,
      arg0IsReceiver: false,
    });

    // call shape 4 — `import('$apps/X')`: a dynamic import is a real,
    // statically known edge into the module's entry point, not `<dynamic>`.
    if (n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a0 = n.arguments[0] ? unwrap(n.arguments[0]!) : undefined;
      if (a0 && ts.isStringLiteral(a0)) {
        const t = em.resolveModuleCall(unit, a0);
        if (t) return this.staticTo({ ...t, viaChecker: true });
        return mk(`import(${a0.text})`);
      }
      return mk('<dynamic>');
    }

    // svelte template lowering + the unmodelled route surfaces (route sources)
    if (ts.isIdentifier(callee)) {
      if (callee.text === '__pc_html') return mk('svelte:html');
      if (callee.text === '__pc_bind') return mk('svelte:bind');
      if (callee.text === '__pc_tpl') return mk('svelte:tpl');
      const route = ROUTE_SOURCE_CALLS[callee.text] ?? em.ad.routeSourceCalls.get(callee.text);
      if (route) return { ...mk(route), dropArgs: true };
    }

    // adapter `[[invoke]]` — the document and the variables are both at this
    // call (`client.request(DOC, vars)`, `useQuery(DOC, {variables})`).
    const iv = this.invokeOp(n, callee);
    if (iv) return iv;

    // adapter `[[handler]] kind = "sdk"` — `getSdk(c).OpName(vars)`
    const sdk = this.sdkOp(n, callee);
    if (sdk) return sdk;

    // handler: `xClient(v)` / `xClient.call(v)` / `registry.getX.call(v)`
    if (ts.isPropertyAccessExpression(callee) && em.ad.handlerMethods.has(callee.name.text)) {
      const t = this.target(callee.expression);
      if (t && t.spec.kind === 'handler') return this.staticTo(t);
    }

    const direct = this.target(callee);
    if (direct) return this.staticTo(direct);

    if (ts.isIdentifier(callee)) {
      // call shape 6 — `export const send = makeSendTrackingEvent(fn)`
      // is NOT the in-repo `$lib/tracker.trackerSend` a catalog regex would see.
      const ext = em.externalFactoryFqn(callee) ?? em.opaqueName(unit, callee.text);
      return mk(ext ?? callee.text);
    }

    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      const base = unwrap(callee.expression);
      // call shape 1 — `const router = useRouter(); router.push(url)`
      const mem = em.resolveMember(callee.expression, m);
      if (mem) return this.staticTo({ ...mem, viaChecker: true });
      // `$derived.by(fn)` / `$effect.pre(fn)` are the rune, not a `.by` method
      if (ts.isIdentifier(base) && RUNE_ROOTS.has(base.text) && !unit.imports.has(base.text)) {
        return mk(`${base.text}.${m}`);
      }
      if (ts.isIdentifier(base)) {
        const b = unit.imports.get(base.text);
        if (b && b.imported === '*') return { ...mk(`${b.spec}.${m}`), arg0IsReceiver: false };
        const ext = em.externalFactoryFqn(base);
        if (ext) {
          const res = mk(`${ext}.${m}`);
          res.arg0IsReceiver = true;
          res.receiver = callee.expression;
          return res;
        }
      }
      const rn = receiverName(callee.expression, (x) => this.c.varType.get(x));
      const res = mk(rn ? `${rn}.${m}` : `.${m}`);
      res.arg0IsReceiver = true;
      res.receiver = callee.expression;
      return res;
    }

    return mk(pathText(n.expression) || '<dynamic>');
  }

  /** the aggregate value every framework callback parameter is aliased to */
  private bound(): number {
    if (this.c.boundAgg < 0) this.c.boundAgg = this.fb.val();
    return this.c.boundAgg;
  }

  /**
   * Callback factories — a callback registered as an object-literal property of a
   * framework factory (`createForm({onSubmit})`, `createMutation(() =>
   * ({mutationFn}))`, `fetchQuery({queryFn})`). The wiring that actually invokes
   * it lives in node_modules, so we approximate it here:
   *   - a function EXPRESSION is inlined as today, but its parameters alias the
   *     enclosing function's bound set (`bind:` results + the factory's own
   *     non-callback arguments);
   *   - a REFERENCE that resolves in-repo becomes a real STATIC call site with
   *     the bound set on arg 0 — that is the `onSubmit: submit.onSubmit` shape.
   * Everything else about the call is emitted normally.
   */
  private frameworkCallbacks(n: ts.CallExpression): void {
    for (const a of n.arguments) {
      const obj = objectArg(a);
      if (!obj) {
        const f = fnLike(a);
        if (f) this.c.cbFns.add(f);
        continue;
      }
      for (const pr of obj.properties) {
        if (ts.isPropertyAssignment(pr)) {
          const f = fnLike(pr.initializer);
          if (f) {
            this.c.cbFns.add(f);
            continue;
          }
          this.callbackRef(pr.initializer, pr);
        } else if (ts.isShorthandPropertyAssignment(pr)) {
          this.callbackRef(pr.name, pr);
        } else if (ts.isMethodDeclaration(pr) && pr.body) {
          this.c.cbFns.add(pr);
        } else if (ts.isSpreadAssignment(pr)) {
          this.fb.flow(this.expr(pr.expression), this.bound());
        }
      }
    }
  }

  private callbackRef(e: ts.Expression, at: ts.Node): void {
    const t = this.target(e);
    if (!t || t.spec.kind === 'op') return;
    const iid = this.c.em.iidOf(t.unit.rel, t.spec.sym);
    this.c.calleeIids.push(iid);
    const cs = this.fb.addCallsite({
      kind: CallKind.STATIC,
      calleeIids: [iid],
      calleeFqn: `${t.unit.rel}:${t.spec.sym}`,
      argc: 1,
      resultc: 1,
      span: spanOf(this.c.unit, at.getStart(this.c.unit.sf)),
      dispatchConfidence: 1.0,
    });
    this.c.em.stats.callsites++;
    this.c.em.stats.resolved++;
    if (t.viaChecker) this.c.em.stats.resolvedByChecker++;
    const port = this.fb.addVertex(VertexKind.CALL_ARG_PORT, 0, cs);
    this.fb.sink(this.bound(), port);
    const rport = this.fb.addVertex(VertexKind.CALL_RESULT_PORT, 0, cs);
    this.fb.source(this.fb.val(), rport);
  }

  private call(n: ts.CallExpression): number {
    const r = this.resolveCallee(n);
    const framework = this.c.em.ad.callbackFactories.has(lastName(n.expression));
    if (framework) this.frameworkCallbacks(n);
    const args: ts.Expression[] = [];
    if (r.argsOverride) {
      // an adapter rule named exactly which expression carries the variables
      args.push(...r.argsOverride);
    } else {
      if (r.arg0IsReceiver && r.receiver) args.push(r.receiver);
      if (!r.dropArgs) args.push(...n.arguments);
      if (r.varsProp && args.length) {
        // `mutate({ variables: {…} })` — the handler's param 0 is the variables
        const v = this.varsOf(args, 0, r.varsProp);
        if (v) args.splice(0, args.length, v);
      }
    }
    const cs = this.fb.addCallsite({
      kind: r.kind,
      calleeIids: r.calleeIids.length ? r.calleeIids : undefined,
      opaque: r.opaque || undefined,
      calleeFqn: r.calleeFqn,
      argc: args.length,
      arg0IsReceiver: r.arg0IsReceiver || undefined,
      resultc: 1,
      span: spanOf(this.c.unit, n.getStart(this.c.unit.sf)),
      dispatchConfidence: 1.0,
    });
    this.c.em.stats.callsites++;
    if (r.opaque) noteOpaque(this.c.em.stats, r.calleeFqn);
    else {
      this.c.em.stats.resolved++;
      if (r.viaChecker) this.c.em.stats.resolvedByChecker++;
    }
    for (const iid of r.calleeIids) this.c.calleeIids.push(iid);
    const argVals: number[] = [];
    // library call: nothing in-repo will summarise it, so a catalog propagator
    // is the only thing that can say it writes into an argument
    const library = this.c.em.libWriteback && r.calleeIids.length === 0 && r.kind !== CallKind.INVOKES_REMOTE;
    // coverage wave 1 §3.2 — `setS(v)` writes into `s`; `useMemo(() => e)` IS e
    const callee = unwrap(n.expression);
    const state = ts.isIdentifier(callee) && this.c.setters.size ? this.setterState(callee) : undefined;
    const thunkIdx = this.c.em.ad.thunkHofs.get(lastName(n.expression));
    const thunk = thunkIdx === undefined ? undefined : fnLike(n.arguments[thunkIdx]);
    let thunkVal = -1;
    args.forEach((a, i) => {
      const port = this.fb.addVertex(VertexKind.CALL_ARG_PORT, i, cs);
      let av: number;
      const f = fnLike(a);
      if (state !== undefined && f) {
        // functional update: `prev` is the state, the callback's result the new state
        const sv = this.fb.varVal(state);
        const prev: string[] = [];
        if (f.parameters[0]) bindNames(f.parameters[0].name, prev);
        for (const nm of prev) this.fb.flow(sv, this.fb.varVal(nm));
        this.fb.flow(this.inlineCaptured(f), sv);
        av = this.fb.val();
      } else if (thunk && unwrap(a) === thunk) {
        thunkVal = this.inlineCaptured(thunk);
        av = this.fb.val();
      } else {
        av = this.expr(a);
        if (state !== undefined) this.fb.flow(av, this.fb.varVal(state));
      }
      argVals.push(av);
      this.fb.sink(av, port);
      if (framework && !fnLike(a) && !objectArg(a)) this.fb.flow(av, this.bound());
      if (library) {
        const root = writebackRoot(a);
        if (root !== null) this.fb.source(this.fb.varVal(root), port);
      }
    });
    const rport = this.fb.addVertex(VertexKind.CALL_RESULT_PORT, 0, cs);
    const v = this.fb.val();
    this.fb.source(v, rport);
    if (thunkVal >= 0) this.fb.flow(thunkVal, v);
    // a `bind:` result is the form value the framework hands to the callback
    if (r.calleeFqn === 'svelte:bind') this.fb.flow(v, this.bound());
    this.typeAnchor(n, r, args, argVals, v);
    if (this.c.em.httpCalls && !r.argsOverride && !r.dropArgs && !r.varsProp) {
      const h = this.httpSite(n);
      // the data arguments, without the receiver the ordinary site carries
      if (h) this.httpCallsite(n, h, r.arg0IsReceiver && r.receiver ? argVals.slice(1) : argVals);
    }
    return v;
  }

  /** the state variable a call of `id` writes, when `id` IS a hook's setter */
  private setterState(id: ts.Identifier): string | undefined {
    const ch = this.c.em.checker;
    if (!ch) return this.c.setters.get(id.text);
    let d: ts.Declaration | undefined;
    try {
      d = ch.getSymbolAtLocation(id)?.valueDeclaration;
    } catch {
      d = undefined;
    }
    return d ? this.c.setters.get(d) : undefined;
  }

  // ---- HTTP client sites (coverage wave 1 §3.4) ---------------------------

  /**
   * The request a call makes, when its callee is bound to an HTTP client: the
   * method and the canonical path template. The binding is resolved, never the
   * name — `import axios from 'axios'`, a global `fetch`, or an instance some
   * `axios.create({baseURL})` made, in this file or imported from another.
   */
  private httpSite(n: ts.CallExpression): { method: string; path: string } | null {
    const unit = this.c.unit;
    const c = unwrap(n.expression);
    const a = n.arguments;
    let ref = this.clientOf(c, unit);
    let form: 'call' | 'config' | 'verb' = 'call';
    let method = '';
    if (!ref) {
      if (!ts.isPropertyAccessExpression(c)) return null;
      ref = this.clientOf(c.expression, unit);
      if (!ref) return null;
      const m = c.name.text;
      if (ref.lib.verbs.includes(m)) {
        form = 'verb';
        method = verbMethod(m);
      } else if (ref.lib.configMethods.includes(m)) form = 'config';
      else if (!ref.lib.callMethods.includes(m)) return null; // `axios.create`, `.interceptors`
    } else if (!ref.lib.callable) return null;
    let url: ts.Expression | undefined;
    let cfg: ts.Expression | undefined; // the per-request config/options
    if (form === 'verb') {
      url = a[0];
      cfg = a[ref.lib.bodyVerbs.includes((c as ts.PropertyAccessExpression).name.text) ? 2 : 1];
    } else {
      const a0 = a[0] ? unwrap(a[0]) : undefined;
      if (form === 'config' || (ref.lib.callConfig && a0 && ts.isObjectLiteralExpression(a0))) {
        // `axios({url, method})`, `axios.request(config)`
        url = a0 && ts.isObjectLiteralExpression(a0) ? propValue(a0, 'url') : undefined;
        method = this.optsMethod(a0);
        cfg = a[0];
      } else {
        url = a[0];
        method = this.optsMethod(a[1]);
        cfg = a[1];
      }
    }
    let t = this.urlTemplate(url);
    // base precedence: the request's own, the instance's, the library default;
    // one the code sets but we cannot read is `{}`, never silently nothing
    const base = this.configBase(cfg, ref.lib) ?? ref.base ?? this.defaultBase(ref.lib);
    if (base !== null && !isAbsoluteUrl(t)) t = joinBase(base, t);
    // `get('articles')` resolves against a base the code sets elsewhere
    // (`axios.defaults.baseURL = …`) or against the page: only a suffix is
    // known, which is the leading `{}` of §1.1 rule 5
    if (!isAbsoluteUrl(t) && !t.startsWith('/') && !t.startsWith('{}')) t = '{}/' + t;
    return { method, path: canonPath(t) };
  }

  /** The client an expression is bound to, read through `unit`'s imports. */
  private clientOf(
    e0: ts.Expression,
    unit: FileUnit,
    depth = 0,
  ): { lib: HttpClientLib; base: string | null } | null {
    if (depth > 4) return null;
    const em = this.c.em;
    const e = unwrap(e0);
    const global = (name: string) => {
      const lib = HTTP_CLIENTS.find((l) => l.globals.includes(name));
      return lib ? { lib, base: null } : null;
    };
    if (ts.isPropertyAccessExpression(e)) {
      // `window.fetch(…)`, `globalThis.fetch(…)`
      const root = unwrap(e.expression);
      const ok = ts.isIdentifier(root) && GLOBAL_SCOPES.has(root.text) && !unit.imports.has(root.text);
      return ok ? global(e.name.text) : null;
    }
    if (!ts.isIdentifier(e)) return null;
    const ch = em.checker;
    let sym: ts.Symbol | undefined;
    try {
      sym = ch?.getSymbolAtLocation(e);
    } catch {
      sym = undefined;
    }
    const decls = sym?.declarations ?? [];
    // the file's import table, unless the checker shows a local shadowing it
    const b = unit.imports.get(e.text);
    if (b && (!decls.length || decls.some(isImportBinding))) {
      const lib = HTTP_CLIENTS.find(
        (l) =>
          l.modules.includes(b.spec) &&
          (l.exports.includes(b.imported) || (b.imported === '*' && l.exports.includes('default'))),
      );
      if (lib) return { lib, base: null };
    }
    if (!ch || !sym) return b ? null : global(e.text);
    let target = sym;
    if (target.flags & ts.SymbolFlags.Alias) {
      try {
        target = ch.getAliasedSymbol(target);
      } catch {
        return null;
      }
    }
    for (const d of target.declarations ?? []) {
      const du = em.unitByFile.get(d.getSourceFile().fileName);
      // declared outside the repo (the DOM lib, typed mode): a platform global
      if (!du) {
        if (!b && global(e.text)) return global(e.text);
        continue;
      }
      const init = ts.isVariableDeclaration(d) ? d.initializer : ts.isExportAssignment(d) ? d.expression : undefined;
      const r = init ? this.instanceOf(init, du, depth + 1) : null;
      if (r) return r;
    }
    return null;
  }

  /** `axios.create({baseURL})`, `ky.extend({prefixUrl})`, or just another name */
  private instanceOf(
    init0: ts.Expression,
    unit: FileUnit,
    depth: number,
  ): { lib: HttpClientLib; base: string | null } | null {
    const init = unwrap(init0);
    if (ts.isIdentifier(init)) return this.clientOf(init, unit, depth);
    if (!ts.isCallExpression(init)) return null;
    const c = unwrap(init.expression);
    if (!ts.isPropertyAccessExpression(c)) return null;
    const parent = this.clientOf(c.expression, unit, depth);
    if (!parent || !parent.lib.factories.includes(c.name.text)) return null;
    // an instance without a base of its own keeps its parent's (or the default)
    return { lib: parent.lib, base: this.configBase(init.arguments[0], parent.lib) ?? parent.base };
  }

  /**
   * The base URL a client config sets: a template, `{}` when it sets one we
   * cannot read (a computed value, a config object we cannot see, a spread of
   * one), undefined when it certainly sets none. Later properties win, as in
   * the object itself.
   */
  private configBase(e0: ts.Expression | undefined, lib: HttpClientLib, depth = 0): string | undefined {
    if (!e0 || !lib.baseProps.length) return undefined;
    const e = unwrap(e0);
    if (ts.isObjectLiteralExpression(e)) {
      let base: string | undefined;
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) {
          const b = depth < 3 ? this.configBase(p.expression, lib, depth + 1) : '{}';
          if (b !== undefined) base = b;
        } else if (lib.baseProps.includes(propName(p))) {
          const v = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
          base = v ? this.urlTemplate(v) : '{}';
        }
      }
      return base;
    }
    // `const cfg = {…}`: its initializer, in whichever file it is declared
    const ch = this.c.em.checker;
    if (ch && ts.isIdentifier(e) && depth < 3) {
      let d: ts.Declaration | undefined;
      try {
        let sym = ch.getSymbolAtLocation(e);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = ch.getAliasedSymbol(sym);
        d = sym?.valueDeclaration;
      } catch {
        d = undefined;
      }
      if (d && ts.isVariableDeclaration(d) && d.initializer && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) {
        return this.configBase(d.initializer, lib, depth + 1);
      }
    }
    return '{}';
  }

  /** the base a repo-wide `axios.defaults.baseURL = v` gives every request of
   *  `lib`: v's template, `{}` when assignments disagree, null when none */
  private defaultBase(lib: HttpClientLib): string | null {
    const em = this.c.em;
    if (!lib.defaults.length) return null;
    const hit = em.defaultBases.get(lib.name);
    if (hit !== undefined) return hit;
    const seen = new Set<string>();
    for (const unit of em.units.values()) {
      const visit = (n: ts.Node): void => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(n.left)
        ) {
          const p = pathText(n.left);
          const root = p.split('.')[0]!;
          const b = unit.imports.get(root);
          if (
            b &&
            lib.modules.includes(b.spec) &&
            lib.defaults.some((d) => p === `${root}.${d}`)
          ) {
            seen.add(this.urlTemplate(n.right));
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(unit.sf);
    }
    const base = seen.size === 0 ? null : seen.size === 1 ? [...seen][0]! : '{}';
    em.defaultBases.set(lib.name, base);
    return base;
  }

  /**
   * A URL expression as a path template: string and template literals, `+`
   * chains, `new URL(path, base)`; each hole a constant the checker knows (a
   * `const` string, a literal type) or a local `const`'s own initializer, else
   * `{}`. An env read or unknown base at the start is therefore the leading
   * `{}` the canonical form keeps (§1.1 rule 5).
   */
  private urlTemplate(e0: ts.Expression | undefined, depth = 0): string {
    if (!e0 || depth > 4) return '{}';
    const e = unwrap(e0);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) {
      return (
        e.head.text + e.templateSpans.map((sp) => this.urlTemplate(sp.expression, depth + 1) + sp.literal.text).join('')
      );
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return this.urlTemplate(e.left, depth + 1) + this.urlTemplate(e.right, depth + 1);
    }
    if (ts.isNewExpression(e) && pathText(e.expression) === 'URL' && e.arguments?.length) {
      const p = this.urlTemplate(e.arguments[0], depth + 1);
      if (e.arguments.length < 2 || p.startsWith('/') || isAbsoluteUrl(p)) return p;
      return joinBase(this.urlTemplate(e.arguments[1], depth + 1), p);
    }
    if (ts.isNumericLiteral(e)) return e.text;
    const k = this.constString(e);
    if (k !== null) return k;
    // `const url = \`/api/users/${id}\`; fetch(url)`
    const ch = this.c.em.checker;
    if (ch && ts.isIdentifier(e)) {
      let d: ts.Declaration | undefined;
      try {
        d = ch.getSymbolAtLocation(e)?.valueDeclaration;
      } catch {
        d = undefined;
      }
      if (
        d &&
        ts.isVariableDeclaration(d) &&
        d.initializer &&
        ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const &&
        d.getSourceFile() === e.getSourceFile()
      ) {
        return this.urlTemplate(d.initializer, depth + 1);
      }
    }
    return '{}';
  }

  /** the single string literal type the checker gives an expression, or null */
  private constString(e: ts.Expression): string | null {
    const ch = this.c.em.checker;
    if (!ch || !(ts.isIdentifier(e) || ts.isPropertyAccessExpression(e))) return null;
    try {
      const t = ch.getTypeAtLocation(e);
      return t.isStringLiteral() ? t.value : null;
    } catch {
      return null;
    }
  }

  /** `{ method: 'post' }` -> POST; absent -> GET; anything not a known constant -> '' */
  private optsMethod(o: ts.Expression | undefined): string {
    if (!o) return 'GET';
    const n = unwrap(o);
    if (!ts.isObjectLiteralExpression(n)) return '';
    const v = propValue(n, 'method');
    if (!v) return n.properties.some(ts.isSpreadAssignment) ? '' : 'GET';
    const u = unwrap(v);
    const lit = ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : this.constString(u);
    const m = (lit ?? '').toUpperCase();
    return HTTP_METHODS.has(m) ? m : '';
  }

  /** the synthetic client site: argc 1, resultc 0, every data argument into port 0 */
  private httpCallsite(n: ts.CallExpression, h: { method: string; path: string }, vals: number[]): void {
    const em = this.c.em;
    const fqn = httpContractName(h.method, h.path);
    const cs = this.fb.addCallsite({
      kind: CallKind.STATIC,
      opaque: true,
      calleeFqn: fqn,
      argc: 1,
      resultc: 0,
      span: spanOf(this.c.unit, n.getStart(this.c.unit.sf)),
      dispatchConfidence: 1.0,
      httpCall: { method: h.method, path: h.path },
    });
    noteOpaque(em.stats, fqn);
    em.stats.callsites++;
    em.stats.httpCalls++;
    const segs = h.path.split('/').filter(Boolean);
    if (segs.some((x) => x !== '{}' && x !== '{*}')) em.stats.httpCallsResolvedPath++;
    if (segs[0] === '{}') em.stats.httpCallsDynamicBase++;
    if (!h.method) em.stats.httpCallsUnknownMethod++;
    const port = this.fb.addVertex(VertexKind.CALL_ARG_PORT, 0, cs);
    for (const v of vals) this.fb.sink(v, port);
  }

  /**
   * Link a call into the `$op` its ARGUMENT (or its result) is typed with, even
   * when the callee itself never resolved — the codegen'd `<X>QueryVariables` /
   * `<X>Mutation` aliases are a second, independent binding of the same edge.
   */
  private typeAnchor(
    n: ts.CallExpression,
    r: Resolved,
    args: ts.Expression[],
    argVals: number[],
    resultVal: number,
  ): void {
    const em = this.c.em;
    if (!em.anchorsOn) return;
    let hit: { unit: FileUnit; spec: FnSpec } | null = null;
    let argVal = -1;
    for (let i = 0; i < args.length; i++) {
      const k = unwrap(args[i]!);
      if (
        !ts.isObjectLiteralExpression(k) &&
        !ts.isIdentifier(k) &&
        !ts.isPropertyAccessExpression(k)
      ) {
        continue;
      }
      const h = em.anchorOf(args[i]!, true);
      if (h) {
        hit = h;
        argVal = argVals[i] ?? -1;
        break;
      }
    }
    if (!hit) hit = em.anchorOf(n, false);
    if (!hit) return;
    // already bound to that very function by the checker: nothing to add
    if (!r.opaque && r.calleeFqn === `${hit.unit.rel}:${hit.spec.sym}`) return;
    const iid = em.iidOf(hit.unit.rel, hit.spec.sym);
    this.c.calleeIids.push(iid);
    const cs = this.fb.addCallsite({
      kind: CallKind.STATIC,
      calleeIids: [iid],
      calleeFqn: `${hit.unit.rel}:${hit.spec.sym}`,
      argc: 1,
      resultc: 1,
      span: spanOf(this.c.unit, n.getStart(this.c.unit.sf)),
      dispatchConfidence: 1.0,
    });
    em.stats.callsites++;
    em.stats.resolved++;
    em.stats.anchors++;
    if (r.opaque) em.stats.anchorsOnOpaque++;
    const aport = this.fb.addVertex(VertexKind.CALL_ARG_PORT, 0, cs);
    if (argVal >= 0) this.fb.sink(argVal, aport);
    const rport = this.fb.addVertex(VertexKind.CALL_RESULT_PORT, 0, cs);
    const rv = this.fb.val();
    this.fb.source(rv, rport);
    this.fb.flow(rv, resultVal);
  }

  // ---- statements ------------------------------------------------------

  stmts(list: readonly ts.Statement[]): void {
    for (const s of list) this.stmt(s);
  }

  stmt(s: ts.Statement): void {
    this.c.depth++;
    try {
      if (this.c.depth > 400) return;
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) this.varDecl(d);
        return;
      }
      if (ts.isExpressionStatement(s)) {
        this.expr(s.expression);
        return;
      }
      if (ts.isReturnStatement(s)) {
        if (s.expression) this.returnValue(this.expr(s.expression));
        return;
      }
      if (ts.isFunctionDeclaration(s) && s.body) {
        this.inlineFn(s.parameters, s.body);
        return;
      }
      if (ts.isBlock(s)) {
        this.stmts(s.statements);
        return;
      }
      if (ts.isIfStatement(s)) {
        this.expr(s.expression);
        this.stmt(s.thenStatement);
        if (s.elseStatement) this.stmt(s.elseStatement);
        return;
      }
      if (this.c.em.tryBlocks && ts.isTryStatement(s)) {
        this.stmts(s.tryBlock.statements);
        if (s.catchClause) this.stmts(s.catchClause.block.statements);
        if (s.finallyBlock) this.stmts(s.finallyBlock.statements);
        return;
      }
      if (ts.isForOfStatement(s) || ts.isForInStatement(s)) {
        const src = this.expr(s.expression);
        if (ts.isVariableDeclarationList(s.initializer)) {
          for (const d of s.initializer.declarations) {
            const names: string[] = [];
            bindNames(d.name, names);
            for (const nm of names) this.fb.flow(src, this.fb.varVal(nm));
          }
        }
        this.stmt(s.statement);
        return;
      }
      // generic recursion
      ts.forEachChild(s, (ch) => {
        if (ts.isStatement(ch)) this.stmt(ch);
        else if (ts.isExpression(ch)) this.expr(ch);
        else if (ts.isVariableDeclarationList(ch)) {
          for (const d of ch.declarations) this.varDecl(d);
        } else if (ts.isCaseBlock(ch)) {
          for (const cl of ch.clauses) this.stmts(cl.statements);
        } else if (ts.isCatchClause(ch)) {
          this.stmts(ch.block.statements);
        }
      });
    } finally {
      this.c.depth--;
    }
  }

  private varDecl(d: ts.VariableDeclaration): void {
    if (!d.initializer) return;
    const init = unwrap(d.initializer);
    if (ts.isNewExpression(init)) {
      const c = pathText(init.expression);
      if (CTOR_TYPES.has(c) && ts.isIdentifier(d.name)) this.c.varType.set(d.name.text, c);
    }
    if (this.c.em.libWriteback && ts.isIdentifier(d.name) && !this.c.varType.has(d.name.text)) {
      const t = containerType(init, d.type);
      if (t) this.c.varType.set(d.name.text, t);
    }
    const v = this.expr(d.initializer);
    const names: string[] = [];
    bindNames(d.name, names);
    for (const nm of names) this.fb.flow(v, this.fb.varVal(nm));
  }

  inlineFn(params: readonly ts.ParameterDeclaration[], body: ts.Node, framework = false): void {
    for (const p of params) {
      const names: string[] = [];
      bindNames(p.name, names);
      // callback params carry no incoming fact of their own; they are bound so
      // that a name collision with an outer variable behaves as a capture.
      for (const nm of names) {
        const v = this.fb.varVal(nm);
        if (framework) this.fb.flow(this.bound(), v);
      }
    }
    this.body(body);
  }

  body(body: ts.Node): void {
    if (ts.isBlock(body)) this.stmts(body.statements);
    else if (ts.isSourceFile(body)) this.stmts(body.statements);
    else if (ts.isExpression(body as ts.Expression)) this.returnValue(this.expr(body as ts.Expression));
  }

  private returnValue(v: number): void {
    const to = this.c.retTo;
    if (to.length) this.fb.flow(v, to[to.length - 1]!);
    else this.fb.sink(v, this.fb.returnVertex());
  }

  /**
   * Inline a closure whose returns go to a fresh value instead of the enclosing
   * function's OUT_RETURN (coverage wave 1): a JSX event handler's return is
   * ignored by React, and `useMemo(() => e)`'s is the call's result. Returns
   * that value.
   */
  inlineCaptured(f: ts.ArrowFunction | ts.FunctionExpression): number {
    const v = this.fb.val();
    this.c.retTo.push(v);
    try {
      this.inlineFn(f.parameters, f.body, this.c.cbFns.has(f));
    } finally {
      this.c.retTo.pop();
    }
    return v;
  }
}

// ---------------------------------------------------------------------------
// function builders
// ---------------------------------------------------------------------------

/**
 * `const [s, setS] = useState(…)` anywhere under `root` (closures included —
 * they are inlined into the same flow): the setter's binding element (or, with
 * no checker to resolve a call to it, its name) -> state name. Collected up
 * front because a handler that calls the setter may precede the declaration.
 */
function stateSetters(
  root: ts.Node,
  ad: AdapterSet,
  byDecl: boolean,
  out: Map<ts.Node | string, string>,
): void {
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      const hook = ts.isCallExpression(init) ? ad.stateHooks.get(lastName(init.expression)) : undefined;
      if (hook) {
        const el = (i: number): ts.BindingElement | undefined => {
          const e = (n.name as ts.ArrayBindingPattern).elements[i];
          return e && ts.isBindingElement(e) && ts.isIdentifier(e.name) ? e : undefined;
        };
        const st = el(hook.state);
        const set = el(hook.setter);
        if (st && set) {
          const key = byDecl ? set : (set.name as ts.Identifier).text;
          if (!out.has(key)) out.set(key, (st.name as ts.Identifier).text);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
}

function buildRegular(em: Emitter, unit: FileUnit, spec: FnSpec): Fn {
  const fb = new FlowBuilder();
  const ctx: FnCtx = {
    em,
    unit,
    fb,
    varType: new Map(),
    calleeIids: [],
    depth: 0,
    cbFns: new Set(),
    boundAgg: -1,
    retTo: [],
    setters: new Map(),
  };
  const f = new FnFlow(ctx);
  spec.params.forEach((p, i) => {
    const vtx = fb.addVertex(VertexKind.IN_PARAM, i, 0);
    const pv = fb.val();
    fb.source(pv, vtx);
    const names: string[] = [];
    bindNames(p.name, names);
    for (const nm of names) fb.flow(pv, fb.varVal(nm));
  });
  const stmts = (spec as FnSpec & { stmts?: ts.Statement[] }).stmts;
  if (em.ad.stateHooks.size) {
    for (const r of stmts ?? (spec.body ? [spec.body] : [])) {
      stateSetters(r, em.ad, em.checker !== null, ctx.setters);
    }
  }
  if (stmts) f.stmts(stmts);
  else if (spec.body) f.body(spec.body);
  return finish(em, unit, spec, fb, ctx.calleeIids);
}

function buildOp(em: Emitter, unit: FileUnit, spec: FnSpec): Fn {
  const fb = new FlowBuilder();
  const doc = spec.op!.doc;
  const varsVtx = fb.addVertex(VertexKind.IN_PARAM, 0, 0);
  const varsVal = fb.val();
  fb.source(varsVal, varsVtx);
  const calleeIids: Uint8Array[] = [];
  const resultVal = fb.val();
  for (const rf of doc.fields) {
    const iid = contractIID(`graphql:${rf.typeField}`);
    calleeIids.push(iid);
    const cs: Omit<CallSite, 'id'> = {
      kind: CallKind.INVOKES_REMOTE,
      calleeIids: [iid],
      calleeFqn: `graphql:${rf.typeField}`,
      argc: rf.argNames.length,
      arg0IsReceiver: undefined,
      resultc: 1,
      span: spanOf(unit, spec.pos),
      dispatchConfidence: 1.0,
    };
    if (em.codec.hasArgNames) cs.argNames = rf.argNames;
    const id = fb.addCallsite(cs);
    em.stats.callsites++;
    em.stats.invokesRemote++;
    if (rf.viaSdl) em.stats.opFieldsViaSdl++;
    else em.stats.opFieldsFallback++;
    rf.argNames.forEach((_, i) => {
      const port = fb.addVertex(VertexKind.CALL_ARG_PORT, i, id);
      if (rf.argUsesVar[i]) fb.sink(varsVal, port);
    });
    const rport = fb.addVertex(VertexKind.CALL_RESULT_PORT, 0, id);
    fb.source(resultVal, rport);
  }
  // mapper(value) -> return
  const mapper = spec.op!.mapper;
  const mspec = mapper && ts.isIdentifier(unwrap(mapper)) ? unit.byName.get(pathText(mapper)) : null;
  if (mspec) {
    const iid = em.iidOf(unit.rel, mspec.sym);
    calleeIids.push(iid);
    const id = fb.addCallsite({
      kind: CallKind.STATIC,
      calleeIids: [iid],
      calleeFqn: `${unit.rel}:${mspec.sym}`,
      argc: 1,
      resultc: 1,
      span: spanOf(unit, spec.pos),
      dispatchConfidence: 1.0,
    });
    em.stats.callsites++;
    const aport = fb.addVertex(VertexKind.CALL_ARG_PORT, 0, id);
    fb.sink(resultVal, aport);
    const rport = fb.addVertex(VertexKind.CALL_RESULT_PORT, 0, id);
    const mv = fb.val();
    fb.source(mv, rport);
    fb.sink(mv, fb.returnVertex());
  } else {
    fb.sink(resultVal, fb.returnVertex());
  }
  em.stats.ops++;
  return finish(em, unit, spec, fb, calleeIids, ['variables']);
}

function buildHandler(em: Emitter, unit: FileUnit, spec: FnSpec): Fn {
  const fb = new FlowBuilder();
  // param0 -> $op -> return
  const vtx = fb.addVertex(VertexKind.IN_PARAM, 0, 0);
  const pv = fb.val();
  fb.source(pv, vtx);
  const calleeIids: Uint8Array[] = [];
  let target: FnSpec | undefined;
  let targetRel = '';
  if (spec.handlerDoc) {
    // adapter `[[handler]] kind = "doc"` — the op is named by the DOCUMENT
    const d = em.docSpecOf(unit, spec.handlerDoc);
    if (d) {
      target = d.spec;
      targetRel = d.unit.rel;
    }
  } else {
    target =
      unit.byName.get('$op') ??
      (spec.handlerPath
        ? em.units.get(em.endpointDirs.get(spec.handlerPath) ?? '')?.byName.get('$op')
        : undefined);
    targetRel = unit.byName.has('$op')
      ? unit.rel
      : (em.endpointDirs.get(spec.handlerPath ?? '') ?? '');
  }
  if (target && targetRel) {
    const iid = em.iidOf(targetRel, target.sym);
    calleeIids.push(iid);
    const id = fb.addCallsite({
      kind: CallKind.STATIC,
      calleeIids: [iid],
      calleeFqn: `${targetRel}:${target.sym}`,
      argc: 1,
      resultc: 1,
      span: spanOf(unit, spec.pos),
      dispatchConfidence: 1.0,
    });
    em.stats.callsites++;
    const aport = fb.addVertex(VertexKind.CALL_ARG_PORT, 0, id);
    fb.sink(pv, aport);
    const rport = fb.addVertex(VertexKind.CALL_RESULT_PORT, 0, id);
    const rv = fb.val();
    fb.source(rv, rport);
    fb.sink(rv, fb.returnVertex());
  } else {
    fb.sink(pv, fb.returnVertex());
    em.stats.warnings.push(
      `handler-warn: ${unit.rel}:${spec.sym} — no $op for '${spec.handlerPath ?? ''}'`,
    );
  }
  return finish(em, unit, spec, fb, calleeIids, ['variables']);
}

function finish(
  em: Emitter,
  unit: FileUnit,
  spec: FnSpec,
  fb: FlowBuilder,
  calleeIids: Uint8Array[],
  paramNames?: string[],
): Fn {
  const flow = fb.build();
  const names =
    paramNames ??
    spec.params.map((p, i) => (ts.isIdentifier(p.name) ? p.name.text : `p${i}`));
  const iid = em.iidOf(unit.rel, spec.sym);
  const h = createHash('sha256');
  h.update(field(JSON.stringify(flow, (_k, v) => (v instanceof Uint8Array ? [...v] : v))));
  for (const c of [...calleeIids].sort(cmpBytes)) h.update(field(c));
  const fn: Fn = {
    id: { iid, bid: new Uint8Array(h.digest()) },
    fqn: `${unit.rel}:${spec.sym}`,
    package: unit.pkg,
    hasBody: true,
    span: spanOf(unit, spec.pos),
    signature: { params: names.map((n) => ({ name: n, type: '' })), returns: [{ type: '' }] },
    flow,
  };
  if (spec.routes?.length) {
    // coverage wave 1 §3.3: bound to the route's CONTRACT endpoint, the iid a
    // client HttpCall links to; the request params are the untrusted ones
    const seen = new Set<string>();
    fn.bindsTo = [];
    for (const r of spec.routes) {
      const eid = httpContractIID(r.method, r.path);
      if (!seen.has(hex(eid))) fn.bindsTo.push(eid);
      seen.add(hex(eid));
    }
    fn.sourceParams = [...new Set(spec.routes.flatMap((r) => r.requestParams))].sort((a, b) => a - b);
  } else if (spec.action) {
    fn.bindsTo = [endpointIID(em.repo.repoId, `action:${fn.fqn}`)];
    fn.sourceParams = spec.params.map((_, i) => i);
  } else if (spec.endpoint) {
    const eid = endpointIID(em.repo.repoId, spec.endpoint);
    fn.bindsTo = [eid];
    fn.sourceParams = [0];
  }
  em.stats.functions++;
  return fn;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

export function build(opts: BuildOpts): Stats {
  const jsx = opts.jsx ?? true;
  // an older cgf.proto (PC_CGF_PROTO) without the HTTP fields: neither is emitted
  const httpRoutes = (opts.httpRoutes ?? true) && opts.codec.hasHttp;
  // coverage wave 1 §3.3: Next.js conventions only for a repo that looks like
  // Next; a root `app/`/`pages/` is served even when `src/` exists
  const next = httpRoutes && looksLikeNext(path.resolve(opts.repoDir), repoDeps(opts.repoDir));
  const repo = loadRepo(opts.repoDir, opts.repoId, opts.schemas ?? [], {
    jsx,
    extraRoots: next ? ['app', 'pages'] : [],
  });
  // Client-library knowledge is DATA (adapters): the core alone knows nothing
  // about how a document becomes a callable.
  const ad = loadAdapters({
    repoDir: opts.repoDir,
    adapters: opts.adapters,
    none: opts.noAdapters,
    routes: opts.adapterRoutes,
    exclude: opts.excludeAdapters,
    dir: opts.adaptersDir,
  });
  const sdlTexts = repo.schemaPaths.map((p) => fs.readFileSync(p, 'utf8'));
  const sdl = loadSdl(sdlTexts);
  const resolver = opts.resolver ?? 'checker';

  // pass 0 — read + lower every unit, then bind them into ONE ts.Program so the
  // checker can follow re-exports, renames and object-literal properties.
  const units: SourceUnit[] = [];
  const warnBuf: string[] = [];
  for (const rel of repo.files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repo.dir, rel), 'utf8');
    } catch {
      continue;
    }
    const svelte = rel.endsWith('.svelte');
    let map: SvelteMap | undefined;
    if (svelte) {
      const low = lowerSvelte(text);
      if (low.warn) warnBuf.push(`${rel}: ${low.warn}`);
      text = low.code;
      map = low.map;
    }
    units.push({ rel, fileName: virtualName(repo.dir, rel), text, svelte, map });
  }
  const rp = resolver === 'checker' ? createRepoProgram(repo, units) : null;

  const em = new Emitter(repo, opts.codec, rp?.checker ?? null, ad);
  em.stats.resolver = resolver;
  em.stats.programMs = rp?.wallMs ?? 0;
  em.anchorsOn = rp !== null && (opts.typeAnchors ?? true);
  em.libWriteback = opts.libraryWriteback ?? true;
  em.jsx = jsx;
  em.jsxComponents = jsx && (opts.jsxComponents ?? true);
  em.jsxFacts = jsx && (opts.jsxFacts ?? true);
  em.stats.reactMajor = reactMajor(repo.dir);
  em.reactSanitizesUrls = (em.stats.reactMajor ?? 0) >= 19;
  em.stats.nextjs = next;
  const roots = nextRoots(repo.dir);
  em.httpCalls = (opts.httpCalls ?? true) && opts.codec.hasHttp;
  em.tryBlocks = opts.tryBlocks ?? true;
  em.instanceNames = opts.instanceNames ?? true;
  const parseFlags: ParseFlags = {
    jsxComponents: em.jsxComponents,
    serverActions: next,
    checker: rp?.checker ?? null,
  };
  em.stats.typed = rp?.typed ?? false;
  em.stats.externalFiles = rp?.externalFiles ?? 0;
  em.stats.warnings.push(...warnBuf);
  if (!opts.quiet) {
    process.stderr.write(
      `pc-fe-ts: repo=${repo.repoId} files=${repo.files.length} schema=${
        repo.schemaPaths.map((p) => path.basename(p)).join(',') || '<none>'
      } adapters=${ad.names.join(',') || '<none>'}${
        ad.routes ? '' : ' routes=off'
      } sdl-types=${sdl.types.size} resolver=${resolver}${
        rp
          ? ` program=${(rp.wallMs / 1000).toFixed(1)}s typed=${rp.typed} ext-dts=${rp.externalFiles}`
          : ''
      }\n`,
    );
  }
  if (!opts.codec.hasArgNames) {
    process.stderr.write(
      'proto-warn: loaded cgf.proto has no CallSite.arg_names — GraphQL args stay positional\n',
    );
  }
  if (!opts.codec.hasHttp && ((opts.httpRoutes ?? true) || (opts.httpCalls ?? true))) {
    process.stderr.write(
      'proto-warn: loaded cgf.proto has no CgfPackage.http_routes / CallSite.http_call — HTTP routes and client sites are not emitted\n',
    );
  }

  for (const u0 of units) {
    const sf =
      rp?.byRel.get(u0.rel) ??
      ts.createSourceFile(
        u0.fileName,
        u0.text,
        ts.ScriptTarget.Latest,
        true,
        u0.svelte || u0.rel.endsWith('.ts')
          ? ts.ScriptKind.TS
          : u0.rel.endsWith('.tsx')
            ? ts.ScriptKind.TSX
            : u0.rel.endsWith('.jsx')
              ? ts.ScriptKind.JSX
              : ts.ScriptKind.JS,
      );
    const u = parseFile(u0.rel, sf, u0.svelte, sdl, em.stats, ad, parseFlags, u0.map);
    if (!u) continue;
    if (httpRoutes && !u0.svelte) markRoutes(u, next, roots);
    em.units.set(u0.rel, u);
    em.stats.files++;
    const dir = ad.opDirOf(u0.rel);
    if (dir && u.byName.has('$op')) em.endpointDirs.set(dir, u0.rel);
  }
  em.indexDecls();

  const byPkg = new Map<string, CgfPackage>();
  const pkgOf = (p: string): CgfPackage => {
    let c = byPkg.get(p);
    if (!c) {
      byPkg.set(
        p,
        (c = {
          repo: repo.repoId,
          commitSha: repo.commitSha,
          packagePath: p,
          schemaVersion: SCHEMA_VERSION,
          language: 'ts',
          functions: [],
          endpoints: [],
          httpRoutes: [],
        }),
      );
    }
    return c;
  };

  const endpointSeen = new Set<string>();
  for (const rel of repo.files) {
    const unit = em.units.get(rel);
    if (!unit) continue;
    const pkg = pkgOf(unit.pkg);
    for (const spec of unit.specs) {
      let fn: Fn;
      try {
        fn =
          spec.kind === 'op'
            ? buildOp(em, unit, spec)
            : spec.kind === 'handler'
              ? buildHandler(em, unit, spec)
              : buildRegular(em, unit, spec);
      } catch (e) {
        em.stats.warnings.push(`extract-warn: ${rel}:${spec.sym}: ${(e as Error).message}`);
        continue;
      }
      pkg.functions.push(fn);
      if (spec.routes?.length) emitRoutes(em, pkg, spec, fn, endpointSeen);
      if (spec.action) {
        const name = `action:${fn.fqn}`;
        if (!endpointSeen.has(name)) {
          endpointSeen.add(name);
          pkg.endpoints!.push({
            iid: endpointIID(repo.repoId, name),
            kind: EndpointKind.HTTP,
            untrustedInput: true,
            name,
          });
          em.stats.endpoints++;
          em.stats.serverActions++;
        }
      }
      if (spec.endpoint && !endpointSeen.has(spec.endpoint)) {
        endpointSeen.add(spec.endpoint);
        const ep: Endpoint = {
          iid: endpointIID(repo.repoId, spec.endpoint),
          kind: EndpointKind.HTTP,
          untrustedInput: true,
          name: spec.endpoint,
        };
        pkg.endpoints!.push(ep);
        em.stats.endpoints++;
      }
    }
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  for (const old of fs.readdirSync(opts.outDir)) {
    if (old.endsWith('.pb')) fs.unlinkSync(path.join(opts.outDir, old));
  }
  for (const p of [...byPkg.keys()].sort()) {
    const cp = byPkg.get(p)!;
    if (!cp.functions.length) continue;
    if (!cp.endpoints!.length) delete cp.endpoints;
    if (!cp.httpRoutes!.length) delete cp.httpRoutes;
    const bytes = opts.codec.encodePackage(cp);
    fs.writeFileSync(path.join(opts.outDir, sanitize(p) + '.pb'), bytes);
  }
  if (!opts.quiet) censusLines(em.stats);
  emitEmptyOutputWarnings(repo, opts, ad, em.stats);
  return em.stats;
}

/**
 * One route -> its contract endpoint (once per iid in the repo) and one
 * `HttpRoute` row per handler (coverage wave 1 §3.3). `endpoint_iid == iid`:
 * the endpoint IS the contract, as for gRPC methods and GraphQL fields.
 */
function emitRoutes(em: Emitter, pkg: CgfPackage, spec: FnSpec, fn: Fn, seen: Set<string>): void {
  for (const r of spec.routes ?? []) {
    const iid = httpContractIID(r.method, r.path);
    const key = `http:${hex(iid)}`;
    if (!seen.has(key)) {
      seen.add(key);
      pkg.endpoints!.push({
        iid,
        kind: EndpointKind.HTTP,
        untrustedInput: true,
        name: `${r.method} ${r.display}`,
      });
      em.stats.endpoints++;
    }
    const row: HttpRoute = {
      iid,
      method: r.method,
      path: r.path,
      display: r.display,
      handlerIid: fn.id.iid,
      endpointIid: iid,
      requestParams: r.requestParams,
      framework: r.framework,
    };
    pkg.httpRoutes!.push(row);
    em.stats.httpRoutes++;
    em.stats.httpRoutesByFramework[r.framework] = (em.stats.httpRoutesByFramework[r.framework] ?? 0) + 1;
  }
}

/** the coverage census, one stderr line per boundary kind that has anything */
function censusLines(st: Stats): void {
  if (st.httpRoutes || st.serverActions) {
    const fw = Object.entries(st.httpRoutesByFramework)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
    process.stderr.write(`http-routes: ${st.httpRoutes} routes (${fw || 'none'}) actions=${st.serverActions}\n`);
  }
  if (st.httpCalls) {
    process.stderr.write(
      `http-calls: ${st.httpCalls} sites, resolved_path=${st.httpCallsResolvedPath}, ` +
        `dynamic_base=${st.httpCallsDynamicBase}, unknown_method=${st.httpCallsUnknownMethod}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// empty-output guardrails — a zero-adapter or zero-endpoint run is usually a
// silent misconfiguration, not a genuinely empty repo. Both checks are cheap
// and generic (no fixture-specific branching) and print unconditionally, even
// under --quiet, since a silent empty output is exactly the failure mode.
// ---------------------------------------------------------------------------

const GRAPHQL_NEEDLE = /graphql|apollo|urql|relay/i;
const GRAPHQL_FILE_SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.svelte-kit']);

/** first `.graphql`/`.gql` file under `dir`, repo-relative, or null. */
function findGraphqlFile(dir: string, rel = ''): string | null {
  const abs = rel ? path.join(dir, rel) : dir;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (GRAPHQL_FILE_SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
      const found = findGraphqlFile(dir, r);
      if (found) return found;
    } else if (e.isFile() && (e.name.endsWith('.graphql') || e.name.endsWith('.gql'))) {
      return r;
    }
  }
  return null;
}

/** Cheap, generic "does this repo look GraphQL-shaped" heuristic. */
function graphqlShapeEvidence(repo: RepoInfo): { deps: string[]; evidence: string[] } {
  const deps = [...repoDeps(repo.dir)].sort().filter((d) => GRAPHQL_NEEDLE.test(d));
  const evidence = deps.map((d) => `dep:${d}`);
  const specRe = /\b(?:from|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  const seenSpecs = new Set<string>();
  for (const rel of repo.files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repo.dir, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(specRe)) {
      const spec = m[1]!;
      if (GRAPHQL_NEEDLE.test(spec) && !seenSpecs.has(spec)) {
        seenSpecs.add(spec);
        evidence.push(`import:${spec}`);
      }
    }
  }
  const gqlFile = findGraphqlFile(repo.dir);
  if (gqlFile) evidence.push(`file:${gqlFile}`);
  return { deps, evidence };
}

function emitEmptyOutputWarnings(
  repo: RepoInfo,
  opts: BuildOpts,
  ad: AdapterSet,
  stats: Stats,
): void {
  if (ad.names.length === 0 && !opts.noAdapters) {
    const { deps, evidence } = graphqlShapeEvidence(repo);
    if (evidence.length) {
      process.stderr.write(
        `warning: no adapter matched package.json (deps: ${deps.join(', ') || '<none>'}) but the ` +
          `repo looks GraphQL-shaped (evidence: ${evidence.join(', ')}); pass --adapter <name> or ` +
          `write an adapter — see docs\n`,
      );
    }
  }
  if (stats.endpoints === 0 && stats.ops === 0) {
    process.stderr.write(
      `warning: ${stats.endpoints} endpoints and ${stats.ops} operations emitted — no entry ` +
        `surface was recognised (SvelteKit route exports, Next.js route files and server actions, ` +
        `adapter handler routes, GraphQL operations); chains can still start at catalog sources ` +
        `in this code (URL and DOM reads, router hooks), but none starts at an endpoint of this repo\n`,
    );
  }
}

/**
 * The react major the repo renders with (coverage wave 1 §3.1): the MINIMUM
 * major its `package.json` range allows (`^18.3.0 || ^19.0.0` -> 18). Only the
 * declared range counts, never an installed `node_modules`, so the same commit
 * extracts to the same bytes on every machine. Null when the range says nothing
 * — the caller treats unknown as unsanitised, the conservative side.
 */
export function reactMajor(repoDir: string): number | null {
  let range: string | undefined;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const k of ['dependencies', 'peerDependencies', 'devDependencies']) {
      range ??= j[k]?.['react'];
    }
  } catch {
    return null;
  }
  // a version token is a number at the start or after an operator/space/`v`;
  // `npm:` aliases, tags (`latest`) and workspace links say nothing
  if (!range || /^(npm|workspace|file|link|git|http)/.test(range)) return null;
  const majors = [...range.matchAll(/(?:^|[\s|^~<>=v])(\d+)(?=[.\sxX*]|$)/g)].map((m) => Number(m[1]));
  return majors.length ? Math.min(...majors) : null;
}

export function sanitize(s: string): string {
  return s.replace(/[/\\:]/g, '_');
}

/**
 * The variable a library call can write into through argument `a`: the
 * identifier itself, or the root of a property chain (`this.items.push(x)`
 * writes into `this`, the same whole-object smear `assignTo` applies to a
 * member write). Null for anything else — a call result, a literal, a global
 * like `Object` or `JSON` (writing "into" those means nothing). A chain whose
 * index is not a literal/identifier is skipped rather than re-evaluated.
 */
function writebackRoot(a: ts.Expression): string | null {
  let n = unwrap(a);
  for (let i = 0; i < 16; i++) {
    if (ts.isIdentifier(n)) return GLOBALS.has(n.text) || n.text === 'undefined' ? null : n.text;
    if (n.kind === ts.SyntaxKind.ThisKeyword) return 'this';
    if (ts.isPropertyAccessExpression(n)) {
      n = unwrap(n.expression);
      continue;
    }
    if (
      ts.isElementAccessExpression(n) &&
      (ts.isIdentifier(n.argumentExpression) || ts.isStringLiteral(n.argumentExpression) || ts.isNumericLiteral(n.argumentExpression))
    ) {
      n = unwrap(n.expression);
      continue;
    }
    return null;
  }
  return null;
}

/** Built-in container a declaration creates or declares: `[]`, `T[]`,
 *  `Array<T>`, `new Map()`, `Set<T>`, … — so its methods get a typed name. */
function containerType(init: ts.Expression, type: ts.TypeNode | undefined): string | null {
  if (ts.isArrayLiteralExpression(init)) return 'Array';
  if (ts.isNewExpression(init)) {
    const c = pathText(init.expression);
    if (CONTAINER_TYPES.has(c)) return c;
  }
  if (type) {
    if (ts.isArrayTypeNode(type)) return 'Array';
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      const t = type.typeName.text === 'ReadonlyArray' ? 'Array' : type.typeName.text;
      if (CONTAINER_TYPES.has(t)) return t;
    }
  }
  return null;
}

const CONTAINER_TYPES = new Set(['Array', 'Map', 'Set', 'WeakMap', 'WeakSet']);
