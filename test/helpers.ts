import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build, type Stats } from '../src/analyze.js';
import { loadCodec, type CgfCodec } from '../src/cgf.js';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const protobuf = require_('protobufjs') as typeof import('protobufjs');

let codecCache: CgfCodec | null = null;
export function codec(): CgfCodec {
  return (codecCache ??= loadCodec());
}

export interface Decoded {
  packages: Record<string, unknown>[];
  functions: Record<string, unknown>[];
  stats: Stats;
  outDir: string;
}

export interface ExtractOpts {
  repoId?: string;
  /** adapters to load; default `['bff-gateway']`, `[]` means `--no-adapters` */
  adapters?: string[];
  noAdapters?: boolean;
  adapterRoutes?: boolean;
  libraryWriteback?: boolean;
}

/** Write `files` into a temp repo, extract it, and decode the .pb back to JSON. */
export function extract(
  files: Record<string, string>,
  opts: string | ExtractOpts = {},
): Decoded {
  const o: ExtractOpts = typeof opts === 'string' ? { repoId: opts } : opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fe-ts-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return extractDir(dir, { adapters: ['bff-gateway'], ...o });
}

/** Extract an on-disk fixture repo (adapters auto-detected unless named). */
export function extractDir(dir: string, o: ExtractOpts = {}): Decoded {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fe-ts-out-'));
  const c = codec();
  const stats = build({
    repoDir: dir,
    repoId: o.repoId ?? 'testrepo',
    outDir: out,
    codec: c,
    quiet: true,
    adapters: o.adapters,
    noAdapters: o.noAdapters,
    adapterRoutes: o.adapterRoutes,
    libraryWriteback: o.libraryWriteback,
  });
  const root = protobuf.loadSync(c.protoPath);
  const Pkg = root.lookupType('panopticode.cgf.CgfPackage');
  const packages: Record<string, unknown>[] = [];
  for (const f of fs.readdirSync(out).sort()) {
    if (!f.endsWith('.pb')) continue;
    const msg = Pkg.decode(fs.readFileSync(path.join(out, f)));
    packages.push(Pkg.toObject(msg, { bytes: String, defaults: true, enums: String }) as Record<string, unknown>);
  }
  const functions = packages.flatMap(
    (p) => (p.functions ?? []) as Record<string, unknown>[],
  );
  return { packages, functions, stats, outDir: out };
}

/** extract with the pre-checker resolver, for A/B assertions */
export function buildSyntactic(dir: string, repoId = 'testrepo'): Stats {
  const out = path.join(dir, '.out-syn');
  return build({ repoDir: dir, repoId, outDir: out, codec: codec(), quiet: true, resolver: 'syntactic' });
}

export function maybeFn(d: Decoded, fqnSuffix: string): Record<string, unknown> | undefined {
  return d.functions.find((x) => String(x.fqn).endsWith(fqnSuffix));
}

/** every callsite of every function in the extract */
export function allCallsites(d: Decoded): Array<Record<string, unknown>> {
  return d.functions.flatMap((f) => callsites(f));
}

export function fn(d: Decoded, fqnSuffix: string): Record<string, unknown> {
  const f = d.functions.find((x) => String(x.fqn).endsWith(fqnSuffix));
  if (!f) {
    throw new Error(`no function ~${fqnSuffix}; have ${d.functions.map((x) => x.fqn).join(', ')}`);
  }
  return f;
}

export function callsites(f: Record<string, unknown>): Array<Record<string, unknown>> {
  return ((f.flow as Record<string, unknown> | undefined)?.callsites ??
    []) as Array<Record<string, unknown>>;
}

export function vertices(f: Record<string, unknown>): Array<Record<string, unknown>> {
  return ((f.flow as Record<string, unknown> | undefined)?.vertices ??
    []) as Array<Record<string, unknown>>;
}

export function edges(f: Record<string, unknown>): Array<Record<string, unknown>> {
  return ((f.flow as Record<string, unknown> | undefined)?.edges ??
    []) as Array<Record<string, unknown>>;
}

/** true when some edge runs from a vertex matching `from` to one matching `to`. */
export function connected(
  f: Record<string, unknown>,
  from: (v: Record<string, unknown>) => boolean,
  to: (v: Record<string, unknown>) => boolean,
): boolean {
  const vs = vertices(f);
  const byId = new Map(vs.map((v) => [Number(v.id ?? 0), v]));
  return edges(f).some(
    (e) => from(byId.get(Number(e.from ?? 0))!) && to(byId.get(Number(e.to ?? 0))!),
  );
}

export const IN_PARAM = 'IN_PARAM';
export const CALL_ARG_PORT = 'CALL_ARG_PORT';
export const CALL_RESULT_PORT = 'CALL_RESULT_PORT';
export const OUT_RETURN = 'OUT_RETURN';

export function kindOf(v: Record<string, unknown>): string {
  return String(v.kind ?? 'IN_PARAM');
}
