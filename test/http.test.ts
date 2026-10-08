// The HTTP boundary (coverage wave 1 §1.1): the canonical path is the join key
// between a client call and a server route in ANY language, so it is pinned by
// the vectors the core repository ships. An embedded copy keeps the test
// meaningful without the sibling checkout (as `scripts/check-proto.sh` treats
// the sibling: compare when present, never require it).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { contractIID } from '../src/hash.js';
import { canonPath, httpContractIID } from '../src/http.js';
import { argOf, callsites, connected, extract, fn, param } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMBEDDED = path.join(HERE, 'fixtures', 'http-canon-vectors.json');
const SIBLING = path.resolve(HERE, '..', '..', 'panopticode', 'testdata', 'http-canon-vectors.json');

interface Vectors {
  vectors: Array<{ in: string; out: string }>;
}
const load = (p: string): Vectors => JSON.parse(fs.readFileSync(p, 'utf8')) as Vectors;

describe('canonical HTTP path (§1.1)', () => {
  it('passes every embedded vector', () => {
    const v = load(EMBEDDED).vectors;
    expect(v.length).toBeGreaterThan(10);
    for (const { in: i, out } of v) expect(canonPath(i), JSON.stringify(i)).toBe(out);
  });

  it.skipIf(!fs.existsSync(SIBLING))('passes the core repository vectors (sibling checkout)', () => {
    for (const { in: i, out } of load(SIBLING).vectors) {
      expect(canonPath(i), JSON.stringify(i)).toBe(out);
    }
  });

  it('the embedded copy has not drifted from the sibling', () => {
    if (!fs.existsSync(SIBLING)) {
      console.log(`http-canon: no sibling vectors at ${SIBLING} — embedded copy only`);
      return;
    }
    expect(load(EMBEDDED).vectors).toEqual(load(SIBLING).vectors);
  });

  it('the contract iid is ContractIID("http:<METHOD> <path>")', () => {
    expect(Buffer.from(httpContractIID('GET', '/api/users/{}'))).toEqual(
      Buffer.from(contractIID('http:GET /api/users/{}')),
    );
    expect(Buffer.from(httpContractIID('', '/x'))).toEqual(Buffer.from(contractIID('http:* /x')));
  });
});

// ---------------------------------------------------------------------------
// client sites (§3.4)
// ---------------------------------------------------------------------------

const CLIENTS = {
  'package.json': '{"dependencies":{"axios":"^1.9.0","ky":"^1.8.0","ofetch":"^1.4.0"}}',
  'src/api/client.ts': `
import axios from 'axios';
export const v2 = axios.create({ baseURL: '/api/v2' });
const envApi = axios.create({ baseURL: import.meta.env.VITE_API_URL });
export default envApi;
`,
  'src/calls.ts': `
import axios from 'axios';
import ky from 'ky';
import { ofetch } from 'ofetch';
import envApi, { v2 } from './api/client';
const BASE = '/svc';
export async function calls(id: string, body: unknown, u: string, init: RequestInit) {
  await fetch(\`\${import.meta.env.VITE_API_URL}/api/users/\${id}\`);
  await fetch('/api/items/' + id + '/tags?x=1', { method: 'POST', body: JSON.stringify(body) });
  await window.fetch(new URL(\`/api/x/\${id}\`, location.origin));
  await fetch(u);
  await fetch('/api/opts', init);
  await axios.post('/api/users', body);
  await axios.get(\`\${BASE}/list\`, { params: { id } });
  await axios({ url: '/api/cfg', method: 'put', data: body });
  await envApi.delete(\`/users/\${id}\`);
  await v2.get('items');
  await ky.post('api/ky', { json: body });
  await ofetch('/api/of', { method: 'DELETE' });
  await $fetch('/api/nuxt');
  axios.create({});
  const url = \`/api/const/\${id}\`;
  await fetch(url);
}
export function shadow(fetch: (x: string) => void) { fetch('/not/a/client'); }
`,
};

