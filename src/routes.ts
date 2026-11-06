// File-system route conventions (coverage wave 1 §3.3): which files ARE an
// HTTP surface, under which URL template, and which handler parameters carry
// the request. One table for every meta-framework the frontend knows, so the
// next convention is one row, not another special case in the analyzer.
//
//   SvelteKit        src/routes/**/+server.{ts,js}   verb exports    [0]     (event)
//   Next App Router  {src/,}app/**/route.*            verb exports    [0, 1]  (request, ctx)
//   Next Pages API   {src/,}pages/api/**              default export  [0]     (req)
//   Next page        {src/,}app/**/page.*             default export  [0]     ({params, searchParams})
//
// Server Actions (`'use server'`) are invoked by direct import, which the checker
// already resolves to a STATIC call, so they are an Endpoint with every parameter
// untrusted and no route; the analyzer marks them, this module only says where
// the directive is.
//
// Next.js conventions apply only to a repo that looks like Next (a `next`
// dependency or a `next.config.*` at the root): an arbitrary `app/` folder is
// never reinterpreted.
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import { canonPath } from './http.js';

export interface RouteDecl {
  /** upper case; `*` = any method (a Pages API handler serves them all) */
  method: string;
  /** canonical template (§1.1) — the contract key */
  path: string;
  /** as derived from the file path, `/api/users/[id]` — reporting only; it
   *  also names the contract endpoint, which several handlers can share */
  display: string;
  /** this handler's own row display when it differs from `display`
   *  (`/a/__data.json +layout.server.ts load`, `/a?/save`) */
  label?: string;
  framework: string;
  /** handler parameter indices that carry request data */
  requestParams: number[];
}

/** how a route file's handlers are found */
export type RouteHandlers = 'verbs' | 'default';

export interface RouteFile {
  framework: string;
  display: string;
  handlers: RouteHandlers;
  /** the method of a `default` handler (`*` for an API handler, GET for a page) */
  method: string;
  requestParams: number[];
  /** a `default` handler's parameter count — picks it out of a wrapper's arguments */
  arity: number;
}

const NEXT_CONFIG = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts', 'next.config.mts'];

/** a `next` dependency, or a `next.config.*` beside package.json */
export function looksLikeNext(repoDir: string, deps: ReadonlySet<string>): boolean {
  return deps.has('next') || NEXT_CONFIG.some((f) => fs.existsSync(path.join(repoDir, f)));
}

/**
 * Next App Router segments -> the URL path, or null when the file is not
 * routable: a `_private` folder (and everything under it) and an intercepting
 * route `(.)x` / `(..)x` / `(...)x` (it re-renders another route) have no URL of
 * their own. A `(group)` and a parallel-route `@slot` contribute no segment;
 * `%5F` is the escape for a literal leading underscore.
 */
function nextAppPath(segs: string[]): string | null {
  const out: string[] = [];
  for (const s of segs) {
    if (s.startsWith('_')) return null;
    if (/^\(\.{1,3}\)/.test(s)) return null;
    if (/^\(.*\)$/.test(s) || s.startsWith('@')) continue;
    out.push(s.replace(/^%5F/i, '_'));
  }
  return '/' + out.join('/');
}

/** which Next.js route roots exist at the repository root (not under `src/`) */
export interface NextRoots {
  app: boolean;
  pages: boolean;
}

/** Next.js serves a root `app/` (`pages/`) and then ignores `src/app` (`src/pages`) */
export function nextRoots(repoDir: string): NextRoots {
  const dir = (d: string): boolean => {
    try {
      return fs.statSync(path.join(repoDir, d)).isDirectory();
    } catch {
      return false;
    }
  };
  return { app: dir('app'), pages: dir('pages') };
}

/** The route a file is, under the conventions that apply to this repo. */
export function routeFileOf(
  rel: string,
  next: boolean,
  roots: NextRoots = { app: false, pages: false },
): RouteFile | null {
  const base = path.posix.basename(rel);
  const dirSegs = path.posix.dirname(rel).split('/').filter((s) => s && s !== '.');
  const svelteDisplay = svelteKitPath(rel);
  if (/^\+server\.[jt]s$/.test(base) && svelteDisplay !== null) {
    return {
      framework: 'sveltekit',
      display: svelteDisplay,
      handlers: 'verbs',
      method: '',
      requestParams: [0],
      arity: 0,
    };
  }
  if (!next) return null;
  const root = dirSegs[0] === 'src' ? 1 : 0;
  // a root `app/`/`pages/` shadows its `src/` twin: those files serve no URL
  if (root === 1 && ((dirSegs[1] === 'app' && roots.app) || (dirSegs[1] === 'pages' && roots.pages))) {
    return null;
  }
  if (dirSegs[root] === 'app') {
    const kind = /^route\.(ts|js|mjs|tsx|jsx)$/.test(base)
      ? 'route'
      : /^page\.(tsx|ts|jsx|js)$/.test(base)
        ? 'page'
        : null;
    if (!kind) return null;
    const p = nextAppPath(dirSegs.slice(root + 1));
    if (p === null) return null;
    return kind === 'route'
      ? { framework: 'next-app', display: p, handlers: 'verbs', method: '', requestParams: [0, 1], arity: 0 }
      : { framework: 'next-page', display: p, handlers: 'default', method: 'GET', requestParams: [0], arity: 1 };
  }
  if (dirSegs[root] === 'pages' && dirSegs[root + 1] === 'api') {
    const m = /^(.+)\.(ts|js|mjs|tsx|jsx)$/.exec(base);
    if (!m || m[1]!.startsWith('_')) return null;
    const segs = [...dirSegs.slice(root + 1), m[1]!];
    if (segs[segs.length - 1] === 'index') segs.pop();
    return {
      framework: 'next-pages-api',
      display: '/' + segs.join('/'),
      handlers: 'default',
      method: '*',
      requestParams: [0],
      arity: 2,
    };
  }
  return null;
}

