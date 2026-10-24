// MR mode: --mode/--base/--head, manifest.json form, and the file-level rule.
// Every test builds its own git repository; no fixture repo is reused, because
// a manifest is defined by a diff between two commits.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';

const require_ = createRequire(import.meta.url);
const protobuf = require_('protobufjs') as typeof import('protobufjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

interface ChangedFn {
  iid: string;
  bid: string;
  fqn: string;
  file: string;
}
interface Manifest {
  mode: string;
  base: string;
  head: string;
  changed_files: string[];
  changed_fns: ChangedFn[];
}

const TS_V1 = `export function alpha(x: string): string {
  return x.trim();
}
export function stable(y: string): string {
  return y.toUpperCase();
}
`;
const TS_V2 = `export function alpha(x: string): string {
  return x.trim() + '!';
}
export function stable(y: string): string {
  return y.toUpperCase();
}
`;
const SVELTE_V1 = `<script lang="ts">
  export let name: string;
  const shout = () => name.toUpperCase();
</script>
<p>{shout()}</p>
`;
const SVELTE_V2 = `<script lang="ts">
  export let name: string;
  const shout = () => name.toUpperCase() + '!';
</script>
<p>{shout()}</p>
`;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fe-ts-mr-'));
}

/** One git command in `dir`, with an identity so commits never need config. */
function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim();
}

