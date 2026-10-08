// Adapters — the client-library knowledge the CORE deliberately does not have.
//
// The core of pc-fe-ts knows TypeScript, Svelte, SvelteKit's file-system routes
// and the CGF contract. It does NOT know how *your* GraphQL client turns a
// document into a callable, because every shop does that differently. That
// knowledge is DATA: one `adapters/<name>.toml` per client library.
//
// See `adapters/README.md` for the schema and `../README.md` for the tour.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { num, parseToml, str, strs, type TomlTable } from './toml.js';

export const ADAPTERS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'adapters',
);

/** How a document becomes a `$op` function. */
export interface OperationRule {
  /** tagged-template tags that carry a document (`gql`, `graphql`) */
  tags: string[];
  /** …and tag PATH suffixes, so `Apollo.gql` / `x.gql` count */
  tagSuffix: string[];
  /** sibling property of the enclosing object literal holding a result mapper */
  mapperProp?: string;
  /** documented only: under aggregate taint a property projection is transparent */
  resultProp?: string;
}

/** How an op is wrapped into a callable that is invoked somewhere else. */
export interface HandlerRule {
  /** `path` — the op is named by a STRING and found via `opDirRegex`
   *  `doc`  — the op is named by a DOCUMENT expression at the factory call
   *  `sdk`  — the factory returns an object whose METHOD NAMES are op names */
  kind: 'path' | 'doc' | 'sdk';
  factories: string[];
  /** kind=path: which argument holds the path string */
  pathArg: number;
  /** kind=path: file rel path -> the path string the op is registered under */
  opDirRegex?: RegExp;
  /** the factory is only ever called ON a receiver (`<endpoint>.<factory>(…)`) */
  onReceiver: boolean;
  /** kind=doc: which argument holds the document */
  docArg: number;
  /** kind=doc: `value` (the result IS the callable) or `array0` (`const [m] = …`) */
  bind: 'value' | 'array0';
  /** methods that invoke the callable (`h.call(v)`, `h.mutateAsync(v)`) */
  methods: string[];
  /** at CALL time the variables are this property of the first argument */
  varsProp?: string;
  /** kind=sdk: which argument of `sdk.OpName(…)` holds the variables */
  varsArg: number;
  /** generated BFF route, e.g. "POST /api/{path}" */
  route?: string;
  /** which handler parameter the route body lands in (informational: always 0) */
  body?: string;
}

/** A call that invokes an operation directly, with the document in hand. */
export interface InvokeRule {
  /** trailing callee name (`request`, `useQuery`, `mutate`) */
  callee: string;
  /** the document is this argument … */
  docArg?: number;
  /** … or this property of that argument */
  docProp?: string;
  /** the variables are this argument … */
  varsArg?: number;
  /** … or this property of it */
  varsProp?: string;
  resultProp?: string;
}

/**
 * A hook that returns `[state, setter]` (coverage wave 1 §3.2): in the
 * function that destructures it, every call of the setter writes its argument
 * into the state variable, and a functional update `set(prev => f(prev))` reads
 * the state and writes `f`'s result. Name-based and same-function, which the
 * flow-insensitive model makes exact for the local case.
 */
export interface StateHook {
  name: string;
  /** tuple index of the state variable */
  state: number;
  /** tuple index of the setter */
  setter: number;
}

export interface Adapter {
  name: string;
  detect: string[];
  operations: OperationRule[];
  handlers: HandlerRule[];
  invokes: InvokeRule[];
  callbackFactories: string[];
  /** callback property -> the framework methods that invoke it */
  handleMethods: Array<{ prop: string; methods: string[] }>;
  sources: Array<{ call: string; fqn: string }>;
  identityHofs: string[];
  stateHooks: StateHook[];
  /** calls that run their callback once and return ITS result (`useMemo`) */
  thunkHofs: Array<{ name: string; fnArg: number }>;
}

/** The merged view analyze.ts consults. Empty == `--no-adapters`. */
export class AdapterSet {
  readonly names: string[] = [];
  readonly gqlTags = new Set<string>();
  readonly gqlTagSuffix: string[] = [];
  readonly mapperProps: string[] = [];
  /** factory name -> the handler rule that declares it */
  readonly handlerFactories = new Map<string, HandlerRule>();
  readonly handlerMethods = new Set<string>();
  readonly opDirRegexes: RegExp[] = [];
  /** trailing callee name -> rules, tried in order */
  readonly invokes = new Map<string, InvokeRule[]>();
  readonly callbackFactories = new Set<string>();
  readonly handleMethods = new Map<string, string[]>();
  readonly routeSourceCalls = new Map<string, string>();
  readonly identityHofs = new Set<string>();
  /** hook name -> its tuple layout (`[[state_hook]]`) */
  readonly stateHooks = new Map<string, StateHook>();
  /** callee name -> the argument holding the callback (`[[thunk_hof]]`) */
  readonly thunkHofs = new Map<string, number>();
  /** `getSdk`-style factories -> the rule that declares them */
  readonly sdkFactories = new Map<string, HandlerRule>();
  /** true when some rule binds a callable to a DOCUMENT, so gql consts must be indexed */
  needsDocIndex = false;
  /** emit the `[[handler]] route = …` HTTP endpoints (CLI `--no-adapter-routes`) */
  routes = true;

