// Empty-output guardrails: a zero-adapter or zero-endpoint run is usually a
// silent misconfiguration, not a genuinely empty repo (see analyze.ts
// emitEmptyOutputWarnings). These warnings print unconditionally to stderr,
// even under --quiet, and never change the exit code or the emitted bytes.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { build } from '../src/analyze.js';
import { loadCodec } from '../src/cgf.js';
import { extract, extractDir } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_FIXTURE = path.resolve(HERE, '..', 'fixtures', 'webapp');

/** run `body` with process.stderr.write captured; returns every write's string. */
function captureStderr(body: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    body();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

function warningsOf(lines: string[]): string[] {
  return lines.filter((l) => l.startsWith('warning:'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('empty-output guardrail warnings', () => {
  it('fixture webapp with an explicit --adapter emits neither warning', () => {
    const lines = captureStderr(() => {
      extractDir(WEBAPP_FIXTURE, { repoId: 'webapp', adapters: ['bff-gateway'] });
    });
    expect(warningsOf(lines)).toEqual([]);
  });

  it('a GraphQL-shaped dependency with no matching adapter warns (a)', () => {
    const lines = captureStderr(() => {
      // "my-graphql-wrapper" is GraphQL-shaped by name but is not any adapter's
      // `detect` string — the vendored/wrapped-client case from the facts.
      extract(
        {
          'package.json': JSON.stringify({
            name: 'app',
            dependencies: { 'my-graphql-wrapper': '^1.0.0' },
          }),
          'src/lib/util.ts': 'export function add(a: number, b: number) { return a + b; }\n',
        },
        { adapters: [] }, // no explicit adapter -> auto-detect, which finds nothing
      );
    });
    const warnings = warningsOf(lines);
    expect(warnings.some((w) => w.includes('no adapter matched package.json'))).toBe(true);
    expect(warnings.some((w) => w.includes('my-graphql-wrapper'))).toBe(true);
    expect(warnings.some((w) => w.includes('GraphQL-shaped'))).toBe(true);
  });

  it('a plain TS repo with no routes warns (b), not (a)', () => {
    const lines = captureStderr(() => {
      extract({
        'src/lib/util.ts': 'export function add(a: number, b: number) { return a + b; }\n',
      });
    });
    const warnings = warningsOf(lines);
    expect(warnings.some((w) => w.includes('0 endpoints and 0 operations emitted'))).toBe(true);
    expect(warnings.some((w) => w.includes('GraphQL-shaped'))).toBe(false);
  });

  it('warning (b) still prints under --quiet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fe-ts-quiet-'));
    fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'lib', 'util.ts'),
      'export function add(a: number, b: number) { return a + b; }\n',
    );
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fe-ts-quiet-out-'));
    const codec = loadCodec();

    const lines = captureStderr(() => {
      build({ repoDir: dir, repoId: 'quiettest', outDir: out, codec, quiet: true, noAdapters: true });
    });

    // under --quiet the per-file "pc-fe-ts: repo=..." stats line is suppressed,
    // but the empty-output warning must still appear.
    expect(lines.some((l) => l.startsWith('pc-fe-ts: repo='))).toBe(false);
    expect(warningsOf(lines).some((w) => w.includes('0 endpoints and 0 operations emitted'))).toBe(
      true,
    );
  });
});