describe('HTTP client sites (§3.4)', () => {
  const d = extract(CLIENTS, { noAdapters: true });
  const f = fn(d, 'calls.ts:calls');
  const http = callsites(f).filter((c) => c.httpCall);

  it('recovers method + canonical path per client shape, by resolved binding', () => {
    expect(http.map((c) => `${(c.httpCall as { method: string }).method || '*'} ${(c.httpCall as { path: string }).path}`)).toEqual([
      'GET /{}/api/users/{}', // env base -> leading {}, template hole -> {}
      'POST /api/items/{}/tags', // + concatenation, query dropped, init.method
      'GET /api/x/{}', // window.fetch(new URL(path, base))
      'GET /{}', // nothing known about the URL
      '* /api/opts', // init is not a literal: method unknown
      'POST /api/users', // axios verb
      'GET /svc/list', // a const string in a template hole
      'PUT /api/cfg', // axios(config)
      'DELETE /{}/users/{}', // an instance whose baseURL is an env read
      'GET /api/v2/items', // an instance whose baseURL is a literal
      'POST /{}/api/ky', // relative: resolved against a base we cannot see
      'DELETE /api/of',
      'GET /api/nuxt', // $fetch global
      'GET /api/const/{}', // a local const URL
    ]);
  });

  it('the synthetic site: opaque STATIC, argc 1, resultc 0, http: name = contract name', () => {
    for (const c of http) {
      const h = c.httpCall as { method: string; path: string };
      expect([c.kind, c.opaque, c.argc, c.resultc]).toEqual(['STATIC', true, 1, 0]);
      expect(c.calleeFqn).toBe(`http:${h.method || '*'} ${h.path}`);
    }
  });

  it('every data argument flows into port 0; the ordinary site is still there', () => {
    const post = http.find((c) => (c.httpCall as { path: string }).path === '/api/users')!;
    expect(connected(f, param(1), argOf(post, 0))).toBe(true); // body
    const users = http[0]!;
    expect(connected(f, param(0), argOf(users, 0))).toBe(true); // id in the URL
    // `.post` keeps its own (syntactic) name for the catalog's egress rules
    expect(callsites(f).some((c) => c.calleeFqn === '.post' && !c.httpCall)).toBe(true);
  });

  it('a factory call and a shadowing parameter are not requests', () => {
    expect(callsites(fn(d, 'calls.ts:shadow')).filter((c) => c.httpCall)).toEqual([]);
    expect(http).toHaveLength(14);
  });

  it('census', () => {
    expect(d.stats.httpCalls).toBe(14);
    expect(d.stats.httpCallsResolvedPath).toBe(13);
    expect(d.stats.httpCallsDynamicBase).toBe(4);
    expect(d.stats.httpCallsUnknownMethod).toBe(1);
  });

  it('--no-http-calls: no synthetic site at all', () => {
    const off = extract(CLIENTS, { noAdapters: true, httpCalls: false });
    expect(callsites(fn(off, 'calls.ts:calls')).filter((c) => c.httpCall || String(c.calleeFqn).startsWith('http:'))).toEqual([]);
    expect(off.stats.httpCalls).toBe(0);
  });
});

describe('axios base URLs: resolved, or `{}` — never silently dropped (review probe http3)', () => {
  const d = extract(
    {
      'package.json': '{"dependencies":{"axios":"^1.9.0"}}',
      'src/api.ts': `
import axios from 'axios';
const cfg = { baseURL: '/api/v2' };
export const a1 = axios.create(cfg);
const common = { baseURL: '/api/v3' };
export const a2 = axios.create({ ...common, timeout: 5 });
export const a3 = axios.create({ baseURL: getBase() });
declare function getBase(): string;
export function a4(c: object) { return axios.create(c); }
axios.defaults.baseURL = '/api/v4';
export async function go(opts: object) {
  await a1.get('/users');
  await a2.get('/users');
  await a3.get('/users');
  await axios.get('/users');
  await axios.get('/users', { baseURL: '/other' });
  await axios.post('/users', {}, { baseURL: '/other2' });
  await axios.get('/users', opts);
}
`,
    },
    { noAdapters: true },
  );
  it('const and spread configs resolve; computed ones, unknown request configs are `{}`; request beats instance beats default', () => {
    const paths = callsites(fn(d, 'api.ts:go'))
      .filter((c) => c.httpCall)
      .map((c) => String(c.calleeFqn));
    expect(paths).toEqual([
      'http:GET /api/v2/users', // `axios.create(cfg)`, cfg a const object
      'http:GET /api/v3/users', // `{ ...common }`
      'http:GET /{}/users', // `baseURL: getBase()`
      'http:GET /api/v4/users', // `axios.defaults.baseURL = '/api/v4'` (joined although the path starts with `/`)
      'http:GET /other/users', // a per-request baseURL overrides
      'http:POST /other2/users', // …at argument 2 for a body verb
      'http:GET /{}/users', // a request config we cannot see may set one
    ]);
  });
});
