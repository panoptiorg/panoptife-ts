// Adapters (adapters) — the client-library knowledge lives in TOML, not in
// `src/`. Two GENERIC GraphQL clients prove the split is real: neither shape
// exists anywhere in the core, and both extract a chain from a URL parameter
// to a GraphQL variable to a DOM sink.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { autoDetect, listAdapters, loadAdapters, parseAdapter } from '../src/adapter.js';
import { parseToml } from '../src/toml.js';
import { allCallsites, callsites, connected, extract, extractDir, fn, kindOf } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (n: string): string => path.join(HERE, 'fixtures', n);
const ADAPTERS = path.resolve(HERE, '..', 'adapters');

/** the callsite of `f` whose callee_fqn ends with `suffix` */
function site(f: Record<string, unknown>, suffix: string): Record<string, unknown> {
  const c = callsites(f).find((x) => String(x.calleeFqn).endsWith(suffix));
  if (!c) {
    throw new Error(
      `no callsite ~${suffix} in ${String(f.fqn)}; have ${callsites(f)
        .map((x) => x.calleeFqn)
        .join(', ')}`,
    );
  }
  return c;
}

/** true when the result of the `from` callsite reaches an arg port of `to` */
function flows(f: Record<string, unknown>, fromFqn: string, toFqn: string): boolean {
  const a = Number(site(f, fromFqn).id ?? 0);
  const b = Number(site(f, toFqn).id ?? 0);
  return connected(
    f,
    (v) => kindOf(v) === 'CALL_RESULT_PORT' && Number(v.callsiteId ?? 0) === a,
    (v) => kindOf(v) === 'CALL_ARG_PORT' && Number(v.callsiteId ?? 0) === b,
  );
}

// ---------------------------------------------------------------------------
// the TOML subset
// ---------------------------------------------------------------------------

