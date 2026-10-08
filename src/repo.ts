// Repo layout: source walk, path aliases, git commit, schema location.
// Everything here is derived syntactically and works without the target's
// node_modules (the walk skips it): `svelte.config.{js,ts,mjs}` is parsed,
// never executed.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.svelte']);
/** coverage wave 1 §3.1: React code also lives in `.jsx`, and CommonJS
 *  modules in `.cjs`. Joined to the walk with JSX on (`--no-jsx` keeps the
 *  previous walk byte for byte). */
const SRC_EXT_JSX = new Set([...SRC_EXT, '.jsx', '.cjs']);
const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  '.svelte-kit',
  'dist',
  'build',
  'coverage',
  '__tests__',
  '__mocks__',
  '.turbo',
  '.vercel',
]);

export interface RepoInfo {
  dir: string;
  repoId: string;
  commitSha: string;
  /** absolute paths, sorted */
  files: string[];
  /** src root (absolute) — package paths are relative to the repo dir */
  alias: Array<{ prefix: string; target: string }>;
  schemaPaths: string[];
  /** `.tsx`/`.jsx` (and `index.tsx`/`index.jsx`) are import candidates — the
   *  `--no-jsx` switch (coverage wave 1 §3.1) */
  jsx: boolean;
}

export interface LoadOpts {
  /** coverage wave 1 §3.1 — walk `.jsx`/`.cjs`, resolve imports to `.tsx`/`.jsx` */
  jsx?: boolean;
  /** coverage wave 1 §3.3 — top-level directories walked even when `src/`
   *  exists (Next.js serves a root `app/`/`pages/` over `src/app`) */
  extraRoots?: string[];
}

function isTestFile(rel: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) ||
    rel.includes('/__tests__/') ||
    rel.includes('/__mocks__/') ||
    rel.startsWith('tests/')
  );
}

/** Deterministic depth-first walk with sorted entries. */
export function walk(root: string, rel = '', ext: ReadonlySet<string> = SRC_EXT): string[] {
  const out: string[] = [];
  const abs = rel ? path.join(root, rel) : root;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
      out.push(...walk(root, r, ext));
    } else if (e.isFile()) {
      if (!ext.has(path.extname(e.name))) continue;
      if (e.name.endsWith('.d.ts')) continue;
      if (isTestFile(r)) continue;
      out.push(r);
    }
  }
  return out;
}

