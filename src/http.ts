// The HTTP boundary (coverage wave 1 §1.1, §3.3, §3.4): the canonical path
// both sides of an HTTP contract are keyed on.
//
// A server route and a client call meet only through `ContractIID("http:" +
// method + " " + path)`, so the path must be canonicalised identically by the
// Go frontend, this frontend and the core. The shared vectors live in the
// core repository (`testdata/http-canon-vectors.json`); `test/http.test.ts`
// runs them against this implementation, and an embedded copy keeps CI honest
// without the sibling checkout.
import { contractIID } from './hash.js';

/** HTTP methods a route file can export / a client can name */
export const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Canonical path template (§1.1): no scheme/authority/query/fragment, empty
 * segments dropped, any parameter segment `{}` whatever its syntax (`{id}`,
 * `:id`, `[id]`, a template hole, a partly dynamic `v{}.json`), a catch-all
 * `{*}` and nothing after it. A client's unresolved base URL is a leading `{}`
 * that the caller writes into the input; it survives as a `{}` segment.
 */
export function canonPath(input: string): string {
  let s = input;
  const auth = /^(?:https?:)?\/\//i.exec(s);
  if (auth) {
    const rest = s.slice(auth[0].length);
    const slash = rest.indexOf('/');
    s = slash < 0 ? '' : rest.slice(slash);
  }
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '{$}') continue;
    let c: string;
    if (seg === '{*}' || seg.startsWith('*') || /^\{[^{}]*\.\.\.\}$/.test(seg) || /^\[\[?\.\.\.[^\]]*\]\]?$/.test(seg)) {
      c = '{*}';
    } else if (seg.includes('{') || seg.includes('[') || seg.startsWith(':')) {
      c = '{}';
    } else {
      c = seg;
    }
    out.push(c);
    if (c === '{*}') break;
  }
  return '/' + out.join('/');
}

/** `http:<METHOD> <canonical path>` — the contract name; `*` = any/unknown method */
export function httpContractName(method: string, path: string): string {
  return `http:${method || '*'} ${path}`;
}

export function httpContractIID(method: string, path: string): Uint8Array {
  return contractIID(httpContractName(method, path));
}

/**
 * coverage wave 1 §3.4 — the HTTP clients a call is recognised as. Detection is
 * by the RESOLVED BINDING of the callee (the import it came from, a global, or
 * an instance a factory made), never by `callee_fqn`: naming is syntactic, so
 * `axios.get`, `ky.get` and `api.get` all name as `.get`.
 */
export interface HttpClientLib {
  name: string;
  /** import specifiers whose binding is the client … */
  modules: string[];
  /** … through these exports (`default` covers a default and a namespace import) */
  exports: string[];
  /** identifiers that are the client with no import at all */
  globals: string[];
  /** `client(url, opts)`; with `callConfig`, `client(config)` when arg 0 is an object */
  callable: boolean;
  callConfig: boolean;
  /** `client.<verb>(url, …)` — the method is the verb (`postForm` -> POST) */
  verbs: string[];
  /** verbs whose config is argument 2 (`post(url, data, config)`); else argument 1 */
  bodyVerbs: string[];
  /** `client.<m>(config)` — url and method are properties of the config */
  configMethods: string[];
  /** `client.<m>(url, opts)` — like calling the client */
  callMethods: string[];
  /** `client.<f>(config)` returns another client of the same library … */
  factories: string[];
  /** … whose base URL is one of these config properties (also per request) */
  baseProps: string[];
  /** assignments that set the base of every request (`axios.defaults.baseURL = …`) */
  defaults: string[];
}

export const HTTP_CLIENTS: HttpClientLib[] = [
  {
    name: 'fetch',
    modules: [],
    exports: [],
    globals: ['fetch'],
    callable: true,
    callConfig: false,
    verbs: [],
    bodyVerbs: [],
    configMethods: [],
    callMethods: [],
    factories: [],
    baseProps: [],
    defaults: [],
  },
  {
    name: 'axios',
    modules: ['axios'],
    exports: ['default'],
    globals: [],
    callable: true,
    callConfig: true,
    verbs: ['get', 'delete', 'head', 'options', 'post', 'put', 'patch', 'postForm', 'putForm', 'patchForm'],
    bodyVerbs: ['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm'],
    configMethods: ['request'],
    callMethods: [],
    factories: ['create'],
    baseProps: ['baseURL'],
    defaults: ['defaults.baseURL'],
  },
  {
    name: 'ky',
    modules: ['ky'],
    exports: ['default'],
    globals: [],
    callable: true,
    callConfig: false,
    verbs: ['get', 'post', 'put', 'patch', 'delete', 'head'],
    bodyVerbs: [],
    configMethods: [],
    callMethods: [],
    factories: ['create', 'extend'],
    baseProps: ['prefixUrl', 'prefix', 'baseUrl'],
    defaults: [],
  },
  {
    name: 'ofetch',
    modules: ['ofetch'],
    exports: ['ofetch', '$fetch'],
    globals: ['$fetch'],
    callable: true,
    callConfig: false,
    verbs: [],
    bodyVerbs: [],
    configMethods: [],
    callMethods: ['raw', 'native'],
    factories: ['create'],
    baseProps: ['baseURL'],
    defaults: [],
  },
];

/** the method a verb names: `get` -> GET, `postForm` -> POST */
export function verbMethod(verb: string): string {
  const m = verb.replace(/Form$/, '').toUpperCase();
  return HTTP_METHODS.has(m) ? m : '';
}

/** a URL that carries its own scheme/authority ignores any base */
export function isAbsoluteUrl(t: string): boolean {
  return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(t);
}

/** base + path the way the clients combine them: exactly one `/` between, also
 *  when the path starts with `/` (axios `combineURLs`); an absolute URL wins */
export function joinBase(base: string, p: string): string {
  if (isAbsoluteUrl(p)) return p;
  return base.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
}