  add(a: Adapter): void {
    if (this.names.includes(a.name)) return;
    this.names.push(a.name);
    for (const op of a.operations) {
      for (const t of op.tags) this.gqlTags.add(t);
      for (const s of op.tagSuffix) if (!this.gqlTagSuffix.includes(s)) this.gqlTagSuffix.push(s);
      if (op.mapperProp && !this.mapperProps.includes(op.mapperProp)) {
        this.mapperProps.push(op.mapperProp);
      }
    }
    for (const h of a.handlers) {
      for (const f of h.factories) this.handlerFactories.set(f, h);
      for (const m of h.methods) this.handlerMethods.add(m);
      if (h.opDirRegex) this.opDirRegexes.push(h.opDirRegex);
      if (h.kind === 'doc' || h.kind === 'sdk') this.needsDocIndex = true;
      if (h.kind === 'sdk') for (const f of h.factories) this.sdkFactories.set(f, h);
    }
    for (const iv of a.invokes) {
      const l = this.invokes.get(iv.callee);
      if (l) l.push(iv);
      else this.invokes.set(iv.callee, [iv]);
      this.needsDocIndex = true;
    }
    for (const c of a.callbackFactories) this.callbackFactories.add(c);
    for (const h of a.handleMethods) {
      const prev = this.handleMethods.get(h.prop) ?? [];
      this.handleMethods.set(h.prop, [...prev, ...h.methods.filter((m) => !prev.includes(m))]);
    }
    for (const s of a.sources) this.routeSourceCalls.set(s.call, s.fqn);
    for (const h of a.identityHofs) this.identityHofs.add(h);
    for (const h of a.stateHooks) this.stateHooks.set(h.name, h);
    for (const h of a.thunkHofs) this.thunkHofs.set(h.name, h.fnArg);
  }

  get empty(): boolean {
    return this.names.length === 0;
  }

