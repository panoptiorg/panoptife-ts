// callee_fqn naming. The catalog matches on this string, so it is the whole
// policy surface of the TS frontend. Naming is syntactic whether or not the
// target repo has node_modules:
//   - a call on an imported symbol      -> "<module>.<name>"
//   - a call on a receiver we recognise -> "<Type>.<method>"  (URLSearchParams.get)
//   - a call on an unrecognised `x.<p>` -> "<p>.<method>"     (items.push)
//   - anything else                     -> ".<method>"        (the flow model)
import ts from 'typescript';

/** last property name -> the type it stands for */
export const PROP_TYPE: Record<string, string> = {
  searchParams: 'URLSearchParams',
  headers: 'Headers',
  cookies: 'Cookies',
  location: 'location',
  localStorage: 'localStorage',
  sessionStorage: 'sessionStorage',
  history: 'History',
  document: 'document',
  console: 'console',
  navigator: 'navigator',
  url: 'URL',
  style: 'CSSStyleDeclaration',
  classList: 'DOMTokenList',
  dataset: 'DOMStringMap',
};

export const GLOBALS = new Set([
  'location',
  'document',
  'window',
  'console',
  'localStorage',
  'sessionStorage',
  'history',
  'navigator',
  'JSON',
  'Math',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Promise',
  'globalThis',
  'process',
  'crypto',
  'URL',
  'URLSearchParams',
]);

/** `new X(...)` -> X, for the few constructors whose methods we name. */
export const CTOR_TYPES = new Set([
  'URL',
  'URLSearchParams',
  'FormData',
  'Headers',
  'Request',
  'Response',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Function',
  'Worker',
]);

/** property WRITES that are sinks — they become `assign:<prop>` call sites. */
export const ASSIGN_SINK_PROPS = new Set([
  'innerHTML',
  'outerHTML',
  'srcdoc',
  'href',
  'src',
  'action',
  'cookie',
  'text',
]);

/**
 * coverage wave 1 §3.1 — intrinsic-element attributes that are sinks, as
 * synthetic `jsx:` call sites (the `svelte:` template facts' React twin).
 * react-dom 19 rewrites a `javascript:` URL in these to a throwing URL
 * (`sanitizeURL`: `href`, `src`, `action`, `formAction`, `xlinkHref`, and `data`
 * on `<object>` only); react-dom 18 only warns. Which runtime renders the element
 * is a fact about the repo, so it is recorded in the NAME and the catalog decides
 * the class: `jsx:attr:<name>` when the repo's react is >= 19,
 * `jsx:attr-unsanitized:<name>` when it is older or unknown. `srcDoc` and
 * `dangerouslySetInnerHTML` are never sanitised.
 */
export const JSX_URL_ATTRS = new Set(['href', 'src', 'action', 'formAction', 'xlinkHref']);

/** the `jsx:` fact an attribute of an intrinsic `<tag>` is, or null */
export function jsxFactName(tag: string, attr: string, reactSanitizesUrls: boolean): string | null {
  if (attr === 'dangerouslySetInnerHTML') return 'jsx:html';
  if (attr === 'srcDoc') return 'jsx:attr:srcDoc';
  if (JSX_URL_ATTRS.has(attr) || (attr === 'data' && tag === 'object')) {
    return reactSanitizesUrls ? `jsx:attr:${attr}` : `jsx:attr-unsanitized:${attr}`;
  }
  return null;
}

/** `<div>`, `<my-el>`, `<svg:rect>` are host elements; `<Child>`, `<a.B>` are values */
export function isIntrinsicTag(tag: ts.JsxTagNameExpression): boolean {
  if (ts.isJsxNamespacedName(tag)) return true;
  return ts.isIdentifier(tag) && (/^[a-z]/.test(tag.text) || tag.text.includes('-'));
}

export const RUNE_ROOTS = new Set([
  '$state',
  '$derived',
  '$effect',
  '$props',
  '$inspect',
  '$host',
  '$bindable',
]);

/**
 * call shape 5 — external higher-order functions that return the
 * function they were handed, with the same call signature. `export const
 * viewCommon = debounce(fn, DELAY)` means a call of `viewCommon` IS a call of
 * `fn`, so the wrapper is walked through during resolution. Deliberately a
 * whitelist: a HOF that is NOT identity-preserving (`makeTrackMount(send)`)
 * must stay opaque, and is named `<pkg>.<factory>.$ret` instead.
 *
 * Only the lodash-shaped, library-agnostic names live here; a shop's own
 * wrappers are `[[identity_hof]]` rows in an adapter (adapters).
 */