/** SvelteKit: the directory under `src/routes` IS the path; `(group)` is pathless */
function svelteRouteOfDir(dir: string): string | null {
  const dirSegs = dir.split('/').filter((s) => s && s !== '.');
  if (dirSegs[0] !== 'src' || dirSegs[1] !== 'routes') return null;
  return '/' + dirSegs.slice(2).filter((s) => !/^\(.*\)$/.test(s)).join('/');
}

/** the URL a SvelteKit route file is mounted at, or null when it is not one */
export function svelteKitPath(rel: string): string | null {
  return svelteRouteOfDir(path.posix.dirname(rel));
}

/**
 * The directories under `src/routes` that ARE a page — the ones whose
 * `<dir>/__data.json` SvelteKit actually serves. Any `+page` file makes the
 * directory a route: `+page.svelte`, `+page.ts`/`.js`, or `+page.server.ts`/`.js`
 * (a directory with only `+page.server.ts` still answers its `__data.json`).
 */
export function svelteKitPageDirs(files: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (!/^\+page\./.test(path.posix.basename(f))) continue;
    const dir = path.posix.dirname(f);
    if (svelteRouteOfDir(dir) !== null) out.add(dir);
  }
  return out;
}

function loadRoute(route: string, file: string): RouteDecl {
  const display = route === '/' ? '/__data.json' : `${route}/__data.json`;
  return {
    method: 'GET',
    path: canonPath(display),
    display,
    label: `${display} ${file} load`,
    framework: 'sveltekit-load',
    requestParams: [0],
  };
}

/**
 * The routes a SvelteKit page endpoint is served at. `sym` is a server `load`
 * (`+page.server` or `+layout.server`) or an `actions.<name>` member
 * (`+page.server`), as the analyzer already accepted it. `pageDirs` is
 * `svelteKitPageDirs(repo.files)` — the directories that ARE a page.
 *  - `load`: the client fetches its data as `GET <route>/__data.json`. A layout
 *    and a page in one route directory share that URL, so they share one
 *    contract. In a directory with no `+page` file at all, `<dir>/__data.json`
 *    is served by nothing: a LAYOUT load only runs as part of each descendant
 *    page's own `__data.json` request, so it is attached to every descendant
 *    page directory's URL (route groups `(x)` are pathless, a nested
 *    `+layout@` reset or a child page is still a descendant) — one contract
 *    per URL, so the descendant URL's contract carries the page load AND every
 *    ancestor layout load. With no descendant page, the layout load is served
 *    nowhere and no route is emitted.
 *  - an action: `POST <route>`; a named action is `?/<name>` on the same URL,
 *    and the query is not part of the contract path.
 */
export function svelteKitPageRoute(rel: string, sym: string, pageDirs: ReadonlySet<string>): RouteDecl[] {
  const dir = path.posix.dirname(rel);
  const route = svelteRouteOfDir(dir);
  if (route === null) return [];
  const file = path.posix.basename(rel);
  if (sym === 'load') {
    if (pageDirs.has(dir)) return [loadRoute(route, file)];
    // a page-less directory is not a route; only a layout load still runs —
    // inside each descendant page's own data request
    if (!/^\+layout\./.test(file)) return [];
    return [...pageDirs]
      .filter((d) => d.startsWith(`${dir}/`))
      .sort()
      .map((d) => loadRoute(svelteRouteOfDir(d)!, file));
  }
  const m = /^actions\.(.+)$/.exec(sym);
  if (!m || !pageDirs.has(dir)) return [];
  const name = m[1]!;
  return [
    {
      method: 'POST',
      path: canonPath(route),
      display: route,
      label: name === 'default' ? route : `${route}?/${name}`,
      framework: 'sveltekit-action',
      requestParams: [0],
    },
  ];
}

export function routeDecl(f: RouteFile, method: string): RouteDecl {
  return {
    method,
    path: canonPath(f.display),
    display: f.display,
    framework: f.framework,
    requestParams: f.requestParams,
  };
}

/** the directive prologue of a module or function body says `text` */
export function hasDirective(stmts: readonly ts.Statement[], text: string): boolean {
  for (const st of stmts) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) return false;
    if (st.expression.text === text) return true;
  }
  return false;
}
