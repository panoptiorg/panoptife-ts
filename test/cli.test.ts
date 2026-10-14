// Command-line behaviour: --version, argument errors, repo checks, adapters
// given as a file path. `main` returns the exit code; output is captured.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEBAPP = path.join(ROOT, 'fixtures', 'webapp');

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fe-ts-cli-'));
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

/** The bytes of every .pb under `dir`, by file name. */
function pbs(dir: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.pb')).sort()) {
    o[f] = fs.readFileSync(path.join(dir, f)).toString('base64');
  }
  return o;
}

afterEach(() => vi.restoreAllMocks());

describe('cli', () => {
  it('--version prints the package version', () => {
    const v = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const r = cli('--version');
    expect(r.code).toBe(0);
    expect(r.out).toBe(`pc-fe-ts ${v}\n`);
  });

  it('names an unknown flag, suggests the nearest, and does not print the usage block', () => {
    const r = cli('build', WEBAPP, '--adaptr', 'x', '--out', tmp());
    expect(r.code).toBe(2);
    expect(r.err).toContain('error: unknown flag --adaptr (did you mean --adapter?)');
    expect(r.err).toContain('run pc-fe-ts --help for usage');
    expect(r.err).not.toContain('usage: pc-fe-ts build');
  });

  it('does not suggest anything for a flag far from every known one', () => {
    const r = cli('build', WEBAPP, '--zzzzzzzz', '--out', tmp());
    expect(r.code).toBe(2);
    expect(r.err).toContain('error: unknown flag --zzzzzzzz\n');
  });

  it('names a missing --out', () => {
    const r = cli('build', WEBAPP);
    expect(r.code).toBe(2);
    expect(r.err).toContain('error: missing --out <dir>');
  });

  it('prints the usage only for --help and for no arguments', () => {
    const h = cli('--help');
    expect(h.code).toBe(0);
    expect(h.out).toContain('usage: pc-fe-ts build');
    const n = cli();
    expect(n.code).toBe(2);
    expect(n.err).toContain('usage: pc-fe-ts build');
  });

  it('fails on a repo that does not exist or is not a directory', () => {
    const missing = path.join(tmp(), 'nope');
    const r = cli('build', '--repo', missing, '--out', tmp());
    expect(r.code).toBe(1);
    expect(r.err).toBe(`error: repo not found: ${missing}\n`);
    const file = path.join(ROOT, 'package.json');
    const f = cli('build', '--repo', file, '--out', tmp());
    expect(f.code).toBe(1);
    expect(f.err).toContain('error: repo is not a directory');
  });

  it('fails on a repo with no source files, and writes nothing', () => {
    const repo = tmp();
    fs.writeFileSync(path.join(repo, 'README.md'), 'x');
    const out = path.join(tmp(), 'out');
    const r = cli('build', '--repo', repo, '--out', out);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`error: no TypeScript, JavaScript or Svelte files under ${repo}`);
    expect(fs.existsSync(out) ? pbs(out) : {}).toEqual({});
  });

  it('--adapter takes a .toml path with the same result as the shipped name', () => {
    const dir = tmp();
    const copy = path.join(dir, 'my-client.toml');
    fs.copyFileSync(path.join(ROOT, 'adapters', 'bff-gateway.toml'), copy);
    const byName = path.join(dir, 'by-name');
    const byPath = path.join(dir, 'by-path');
    expect(cli('build', WEBAPP, '--adapter', 'bff-gateway', '--out', byName, '--quiet').code).toBe(0);
    expect(cli('build', WEBAPP, '--adapter', copy, '--out', byPath, '--quiet').code).toBe(0);
    const a = pbs(byName);
    expect(Object.keys(a).length).toBeGreaterThan(0);
    expect(pbs(byPath)).toEqual(a);
  });

  it('an unknown adapter lists the shipped ones, without a stack', () => {
    const r = cli('build', WEBAPP, '--adapter', 'nope', '--out', tmp(), '--quiet');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^error: adapter 'nope' not found; shipped adapters: apollo, .*bff-gateway.*; or pass a path to a \.toml file\n$/);
  });

  it('a missing adapter file is an error naming the path', () => {
    const r = cli('build', WEBAPP, '--adapter', './absent.toml', '--out', tmp(), '--quiet');
    expect(r.code).toBe(1);
    expect(r.err).toContain('error: adapter file not found:');
  });
});
