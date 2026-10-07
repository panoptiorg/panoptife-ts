import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSyntactic,
  CALL_ARG_PORT,
  CALL_RESULT_PORT,
  callsites,
  connected,
  edges,
  extract,
  fn,
  kindOf,
  vertices,
} from './helpers.js';
import { contractIID } from '../src/hash.js';

const SCHEMA = `
type Query { searchByToken(token: String!, limit: Int): String! }
type Mutation { auth: AuthMutations! }
type AuthMutations { login(input: LoginInput!): LoginPayload! }
type LoginPayload { success: Boolean!, token: String! }
input LoginInput { pincode: String, password: String }
`;

const CLIENT_STUB = `
export const GatewayEndpoint = { create<T>(c: T): T { return c; } };
export const browser = false;
export function gql(s: TemplateStringsArray, ...v: unknown[]): string { return String(s); }
`;

describe('gql document -> INVOKES_REMOTE call sites', () => {
  const d = extract({
    'schema.graphql': SCHEMA,
    'src/api/core/client.ts': CLIENT_STUB,
    'src/api/endpoints/search/index.ts': `
import { browser, GatewayEndpoint, gql } from '../../core/client';
export const $gateway = GatewayEndpoint.create({
  name: 'Search',
  gqlNode: !browser && gql\`
    query Search($token: String!, $limit: Int) {
      searchByToken(token: $token, limit: $limit)
    }
  \`,
  mapper,
});
function mapper(v: { searchByToken: string }) { return v.searchByToken; }
export const searchClient = $gateway.getClientHandler('search');
`,
  });
  const op = fn(d, 'search/index.ts:$op');
  const remote = callsites(op).filter((c) => c.kind === 'INVOKES_REMOTE');

  it('emits one INVOKES_REMOTE per argument-carrying field', () => {
    expect(remote).toHaveLength(1);
  });
  it('joins on the schema-native contract iid', () => {
    expect(remote[0]!.calleeFqn).toBe('graphql:Query.searchByToken');
    // toObject renders bytes as base64; the digest itself is checked in hash.test.ts
    expect(String(remote[0]!.calleeIids?.[0])).toBe(
      Buffer.from(contractIID('graphql:Query.searchByToken')).toString('base64'),
    );
  });
  it('carries the SDL arg names, not positions', () => {
    expect(remote[0]!.argNames).toEqual(['token', 'limit']);
    expect(remote[0]!.argc).toBe(2);
    expect(remote[0]!.arg0IsReceiver).toBe(false);
    expect(remote[0]!.resultc).toBe(1);
  });
  it('wires the variables object into every arg port that uses a $var', () => {
    expect(
      connected(
        op,
        (v) => kindOf(v) === 'IN_PARAM',
        (v) => kindOf(v) === 'CALL_ARG_PORT',
      ),
    ).toBe(true);
  });
  it('routes the result through the mapper to OUT_RETURN', () => {
    const mapperCs = callsites(op).find((c) => String(c.calleeFqn).endsWith(':mapper'));
    expect(mapperCs).toBeTruthy();
    expect(
      connected(
        op,
        (v) => kindOf(v) === 'CALL_RESULT_PORT',
        (v) => kindOf(v) === 'OUT_RETURN',
      ),
    ).toBe(true);
  });
});

