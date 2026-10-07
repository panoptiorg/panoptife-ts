// Per-repo extraction: files -> FnSpecs -> LocalFlow -> CgfPackages.
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import { CallKind, EndpointKind, SCHEMA_VERSION, VertexKind, type CgfCodec } from './cgf.js';
import { FlowBuilder } from './flow.js';
import { analyzeDocument, type OpDoc } from './gqlop.js';
import { contractIID, endpointIID, field, fnIID } from './hash.js';
import type { CallSite, CgfPackage, Endpoint, Fn, Span } from './model.js';
import { loadAdapters, repoDeps, AdapterSet, type HandlerRule, type InvokeRule } from './adapter.js';
import {
  assignSinkName,
  CTOR_TYPES,
  GLOBALS,
  IDENTITY_HOFS,
  pathText,
  receiverName,
  ROUTE_SOURCE_CALLS,
  RUNE_ROOTS,
  sourceReadName,
  unwrap,
} from './naming.js';
import { createRepoProgram, virtualName, type SourceUnit } from './program.js';
import { loadRepo, resolveImport, type RepoInfo } from './repo.js';
import { loadSdl, type Sdl } from './sdl.js';
import { lowerSvelte, mapSveltePos, type SvelteMap } from './svelte.js';
import { createHash } from 'node:crypto';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

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

function parseFile(
  rel: string,
  sf: ts.SourceFile,
  svelte: boolean,
  sdl: Sdl,
  stats: Stats,
  ad: AdapterSet,
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
          const cb = callbackBody(init);
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
      if (shape && nm && called.has(nm) && !seen.has(nm) && !unit.byName.has(nm)) {
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
    args.forEach((a, i) => {
      const port = this.fb.addVertex(VertexKind.CALL_ARG_PORT, i, cs);
      const av = this.expr(a);
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
    // a `bind:` result is the form value the framework hands to the callback
    if (r.calleeFqn === 'svelte:bind') this.fb.flow(v, this.bound());
    this.typeAnchor(n, r, args, argVals, v);
    return v;
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
        if (s.expression) this.fb.sink(this.expr(s.expression), this.fb.returnVertex());
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
    else if (ts.isExpression(body as ts.Expression))
      this.fb.sink(this.expr(body as ts.Expression), this.fb.returnVertex());
  }
}

// ---------------------------------------------------------------------------
// function builders
// ---------------------------------------------------------------------------

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
  if (spec.endpoint) {
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
  const repo = loadRepo(opts.repoDir, opts.repoId, opts.schemas ?? []);
  // Client-library knowledge is DATA (adapters): the core alone knows nothing
  // about how a document becomes a callable.
  const ad = loadAdapters({
    repoDir: opts.repoDir,
    adapters: opts.adapters,
    none: opts.noAdapters,
    routes: opts.adapterRoutes,
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
            : ts.ScriptKind.JS,
      );
    const u = parseFile(u0.rel, sf, u0.svelte, sdl, em.stats, ad, u0.map);
    if (!u) continue;
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
    const bytes = opts.codec.encodePackage(cp);
    fs.writeFileSync(path.join(opts.outDir, sanitize(p) + '.pb'), bytes);
  }
  emitEmptyOutputWarnings(repo, opts, ad, em.stats);
  return em.stats;
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
      `warning: ${stats.endpoints} endpoints and ${stats.ops} operations emitted — nothing in this ` +
        `repo is an input surface the tool recognises (SvelteKit route exports, or adapter ` +
        `handler routes); a Go/TS corpus built from it will produce no chains rooted here\n`,
    );
  }
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
