// MR-mode diff manifest. mr mode still extracts the working tree as in main
// mode (the core's summary cache makes reuse content-addressed, not
// manifest-driven); the manifest only tells the core WHICH functions the MR
// touched, for the changed_functions list and chain classification in the
// impact report. The JSON form matches the Go frontend's `manifest.json`
// (`internal/emit/manifest.go` in panoptife-go): the Rust core reads `base`,
// `head`, `changed_files` and `changed_fns{iid, bid, fqn, file}` from it.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { UserError } from './errors.js';
import { hex } from './hash.js';
import type { Fn } from './model.js';

export interface ChangedFn {
  iid: string;
  bid: string;
  fqn: string;
  /** repo-relative, "/" separators */
  file: string;
}

export interface Manifest {
  mode: string;
  base: string;
  head: string;
  changed_files: string[];
  changed_fns: ChangedFn[];
}

export const manifestName = 'manifest.json';

/** `git -C <repoDir> diff --name-only --relative <base> <head>`; `--relative`
 *  handles repoDir being a subdir of the git toplevel (a monorepo checkout). */
export function changedFiles(repoDir: string, base: string, head: string): string[] {
  let out: Buffer;
  try {
    out = execFileSync('git', ['-C', repoDir, 'diff', '--name-only', '--relative', base, head], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stderr?: Buffer; message: string };
    const detail = err.stderr?.toString().trim() || err.message;
    throw new UserError(`git diff ${base}..${head} in ${repoDir}: ${detail}`);
  }
  return out
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** every emitted function whose span file is one of `files` (the same
 *  file-level rule as the Go frontend). Spans are repo-relative already; a
 *  deleted file has no functions at head, so it appears in changed_files only. */
export function changedFns(files: string[], fns: readonly Fn[]): ChangedFn[] {
  const changed = new Set(files);
  const out: ChangedFn[] = [];
  for (const f of fns) {
    const file = f.span?.file;
    if (!file || !changed.has(file)) continue;
    out.push({ iid: hex(f.id.iid), bid: hex(f.id.bid), fqn: f.fqn, file });
  }
  return out;
}

export function buildManifest(
  mode: string,
  base: string,
  head: string,
  files: string[],
  fns: readonly Fn[],
): Manifest {
  return { mode, base, head, changed_files: files, changed_fns: changedFns(files, fns) };
}

/** Written next to the .pb files; the core's loader reads *.pb only, so the
 *  name never collides. */
export function writeManifest(outDir: string, m: Manifest): void {
  fs.writeFileSync(path.join(outDir, manifestName), JSON.stringify(m, null, 2));
}

/** mr mode analyzes the working tree and trusts it is checked out at --head;
 *  --base is only an input to the diff. CI checkouts satisfy this; warn when
 *  they do not. Git trouble here is silent, as in the Go frontend. */
export function warnIfNotHead(repoDir: string, head: string): void {
  const rev = (arg: string): string | null => {
    try {
      return execFileSync('git', ['-C', repoDir, 'rev-parse', arg], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  const cur = rev('HEAD');
  const want = rev(`${head}^{commit}`);
  if (!cur || !want || cur === want) return;
  process.stderr.write(
    `warning: working tree HEAD ${cur.slice(0, 8)} != --head ${want.slice(0, 8)}; extraction reflects the working tree\n`,
  );
}