describe('nested input-object variable propagation', () => {
  const d = extract({
    'schema.graphql': SCHEMA,
    'src/api/core/client.ts': CLIENT_STUB,
    'src/api/endpoints/auth/login/index.ts': `
import { browser, GatewayEndpoint, gql } from '../../../core/client';
export const $gateway = GatewayEndpoint.create({
  name: 'AuthLogin',
  gqlNode: !browser && gql\`
    mutation AuthLogin($pincode: String, $password: String) {
      auth { login(input: { pincode: $pincode, password: $password }) { success token } }
    }
  \`,
});
export const authLoginClient = $gateway.getClientHandler('auth/login');
`,
  });
  const op = fn(d, 'login/index.ts:$op');
  const remote = callsites(op).filter((c) => c.kind === 'INVOKES_REMOTE');

  it('walks the SDL to the nested parent type', () => {
    expect(remote.map((c) => c.calleeFqn)).toEqual(['graphql:AuthMutations.login']);
  });
  it('the whole `input` arg carries the variables (MVP: no k=2 field path)', () => {
    expect(remote[0]!.argNames).toEqual(['input']);
    expect(
      connected(
        op,
        (v) => kindOf(v) === 'IN_PARAM',
        (v) => kindOf(v) === 'CALL_ARG_PORT' && Number(v.callsiteId ?? 0) === Number(remote[0]!.id ?? 0),
      ),
    ).toBe(true);
  });
  it('a parentless field with no SDL falls back to root fields + warns', () => {
    const noSdl = extract({
      'src/api/core/client.ts': CLIENT_STUB,
      'src/api/endpoints/auth/login/index.ts': `
import { gql } from '../../../core/client';
export const q = gql\`mutation M($p: String) { auth { login(input: { pincode: $p }) { token } } }\`;
`,
    });
    expect(noSdl.stats.warnings.some((w) => w.includes('graphql-warn'))).toBe(true);
    const cs = callsites(fn(noSdl, 'login/index.ts:$op')).filter(
      (c) => c.kind === 'INVOKES_REMOTE',
    );
    expect(cs).toHaveLength(0); // `login` is not a root field: skipped, not guessed
  });
});

describe('handler resolution', () => {
  const files = {
    'schema.graphql': SCHEMA,
    'src/api/core/client.ts': CLIENT_STUB,
    'src/api/endpoints/search/index.ts': `
import { browser, GatewayEndpoint, gql } from '../../core/client';
export const $gateway = GatewayEndpoint.create({
  name: 'Search',
  gqlNode: !browser && gql\`query Search($token: String!) { searchByToken(token: $token) }\`,
});
export const searchClient = $gateway.getClientHandler('search');
`,
    'src/routes/x/+page.server.ts': `
import { searchClient } from '../../api/endpoints/search';
export const load = async ({ url }) => {
  const t = url.searchParams.get('t') ?? '';
  const a = await searchClient.call({ token: t });
  const b = await searchClient({ token: t });
  const c = await searchClient.cache();
  const e = await searchClient.fetch({ token: t });
  return { a, b, c, e };
};
`,
  };
  const d = extract(files);
  const load = fn(d, '+page.server.ts:load');

  it('xClient.call / xClient() / .cache() / .fetch() all bind to the handler', () => {
    const toHandler = callsites(load).filter((c) =>
      String(c.calleeFqn).endsWith('search/index.ts:searchClient'),
    );
    expect(toHandler).toHaveLength(4);
    for (const c of toHandler) {
      expect(c.kind).toBe('STATIC');
      expect(c.opaque).toBe(false);
      expect(c.calleeIids).toHaveLength(1);
    }
  });

  it('the handler is a real function: param0 -> $op -> return', () => {
    const h = fn(d, 'search/index.ts:searchClient');
    const toOp = callsites(h).filter((c) => String(c.calleeFqn).endsWith('index.ts:$op'));
    expect(toOp).toHaveLength(1);
    expect(
      connected(
        h,
        (v) => kindOf(v) === 'IN_PARAM',
        (v) => kindOf(v) === 'CALL_ARG_PORT',
      ),
    ).toBe(true);
    expect(
      connected(
        h,
        (v) => kindOf(v) === 'CALL_RESULT_PORT',
        (v) => kindOf(v) === 'OUT_RETURN',
      ),
    ).toBe(true);
  });

  it('+page.server.ts load is an untrusted HTTP endpoint', () => {
    expect(load.sourceParams).toEqual([0]);
    expect(load.bindsTo).toHaveLength(1);
    const eps = d.packages.flatMap(
      (p) => (p.endpoints ?? []) as Array<Record<string, unknown>>,
    );
    const ep = eps.find((e) => String(e.name).startsWith('load '));
    expect(ep).toBeTruthy();
    expect(ep!.kind).toBe('HTTP');
    expect(ep!.untrustedInput).toBe(true);
  });
});

