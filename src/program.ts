// A `ts.Program` over the repo's OWN sources only (a deliberate deviation).
//
// The design constraint stays: the target repo has NO `node_modules`. We get a
// real binder/checker anyway by owning module resolution ourselves —
// `resolveModuleNameLiterals` maps a specifier to a repo-relative file with the
// same rules the syntactic resolver used (relative, `tsconfig.paths`,
// `kit.alias`, index/extension candidates) and returns `undefined` for anything
// outside the repo. An unresolved import therefore has no symbol at all, which
// is exactly the "stays opaque" contract.
//
// `.svelte` files enter the program as in-memory units under a virtual
// `<file>.svelte.__pc.ts` name carrying `svelte.ts`'s lowered script; the
// virtual suffix can never collide with a real repo file (`.svelte.ts` runes
// modules included) and module resolution never has to guess it because we
// resolve `./Foo.svelte` to it explicitly.
//
// No lib, no @types, no JSON: the checker's job here is symbol resolution
// (aliases, re-exports, object-literal properties), not type correctness.
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import { resolveImport, type RepoInfo } from './repo.js';
import type { SvelteMap } from './svelte.js';

/** virtual name suffix for a lowered .svelte unit */
export const SVELTE_SUFFIX = '.__pc.ts';

export interface SourceUnit {
  /** repo-relative path of the real file */
  rel: string;
  /** absolute name inside the program (virtual for .svelte) */
  fileName: string;
  text: string;
  svelte: boolean;
  /** .svelte only: lowered offset -> original offset */
  map?: SvelteMap;
}

export interface RepoProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** rel -> the program's SourceFile */
  byRel: Map<string, ts.SourceFile>;
  /** ms spent in createProgram + getTypeChecker */
  wallMs: number;
  /** the repo's node_modules was found and its .d.ts are in the program */
  typed: boolean;
  /** source files pulled in from node_modules */
  externalFiles: number;
}

function scriptKindFor(rel: string, svelte: boolean): ts.ScriptKind {
  if (svelte) return ts.ScriptKind.TS;
  if (rel.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (rel.endsWith('.js') || rel.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function virtualName(repoDir: string, rel: string): string {
  const abs = path.join(repoDir, rel);
  return rel.endsWith('.svelte') ? abs + SVELTE_SUFFIX : abs;
}

/**
 * Two modes:
 *  - **untyped** (no `node_modules` in the target): `noLib`, `types: []`, and
 *    module resolution that only ever answers with a repo file. External imports
 *    have no symbol, which is the "stays opaque" contract.
 *  - **typed** (`node_modules` present): real `lib`/`@types`, and unresolved
 *    in-repo specifiers fall through to `ts.resolveModuleName` — but ONLY `.d.ts`
 *    answers are accepted, so an untyped dependency stays opaque instead of
 *    dragging its whole JS implementation into the program.
 */
function optionsFor(typed: boolean): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    noResolve: false,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    allowNonTsExtensions: true,
    noEmit: true,
    isolatedModules: false,
    disableSourceOfProjectReferenceRedirect: true,
  };
  if (typed) return { ...base, resolveJsonModule: false };
  return { ...base, types: [], noLib: true };
}

/**
 * Build the program. `units` must be in the deterministic (sorted) walk order —
 * root order is the only order the checker can leak into declaration lists.
 */
export function createRepoProgram(repo: RepoInfo, units: SourceUnit[]): RepoProgram {
  const t0 = Date.now();
  const typed = fs.existsSync(path.join(repo.dir, 'node_modules'));
  const OPTIONS = optionsFor(typed);
  let externalFiles = 0;
  const byName = new Map<string, SourceUnit>();
  for (const u of units) byName.set(u.fileName, u);
  const relOf = new Map<string, string>();
  for (const u of units) relOf.set(u.fileName, u.rel);
  const inRepo = new Set(units.map((u) => u.rel));

  const cache = new Map<string, ts.SourceFile | undefined>();
  const getSourceFile = (fileName: string): ts.SourceFile | undefined => {
    if (cache.has(fileName)) return cache.get(fileName);
    const u = byName.get(fileName);
    let sf: ts.SourceFile | undefined;
    if (u) {
      sf = ts.createSourceFile(
        fileName,
        u.text,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        scriptKindFor(u.rel, u.svelte),
      );
    } else if (typed) {
      // lib.d.ts, @types, and the `.d.ts` of a real dependency
      let text: string | undefined;
      try {
        text = fs.readFileSync(fileName, 'utf8');
      } catch {
        text = undefined;
      }
      if (text !== undefined) {
        externalFiles++;
        sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
      }
    }
    cache.set(fileName, sf);
    return sf;
  };

  const mrHost: ts.ModuleResolutionHost = {
    fileExists: (f) => byName.has(f) || fs.existsSync(f),
    readFile: (f) => byName.get(f)?.text ?? (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined),
    directoryExists: (d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    },
    realpath: (f) => f,
    getCurrentDirectory: () => repo.dir,
  };
  const extCache = new Map<string, ts.ResolvedModuleFull | undefined>();

  const resolveOne = (spec: string, containingFile: string): ts.ResolvedModuleFull | undefined => {
    const fromRel = relOf.get(containingFile);
    if (fromRel !== undefined) {
      const rel = resolveImport(repo, fromRel, spec, (r) => inRepo.has(r));
      if (rel) {
        return {
          resolvedFileName: virtualName(repo.dir, rel),
          extension: rel.endsWith('.tsx') ? ts.Extension.Tsx : ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }
    }
    if (!typed) return undefined;
    // a real dependency: accept its TYPES only (never its JS implementation)
    const dir = path.dirname(containingFile);
    const key = `${dir}\u0000${spec}`;
    if (extCache.has(key)) return extCache.get(key);
    let out: ts.ResolvedModuleFull | undefined;
    try {
      const r = ts.resolveModuleName(spec, containingFile, OPTIONS, mrHost).resolvedModule;
      if (r && r.resolvedFileName.endsWith('.d.ts')) out = r;
    } catch {
      out = undefined;
    }
    extCache.set(key, out);
    return out;
  };

  const host: ts.CompilerHost = {
    getSourceFile,
    getDefaultLibFileName: (o) => (typed ? ts.getDefaultLibFilePath(o) : 'lib.d.ts'),
    writeFile: () => {},
    getCurrentDirectory: () => repo.dir,
    getDirectories: (d) => {
      try {
        return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
      } catch {
        return [];
      }
    },
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => byName.has(f) || (typed && fs.existsSync(f)),
    readFile: (f) => mrHost.readFile(f),
    realpath: (f) => f,
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((l) => ({ resolvedModule: resolveOne(l.text, containingFile) })),
    // TS still prefers `resolveModuleNames` when present; keep both so the
    // behaviour does not depend on the compiler's internal preference order.
    resolveModuleNames: (names, containingFile) =>
      names.map((nm) => resolveOne(nm, containingFile)),
    resolveTypeReferenceDirectiveReferences: (refs) =>
      refs.map(() => ({ resolvedTypeReferenceDirective: undefined })),
  };

  const program = ts.createProgram({
    rootNames: units.map((u) => u.fileName),
    options: OPTIONS,
    host,
  });
  const checker = program.getTypeChecker();
  const byRel = new Map<string, ts.SourceFile>();
  for (const u of units) {
    const sf = program.getSourceFile(u.fileName);
    if (sf) byRel.set(u.rel, sf);
  }
  return { program, checker, byRel, wallMs: Date.now() - t0, typed, externalFiles };
}
