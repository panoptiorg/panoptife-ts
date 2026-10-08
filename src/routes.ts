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
  /** as derived from the file path, `/api/users/[id]` — reporting only */
  display: string;
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
  // SvelteKit: the directory under src/routes IS the path; `(group)` is pathless
  if (/^\+server\.[jt]s$/.test(base) && dirSegs[0] === 'src' && dirSegs[1] === 'routes') {
    const segs = dirSegs.slice(2).filter((s) => !/^\(.*\)$/.test(s));
    return {
      framework: 'sveltekit',
      display: '/' + segs.join('/'),
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