describe('SvelteKit endpoints', () => {
  const d = extract({
    'src/routes/a/+page.server.ts': `
function load(id: string) { return id; }
export function actionsLog(msg: string) { return msg; }
export const actions = {
  default: async ({ request }) => request,
  save: (event) => () => event,
};
`,
    'src/routes/b/+layout.server.ts': `
const load = async (event) => event;
export { load };
export const actions = { x: async (event) => event };
`,
    'src/routes/c/+server.ts': `
export async function GET(event) { return event; }
export const load = (event) => event;
`,
    'src/lib/server/cache.server.ts': `
export async function load(key: string) { return key; }
`,
  });

  it('only SvelteKit route exports become endpoints', () => {
    const eps = d.packages
      .flatMap((p) => (p.endpoints ?? []) as Array<Record<string, unknown>>)
      .map((e) => String(e.name))
      .sort();
    expect(eps).toEqual([
      'GET src/routes/c',
      'actions.default src/routes/a',
      'actions.save src/routes/a',
      'load src/routes/b',
    ]);
  });

  it('a function that is not an endpoint has no untrusted param', () => {
    for (const s of [
      'routes/a/+page.server.ts:load',
      '+page.server.ts:actionsLog',
      '+page.server.ts:actions.save.$ret',
      '+layout.server.ts:actions.x',
      '+server.ts:load',
      'cache.server.ts:load',
    ]) {
      expect(fn(d, s).sourceParams, s).toEqual([]);
    }
    expect(fn(d, '+page.server.ts:actions.save').sourceParams).toEqual([0]);
  });
});

describe('class method names', () => {
  const d = extract({
    'src/lib/repo.ts': `
export class UserRepo {
  #where(id: string) { return id; }
  'find-by-name'(n: string) { return n; }
  42() { return 1; }
  ['by-id'](x: string) { return x; }
  [Symbol.iterator]() { return [][Symbol.iterator](); }
  constructor(private db: unknown) {}
  find(id: string) { return this.#where(id); }
}
`,
  });

  it('keeps private, quoted, numeric and literal computed names', () => {
    const names = d.functions
      .map((f) => String(f.fqn))
      .filter((q) => q.includes(':UserRepo.'))
      .map((q) => q.slice(q.indexOf(':') + 1))
      .sort();
    expect(names).toEqual([
      'UserRepo.#where',
      'UserRepo.42',
      'UserRepo.[computed]',
      'UserRepo.by-id',
      'UserRepo.constructor',
      'UserRepo.find',
      'UserRepo.find-by-name',
    ]);
  });

  it('a call to a private method binds to it', () => {
    const c = callsites(fn(d, 'UserRepo.find')).filter((x) =>
      String(x.calleeFqn).endsWith(':UserRepo.#where'),
    );
    expect(c).toHaveLength(1);
    expect(c[0]!.opaque).toBe(false);
  });
});

describe('svelte template lowering', () => {
  const d = extract({
    'src/routes/x/+page.svelte': `<script lang="ts">
  import { goto } from '$app/navigation';
  let typed = '';
  let res = '';
  function run() {
    const q = new URL(location.href).searchParams.get('q') ?? '';
    res = q + typed;
    goto(q);
  }
</script>
<input bind:value={typed} />
<button on:click={run}>go</button>
{@html res}
`,
  });
  const s = fn(d, '+page.svelte:$script');
  const names = callsites(s).map((c) => c.calleeFqn);

  it('{@html e} becomes a svelte:html call site', () => {
    expect(names).toContain('svelte:html');
    const h = callsites(s).find((c) => c.calleeFqn === 'svelte:html')!;
    expect(h.argc).toBe(1);
  });
  it('bind:value={v} makes v a result port of svelte:bind', () => {
    expect(names).toContain('svelte:bind');
    const b = callsites(s).find((c) => c.calleeFqn === 'svelte:bind')!;
    expect(b.argc).toBe(0);
    expect(b.resultc).toBe(1);
    // the bound variable reaches {@html}: svelte:bind result -> svelte:html arg
    const html = callsites(s).find((c) => c.calleeFqn === 'svelte:html')!;
    expect(
      connected(
        s,
        (v) => kindOf(v) === 'CALL_RESULT_PORT' && Number(v.callsiteId ?? 0) === Number(b.id ?? 0),
        (v) => kindOf(v) === 'CALL_ARG_PORT' && Number(v.callsiteId ?? 0) === Number(html.id ?? 0),
      ),
    ).toBe(true);
  });
  it('a whole .svelte file is ONE function ($script), closures inlined', () => {
    expect(d.functions.filter((f) => String(f.fqn).includes('+page.svelte'))).toHaveLength(1);
  });
});

