// File-system routes (coverage wave 1 §3.3): every route file convention the
// frontend knows becomes `Endpoint{HTTP}` keyed on the route's contract iid,
// plus an `HttpRoute` the core links client calls to. Next.js conventions apply
// only to a repo that looks like Next.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { contractIID, endpointIID } from '../src/hash.js';
import { routeFileOf, svelteKitPageDirs, svelteKitPageRoute, svelteKitPath } from '../src/routes.js';
import {
  argOf,
  callsites,
  connected,
  extract,
  extractDir,
  fn,
  param,
  resultOf,
  siteOf,
  type Decoded,
} from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEXTAPP = path.resolve(HERE, '..', 'fixtures', 'nextapp');

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const routes = (d: Decoded) =>
  d.packages.flatMap((p) => (p.httpRoutes ?? []) as Array<Record<string, unknown>>);
const endpoints = (d: Decoded) =>
  d.packages.flatMap((p) => (p.endpoints ?? []) as Array<Record<string, unknown>>);
const NEXT_PKG = '{"dependencies":{"next":"^16.0.0","react":"^19.0.0"}}';

describe('fixtures/nextapp', () => {
  const d = extractDir(NEXTAPP, { repoId: 'nextapp' });

  it('one HttpRoute per handler, method + canonical path + request params', () => {
    const rows = routes(d)
      .map((r) => [r.method, r.path, r.display, r.framework, r.requestParams])
      .sort((a, b) => (String(a[1]) + a[0] < String(b[1]) + b[0] ? -1 : 1));
    expect(rows).toEqual([
      ['GET', '/about', '/about', 'next-page', [0]],
      ['*', '/api/legacy', '/api/legacy', 'next-pages-api', [0]],
      ['GET', '/api/run', '/api/run', 'next-app', [0, 1]],
      ['DELETE', '/api/users/{}', '/api/users/[id]', 'next-app', [0, 1]],
      ['GET', '/api/users/{}', '/api/users/[id]', 'next-app', [0, 1]],
      ['GET', '/users/{}', '/users/[id]', 'next-page', [0]],
    ]);
    expect(d.stats.nextjs).toBe(true);
    expect(d.stats.httpRoutes).toBe(6);
  });

  it('the route iid is the http: contract iid, and endpoint_iid == iid', () => {
    const r = routes(d).find((x) => x.method === 'GET' && x.path === '/api/users/{}')!;
    expect(r.iid).toBe(b64(contractIID('http:GET /api/users/{}')));
    expect(r.endpointIid).toBe(r.iid);
    const h = fn(d, 'api/users/[id]/route.ts:GET');
    expect(r.handlerIid).toBe((h.id as { iid: string }).iid);
    expect(h.bindsTo).toEqual([r.iid]);
    expect(h.sourceParams).toEqual([0, 1]);
    const ep = endpoints(d).find((e) => e.iid === r.iid)!;
    expect([ep.kind, ep.untrustedInput, ep.name]).toEqual(['HTTP', true, 'GET /api/users/[id]']);
  });

  it('`export { remove as DELETE }` binds the renamed local', () => {
    expect(fn(d, 'api/users/[id]/route.ts:remove').bindsTo).toEqual([
      b64(contractIID('http:DELETE /api/users/{}')),
    ]);
  });

  it('a route handler reads its request: searchParams -> exec', () => {
    const f = fn(d, 'api/run/route.ts:GET');
    const get = siteOf(f, 'URLSearchParams.get');
    // calls are barriers: request -> .get receiver, .get result -> exec
    expect(connected(f, param(0), argOf(get, 0))).toBe(true);
    expect(connected(f, resultOf(siteOf(f, 'read:URL.searchParams')), argOf(get, 0))).toBe(true);
    expect(connected(f, resultOf(get), argOf(siteOf(f, 'node:child_process.exec'), 0))).toBe(true);
  });

  it('awaited Promise params reach the query', () => {
    const f = fn(d, 'api/users/[id]/route.ts:GET');
    expect(connected(f, param(1), argOf(siteOf(f, 'pg.Pool.query'), 1))).toBe(true);
  });

  it("a 'use server' action: endpoint, every param untrusted, no route", () => {
    const a = fn(d, 'app/actions.ts:renameUser');
    expect(a.sourceParams).toEqual([0, 1]);
    const name = 'action:app/actions.ts:renameUser';
    expect(a.bindsTo).toEqual([b64(endpointIID('nextapp', name))]);
    expect(endpoints(d).some((e) => e.name === name && e.untrustedInput === true)).toBe(true);
    // `pool` is `new Pool()` from 'pg' in lib/db.ts: the call is named for its class
    const q = siteOf(a, 'pg.Pool.query');
    expect(q.calleeFqn).toBe('pg.Pool.query');
    expect(connected(a, param(1), argOf(q, 1))).toBe(true);
    expect(d.stats.serverActions).toBe(1);
    // the client component calls it as an ordinary in-repo function
    expect(siteOf(fn(d, 'Profile.tsx:Profile'), 'app/actions.ts:renameUser').opaque).toBe(false);
  });

  it('a page: the props object is untrusted; groups dropped, private folders skipped', () => {
    expect(fn(d, 'users/[id]/page.tsx:UserPage').sourceParams).toEqual([0]);
    expect(fn(d, 'about/page.tsx:AboutPage').sourceParams).toEqual([0]);
    expect(fn(d, '_components/Hidden/page.tsx:Hidden').sourceParams).toEqual([]);
    expect(fn(d, 'Profile.tsx:Profile').sourceParams).toEqual([]);
  });

  it('a Pages API handler: one route for every method', () => {
    expect(fn(d, 'pages/api/legacy.ts:handler').sourceParams).toEqual([0]);
  });

  it("a client component's fetch carries the key of the app's own route", () => {
    const p = fn(d, 'Profile.tsx:Profile');
    const site = siteOf(p, 'http:GET /api/users/{}');
    expect(site.httpCall).toEqual({ method: 'GET', path: '/api/users/{}' });
    const route = routes(d).find((r) => r.method === 'GET' && r.path === '/api/users/{}')!;
    // the core links by method + path; the contract iids are the same bytes
    expect(b64(contractIID(String(site.calleeFqn)))).toBe(route.iid);
  });

  it('double extract is byte-identical', () => {
    const again = extractDir(NEXTAPP, { repoId: 'nextapp' });
    const read = (x: Decoded): Array<[string, string]> =>
      fs.readdirSync(x.outDir).sort().map((f) => [f, fs.readFileSync(path.join(x.outDir, f)).toString('base64')]);
    expect(read(again)).toEqual(read(d));
  });

  it('--no-http-routes: no routes, no actions, no endpoints', () => {
    const off = extractDir(NEXTAPP, { repoId: 'nextapp', httpRoutes: false });
    expect(routes(off)).toEqual([]);
    expect(endpoints(off)).toEqual([]);
    expect(fn(off, 'app/actions.ts:renameUser').sourceParams).toEqual([]);
  });
});