describe('adapter TOML', () => {
  it('reads scalars, arrays and [[tables]]', () => {
    const d = parseToml(
      `name = "x"           # trailing comment
detect = ["a", "b"]
[[handler]]
kind = "path"
path_arg = 0
on_receiver = true
methods = ["call"]
[[handler]]
kind = "sdk"
factories = ['getSdk']
`,
      't',
    );
    expect(d.root.name).toBe('x');
    expect(d.root.detect).toEqual(['a', 'b']);
    expect(d.tables.get('handler')).toHaveLength(2);
    expect(d.tables.get('handler')![0]!.on_receiver).toBe(true);
    expect(d.tables.get('handler')![1]!.factories).toEqual(['getSdk']);
  });

  it('rejects a typo instead of silently ignoring it', () => {
    expect(() => parseToml('[handler]\nkind = "path"\n', 't')).toThrow(/not supported/);
    expect(() => parseToml('kind "path"\n', 't')).toThrow(/expected key = value/);
    expect(() => parseAdapter('[[invoke]]\ndoc_arg = 0\n', 't')).toThrow(/callee is required/);
    expect(() => parseAdapter('[[handler]]\nkind = "nope"\n', 't')).toThrow(/kind must be/);
  });

  it('every shipped adapter parses', () => {
    const names = listAdapters(ADAPTERS);
    expect(names).toEqual(['apollo', 'bff-gateway', 'felte', 'graphql-request', 'react', 'tanstack-query']);
    for (const n of names) {
      const a = parseAdapter(fs.readFileSync(path.join(ADAPTERS, `${n}.toml`), 'utf8'), n);
      expect(a.name).toBe(n);
      expect(a.detect.length).toBeGreaterThan(0);
    }
  });

  it('`include` pulls in the adapters an adapter depends on', () => {
    const s = loadAdapters({ repoDir: HERE, adapters: ['bff-gateway'], dir: ADAPTERS });
    expect(s.names).toContain('bff-gateway');
    expect(s.names).toContain('tanstack-query');
    expect(s.names).toContain('felte');
    expect(s.handlerFactories.has('getClientHandler')).toBe(true);
    expect(s.callbackFactories.has('createForm')).toBe(true);
    expect(s.handleMethods.get('mutationFn')).toEqual(['mutate', 'mutateAsync']);
  });

  it('reads [[state_hook]] and [[thunk_hof]] (coverage wave 1 §3.2)', () => {
    const a = parseAdapter(
      'name = "x"\n[[state_hook]]\nname = "useSignal"\nstate = 1\nsetter = 0\n[[thunk_hof]]\nname = "compute"\nfn_arg = 1\n',
      't',
    );
    expect(a.stateHooks).toEqual([{ name: 'useSignal', state: 1, setter: 0 }]);
    expect(a.thunkHofs).toEqual([{ name: 'compute', fnArg: 1 }]);
    expect(() => parseAdapter('[[state_hook]]\nstate = 0\n', 't')).toThrow(/name is required/);
    const r = loadAdapters({ repoDir: HERE, adapters: ['react'], dir: ADAPTERS });
    expect([...r.stateHooks.keys()]).toEqual(['useState', 'useReducer']);
    expect([...r.thunkHofs.keys()]).toEqual(['useMemo', 'startTransition']);
    expect(r.identityHofs.has('forwardRef')).toBe(true);
  });

  it('--no-adapter excludes an adapter even when it is included by another', () => {
    const s = loadAdapters({ repoDir: HERE, adapters: ['bff-gateway'], exclude: ['felte'], dir: ADAPTERS });
    expect(s.names).toEqual(['tanstack-query', 'bff-gateway']);
  });

  it('auto-detects from the target repo package.json', () => {
    expect(autoDetect(FIX('apollo'), ADAPTERS)).toEqual(['apollo']);
    expect(autoDetect(FIX('graphql-request'), ADAPTERS)).toEqual(['graphql-request']);
    expect(autoDetect(HERE, ADAPTERS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// @apollo/client
// ---------------------------------------------------------------------------

describe('apollo adapter', () => {
  const d = extractDir(FIX('apollo'), { repoId: 'apollo-fixture' });

  it('auto-detects @apollo/client and nothing else', () => {
    expect(d.stats.adapters).toEqual(['apollo']);
  });

  it('a gql document becomes an $op with schema-native arg names', () => {
    const op = fn(d, 'ops.ts:$op$0');
    const r = callsites(op).filter((c) => c.kind === 'INVOKES_REMOTE');
    expect(r).toHaveLength(1);
    expect(r[0]!.calleeFqn).toBe('graphql:Mutation.login');
    expect(r[0]!.argNames).toEqual(['token', 'remember']);
    expect(fn(d, 'ops.ts:$op$1')).toBeTruthy();
    expect(
      callsites(fn(d, 'ops.ts:$op$1')).map((c) => c.calleeFqn),
    ).toEqual(['graphql:Query.user']);
  });

  it('`const [mutate] = useMutation(DOC)` binds the callable to the document', () => {
    const h = fn(d, 'page.ts:loginPage.$doLogin');
    expect(site(h, 'ops.ts:$op$0')).toBeTruthy();
  });

  it('a URL param reaches the mutation variables, and the result reaches a sink', () => {
    const f = fn(d, 'page.ts:loginPage');
    // searchParams.get('token') -> doLogin({variables:{token}}) -> innerHTML
    expect(flows(f, 'URLSearchParams.get', 'loginPage.$doLogin')).toBe(true);
    expect(flows(f, 'loginPage.$doLogin', 'assign:innerHTML')).toBe(true);
    // the adapter's `vars_prop` projected `{variables: …}` down to one arg
    expect(site(f, 'loginPage.$doLogin').argc).toBe(1);
  });

  it('`useQuery(DOC, {variables})` invokes the op at the call site', () => {
    const f = fn(d, 'page.ts:userPage');
    expect(flows(f, 'URLSearchParams.get', 'ops.ts:$op$1')).toBe(true);
    expect(flows(f, 'ops.ts:$op$1', 'assign:innerHTML')).toBe(true);
  });

  it('`client.mutate({mutation: DOC, variables})` invokes the op too', () => {
    const f = fn(d, 'direct.ts:directLogin');
    expect(flows(f, 'URLSearchParams.get', 'ops.ts:$op$0')).toBe(true);
    expect(flows(f, 'ops.ts:$op$0', 'assign:innerHTML')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// graphql-request
// ---------------------------------------------------------------------------

describe('graphql-request adapter', () => {
  const d = extractDir(FIX('graphql-request'), { repoId: 'gqlr-fixture' });

  it('auto-detects graphql-request', () => {
    expect(d.stats.adapters).toEqual(['graphql-request']);
  });

  it('the document is one $op with the SDL arg names', () => {
    const r = callsites(fn(d, 'ops.ts:$op')).filter((c) => c.kind === 'INVOKES_REMOTE');
    expect(r).toHaveLength(1);
    expect(r[0]!.calleeFqn).toBe('graphql:Mutation.login');
    expect(r[0]!.argNames).toEqual(['token', 'remember']);
  });

  it('`client.request(DOC, variables)` — doc at arg 0', () => {
    const f = fn(d, 'calls.ts:viaClient');
    expect(flows(f, 'URLSearchParams.get', 'ops.ts:$op')).toBe(true);
    expect(flows(f, 'ops.ts:$op', 'assign:innerHTML')).toBe(true);
  });

  it('`request(url, DOC, variables)` — doc at arg 1, same op', () => {
    const f = fn(d, 'calls.ts:viaBare');
    expect(site(f, 'ops.ts:$op').argc).toBe(1);
    expect(flows(f, 'URLSearchParams.get', 'ops.ts:$op')).toBe(true);
  });

  it('codegen SDK: `getSdk(client).Login(vars)` binds by OPERATION NAME', () => {
    const f = fn(d, 'calls.ts:viaSdk');
    expect(flows(f, 'URLSearchParams.get', 'ops.ts:$op')).toBe(true);
    expect(flows(f, 'ops.ts:$op', 'assign:innerHTML')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the split itself
// ---------------------------------------------------------------------------

describe('--no-adapters: the core knows no client library', () => {
  // exactly the shape the in-house `bff-gateway` example models.
  const FILES = {
    'schema.graphql': 'type Query { searchByToken(token: String!): String! }',
    'src/api/core/client.ts': `
export const GatewayEndpoint = { create<T>(c: T): T { return c; } };
export const browser = false;
export function gql(s: TemplateStringsArray): string { return String(s); }
`,
    'src/api/endpoints/search/index.ts': `
import { browser, GatewayEndpoint, gql } from '../../core/client';
export const $gateway = GatewayEndpoint.create({
  name: 'Search',
  gqlNode: !browser && gql\`query Search($token: String!) { searchByToken(token: $token) }\`,
});
export const searchClient = $gateway.getClientHandler('search');
`,
    'src/routes/page.ts': `
import { searchClient } from '../api/endpoints/search';
export function go(el: HTMLElement) {
  const q = new URLSearchParams(location.search).get('q');
  el.innerHTML = searchClient.call({ token: q });
}
`,
  };

  it('with the bff-gateway adapter the GraphQL callsite is there', () => {
    const d = extract(FILES, { adapters: ['bff-gateway'] });
    const gql = allCallsites(d).filter((c) => String(c.calleeFqn).startsWith('graphql:'));
    expect(gql.map((c) => c.calleeFqn)).toEqual(['graphql:Query.searchByToken']);
    expect(d.stats.handlers).toBe(1);
  });

  it('with --no-adapters the SAME code yields NO GraphQL callsite at all', () => {
    const d = extract(FILES, { noAdapters: true });
    expect(d.stats.adapters).toEqual([]);
    expect(d.stats.ops).toBe(0);
    expect(d.stats.handlers).toBe(0);
    expect(d.stats.invokesRemote).toBe(0);
    expect(allCallsites(d).filter((c) => String(c.calleeFqn).startsWith('graphql:'))).toEqual([]);
    // …but the core still does its own job: the URL source and the DOM sink.
    const f = fn(d, 'routes/page.ts:go');
    expect(callsites(f).map((c) => c.calleeFqn)).toContain('URLSearchParams.get');
    expect(callsites(f).map((c) => c.calleeFqn)).toContain('assign:innerHTML');
  });

  it('no vendor name survives in the core', () => {
    const src = path.resolve(HERE, '..', 'src');
    const bad = /acme|bff-gateway|getClientHandler|mfDefine|GatewayEndpoint|apiMain/i;
    const hits: string[] = [];
    for (const f of fs.readdirSync(src)) {
      if (!f.endsWith('.ts')) continue;
      fs.readFileSync(path.join(src, f), 'utf8')
        .split('\n')
        .forEach((l, i) => {
          if (bad.test(l)) hits.push(`src/${f}:${i + 1}: ${l.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generated BFF routes
// ---------------------------------------------------------------------------

describe('[[handler]] route — the generated BFF surface', () => {
  const FILES = {
    'schema.graphql': 'type Mutation { pay(amount: Int!): Boolean! }',
    'src/gw/core/client.ts': `
export const GatewayEndpoint = { create<T>(c: T): T { return c; } };
export function gql(s: TemplateStringsArray): string { return String(s); }
`,
    'src/gw/endpoints/pay/index.ts': `
import { GatewayEndpoint, gql } from '../../core/client';
export const $gateway = GatewayEndpoint.create({
  gqlNode: gql\`mutation Pay($amount: Int!) { pay(amount: $amount) }\`,
});
export const payClient = $gateway.getClientHandler('pay');
`,
  };

  it('emits an untrusted HTTP endpoint bound to the handler', () => {
    const d = extract(FILES, { adapters: ['bff-gateway'] });
    const eps = d.packages.flatMap((p) => (p.endpoints ?? []) as Array<Record<string, unknown>>);
    const ep = eps.find((e) => e.name === 'POST /api/pay');
    expect(ep).toBeTruthy();
    expect(ep!.kind).toBe('HTTP');
    expect(ep!.untrustedInput).toBe(true);
    const h = fn(d, 'endpoints/pay/index.ts:payClient');
    expect(h.bindsTo).toHaveLength(1);
    expect(h.sourceParams).toEqual([0]);
    expect((h.signature as { params: Array<{ name: string }> }).params[0]!.name).toBe('variables');
  });

  it('--no-adapter-routes keeps the handler but drops the endpoint', () => {
    const d = extract(FILES, { adapters: ['bff-gateway'], adapterRoutes: false });
    const eps = d.packages.flatMap((p) => (p.endpoints ?? []) as Array<Record<string, unknown>>);
    expect(eps).toEqual([]);
    const h = fn(d, 'endpoints/pay/index.ts:payClient');
    expect(h.bindsTo ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// the *.gql.ts endpoint shape and a custom gateway root
// ---------------------------------------------------------------------------

describe('[[handler]] route — the one-operation-per-file *.gql.ts shape', () => {
  // An acme-style gateway also serves `<root>/**/*.gql.ts`, one operation
  // per file, and derives the URL from the FILE NAME — not from the string
  // handed to `getClientHandler` (here deliberately different). `<root>` is
  // whatever the repo configures (`src/shared/gw` here, not the default
  // `src/service/gateway`), so the regexes must be root-agnostic.
  const FILES = {
    'schema.graphql': 'type Query { user(id: ID!): String! account(id: ID!): String! }',
    'src/shared/gw/core/client.ts': `
export const GatewayEndpoint = { create<T>(c: T): T { return c; } };
export const browser = false;
export function gql(s: TemplateStringsArray): string { return String(s); }
`,
    // the call-site string ('user') drifts from the file name; the FILE wins
    'src/shared/gw/ops/queryUser.gql.ts': `
import { browser, GatewayEndpoint, gql } from '../core/client';
export const $gateway = GatewayEndpoint.create({
  gqlNode: !browser && gql\`query QueryUser($id: ID!) { user(id: $id) }\`,
});
export const queryUserClient = $gateway.getClientHandler('user');
`,
    // the gateway serves the file even with NO getClientHandler call in it
    'src/shared/gw/ops/queryAccount.gql.ts': `
import { browser, GatewayEndpoint, gql } from '../core/client';
export const $gateway = GatewayEndpoint.create({
  gqlNode: !browser && gql\`query QueryAccount($id: ID!) { account(id: $id) }\`,
});
`,
    'src/routes/page.ts': `
import { queryUserClient } from '../shared/gw/ops/queryUser.gql';
export function go(el: HTMLElement) {
  const id = new URLSearchParams(location.search).get('id');
  el.innerHTML = queryUserClient.call({ id });
}
`,
  };

  it('names the route after the FILE, not the call-site string', () => {
    const d = extract(FILES, { adapters: ['bff-gateway'] });
    const eps = d.packages.flatMap((p) => (p.endpoints ?? []) as Array<Record<string, unknown>>);
    const names = eps.map((e) => e.name).sort();
    expect(names).toContain('POST /api/queryUser');
    expect(names).not.toContain('POST /api/user');
  });

  it('serves a *.gql.ts endpoint file that has no getClientHandler call', () => {
    const d = extract(FILES, { adapters: ['bff-gateway'] });
    const eps = d.packages.flatMap((p) => (p.endpoints ?? []) as Array<Record<string, unknown>>);
    const ep = eps.find((e) => e.name === 'POST /api/queryAccount');
    expect(ep).toBeTruthy();
    expect(ep!.kind).toBe('HTTP');
    expect(ep!.untrustedInput).toBe(true);
    // the route is anchored at the operation, with the variables as input
    const op = fn(d, 'ops/queryAccount.gql.ts:$op');
    expect(op.bindsTo).toHaveLength(1);
    expect(op.sourceParams).toEqual([0]);
  });

  it('links the handler, its op and the route like the standard shape', () => {
    const d = extract(FILES, { adapters: ['bff-gateway'] });
    const h = fn(d, 'ops/queryUser.gql.ts:queryUserClient');
    expect(h.bindsTo).toHaveLength(1);
    expect(h.sourceParams).toEqual([0]);
    // the page's URL read reaches the GraphQL field THROUGH the handler and op
    const page = fn(d, 'routes/page.ts:go');
    expect(flows(page, 'URLSearchParams.get', 'ops/queryUser.gql.ts:queryUserClient')).toBe(true);
    const hSites = callsites(h).map((c) => c.calleeFqn);
    expect(hSites).toContain('src/shared/gw/ops/queryUser.gql.ts:$op');
    const gqlSites = allCallsites(d)
      .filter((c) => String(c.calleeFqn).startsWith('graphql:'))
      .map((c) => c.calleeFqn)
      .sort();
    expect(gqlSites).toEqual(['graphql:Query.account', 'graphql:Query.user']);
  });

  it('--no-adapter-routes drops both file-side and call-side routes', () => {
    const d = extract(FILES, { adapters: ['bff-gateway'], adapterRoutes: false });
    const eps = d.packages.flatMap((p) => (p.endpoints ?? []) as Array<Record<string, unknown>>);
    expect(eps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// a stale registry path gets no route
// ---------------------------------------------------------------------------

describe('[[handler]] route — a stale registry path gets no route', () => {
  // A registry handler whose `getClientHandler('<string>')` names no
  // registered endpoint file is served by nothing: the gateway's URL comes
  // from the FILE, wherever the handler is declared. The endpoint file itself
  // (no in-file handler here) is the only entry — the stale string must not
  // add a second one the server does not serve.
  const FILES = {
    'schema.graphql': 'type Query { account(id: ID!): String! }',
    'src/gw/core/client.ts': `
export const GatewayEndpoint = { create<T>(c: T): T { return c; } };
export const browser = false;
export function gql(s: TemplateStringsArray): string { return String(s); }
`,
    // the file registers 'queryAccount' (its own name); no handler in it
    'src/gw/ops/queryAccount.gql.ts': `
import { browser, GatewayEndpoint, gql } from '../core/client';
export const $gateway = GatewayEndpoint.create({
  gqlNode: !browser && gql\`query QueryAccount($id: ID!) { account(id: $id) }\`,
});
`,
    // a central registry whose string has drifted from the file name
    'src/api/registry.ts': `
import { $gateway } from '../gw/ops/queryAccount.gql';
export const userApi = $gateway.getClientHandler('user');
`,
  };

  it('one entry, from the file; the stale string adds none', () => {
    const d = extract(FILES, { adapters: ['bff-gateway'] });
    const eps = d.packages.flatMap((p) => (p.endpoints ?? []) as Array<Record<string, unknown>>);
    expect(eps.map((e) => e.name)).toEqual(['POST /api/queryAccount']);
    // the stale handler is bound to no endpoint of its own
    const h = fn(d, 'api/registry.ts:userApi');
    expect(h.bindsTo ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// op_dir_regex — the gateway's URL rules, expressed as adapter data
// ---------------------------------------------------------------------------

describe('op_dir_regex — gateway URL rules as data', () => {
  const s = loadAdapters({ repoDir: HERE, adapters: ['bff-gateway'], dir: ADAPTERS });
  const reg = (rel: string): string | null => s.opDirRuleOf(rel)?.path ?? null;

  it('a.b.gql.ts registers a — the basename up to the FIRST dot', () => {
    expect(reg('src/gw/ops/a.b.gql.ts')).toBe('a');
    expect(reg('src/gw/ops/a.b.c.gql.ts')).toBe('a');
    expect(reg('src/gw/ops/queryUser.gql.ts')).toBe('queryUser');
  });

  it('only .gql.ts and index.ts are served — no .js, no other suffix', () => {
    expect(reg('src/gw/ops/queryUser.gql.js')).toBe(null);
    expect(reg('src/gw/ops/queryUser.gql.tsx')).toBe(null);
    expect(reg('src/gw/endpoints/x/index.js')).toBe(null);
  });

  it('nested endpoints dirs: the LAST one wins, like the gateway', () => {
    expect(reg('x/endpoints/a/endpoints/b/index.ts')).toBe('b');
    expect(reg('src/service/gateway/endpoints/userState/index.ts')).toBe('userState');
  });

  it('endpoints must be a whole path segment', () => {
    expect(reg('src/fooendpoints/y/index.ts')).toBe(null);
  });
});