describe('opaque callee_fqn naming', () => {
  const d = extract({
    'src/a.ts': `
import { goto } from '$app/navigation';
import * as store from 'svelte/store';
export function f(u: string, el: HTMLElement, unknownThing: any) {
  const q = new URL(location.href).searchParams.get('pin');
  goto(q ?? '');
  store.get(u);
  el.innerHTML = q ?? '';
  location.href = u;
  console.log(q);
  unknownThing.mysteryMethod(q);
}
`,
  });
  const f = fn(d, 'a.ts:f');
  const names = callsites(f).map((c) => c.calleeFqn);

  it('module-qualified for imports, receiver-typed for known receivers', () => {
    expect(names).toContain('$app/navigation.goto');
    expect(names).toContain('svelte/store.get');
    expect(names).toContain('URLSearchParams.get');
    expect(names).toContain('console.log');
  });
  it('property writes to sink props become assign: call sites', () => {
    expect(names).toContain('assign:innerHTML');
    expect(names).toContain('assign:location.href');
  });
  it('an unknown receiver degrades to `.method`, never a guess', () => {
    expect(names).toContain('.mysteryMethod');
  });
  it('everything unresolved is flagged opaque', () => {
    for (const c of callsites(f)) {
      if (!String(c.calleeFqn).includes('.ts:')) expect(c.opaque).toBe(true);
    }
  });
});

describe('determinism', () => {
  const files = {
    'schema.graphql': SCHEMA,
    'src/api/core/client.ts': CLIENT_STUB,
    'src/api/endpoints/search/index.ts': `
import { browser, GatewayEndpoint, gql } from '../../core/client';
export const $gateway = GatewayEndpoint.create({
  name: 'Search',
  gqlNode: !browser && gql\`query Search($token: String!) { searchByToken(token: $token) }\`,
});
export const searchClient = $gateway.getClientHandler('search');
`,
    'src/routes/x/+page.svelte': `<script>
  import { searchClient } from '../../api/endpoints/search';
  let r = '';
  async function go() { r = await searchClient.call({ token: location.href }); }
</script>
{@html r}
`,
    'src/routes/x/+page.server.ts': `
import { searchClient } from '../../api/endpoints/search';
export const load = async ({ url }) => searchClient.call({ token: url.searchParams.get('t') });
`,
  };
  it('double extract is byte-identical', () => {
    const a = extract(files);
    const b = extract(files);
    const read = (d: typeof a): Array<[string, string]> =>
      fs
        .readdirSync(d.outDir)
        .sort()
        .map((f) => [f, fs.readFileSync(path.join(d.outDir, f)).toString('base64')]);
    expect(read(a)).toEqual(read(b));
  });
  it('vertex ids are dense and edges sorted', () => {
    const d = extract(files);
    for (const f of d.functions) {
      vertices(f).forEach((v, i) => expect(Number(v.id ?? 0)).toBe(i));
      const es = edges(f).map((e) => [Number(e.from ?? 0), Number(e.to ?? 0)]);
      const sorted = [...es].sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]!);
      expect(es).toEqual(sorted);
    }
  });
});

// ---------------------------------------------------------------------------
// checker resolution — checker-backed symbol resolution
// ---------------------------------------------------------------------------

const REG_SCHEMA = `
type Query { securityV2(id: ID!): String! }
`;