/** A git repository with `files` committed as its first commit. */
function initRepo(files: Record<string, string>): { dir: string; base: string } {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  writeAll(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

function writeAll(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

/** Run the CLI with stdout and stderr captured. */
function cli(...argv: string[]): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => ((err += String(c)), true));
  try {
    return { code: main(argv), out, err };
  } finally {
    vi.restoreAllMocks();
  }
}

interface DecodedFn {
  iid: string;
  bid: string;
  fqn: string;
  file: string;
}

/** Decode every function of the run's own CGF output: iid/bid hex, fqn, span file. */
function decodedFns(outDir: string): DecodedFn[] {
  const root = protobuf.loadSync(path.join(ROOT, 'proto', 'cgf.proto'));
  const Pkg = root.lookupType('panopticode.cgf.CgfPackage');
  const fns: DecodedFn[] = [];
  for (const f of fs.readdirSync(outDir).sort()) {
    if (!f.endsWith('.pb')) continue;
    const msg = Pkg.decode(fs.readFileSync(path.join(outDir, f)));
    const obj = Pkg.toObject(msg, { bytes: Buffer, defaults: true }) as {
      functions: Array<{ id: { iid: Buffer; bid: Buffer }; fqn: string; span: { file: string } }>;
    };
    for (const fn of obj.functions) {
      fns.push({
        iid: fn.id.iid.toString('hex'),
        bid: fn.id.bid.toString('hex'),
        fqn: fn.fqn,
        file: fn.span.file,
      });
    }
  }
  return fns;
}

function mr(dir: string, out: string, base: string, head: string, ...extra: string[]): number {
  return cli('build', dir, '--out', out, '--quiet', '--mode', 'mr', '--base', base, '--head', head, ...extra).code;
}

function readManifest(out: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')) as Manifest;
}

afterEach(() => vi.restoreAllMocks());

describe('mr mode', () => {
  it('lists the changed files and exactly the functions declared in them, with the run\'s CGF ids', () => {
    const { dir, base } = initRepo({ 'src/lib.ts': TS_V1, 'src/page.svelte': SVELTE_V1 });
    writeAll(dir, { 'src/lib.ts': TS_V2, 'src/page.svelte': SVELTE_V2 });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'head');
    const head = git(dir, 'rev-parse', 'HEAD');
    const out = path.join(tmp(), 'out');

    expect(mr(dir, out, base, head)).toBe(0);

    const m = readManifest(out);
    expect(m.mode).toBe('mr');
    expect(m.base).toBe(base);
    expect(m.head).toBe(head);
    expect([...m.changed_files].sort()).toEqual(['src/lib.ts', 'src/page.svelte']);

    // the file-level rule: every function of the CGF whose span file changed,
    // and nothing else — ids byte-equal to the same run's CGF
    const fromCgf = decodedFns(out).filter((f) => m.changed_files.includes(f.file));
    expect(m.changed_fns.map((c) => `${c.fqn}@${c.iid}@${c.bid}@${c.file}`).sort()).toEqual(
      fromCgf.map((f) => `${f.fqn}@${f.iid}@${f.bid}@${f.file}`).sort(),
    );
    const fqns = m.changed_fns.map((c) => c.fqn);
    expect(fqns).toContain('src/lib.ts:alpha');
    expect(fqns).toContain('src/page.svelte:$script');
  });

  it('contains a deleted file and a renamed file, with functions only from the surviving name', () => {
    const { dir, base } = initRepo({
      'src/keep.ts': 'export function keep(): number {\n  return 1;\n}\n',
      'src/gone.ts': 'export function gone(): number {\n  return 2;\n}\n',
      'src/old-name.ts': 'export function moved(): number {\n  return 3;\n}\n',
    });
    fs.rmSync(path.join(dir, 'src/gone.ts'));
    fs.renameSync(path.join(dir, 'src/old-name.ts'), path.join(dir, 'src/new-name.ts'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'drop and rename');
    const head = git(dir, 'rev-parse', 'HEAD');
    const out = path.join(tmp(), 'out');

    expect(mr(dir, out, base, head)).toBe(0);

    const m = readManifest(out);
    expect(m.changed_files).toContain('src/gone.ts');
    expect(m.changed_files).toContain('src/new-name.ts');
    const files = m.changed_fns.map((c) => c.file);
    expect(files).toContain('src/new-name.ts');
    expect(files).not.toContain('src/gone.ts');
    // the deleted file keeps no functions at head; keep the manifest consistent
    for (const c of m.changed_fns) {
      expect(m.changed_files).toContain(c.file);
      expect(fs.existsSync(path.join(dir, c.file))).toBe(true);
    }
  });

  it('makes paths relative to --repo when it is a subdirectory of the git top level', () => {
    const { dir, base } = initRepo({
      'web/src/lib.ts': TS_V1,
      'other/readme.md': 'x\n',
    });
    const sub = path.join(dir, 'web');
    writeAll(sub, { 'src/lib.ts': TS_V2 });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'edit web');
    const head = git(dir, 'rev-parse', 'HEAD');
    const out = path.join(tmp(), 'out');

    expect(mr(sub, out, base, head)).toBe(0);

    const m = readManifest(out);
    expect(m.changed_files).toEqual(['src/lib.ts']);
    expect(m.changed_fns.map((c) => c.file)).toEqual(['src/lib.ts', 'src/lib.ts']);
    expect(m.changed_fns.map((c) => c.fqn)).toContain('src/lib.ts:alpha');
  });

  it('needs --base and --head, rejects a bad --mode, and writes no manifest in main mode', () => {
    const { dir, base } = initRepo({ 'src/lib.ts': TS_V1 });
    const out = path.join(tmp(), 'out');
    const noBase = cli('build', dir, '--out', out, '--quiet', '--mode', 'mr', '--head', 'HEAD');
    expect(noBase.code).toBe(2);
    expect(noBase.err).toContain('error: --mode mr needs --base <sha>');
    const noHead = cli('build', dir, '--out', out, '--quiet', '--mode', 'mr', '--base', base);
    expect(noHead.code).toBe(2);
    expect(noHead.err).toContain('error: --mode mr needs --head <sha>');
    const badMode = cli('build', dir, '--out', out, '--quiet', '--mode', 'branch');
    expect(badMode.code).toBe(2);
    expect(badMode.err).toContain("error: --mode must be main or mr, got 'branch'");

    expect(cli('build', dir, '--out', out, '--quiet', '--mode', 'main', '--base', base, '--head', 'HEAD').code).toBe(0);
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(false);
  });

  it('fails on an unknown commit and names the problem', () => {
    const { dir } = initRepo({ 'src/lib.ts': TS_V1 });
    const out = path.join(tmp(), 'out');
    const r = cli('build', dir, '--out', out, '--quiet', '--mode', 'mr', '--base', 'deadbeef', '--head', 'HEAD');
    expect(r.code).toBe(1);
    expect(r.err).toContain('error: git diff deadbeef..HEAD');
  });

  it('prints the mr line before the summary, also under --quiet, and warns when HEAD is not --head', () => {
    const { dir, base } = initRepo({ 'src/lib.ts': TS_V1 });
    writeAll(dir, { 'src/lib.ts': TS_V2 });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'head');
    const head = git(dir, 'rev-parse', 'HEAD');
    const out = path.join(tmp(), 'out');

    const r = cli('build', dir, '--out', out, '--quiet', '--mode', 'mr', '--base', base, '--head', head);
    expect(r.code).toBe(0);
    const lines = r.err.split('\n').filter((l) => l.startsWith('mr ') || l.startsWith('pc-fe-ts: files='));
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(
      new RegExp(`^mr base=${base.slice(0, 8)} head=${head.slice(0, 8)} changed_files=1 changed_fns=\\d+$`),
    );

    // an older checkout: the working tree sits at base, --head points further on
    const out2 = path.join(tmp(), 'out2');
    git(dir, 'checkout', '-q', base);
    const r2 = cli('build', dir, '--out', out2, '--quiet', '--mode', 'mr', '--base', base, '--head', head);
    expect(r2.code).toBe(0);
    expect(r2.err).toContain('warning: working tree HEAD');
    expect(r2.err).toContain('extraction reflects the working tree');
  });
});