function gitSha(dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Pull `kit.alias` string literals out of svelte.config.{js,ts} without running it. */
function svelteAliases(dir: string): Array<{ prefix: string; target: string }> {
  const out: Array<{ prefix: string; target: string }> = [];
  for (const name of ['svelte.config.js', 'svelte.config.ts', 'svelte.config.mjs']) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (
        ts.isPropertyAssignment(n) &&
        (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
        n.name.text === 'alias' &&
        ts.isObjectLiteralExpression(n.initializer)
      ) {
        for (const pr of n.initializer.properties) {
          if (!ts.isPropertyAssignment(pr)) continue;
          const key = ts.isIdentifier(pr.name)
            ? pr.name.text
            : ts.isStringLiteral(pr.name)
              ? pr.name.text
              : null;
          if (key && ts.isStringLiteral(pr.initializer)) {
            out.push({ prefix: key, target: pr.initializer.text.replace(/^\.\//, '') });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    break;
  }
  return out;
}

/**
 * `compilerOptions.paths` from tsconfig.json AND its relative `extends` chain.
 * SvelteKit generates `.svelte-kit/tsconfig.json` and puts EVERY project alias
 * there (`$gatewayService`, `$shared`, `$apps`, …) — the repo's own tsconfig
 * only extends it. Skipping that file is what left a project alias such as
 * `$gatewayService/core/client` unresolved (checker resolution). Paths are
 * resolved against the declaring file's own directory, then made repo-relative;
 * anything outside the repo is dropped. Package `extends` (node_modules) is not
 * followed — those never carry in-repo paths.
 */
function tsconfigAliases(dir: string): Array<{ prefix: string; target: string }> {
  const out: Array<{ prefix: string; target: string }> = [];
  const seen = new Set<string>();
  const visit = (file: string, depth: number): void => {
    if (depth > 5 || seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    let cfg: Record<string, unknown>;
    try {
      cfg = (ts.parseConfigFileTextToJson(file, fs.readFileSync(file, 'utf8')).config ??
        {}) as Record<string, unknown>;
    } catch {
      return;
    }
    const co = (cfg.compilerOptions ?? {}) as Record<string, unknown>;
    const base = path.resolve(path.dirname(file), (co.baseUrl as string | undefined) ?? '.');
    const paths = (co.paths ?? {}) as Record<string, string[]>;
    for (const k of Object.keys(paths).sort()) {
      const v = paths[k]?.[0];
      if (!v) continue;
      const abs = path.resolve(base, v.replace(/\/?\*$/, ''));
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      out.push({ prefix: k.replace(/\/?\*$/, ''), target: rel });
    }
    const ext = cfg.extends;
    for (const e of Array.isArray(ext) ? ext : ext ? [ext] : []) {
      if (typeof e !== 'string' || !e.startsWith('.')) continue;
      visit(path.resolve(path.dirname(file), e.endsWith('.json') ? e : e + '.json'), depth + 1);
    }
  };
  visit(path.join(dir, 'tsconfig.json'), 0);
  return out;
}

const DEFAULT_ALIAS = [
  { prefix: '$lib', target: 'src/lib' },
  { prefix: '$app', target: '<virtual>' }, // never in-repo; stays opaque
];

export function findSchemas(dir: string, explicit: string[]): string[] {
  if (explicit.length) return explicit.map((s) => path.resolve(s));
  const out: string[] = [];
  for (const c of ['schema.graphql', 'schema.gql', 'schema.graphqls']) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) out.push(p);
  }
  if (out.length) return out;
  // .graphqlrc.yml / codegen.yaml may name a local snapshot
  for (const c of ['.graphqlrc.yml', '.graphqlrc.yaml', 'codegen.yaml', 'codegen.yml']) {
    const p = path.join(dir, c);
    if (!fs.existsSync(p)) continue;
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/([\w./-]+\.graphqls?)/g)) {
      const cand = path.join(dir, m[1]!);
      if (fs.existsSync(cand) && !out.includes(cand)) out.push(cand);
    }
  }
  return out;
}

export function loadRepo(
  dir: string,
  repoId: string | undefined,
  schemas: string[],
  opts: LoadOpts = {},
): RepoInfo {
  const jsx = opts.jsx ?? true;
  const abs = path.resolve(dir);
  const alias: Array<{ prefix: string; target: string }> = [];
  const havePrefix = new Set<string>();
  for (const a of [...svelteAliases(abs), ...tsconfigAliases(abs), ...DEFAULT_ALIAS]) {
    if (havePrefix.has(a.prefix)) continue; // first declaration wins, deterministically
    havePrefix.add(a.prefix);
    alias.push(a);
  }
  // longest prefix first so `$gatewayService` beats `$g`
  alias.sort((a, b) => b.prefix.length - a.prefix.length || (a.prefix < b.prefix ? -1 : 1));
  const roots = fs.existsSync(path.join(abs, 'src')) ? ['src'] : [''];
  if (roots[0] === 'src') {
    for (const r of opts.extraRoots ?? []) {
      if (fs.existsSync(path.join(abs, r)) && !roots.includes(r)) roots.push(r);
    }
  }
  const files: string[] = [];
  for (const r of roots) files.push(...walk(abs, r, jsx ? SRC_EXT_JSX : SRC_EXT));
  files.sort();
  return {
    dir: abs,
    repoId: repoId || path.basename(abs),
    commitSha: gitSha(abs),
    files,
    alias,
    schemaPaths: findSchemas(abs, schemas),
    jsx,
  };
}

/** Resolve an import specifier to a repo-relative file, or null if external. */
export function resolveImport(
  repo: RepoInfo,
  fromRel: string,
  spec: string,
  exists: (rel: string) => boolean,
): string | null {
  let base: string | null = null;
  if (spec.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  } else {
    for (const a of repo.alias) {
      if (spec === a.prefix || spec.startsWith(a.prefix + '/')) {
        if (a.target.startsWith('<')) return null;
        base = path.posix.normalize(a.target + spec.slice(a.prefix.length));
        break;
      }
    }
  }
  if (base === null) return null;
  const cands = [
    base,
    base + '.ts',
    base + '.js',
    base + '.svelte',
    base + '.svelte.ts',
    base + '/index.ts',
    base + '/index.js',
    base + '/index.svelte.ts',
  ];
  // Appended, never interleaved: a specifier that resolved before resolves to
  // the same file; only one that used to stay opaque (`./Child` -> Child.tsx)
  // gains a target.
  if (repo.jsx) {
    cands.push(base + '.tsx', base + '.jsx', base + '/index.tsx', base + '/index.jsx');
  }
  for (const c of cands) if (exists(c)) return c;
  return null;
}