export const IDENTITY_HOFS = new Set([
  'debounce',
  'throttle',
  'memoize',
  'memo',
  'once',
]);

/**
 * Route sources — a page's untrusted surface is its route. Svelte 5's `$props()`
 * carries `+page`'s `data`/`params` into a component, so a bare `$props()` call
 * IS a synthetic ZERO-ARG source call site. A framework-specific route mount —
 * a microfrontend runtime that declares `{path:'/x/[id]'}` — is a `[[source]]`
 * row in an adapter, merged over this table at resolution time.
 */
export const ROUTE_SOURCE_CALLS: Record<string, string> = {
  $props: 'read:page.data',
};

/** property READS that are untrusted-input surfaces — `read:<path>` call sites. */
export const SOURCE_READS: Array<{ suffix: string; fqn: string }> = [
  { suffix: '.searchParams', fqn: 'read:URL.searchParams' },
  { suffix: '$page.url', fqn: 'read:$page.url' },
  { suffix: 'page.url', fqn: 'read:$page.url' },
  { suffix: 'location.href', fqn: 'read:location.href' },
  { suffix: 'location.search', fqn: 'read:location.search' },
  { suffix: 'location.hash', fqn: 'read:location.hash' },
  { suffix: 'document.cookie', fqn: 'read:document.cookie' },
  { suffix: 'document.referrer', fqn: 'read:document.referrer' },
  { suffix: '.target.value', fqn: 'read:event.target.value' },
  { suffix: '$page.params', fqn: 'read:route.params' },
  { suffix: 'page.params', fqn: 'read:route.params' },
  { suffix: '$page.data', fqn: 'read:page.data' },
  { suffix: 'page.data', fqn: 'read:page.data' },
];

export function unwrap(e: ts.Expression): ts.Expression {
  let n: ts.Expression = e;
  for (;;) {
    if (ts.isParenthesizedExpression(n)) n = n.expression;
    else if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
    else if (ts.isNonNullExpression(n)) n = n.expression;
    else if (ts.isTypeAssertionExpression(n)) n = n.expression;
    else return n;
  }
}

/** Dotted text of a pure identifier/property chain, or "" when it is not one. */
export function pathText(e: ts.Expression): string {
  const n = unwrap(e);
  if (ts.isIdentifier(n)) return n.text;
  if (n.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(n)) {
    const base = pathText(n.expression);
    return base ? `${base}.${n.name.text}` : '';
  }
  if (ts.isNonNullExpression(n)) return pathText(n.expression);
  return '';
}

/** Best-effort receiver "type" name for `<recv>.<method>()`. */
export function receiverName(e: ts.Expression, varType: (n: string) => string | undefined): string {
  const n = unwrap(e);
  if (ts.isIdentifier(n)) {
    const t = varType(n.text);
    if (t) return t;
    if (GLOBALS.has(n.text)) return n.text;
    return '';
  }
  if (ts.isPropertyAccessExpression(n)) {
    const p = n.name.text;
    return PROP_TYPE[p] ?? p;
  }
  if (ts.isNewExpression(n)) {
    const c = pathText(n.expression);
    return CTOR_TYPES.has(c) ? c : '';
  }
  if (ts.isCallExpression(n)) {
    const c = unwrap(n.expression);
    if (ts.isPropertyAccessExpression(c)) return PROP_TYPE[c.name.text] ?? '';
    return '';
  }
  if (ts.isElementAccessExpression(n)) return receiverName(n.expression, varType);
  return '';
}

/** `assign:` call-site name for a property write, or null when it is not a sink. */
export function assignSinkName(lhs: ts.Expression): string | null {
  const n = unwrap(lhs);
  if (!ts.isPropertyAccessExpression(n)) return null;
  const prop = n.name.text;
  if (!ASSIGN_SINK_PROPS.has(prop)) return null;
  const p = pathText(n);
  if (p.endsWith('location.href')) return 'assign:location.href';
  if (p.endsWith('document.cookie')) return 'assign:document.cookie';
  return `assign:${prop}`;
}

/** `read:` call-site name for a property read, or null. */
export function sourceReadName(e: ts.PropertyAccessExpression): string | null {
  const p = pathText(e);
  if (!p) {
    // still catch `foo().searchParams`
    return e.name.text === 'searchParams' ? 'read:URL.searchParams' : null;
  }
  for (const r of SOURCE_READS) {
    if (p === r.suffix.replace(/^\./, '') || p.endsWith(r.suffix)) return r.fqn;
  }
  return null;
}