const REG_FILES: Record<string, string> = {
  'schema.graphql': REG_SCHEMA,
  'src/service/gateway/endpoints/getSecurity/index.ts': `
import { browser, GatewayEndpoint, gql } from '../../core/client';
export const $gateway = GatewayEndpoint.create({
  name: 'GetSecurity',
  gqlNode: !browser && gql\`query GetSecurity($id: ID!) { securityV2(id: $id) }\`,
});
export const getSecurityClient = $gateway.getClientHandler('getSecurity');
`,
  'src/service/gateway/endpoints/core/client.ts': CLIENT_STUB,
  // (b) barrel re-export WITH RENAME, plus `export *`
  'src/lib/api/main/model/endpoints.ts': `
import { getSecurityClient as getSecurity } from '../../../../service/gateway/endpoints/getSecurity';
export const endpoints = { getSecurity };
`,
  'src/lib/api/main/model/client.ts': `
import { endpoints } from './endpoints';
export const client = endpoints;
`,
  'src/lib/api/main/index.ts': `export { client as apiMain } from './model/client';`,
  'src/lib/api/star.ts': `export * from './main/index';`,
  // (a) registry object property -> handler
  'src/lib/entity/security/handlers/getHandle.ts': `
import { apiMain } from '../../../api/main';
export const getHandle = (params: { id: string }) => apiMain.getSecurity.call({ id: params.id });
`,
  // (b) `export *` reaches the same symbol
  'src/lib/entity/security/handlers/starHandle.ts': `
import { apiMain } from '../../../api/star';
export const starHandle = (id: string) => apiMain.getSecurity.call({ id });
`,
  // (c) callback as an object-literal property of a framework factory
  'src/apps/MFSecurity/config.ts': `
import { mfDefine } from '@acme/mf-core';
export const config = mfDefine({ type: 'page', path: '/security/[id]' });
`,
  'src/apps/MFSecurity/Form.svelte': `<script lang="ts">
  import { createForm } from 'felte';
  import { getHandle } from '../../lib/entity/security/handlers/getHandle';
  let data = { id: '' };
  const { form } = createForm({
    initialValues: data,
    onSubmit: (values) => getHandle({ id: values.id }),
  });
</script>
<input bind:value={data.id} />
`,
  'src/apps/MFSecurity/Page.svelte': `<script lang="ts">
  import { getHandle } from '../../lib/entity/security/handlers/getHandle';
  const { id } = $props();
  getHandle({ id });
</script>
`,
};

describe('checker-backed resolution (checker resolution)', () => {
  const d = extract(REG_FILES);
  const sites = (suffix: string): Array<Record<string, unknown>> => callsites(fn(d, suffix));

  it('resolves a registry object property to the handler behind it', () => {
    const cs = sites('getHandle.ts:getHandle');
    const st = cs.filter((c) => !c.opaque && String(c.calleeFqn).endsWith(':getSecurityClient'));
    expect(st).toHaveLength(1);
    expect(st[0]!.kind).toBe('STATIC');
  });

  it('follows `export *` to the same handler', () => {
    const cs = sites('starHandle.ts:starHandle');
    expect(cs.some((c) => String(c.calleeFqn).endsWith(':getSecurityClient'))).toBe(true);
  });

  it('the handler reaches the $op, so a source can reach the GraphQL contract', () => {
    const h = fn(d, 'getSecurity/index.ts:getSecurityClient');
    expect(callsites(h).some((c) => String(c.calleeFqn).endsWith(':$op'))).toBe(true);
  });

  it('a callback passed as an object-literal property is wired to the bound value', () => {
    const f = fn(d, 'Form.svelte:$script');
    const cs = callsites(f);
    const bind = cs.findIndex((c) => c.calleeFqn === 'svelte:bind');
    const handle = cs.findIndex((c) => String(c.calleeFqn).endsWith(':getHandle'));
    expect(bind).toBeGreaterThanOrEqual(0);
    expect(handle).toBeGreaterThanOrEqual(0);
    expect(
      connected(
        f,
        (v) => kindOf(v) === CALL_RESULT_PORT && Number(v.callsiteId ?? 0) === bind,
        (v) => kindOf(v) === CALL_ARG_PORT && Number(v.callsiteId ?? 0) === handle,
      ),
    ).toBe(true);
  });

  it('$props() and mfDefine() are zero-arg route sources', () => {
    const p = callsites(fn(d, 'Page.svelte:$script')).find((c) => c.calleeFqn === 'read:page.data');
    expect(p).toBeTruthy();
    expect(p!.argc).toBe(0);
    expect(p!.resultc).toBe(1);
    const m = callsites(fn(d, 'MFSecurity/config.ts:$module')).find(
      (c) => c.calleeFqn === 'read:route.params',
    );
    expect(m).toBeTruthy();
    expect(m!.argc).toBe(0);
  });

  it('the route source reaches the handler call', () => {
    const f = fn(d, 'Page.svelte:$script');
    const cs = callsites(f);
    const src = cs.findIndex((c) => c.calleeFqn === 'read:page.data');
    const handle = cs.findIndex((c) => String(c.calleeFqn).endsWith(':getHandle'));
    expect(
      connected(
        f,
        (v) => kindOf(v) === CALL_RESULT_PORT && Number(v.callsiteId ?? 0) === src,
        (v) => kindOf(v) === CALL_ARG_PORT && Number(v.callsiteId ?? 0) === handle,
      ),
    ).toBe(true);
  });

  it('--resolver=syntactic does NOT resolve the registry (the A/B control)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fe-ts-syn-'));
    for (const [rel, body] of Object.entries(REG_FILES)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    const st = buildSyntactic(dir);
    expect(st.resolvedByChecker).toBe(0);
    expect(st.resolved).toBeLessThan(d.stats.resolved);
  });
});

