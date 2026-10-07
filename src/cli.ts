// pc-fe-ts — TypeScript/Svelte CGF frontend.
//
//   pc-fe-ts build --repo <dir> [--repo-id <id>] [--schema <path>]… --out <dir>
//                  [--adapter <name>]… [--no-adapters] [--no-adapter-routes]
//                  [--no-library-writeback]
//                  [--top-opaque N] [--json-stats <file>] [--quiet]
//                  [--resolver checker|syntactic] [--no-type-anchors]
import * as fs from 'node:fs';
import { listAdapters } from './adapter.js';
import { build } from './analyze.js';
import { loadCodec } from './cgf.js';

function usage(): never {
  process.stderr.write(
    'usage: pc-fe-ts build --repo <dir> --out <dir> [--repo-id <id>] [--schema <path>]…\n' +
      '                     [--adapter <name>]… [--no-adapters] [--no-adapter-routes]\n' +
      '                     [--no-library-writeback]\n' +
      '                     [--top-opaque <n>] [--json-stats <file>] [--quiet]\n' +
      '                     [--resolver checker|syntactic] [--no-type-anchors]\n' +
      `\nknown adapters: ${listAdapters().join(', ') || '<none>'}\n` +
      'default: auto-detected from the target repo\'s package.json dependencies\n',
  );
  process.exit(2);
}

export function main(argv: string[]): void {
  const cmd = argv[0];
  if (cmd !== 'build') usage();
  const a = argv.slice(1);
  let repoDir = '';
  let repoId: string | undefined;
  let outDir = '';
  let topOpaque = 0;
  let jsonStats = '';
  let quiet = false;
  let resolver: 'checker' | 'syntactic' = 'checker';
  let typeAnchors = true;
  let noAdapters = false;
  let libraryWriteback = true;
  let adapterRoutes = true;
  const adapters: string[] = [];
  const schemas: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = a[i + 1];
    switch (k) {
      case '--repo':
        repoDir = v!;
        i++;
        break;
      case '--repo-id':
        repoId = v;
        i++;
        break;
      case '--out':
        outDir = v!;
        i++;
        break;
      case '--schema':
        schemas.push(v!);
        i++;
        break;
      case '--top-opaque':
        topOpaque = Number(v);
        i++;
        break;
      case '--json-stats':
        jsonStats = v!;
        i++;
        break;
      case '--resolver':
        if (v !== 'checker' && v !== 'syntactic') usage();
        resolver = v;
        i++;
        break;
      case '--no-type-anchors':
        typeAnchors = false;
        break;
      case '--adapter':
        if (!v) usage();
        adapters.push(v);
        i++;
        break;
      case '--no-adapters':
        noAdapters = true;
        break;
      case '--no-adapter-routes':
        adapterRoutes = false;
        break;
      case '--no-library-writeback':
        libraryWriteback = false;
        break;
      case '--quiet':
        quiet = true;
        break;
      default:
        if (!repoDir) repoDir = k!;
        else usage();
    }
  }
  if (!repoDir || !outDir) usage();

  const t0 = Date.now();
  const codec = loadCodec();
  const stats = build({
    repoDir,
    repoId,
    outDir,
    schemas,
    codec,
    quiet,
    resolver,
    typeAnchors,
    adapters,
    noAdapters,
    adapterRoutes,
    libraryWriteback,
  });
  const top = [...stats.opaque.entries()]
    .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    .slice(0, topOpaque || 10);
  const warnKinds = new Map<string, number>();
  for (const w of stats.warnings) {
    const k = /([a-z-]+warn|[a-z]+-warn)/.exec(w)?.[1] ?? 'warn';
    warnKinds.set(k, (warnKinds.get(k) ?? 0) + 1);
  }
  process.stderr.write(
    `pc-fe-ts: files=${stats.files} functions=${stats.functions} callsites=${stats.callsites} ` +
      `invokes_remote=${stats.invokesRemote} ops=${stats.ops} ` +
      `gql_fields[sdl=${stats.opFieldsViaSdl} fallback=${stats.opFieldsFallback}] ` +
      `handlers=${stats.handlers} endpoints=${stats.endpoints} ` +
      `adapters=${stats.adapters.join('+') || '<none>'} ` +
      `static=${stats.resolved} (${((100 * stats.resolved) / Math.max(1, stats.callsites)).toFixed(
        1,
      )}% via-checker=${stats.resolvedByChecker}) ` +
      `anchors=${stats.anchors} (on-opaque=${stats.anchorsOnOpaque}) ` +
      `resolver=${stats.resolver} typed=${stats.typed} program=${(stats.programMs / 1000).toFixed(1)}s ` +
      `warnings=${stats.warnings.length} wall=${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
  );
  if (topOpaque) {
    process.stderr.write('top opaque callee_fqn:\n');
    for (const [fqn, n] of top) process.stderr.write(`  ${String(n).padStart(7)}  ${fqn}\n`);
  }
  if (jsonStats) {
    fs.writeFileSync(
      jsonStats,
      JSON.stringify(
        {
          ...stats,
          opaque: Object.fromEntries(
            [...stats.opaque.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)),
          ),
          warnings: stats.warnings.slice(0, 200),
        },
        null,
        1,
      ),
    );
  }
}

main(process.argv.slice(2));