describe('route conventions', () => {
  it('Next conventions need a Next-looking repo', () => {
    const files = {
      'app/api/x/route.ts': 'export async function GET(r: Request) { return r; }',
      'pages/api/y.ts': 'export default function h(req: unknown) { return req; }',
    };
    expect(routes(extract(files, { noAdapters: true }))).toEqual([]);
    const withNext = extract({ ...files, 'package.json': NEXT_PKG }, { noAdapters: true });
    expect(routes(withNext).map((r) => `${r.method} ${r.path}`).sort()).toEqual(['* /api/y', 'GET /api/x']);
    const withConfig = extract({ ...files, 'next.config.mjs': 'export default {};' }, { noAdapters: true });
    expect(routes(withConfig)).toHaveLength(2);
  });

  it('a root app/ is served even when src/ exists', () => {
    const d = extract(
      {
        'package.json': NEXT_PKG,
        'src/lib/util.ts': 'export const u = 1;',
        'app/api/ping/route.ts': 'export const POST = async (req: Request) => req;',
      },
      { noAdapters: true },
    );
    expect(routes(d).map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/ping']);
  });

  it('a root app/ shadows src/app (and pages/ shadows src/pages): only the root serves', () => {
    const d = extract(
      {
        'package.json': NEXT_PKG,
        'src/app/both/route.ts': 'export function GET(r: Request) { return r; }',
        'app/both/route.ts': 'export function GET(r: Request) { return r; }',
        'src/pages/api/p.ts': 'export default function h(req: unknown) { return req; }',
        'pages/api/p.ts': 'export default function h(req: unknown) { return req; }',
      },
      { noAdapters: true },
    );
    const handler = (r: Record<string, unknown>): string =>
      String(d.functions.find((f) => (f.id as { iid: string }).iid === r.handlerIid)?.fqn);
    expect(routes(d).map((r) => `${r.method} ${r.path} ${handler(r)}`).sort()).toEqual([
      '* /api/p pages/api/p.ts:h',
      'GET /both app/both/route.ts:GET',
    ]);
    expect(fn(d, 'src/app/both/route.ts:GET').sourceParams).toEqual([]);
    expect(fn(d, 'src/pages/api/p.ts:h').sourceParams).toEqual([]);
    expect(d.functions.find((f) => f.fqn === 'pages/api/p.ts:h')?.sourceParams).toEqual([0]);
    expect(routeFileOf('src/app/x/route.ts', true, { app: true, pages: false })).toBeNull();
    expect(routeFileOf('src/pages/api/x.ts', true, { app: true, pages: false })?.display).toBe('/api/x');
  });

  it("a nested function with a 'use server' directive is an action of its own", () => {
    const d = extract(
      {
        'package.json': NEXT_PKG,
        'src/app/todo/page.tsx': `
export default function Page() {
  async function add(form: FormData) {
    'use server';
    eval(String(form.get('x')));
  }
  return <form action={add} />;
}
`,
      },
      { noAdapters: true },
    );
    const add = fn(d, 'page.tsx:Page.$add');
    expect(add.sourceParams).toEqual([0]);
    expect(endpoints(d).map((e) => e.name)).toContain('action:src/app/todo/page.tsx:Page.$add');
    expect(routes(d).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /todo']);
  });

  it('`export default withAuth(handler)` binds the wrapped local handler', () => {
    const d = extract(
      {
        'package.json': NEXT_PKG,
        'pages/api/secure/[id].ts': `
import { withAuth } from '../../../lib/auth';
async function handler(req: { query: unknown }) { return req.query; }
export default withAuth(handler);
`,
        'lib/auth.ts': 'export const withAuth = (h: unknown) => h;',
      },
      { noAdapters: true },
    );
    expect(routes(d).map((r) => `${r.method} ${r.path}`)).toEqual(['* /api/secure/{}']);
    expect(fn(d, '[id].ts:handler').sourceParams).toEqual([0]);
  });

  it('a wrapped default export binds the handler, not the comparator or key function (review probe memo2)', () => {
    const d = extract(
      {
        'package.json': NEXT_PKG,
        'app/p/page.tsx': `
import { memo } from 'react';
function Page({ params }: { params: { x: string } }) { return <div>{params.x}</div>; }
export default memo(Page, (a, b) => a === b);
`,
        'pages/api/k.ts': `
function handler(req: { query: { x: string } }, res: { end(x: string): void }) { res.end(req.query.x); }
declare function rateLimit(h: unknown, key: (r: { ip: string }) => string): unknown;
export default rateLimit(handler, (r) => r.ip);
`,
      },
      { adapters: ['react'] },
    );
    expect(fn(d, 'page.tsx:Page').sourceParams).toEqual([0]);
    expect(fn(d, 'k.ts:handler').sourceParams).toEqual([0]);
    expect(fn(d, 'k.ts:handler').bindsTo).toEqual([b64(contractIID('http:* /api/k'))]);
    expect(routes(d).map((r) => `${r.method} ${r.path}`).sort()).toEqual(['* /api/k', 'GET /p']);
  });

  it('a method on an instance of an imported class is <module>.<Class>.<method>', () => {
    const files = {
      'src/db.ts': `
import { Pool } from 'pg';
import pg from 'pg';
import Redis from 'ioredis';
import { Local } from './local';
export const pool = new Pool();
export const other = new pg.Client();
export const redis = new Redis();
export const mine = new Local();
`,
      'src/local.ts': 'export class Local { run(q: string) { return q; } }',
      'src/use.ts': `
import { pool, other, redis, mine } from './db';
export async function use(q: string) {
  await pool.query(q);
  await other.query(q);
  await redis.get(q);
  mine.run(q);
}
`,
    };
    const names = (d: Decoded) => callsites(fn(d, 'use.ts:use')).map((c) => String(c.calleeFqn));
    expect(names(extract(files, { noAdapters: true }))).toEqual([
      'pg.Pool.query',
      'pg.Client.query',
      'ioredis.Redis.get',
      'src/local.ts:Local.run', // an in-repo class still resolves to its method
    ]);
    expect(names(extract(files, { noAdapters: true, instanceNames: false }))).toEqual([
      '.query',
      '.query',
      '.get',
      'src/local.ts:Local.run',
    ]);
  });

  it('path derivation: groups, slots, interception, private folders, catch-alls', () => {
    const p = (rel: string) => routeFileOf(rel, true)?.display ?? null;
    expect(p('app/(shop)/items/[[...slug]]/page.tsx')).toBe('/items/[[...slug]]');
    expect(p('src/app/@modal/users/[id]/page.tsx')).toBe('/users/[id]');
    expect(p('app/@modal/(.)photo/[id]/page.tsx')).toBeNull();
    expect(p('app/_lib/x/route.ts')).toBeNull();
    expect(p('app/%5Fescaped/route.ts')).toBe('/_escaped');
    expect(p('app/route.ts')).toBe('/');
    expect(p('pages/api/index.ts')).toBe('/api');
    expect(p('pages/api/[...all].ts')).toBe('/api/[...all]');
    expect(p('pages/about.tsx')).toBeNull(); // a Pages Router PAGE is not an API route
    expect(p('src/routes/api/[id]/+server.ts')).toBe('/api/[id]');
    expect(p('src/routes/(app)/+server.js')).toBe('/');
    expect(routeFileOf('app/api/x/route.ts', false)).toBeNull();
  });

  it('a directory is a page when it has any +page file: svelte, ts, or server.ts', () => {
    expect(
      svelteKitPageDirs([
        'src/routes/a/+page.svelte',
        'src/routes/b/+page.ts',
        'src/routes/bx/+page.server.ts',
      ]),
    ).toEqual(new Set(['src/routes/a', 'src/routes/b', 'src/routes/bx']));
    expect(svelteKitPageDirs(['src/routes/a/+page.server.ts', 'lib/+page.svelte'])).toEqual(
      new Set(['src/routes/a']),
    );
    for (const rel of ['src/routes/a/+page.svelte', 'src/routes/a/+page.ts']) {
      expect(svelteKitPath(rel)).toBe('/a');
    }
    // a page +page.server.ts in a dir WITH a page keeps its own URL
    const dirs = svelteKitPageDirs(['src/routes/a/+page.svelte', 'src/routes/a/+page.server.ts']);
    expect(svelteKitPageRoute('src/routes/a/+page.server.ts', 'load', dirs)).toHaveLength(1);
    // a page +page.server.ts in a dir with only itself is served too
    const alone = svelteKitPageDirs(['src/routes/bx/+page.server.ts']);
    expect(svelteKitPageRoute('src/routes/bx/+page.server.ts', 'load', alone)[0]!.path).toBe(
      '/bx/__data.json',
    );
    // a layout load in a dir with no +page file flows to the descendant pages
    const attached = svelteKitPageRoute(
      'src/routes/shell/+layout.server.ts',
      'load',
      new Set(['src/routes/shell/a']),
    );
    expect(attached.map((r) => r.path)).toEqual(['/shell/a/__data.json']);
    expect(attached[0]!.label).toBe('/shell/a/__data.json +layout.server.ts load');
  });
});

describe('SvelteKit server load and form actions', () => {
  const d = extract({
    'src/routes/+page.svelte': '<h1>home</h1>',
    'src/routes/+page.server.ts': `
export const load = async (event) => ({ q: event.url.searchParams.get('q') });
`,
    'src/routes/(app)/users/[id]/+layout.server.ts': `
export async function load(event) { return { id: event.params.id }; }
`,
    'src/routes/(app)/users/[id]/+page.server.ts': `
export async function load(event) { return { tab: event.url.searchParams.get('tab') }; }
export const actions = {
  default: async ({ request }) => request.formData(),
  rename: async (event) => event.request.formData(),
};
`,
    'src/routes/(app)/users/[id]/+page.ts': `
export const load = async (event) => event.data;
`,
  });
  const rows = () =>
    routes(d)
      .map((r) => [r.method, r.path, r.framework, r.display])
      .sort((a, b) => (String(a[1]) + a[3] < String(b[1]) + b[3] ? -1 : 1));

  it('a server load is GET <route>/__data.json, an action POST <route>', () => {
    expect(rows()).toEqual([
      ['GET', '/__data.json', 'sveltekit-load', '/__data.json +page.server.ts load'],
      ['GET', '/users/{}/__data.json', 'sveltekit-load', '/users/[id]/__data.json +layout.server.ts load'],
      ['GET', '/users/{}/__data.json', 'sveltekit-load', '/users/[id]/__data.json +page.server.ts load'],
      ['POST', '/users/{}', 'sveltekit-action', '/users/[id]'],
      ['POST', '/users/{}', 'sveltekit-action', '/users/[id]?/rename'],
    ]);
    for (const r of routes(d)) {
      expect(r.iid).toBe(b64(contractIID(`http:${r.method} ${r.path}`)));
      expect(r.endpointIid).toBe(r.iid);
      expect(r.requestParams).toEqual([0]);
    }
  });

  it('a layout and a page load in one directory share one endpoint; both bind to it', () => {
    const iid = b64(contractIID('http:GET /users/{}/__data.json'));
    const eps = endpoints(d).filter((e) => e.iid === iid);
    expect(eps).toHaveLength(1);
    expect(eps[0]!.name).toBe('GET /users/[id]/__data.json');
    expect(eps[0]!.untrustedInput).toBe(true);
    for (const f of ['[id]/+layout.server.ts:load', '[id]/+page.server.ts:load']) {
      const h = fn(d, f);
      expect(h.bindsTo, f).toEqual([iid]);
      expect(h.sourceParams, f).toEqual([0]);
      const row = routes(d).find((r) => r.handlerIid === (h.id as { iid: string }).iid)!;
      expect(row.iid, f).toBe(iid);
    }
  });

  it('every action binds to the one POST endpoint; the universal +page.ts load is no endpoint', () => {
    const iid = b64(contractIID('http:POST /users/{}'));
    expect(endpoints(d).filter((e) => e.iid === iid).map((e) => e.name)).toEqual(['POST /users/[id]']);
    for (const f of ['+page.server.ts:actions.default', '+page.server.ts:actions.rename']) {
      expect(fn(d, f).bindsTo, f).toEqual([iid]);
    }
    expect(fn(d, '[id]/+page.ts:load').bindsTo ?? []).toEqual([]);
    expect(endpoints(d).map((e) => String(e.name)).sort()).toEqual([
      'GET /__data.json',
      'GET /users/[id]/__data.json',
      'POST /users/[id]',
    ]);
  });
});

describe('SvelteKit layout in a directory with no +page file', () => {
  // `+layout.server.ts` in a directory without a `+page` file: SvelteKit
  // serves no `<dir>/__data.json` there. The layout
  // load only runs as part of each descendant page's own data request.
  const files = {
    'src/routes/shell/+layout.server.ts': `
export async function load(event) { return { theme: event.url.searchParams.get('theme') }; }
`,
    'src/routes/shell/a/+page.svelte': '<h1>a</h1>',
    'src/routes/shell/a/+page.server.ts': `
export async function load(event) { return { q: event.url.searchParams.get('q') }; }
`,
    'src/routes/shell/b/+page.svelte': '<h1>b</h1>',
    'src/routes/shell/b/+page.ts': `
export const load = async (event) => event.data;
`,
    // a pageless leaf with no load: its __data.json is served but has no
    // handler of its own — the layout row alone is its contract
    'src/routes/shell/c/+page.svelte': '<h1>c</h1>',
  };
  const d = extract(files);
  const rows = routes(d);

  it('the layout load attaches to each descendant page URL; the page-less URL is gone', () => {
    expect(
      rows
        .map((r) => [r.method, r.path, r.framework, r.display])
        .sort((a, b) => (String(a[1]) + a[3] < String(b[1]) + b[3] ? -1 : 1)),
    ).toEqual([
      ['GET', '/shell/a/__data.json', 'sveltekit-load', '/shell/a/__data.json +layout.server.ts load'],
      ['GET', '/shell/a/__data.json', 'sveltekit-load', '/shell/a/__data.json +page.server.ts load'],
      ['GET', '/shell/b/__data.json', 'sveltekit-load', '/shell/b/__data.json +layout.server.ts load'],
      ['GET', '/shell/c/__data.json', 'sveltekit-load', '/shell/c/__data.json +layout.server.ts load'],
    ]);
  });

  it('one contract per descendant URL: page load AND layout load share the endpoint', () => {
    for (const path of ['/shell/a/__data.json', '/shell/b/__data.json', '/shell/c/__data.json']) {
      const iid = b64(contractIID(`http:GET ${path}`));
      expect(endpoints(d).filter((e) => e.iid === iid), path).toHaveLength(1);
    }
    const layout = fn(d, 'shell/+layout.server.ts:load');
    // the one layout binds to every descendant page URL it is served within
    expect(layout.bindsTo).toEqual([
      b64(contractIID('http:GET /shell/a/__data.json')),
      b64(contractIID('http:GET /shell/b/__data.json')),
      b64(contractIID('http:GET /shell/c/__data.json')),
    ]);
    expect(layout.sourceParams).toEqual([0]);
  });

  it('a layout in a directory with no +page file and no descendant page: served nowhere, no endpoint', () => {
    const dead = extract({
      // +layout.server.ts, +layout.svelte, nothing under it
      'src/routes/(app)/(auth)/donate/+layout.server.ts': `
export async function load(event) { return { x: event.url.searchParams.get('x') }; }
`,
      'src/routes/(app)/(auth)/donate/+layout.svelte': '<slot />',
    });
    expect(routes(dead)).toEqual([]);
    expect(endpoints(dead)).toEqual([]);
    expect(fn(dead, '(auth)/donate/+layout.server.ts:load').bindsTo ?? []).toEqual([]);
  });

  it('route groups are pathless on both ends: (auth)/donate load reaches donate/list pages', () => {
    const d2 = extract({
      'src/routes/(app)/(auth)/donate/+layout.server.ts': `
export async function load(event) { return { x: event.url.searchParams.get('x') }; }
`,
      'src/routes/(app)/(auth)/donate/list/+page.svelte': '<h1>l</h1>',
      'src/routes/(app)/(auth)/donate/(special)/top/+page.svelte': '<h1>t</h1>',
    });
    expect(routes(d2).map((r) => String(r.path)).sort()).toEqual([
      '/donate/list/__data.json',
      '/donate/top/__data.json',
    ]);
  });
});