// ---------------------------------------------------------------------------
// the call shapes — the five call shapes the checker binding alone cannot follow
// ---------------------------------------------------------------------------

const SHAPE_FILES: Record<string, string> = {
  'src/lib/sink.ts': `export function sink(v: string): string { return v; }`,
  'src/lib/nav.ts': `export function goto(p: string): string { return p; }`,

  // (1) factory returning an OBJECT LITERAL of closures
  'src/lib/router.svelte.ts': `
import { goto } from './nav';
export const useRouter = () => {
  const push = (path: string) => goto(path);
  const replace = (path: string) => goto(path);
  return { push, replace };
};
`,
  // (1) framework HANDLE: createMutation(() => ({mutationFn})) then m.mutateAsync(v)
  'src/lib/mutation.ts': `
import { createMutation } from '@tanstack/svelte-query';
import { sink } from './sink';
export const useBuy = () => createMutation(() => ({ mutationFn: (v: string) => sink(v) }));
`,
  'src/lib/buyer.ts': `
import { useBuy } from './mutation';
export function go(v: string) { const buy = useBuy(); return buy.mutateAsync(v); }
`,
  // (1b) destructured at module scope, re-exported renamed
  'src/lib/ctx.ts': `
export const useCreateContext = (fn: (p: string) => string) => {
  return { initStore: (p: string) => fn(p), useStore: () => 'x' };
};
`,
  'src/stores/apiStore.ts': `
import { useCreateContext } from '../lib/ctx';
import { sink } from '../lib/sink';
const { initStore, useStore } = useCreateContext((p: string) => sink(p));
export { initStore as initApiStore, useStore as useApiStore };
`,
  'src/stores/consumer.ts': `
import { initApiStore } from './apiStore';
export function boot(v: string) { return initApiStore(v); }
`,
  // (3) nested local function called by name
  'src/lib/calc.ts': `
import { sink } from './sink';
export function outer(v: string) {
  const helper = (x: string) => sink(x);
  helper(v);
}
`,
  // (4) dynamic import
  'src/apps/Widget/index.ts': `
import { sink } from '../../lib/sink';
export default sink('boot');
`,
  'src/manifest.ts': `
export const config = { W: async () => import('./apps/Widget') };
`,
  // (5) identity-preserving external HOF / (6) a NON-identity external factory
  'src/lib/debounced.ts': `
import { debounce } from 'lodash-es';
import { sink } from './sink';
export const fn = (v: string) => sink(v);
export const viewCommon = debounce(fn, 300);
`,
  'src/lib/caller.ts': `
import { viewCommon } from './debounced';
export function callIt(v: string) { return viewCommon(v); }
`,
  'src/lib/tracker.ts': `
import { makeSend } from '@ext/tracker';
import { sink } from './sink';
const infoFn = (v: string) => sink(v);
export const send = makeSend(infoFn);
`,
  'src/lib/trackCaller.ts': `
import { send } from './tracker';
export function track(v: string) { return send(v); }
`,
  // (1) consumer + (3) template call + ($derived.by) + (7) span mapping
  'src/app/Page.svelte': `<script lang="ts">
  import { useRouter } from '../lib/router.svelte';
  const router = useRouter();
  const { id } = $props();
  const open = () => { router.push('/x/' + id); };
  const doubled = $derived.by(() => id);
</script>
<button onclick={() => open()}>{doubled}</button>
`,
};