  /** the `<path>` an op file registers itself under, or null */
  opDirOf(rel: string): string | null {
    for (const re of this.opDirRegexes) {
      const m = re.exec(rel);
      if (m && m[1]) return m[1];
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

function one(t: TomlTable, k: string, where: string, dflt: number): number {
  return num(t, k, where) ?? dflt;
}

export function parseAdapter(text: string, file: string): Adapter {
  const doc = parseToml(text, file);
  const name = str(doc.root, 'name', file) ?? path.basename(file, '.toml');
  const a: Adapter = {
    name,
    detect: strs(doc.root, 'detect', file),
    operations: [],
    handlers: [],
    invokes: [],
    callbackFactories: [],
    handleMethods: [],
    sources: [],
    identityHofs: [],
    stateHooks: [],
    thunkHofs: [],
  };
  for (const t of doc.tables.get('operation') ?? []) {
    const w = `${file} [[operation]]`;
    a.operations.push({
      tags: strs(t, 'tags', w),
      tagSuffix: strs(t, 'tag_suffix', w),
      mapperProp: str(t, 'mapper_prop', w),
      resultProp: str(t, 'result_prop', w),
    });
  }
  for (const t of doc.tables.get('handler') ?? []) {
    const w = `${file} [[handler]]`;
    const kind = (str(t, 'kind', w) ?? 'path') as HandlerRule['kind'];
    if (kind !== 'path' && kind !== 'doc' && kind !== 'sdk') {
      throw new Error(`${w}: kind must be path | doc | sdk`);
    }
    const bind = (str(t, 'bind', w) ?? 'value') as HandlerRule['bind'];
    if (bind !== 'value' && bind !== 'array0') throw new Error(`${w}: bind must be value | array0`);
    const rx = str(t, 'op_dir_regex', w);
    a.handlers.push({
      kind,
      factories: strs(t, 'factories', w),
      pathArg: one(t, 'path_arg', w, 0),
      onReceiver: (t['on_receiver'] as boolean | undefined) ?? false,
      opDirRegex: rx ? new RegExp(rx) : undefined,
      docArg: one(t, 'doc_arg', w, 0),
      bind,
      methods: strs(t, 'methods', w),
      varsProp: str(t, 'vars_prop', w),
      varsArg: one(t, 'vars_arg', w, 0),
      route: str(t, 'route', w),
      body: str(t, 'body', w),
    });
  }
  for (const t of doc.tables.get('invoke') ?? []) {
    const w = `${file} [[invoke]]`;
    const callee = str(t, 'callee', w);
    if (!callee) throw new Error(`${w}: callee is required`);
    a.invokes.push({
      callee,
      docArg: num(t, 'doc_arg', w),
      docProp: str(t, 'doc_prop', w),
      varsArg: num(t, 'vars_arg', w),
      varsProp: str(t, 'vars_prop', w),
      resultProp: str(t, 'result_prop', w),
    });
  }
  for (const t of doc.tables.get('callback_factory') ?? []) {
    const w = `${file} [[callback_factory]]`;
    const nm = str(t, 'name', w);
    if (!nm) throw new Error(`${w}: name is required`);
    a.callbackFactories.push(nm);
  }
  for (const t of doc.tables.get('handle_method') ?? []) {
    const w = `${file} [[handle_method]]`;
    const prop = str(t, 'prop', w);
    if (!prop) throw new Error(`${w}: prop is required`);
    a.handleMethods.push({ prop, methods: strs(t, 'methods', w) });
  }
  for (const t of doc.tables.get('source') ?? []) {
    const w = `${file} [[source]]`;
    const call = str(t, 'call', w);
    const fqn = str(t, 'fqn', w);
    if (!call || !fqn) throw new Error(`${w}: call and fqn are required`);
    a.sources.push({ call, fqn });
  }
  for (const t of doc.tables.get('identity_hof') ?? []) {
    const w = `${file} [[identity_hof]]`;
    const nm = str(t, 'name', w);
    if (!nm) throw new Error(`${w}: name is required`);
    a.identityHofs.push(nm);
  }
  for (const t of doc.tables.get('state_hook') ?? []) {
    const w = `${file} [[state_hook]]`;
    const nm = str(t, 'name', w);
    if (!nm) throw new Error(`${w}: name is required`);
    a.stateHooks.push({ name: nm, state: one(t, 'state', w, 0), setter: one(t, 'setter', w, 1) });
  }
  for (const t of doc.tables.get('thunk_hof') ?? []) {
    const w = `${file} [[thunk_hof]]`;
    const nm = str(t, 'name', w);
    if (!nm) throw new Error(`${w}: name is required`);
    a.thunkHofs.push({ name: nm, fnArg: one(t, 'fn_arg', w, 0) });
  }
  // `include = [...]` is resolved by the loader, which knows the directory.
  return a;
}

function adapterFile(dir: string, name: string): string {
  return path.join(dir, `${name}.toml`);
}

/** Read one adapter and everything its `include` names, depth-first. An
 *  excluded name (`--no-adapter`) is skipped wherever it is reached. */
function loadOne(dir: string, name: string, set: AdapterSet, seen: Set<string>): void {
  if (seen.has(name)) return;
  seen.add(name);
  const file = adapterFile(dir, name);
  if (!fs.existsSync(file)) {
    throw new Error(`adapter '${name}' not found (looked in ${dir})`);
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const inc of strs(parseToml(text, file).root, 'include', file)) {
    loadOne(dir, inc, set, seen);
  }
  set.add(parseAdapter(text, file));
}

export function listAdapters(dir = ADAPTERS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.toml'))
    .map((f) => f.slice(0, -5))
    .sort();
}

/** package.json dependency names of the target repo (deps + devDeps + peer). */
export function repoDeps(repoDir: string): Set<string> {
  const out = new Set<string>();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const d of Object.keys(j[k] ?? {})) out.add(d);
    }
  } catch {
    /* no package.json — auto-detect finds nothing, which is a valid answer */
  }
  return out;
}

/** Adapters whose `detect` list intersects the repo's dependencies. */
export function autoDetect(repoDir: string, dir = ADAPTERS_DIR): string[] {
  const deps = repoDeps(repoDir);
  const hits: string[] = [];
  for (const name of listAdapters(dir)) {
    let det: string[];
    try {
      det = strs(parseToml(fs.readFileSync(adapterFile(dir, name), 'utf8'), name).root, 'detect', name);
    } catch {
      continue;
    }
    if (det.some((d) => deps.has(d))) hits.push(name);
  }
  return hits;
}

export interface AdapterOpts {
  repoDir: string;
  /** explicit `--adapter` names; overrides auto-detect */
  adapters?: string[];
  /** `--no-adapters` */
  none?: boolean;
  /** `--no-adapter-routes` */
  routes?: boolean;
  /** `--no-adapter <name>`: never load these, detected or included */
  exclude?: string[];
  dir?: string;
}

export function loadAdapters(o: AdapterOpts): AdapterSet {
  const set = new AdapterSet();
  set.routes = o.routes ?? true;
  if (o.none) return set;
  const dir = o.dir ?? ADAPTERS_DIR;
  const names = o.adapters?.length ? o.adapters : autoDetect(o.repoDir, dir);
  // pre-seeding `seen` makes loadOne skip an excluded adapter, also as an include
  const seen = new Set<string>(o.exclude ?? []);
  for (const n of names) loadOne(dir, n, set, seen);
  return set;
}
