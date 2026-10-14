// pc-fe-ts — TypeScript/Svelte CGF frontend.
//
//   pc-fe-ts build --repo <dir> [--repo-id <id>] [--schema <path>]… --out <dir>
//                  [--adapter <name or .toml path>]… [--no-adapter <name>]… [--no-adapters] [--no-adapter-routes]
//                  [--no-library-writeback] [--no-jsx] [--no-jsx-components] [--no-jsx-facts]
//                  [--no-http-routes] [--no-http-calls] [--no-try-blocks] [--no-instance-names]
//                  [--top-opaque N] [--json-stats <file>] [--quiet]
//                  [--resolver checker|syntactic] [--no-type-anchors]
import * as fs from 'node:fs';
import { listAdapters } from './adapter.js';
import { build } from './analyze.js';
import { loadCodec } from './cgf.js';
import { UserError } from './errors.js';

const USAGE =
  'usage: pc-fe-ts build --repo <dir> --out <dir> [--repo-id <id>] [--schema <path>]…\n' +
  '                     [--adapter <name or .toml path>]… [--no-adapter <name>]… [--no-adapters]\n' +
  '                     [--no-adapter-routes]\n' +
  '                     [--no-library-writeback] [--no-jsx] [--no-jsx-components] [--no-jsx-facts]\n' +
  '                     [--no-http-routes] [--no-http-calls] [--no-try-blocks]\n' +
  '                     [--no-instance-names]\n' +
  '                     [--top-opaque <n>] [--json-stats <file>] [--quiet]\n' +
  '                     [--resolver checker|syntactic] [--no-type-anchors]\n' +
  '       pc-fe-ts --version\n';

/** Flags that take a value, and flags that do not. */
const VALUE_FLAGS = [
  '--repo',
  '--repo-id',
  '--out',
  '--schema',
  '--top-opaque',
  '--json-stats',
  '--resolver',
  '--adapter',
  '--no-adapter',
];
const BOOL_FLAGS = [
  '--no-type-anchors',
  '--no-adapters',
  '--no-adapter-routes',
  '--no-library-writeback',
  '--no-jsx',
  '--no-jsx-components',
  '--no-jsx-facts',
  '--no-http-routes',
  '--no-http-calls',
  '--no-try-blocks',
  '--no-instance-names',
  '--quiet',
];

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The known flag closest to `flag`, if within edit distance 2. */
function suggestFlag(flag: string): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const k of [...VALUE_FLAGS, ...BOOL_FLAGS]) {
    const d = editDistance(flag, k);
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

function helpText(): string {
  return (
    `${USAGE}\nshipped adapters: ${listAdapters().join(', ') || '<none>'}\n` +
    "default: auto-detected from the target repo's package.json dependencies\n"
  );
}

function usageError(message: string): UserError {
  return new UserError(`${message}\nrun pc-fe-ts --help for usage`, 2);
}

function packageVersion(): string {
  const pkg = new URL('../package.json', import.meta.url);
  return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version: string }).version;
}

/** Runs the CLI and returns its exit code. */
export function main(argv: string[]): number {
  if (argv.length === 0) {
    process.stderr.write(helpText());
    return 2;
  }
  try {
    run(argv);
    return 0;
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    process.stderr.write(`error: ${e.message}\n`);
    return e.code;
  }
}

function run(argv: string[]): void {
  const cmd = argv[0];
  if (cmd === '--version') {
    process.stdout.write(`pc-fe-ts ${packageVersion()}\n`);
    return;
  }
  if (cmd === '--help' || cmd === '-h' || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(helpText());
    return;
  }
  if (cmd !== 'build') throw usageError(`unknown command '${cmd}'`);
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
  let jsx = true;
  let jsxComponents = true;
  let jsxFacts = true;
  let httpRoutes = true;
  let httpCalls = true;
  let tryBlocks = true;
  let instanceNames = true;
  const adapters: string[] = [];
  const excludeAdapters: string[] = [];
  const schemas: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const k = a[i]!;
    if (VALUE_FLAGS.includes(k)) {
      const v = a[i + 1];
      if (v === undefined || v.startsWith('--')) throw usageError(`${k} needs a value`);
      i++;
      switch (k) {
        case '--repo':
          repoDir = v;
          break;
        case '--repo-id':
          repoId = v;
          break;
        case '--out':
          outDir = v;
          break;
        case '--schema':
          schemas.push(v);
          break;
        case '--top-opaque':
          topOpaque = Number(v);
          break;
        case '--json-stats':
          jsonStats = v;
          break;
        case '--resolver':
          if (v !== 'checker' && v !== 'syntactic') {
            throw usageError(`--resolver must be checker or syntactic, got '${v}'`);
          }
          resolver = v;
          break;
        case '--adapter':
          adapters.push(v);
          break;
        case '--no-adapter':
          excludeAdapters.push(v);
          break;
      }
      continue;
    }
    switch (k) {
      case '--no-type-anchors':
        typeAnchors = false;
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
      case '--no-jsx':
        jsx = false;
        break;
      case '--no-jsx-components':
        jsxComponents = false;
        break;
      case '--no-jsx-facts':
        jsxFacts = false;
        break;
      case '--no-http-routes':
        httpRoutes = false;
        break;
      case '--no-http-calls':
        httpCalls = false;
        break;
      case '--no-try-blocks':
        tryBlocks = false;
        break;
      case '--no-instance-names':
        instanceNames = false;
        break;
      case '--quiet':
        quiet = true;
        break;
      default: {
        if (k.startsWith('-')) {
          const hint = suggestFlag(k);
          throw usageError(`unknown flag ${k}${hint ? ` (did you mean ${hint}?)` : ''}`);
        }
        if (repoDir) throw usageError(`unexpected argument '${k}'`);
        repoDir = k;
      }
    }
  }
  if (!repoDir) throw usageError('missing --repo <dir>');
  if (!outDir) throw usageError('missing --out <dir>');
  if (!fs.existsSync(repoDir)) throw new UserError(`repo not found: ${repoDir}`);
  if (!fs.statSync(repoDir).isDirectory()) throw new UserError(`repo is not a directory: ${repoDir}`);

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
    excludeAdapters,
    noAdapters,
    adapterRoutes,
    libraryWriteback,
    jsx,
    jsxComponents,
    jsxFacts,
    httpRoutes,
    httpCalls,
    tryBlocks,
    instanceNames,
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