describe('call shapes (call shapes)', () => {
  const d = extract(SHAPE_FILES);
  const cs = (suffix: string): Array<Record<string, unknown>> => callsites(fn(d, suffix));
  const has = (suffix: string, target: string): boolean =>
    cs(suffix).some((c) => !c.opaque && String(c.calleeFqn).endsWith(target));

  it('(1) emits one function per property of a returned object literal', () => {
    expect(fn(d, 'router.svelte.ts:useRouter.$ret.push')).toBeTruthy();
    expect(fn(d, 'router.svelte.ts:useRouter.$ret.replace')).toBeTruthy();
  });

  it('(1) binds `router.push(...)` when `router` came from the factory', () => {
    expect(has('Page.svelte:$script', 'router.svelte.ts:useRouter.$ret.push')).toBe(true);
  });

  it('(1) the closure body is emitted standalone AND stays inlined in the parent', () => {
    expect(has('router.svelte.ts:useRouter.$ret.push', 'nav.ts:goto')).toBe(true);
    expect(has('router.svelte.ts:useRouter', 'nav.ts:goto')).toBe(true);
  });

  it('(1) a createMutation handle resolves `m.mutateAsync(v)` to the mutationFn', () => {
    expect(has('buyer.ts:go', 'mutation.ts:useBuy.$ret.mutateAsync')).toBe(true);
    expect(has('mutation.ts:useBuy.$ret.mutateAsync', 'sink.ts:sink')).toBe(true);
  });

  it('(1b) a destructured + renamed re-export resolves to <factory>.$ret.<prop>', () => {
    expect(has('consumer.ts:boot', 'ctx.ts:useCreateContext.$ret.initStore')).toBe(true);
  });

  it('(3) a nested local function called by name binds to parent.$<name>', () => {
    expect(fn(d, 'calc.ts:outer.$helper')).toBeTruthy();
    expect(has('calc.ts:outer', 'calc.ts:outer.$helper')).toBe(true);
  });

  it('(3) a template call in a .svelte file binds to $script.$<name>', () => {
    expect(has('Page.svelte:$script', 'Page.svelte:$script.$open')).toBe(true);
  });

  it('(4) `import(...)` is STATIC to the module, never <dynamic>', () => {
    expect(has('manifest.ts:config.W', 'apps/Widget/index.ts:$module')).toBe(true);
    expect(cs('manifest.ts:config.W').some((c) => c.calleeFqn === '<dynamic>')).toBe(false);
  });

  it('(5) an identity-preserving HOF is walked through to the wrapped function', () => {
    expect(has('caller.ts:callIt', 'debounced.ts:fn')).toBe(true);
  });

  it('(6) a NON-identity external factory is named for the factory, not the const', () => {
    const c = cs('trackCaller.ts:track').find((x) => String(x.calleeFqn).includes('makeSend'));
    expect(c?.calleeFqn).toBe('@ext/tracker.makeSend.$ret');
    expect(c?.opaque).toBe(true);
  });

  it('($derived.by) classifies as the rune, not as a `.by` method', () => {
    const names = cs('Page.svelte:$script').map((c) => String(c.calleeFqn));
    expect(names).toContain('$derived.by');
    expect(names).not.toContain('.by');
  });

  it('(7) a .svelte span points at the ORIGINAL line, not the lowered one', () => {
    const f = fn(d, 'Page.svelte:$script');
    const tpl = callsites(f).filter((c) => c.calleeFqn === 'svelte:tpl');
    expect(tpl.length).toBeGreaterThan(0);
    // the template lives on line 8; the lowered script is 6 lines long
    for (const t of tpl) expect(Number((t.span as Record<string, unknown>).line)).toBe(8);
    const push = callsites(f).find((c) => String(c.calleeFqn).endsWith('useRouter.$ret.push'));
    expect(Number((push!.span as Record<string, unknown>).line)).toBe(5);
  });
});

