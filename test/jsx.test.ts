// JSX (coverage wave 1 §3.1): attribute and child expressions are walked, a
// component element is a STATIC call with the props object as arg 0, and the
// sink-bearing attributes of host elements are synthetic `jsx:` facts.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { reactMajor } from '../src/analyze.js';
import { fnIID } from '../src/hash.js';
import {
  argOf,
  callsites,
  connected,
  extract,
  extractDir,
  fn,
  kindOf,
  maybeFn,
  param,
  resultOf,
  siteOf,
  type ExtractOpts,
} from './helpers.js';

const names = (f: Record<string, unknown>): string[] => callsites(f).map((c) => String(c.calleeFqn));
const OUT_RETURN = (v: Record<string, unknown>): boolean => kindOf(v) === 'OUT_RETURN';

// ---------------------------------------------------------------------------
// walking JSX at all
// ---------------------------------------------------------------------------

const WALK = {
  'src/App.tsx': `
import { helper } from './Child';
export function App({ q }: { q: string }) {
  return (
    <div onClick={() => { location.href = q; }} title={helper(q)}>
      {document.write(q)}
    </div>
  );
}
`,
  'src/Child.tsx': `export function helper(v: string) { return v; }`,
  'src/Legacy.jsx': `export function legacy(q) { return <p onClick={() => eval(q)} />; }`,
  'src/conf.cjs': `module.exports = { run(x) { return x; } };`,
};

describe('JSX attribute and child expressions are walked', () => {
  const on = extract(WALK, { noAdapters: true });
  const off = extract(WALK, { noAdapters: true, jsx: false });

  it('an onClick handler body is visible, with the prop flowing into its sink', () => {
    const f = fn(on, 'App.tsx:App');
    const sink = siteOf(f, 'assign:location.href');
    expect(connected(f, param(0), argOf(sink, 0))).toBe(true);
  });

  it('a `{…}` child and an attribute value are walked too', () => {
    const f = fn(on, 'App.tsx:App');
    expect(connected(f, param(0), argOf(siteOf(f, 'document.write')))).toBe(true);
    // `./Child` resolves to Child.tsx, so the call in the attribute binds
    const h = siteOf(f, 'src/Child.tsx:helper');
    expect(h.opaque).toBe(false);
    expect(connected(f, param(0), argOf(h, 0))).toBe(true);
  });

  it("an inline handler's return does not become the component's return", () => {
    const f = fn(on, 'Legacy.jsx:legacy');
    expect(names(f)).toContain('eval');
    expect(connected(f, param(0), OUT_RETURN)).toBe(false);
  });

  it('.jsx and .cjs files join the walk', () => {
    expect(maybeFn(on, 'src/Legacy.jsx:legacy')).toBeTruthy();
    expect(maybeFn(on, 'src/conf.cjs:$module')).toBeTruthy();
  });

  it('--no-jsx: the previous model — JSX invisible, no .jsx/.cjs, no .tsx imports', () => {
    const f = fn(off, 'App.tsx:App');
    expect(names(f)).toEqual([]);
    expect(maybeFn(off, 'src/Legacy.jsx:legacy')).toBeUndefined();
    expect(maybeFn(off, 'src/conf.cjs:$module')).toBeUndefined();
    const g = extract(
      { ...WALK, 'src/use.ts': `import { helper } from './Child';\nexport const u = (x: string) => helper(x);` },
      { noAdapters: true, jsx: false },
    );
    expect(siteOf(fn(g, 'use.ts:u'), 'helper').opaque).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// component elements are calls
// ---------------------------------------------------------------------------

const COMPONENTS: Record<string, string> = {
  'src/App.tsx': `
import React, { memo, forwardRef } from 'react';
import { Button } from '@ui/kit';
import * as UI from '@ui/lib';
import Panel from './c/Panel';
import { Card } from './c/Card';
import Def from './c/Def';
const M = memo(Card);
const RM = React.memo(Card);
const Input = forwardRef((props: { v: string }, ref) => <input ref={ref} value={props.v} />);
export function App({ q, Comp }: { q: string; Comp: () => null }) {
  const rest = { title: q };
  return (
    <>
      <Panel body={q} />
      <M>{q}</M>
      <RM {...rest} />
      <Input v={q} />
      <Def d={q} />
      <Button label={q} />
      <UI.Link to={q} />
      <Comp a={q} />
    </>
  );
}
`,
  'src/c/Panel.tsx': `
export default function Panel({ body }: { body: string }) {
  return <div dangerouslySetInnerHTML={{ __html: body }} />;
}
`,
  'src/c/Card.tsx': `
export const Card = ({ title, children }: { title?: string; children?: unknown }) =>
  <h1 title={title}>{children}</h1>;
`,
  'src/c/Def.tsx': `
import { memo } from 'react';
export default memo(function Def({ d }: { d: string }) { return <a href={d} />; });
`,
};

describe('component elements are STATIC calls with the props object as arg 0', () => {
  const d = extract(COMPONENTS, { noAdapters: true });
  const app = fn(d, 'App.tsx:App');

  it('binds the tag to the component the checker resolves', () => {
    const cs = siteOf(app, 'src/c/Panel.tsx:Panel');
    expect(cs.kind).toBe('STATIC');
    expect(cs.opaque).toBe(false);
    expect(cs.argc).toBe(1);
    expect(cs.resultc).toBe(1);
    expect(String((cs.calleeIids as string[])[0])).toBe(
      Buffer.from(fnIID('testrepo', 'src/c', 'src/c/Panel.tsx:Panel')).toString('base64'),
    );
  });

  it('attributes, children and spreads all flow into the props port', () => {
    expect(connected(app, param(0), argOf(siteOf(app, 'src/c/Panel.tsx:Panel'), 0))).toBe(true);
    const cards = callsites(app).filter((c) => c.calleeFqn === 'src/c/Card.tsx:Card');
    expect(cards).toHaveLength(2); // memo(Card) and React.memo(Card), walked through
    for (const c of cards) expect(connected(app, param(0), argOf(c, 0))).toBe(true);
  });

  it('forwardRef(inline) and `export default memo(function …)` resolve too', () => {
    expect(siteOf(app, 'src/App.tsx:Input').opaque).toBe(false);
    const def = siteOf(app, 'src/c/Def.tsx:default');
    expect(def.opaque).toBe(false);
    expect(connected(app, param(0), argOf(def, 0))).toBe(true);
    // the wrapped function IS the component: its param 0 reaches its own sink
    const body = fn(d, 'Def.tsx:default');
    expect(connected(body, param(0), argOf(siteOf(body, 'jsx:attr-unsanitized:href'), 0))).toBe(true);
  });

  it('an unresolved tag keeps the import-qualified name, else jsx:<Name>', () => {
    for (const n of ['@ui/kit.Button', '@ui/lib.Link', 'jsx:Comp']) {
      const c = siteOf(app, n);
      expect(c.calleeFqn).toBe(n);
      expect(c.opaque).toBe(true);
      expect(connected(app, param(0), argOf(c, 0))).toBe(true);
    }
  });

  it('the props object reaches the sink inside the callee (interprocedural shape)', () => {
    const panel = fn(d, 'Panel.tsx:Panel');
    expect(connected(panel, param(0), argOf(siteOf(panel, 'jsx:html'), 0))).toBe(true);
  });

  it('counts the census', () => {
    expect(d.stats.jsxComponents).toBe(8);
    expect(d.stats.jsxComponentsResolved).toBe(5);
  });

  it('--no-jsx-components: no component call sites, facts stay', () => {
    const off = extract(COMPONENTS, { noAdapters: true, jsxComponents: false });
    expect(names(fn(off, 'App.tsx:App'))).toEqual([]);
    expect(names(fn(off, 'Panel.tsx:Panel'))).toEqual(['jsx:html']);
    // `export default memo(function …)` is not a function of its own then
    expect(maybeFn(off, 'Def.tsx:default')).toBeUndefined();
  });
});

describe('a wrapper wraps ARG 0, never a later inline function (review probes memo2, lazy2)', () => {
  const d = extract(
    {
      'package.json': '{"dependencies":{"react":"^19.0.0"}}',
      'src/C.tsx': `
import { memo } from 'react';
function Comp(props: { a: string }) { return <div dangerouslySetInnerHTML={{ __html: props.a }} />; }
export const MemoComp = memo(Comp, (p, n) => p.a === n.a);
export default memo(Comp, (prev, next) => prev.a === next.a);
`,
      'src/N.tsx': 'export function Named(p: { s: string }) { return <iframe srcDoc={p.s} />; }',
      'src/P.tsx': `
import { lazy } from 'react';
import Def, { MemoComp } from './C';
const L = lazy(() => import('./N').then((m) => ({ default: m.Named })));
export function P({ t }: { t: string }) {
  return <><MemoComp a={t} /><Def a={t} /><L s={t} /></>;
}
`,
    },
    { adapters: [] },
  );
  const p = fn(d, 'P.tsx:P');

  it('memo(Comp, areEqual) is Comp — for a const and for `export default`', () => {
    const comps = callsites(p).filter((c) => c.calleeFqn === 'src/C.tsx:Comp');
    expect(comps).toHaveLength(2);
    // the comparator is not a function of its own any more
    expect(maybeFn(d, 'C.tsx:MemoComp')).toBeUndefined();
    expect(maybeFn(d, 'C.tsx:default')).toBeUndefined();
  });

  it("lazy(() => import('./N').then((m) => ({ default: m.Named }))) is N's Named", () => {
    const l = siteOf(p, 'src/N.tsx:Named');
    expect(l.opaque).toBe(false);
    expect(connected(p, param(0), argOf(l, 0))).toBe(true);
  });
});

describe("a component's result does not smear into its parent's props", () => {
  // review probe `smear`: SearchBox returns markup built from a URL parameter;
  // as a child of Layout it must not make Layout's `home` prop look tainted
  const d = extract(
    {
      'src/a.tsx': `
import { useSearchParams } from 'react-router-dom';
const items = ['a', 'b'];
export function SearchBox() {
  const [sp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const hits = items.filter((i) => i.includes(q));
  return <ul>{hits.length}</ul>;
}
export function Layout(props: { home: string; children: unknown }) {
  return <div><a href={props.home}>home</a>{props.children}</div>;
}
export function Page() {
  const label = <SearchBox />;
  return <Layout home="/" title={label}><SearchBox /></Layout>;
}
`,
    },
    { noAdapters: true },
  );
  it('the child call is made, its result reaches neither the props nor the return', () => {
    const page = fn(d, 'a.tsx:Page');
    const boxes = callsites(page).filter((c) => c.calleeFqn === 'src/a.tsx:SearchBox');
    expect(boxes).toHaveLength(2);
    const layout = siteOf(page, 'src/a.tsx:Layout');
    for (const b of boxes) {
      expect(connected(page, resultOf(b), argOf(layout, 0))).toBe(false);
      expect(connected(page, resultOf(b), OUT_RETURN)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// intrinsic-element facts
// ---------------------------------------------------------------------------

const HOST = `
import { sanitize } from './s';
export function Page({ q, fn }: { q: string; fn: () => void }) {
  return (
    <main>
      <a href={q}>{q}</a>
      <a href="/static" />
      <a href={'/also-static'} />
      <iframe srcDoc={q} src={\`/embed/\${q}\`} />
      <object data={q} />
      <div data={q} />
      <form action={fn} formAction={() => fn()} />
      <section dangerouslySetInnerHTML={{ __html: sanitize(q), title: q }} />
    </main>
  );
}
`;
const host = (pkg?: string, o: ExtractOpts = {}) =>
  extract(
    {
      'src/Page.tsx': HOST,
      'src/s.ts': 'export function sanitize(s: string) { return s; }',
      ...(pkg ? { 'package.json': pkg } : {}),
    },
    { noAdapters: true, ...o },
  );

describe('intrinsic-element facts', () => {
  it('react unknown or < 19: URL attributes are jsx:attr-unsanitized:<name>', () => {
    for (const d of [host(), host('{"dependencies":{"react":"^18.2.0 || ^19.0.0"}}')]) {
      const n = names(fn(d, 'Page.tsx:Page')).filter((x) => x.startsWith('jsx:'));
      expect(n.sort()).toEqual([
        'jsx:attr-unsanitized:data',
        'jsx:attr-unsanitized:href',
        'jsx:attr-unsanitized:src',
        'jsx:attr:srcDoc',
        'jsx:html',
      ]);
    }
  });

  it('react >= 19 sanitises javascript: URLs: jsx:attr:<name>; srcDoc and html unchanged', () => {
    const d = host('{"dependencies":{"react":"^19.1.0"}}');
    expect(d.stats.reactMajor).toBe(19);
    const n = names(fn(d, 'Page.tsx:Page')).filter((x) => x.startsWith('jsx:'));
    expect(n.sort()).toEqual([
      'jsx:attr:data',
      'jsx:attr:href',
      'jsx:attr:src',
      'jsx:attr:srcDoc',
      'jsx:html',
    ]);
  });

  it('a fact is one arg, no result, fed by the attribute value', () => {
    const f = fn(host(), 'Page.tsx:Page');
    for (const n of ['jsx:attr-unsanitized:href', 'jsx:attr:srcDoc', 'jsx:attr-unsanitized:src']) {
      const c = siteOf(f, n);
      expect([c.argc, c.resultc, c.opaque]).toEqual([1, 0, true]);
      expect(connected(f, param(0), argOf(c, 0))).toBe(true);
    }
  });

  it('jsx:html receives the __html value, not its sibling properties', () => {
    const f = fn(host(), 'Page.tsx:Page');
    const html = siteOf(f, 'jsx:html');
    const san = siteOf(f, 'src/s.ts:sanitize');
    expect(connected(f, resultOf(san), argOf(html, 0))).toBe(true);
    // `title: q` sits in the same object literal but is not the markup
    expect(connected(f, param(0), argOf(html, 0))).toBe(false);
  });

  it('literals, text children, `data` off <object> and function actions are not facts', () => {
    const f = fn(host(), 'Page.tsx:Page');
    expect(names(f).filter((x) => x.endsWith(':href'))).toHaveLength(1);
    expect(names(f).filter((x) => x.includes('action') || x.includes('formAction'))).toEqual([]);
    expect(names(f).filter((x) => x.endsWith(':data'))).toHaveLength(1);
  });

  it('--no-jsx-facts: no jsx: facts at all', () => {
    const f = fn(host(undefined, { jsxFacts: false }), 'Page.tsx:Page');
    expect(names(f).filter((x) => x.startsWith('jsx:'))).toEqual([]);
  });
});

describe('reactMajor', () => {
  const repo = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fe-ts-react-'));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
  };
  it('reads the minimum major of the package.json range', () => {
    const pj = (r: string) => ({ 'package.json': JSON.stringify({ dependencies: { react: r } }) });
    expect(reactMajor(repo(pj('^19.0.0')))).toBe(19);
    expect(reactMajor(repo(pj('~18.3.1')))).toBe(18);
    expect(reactMajor(repo(pj('>=18 <20')))).toBe(18);
    expect(reactMajor(repo(pj('19.x')))).toBe(19);
    expect(reactMajor(repo(pj('latest')))).toBeNull();
    expect(reactMajor(repo(pj('npm:@preact/compat@^10')))).toBeNull();
    expect(reactMajor(repo({}))).toBeNull();
  });
  it('only the declared range counts — an installed node_modules never does (same bytes everywhere)', () => {
    expect(
      reactMajor(
        repo({
          'package.json': JSON.stringify({ dependencies: { react: '^18.3.0 || ^19.0.0' } }),
          'node_modules/react/package.json': JSON.stringify({ version: '19.2.1' }),
        }),
      ),
    ).toBe(18);
    expect(reactMajor(repo({ 'package.json': JSON.stringify({ dependencies: { react: '19.0.0 - 19.2.0' } }) }))).toBe(19);
  });
});

// ---------------------------------------------------------------------------
// hooks (coverage wave 1 §3.2) — adapters/react.toml
// ---------------------------------------------------------------------------

const HOOKS = {
  'package.json': '{"dependencies":{"react":"^19.0.0","react-router":"^7.0.0"}}',
  'src/Hooks.tsx': `
import { useState, useMemo, useReducer, lazy } from 'react';
import { useSearchParams } from 'react-router';
const Lazy = lazy(() => import('./LazyPage'));
export function Hooks() {
  const [sp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const [h, setH] = useState('');
  const [n, setN] = useState('');
  const [st, dispatch] = useReducer((s: unknown, a: unknown) => a, {});
  const trimmed = useMemo(() => q.trim(), [q]);
  return (
    <div onClick={() => { setH(q); setN((prev) => prev + trimmed); dispatch({ v: q }); }}>
      <p id="h" dangerouslySetInnerHTML={{ __html: h }} />
      <p id="n" dangerouslySetInnerHTML={{ __html: n }} />
      <p id="st" dangerouslySetInnerHTML={{ __html: st }} />
      <Lazy x={q} />
    </div>
  );
}
`,
  'src/LazyPage.tsx': 'export default function LazyPage(p: { x: string }) { return <p>{p.x}</p>; }',
};

describe('react hooks and wrappers (adapters/react.toml)', () => {
  const d = extract(HOOKS, { adapters: [] }); // auto-detect: react is a dependency
  const f = fn(d, 'Hooks.tsx:Hooks');
  const src = siteOf(f, 'react-router.useSearchParams');
  // calls are barriers: `q` is the result of `sp.get`, fed by the hook's result
  const q = siteOf(f, 'react-router.useSearchParams.$ret.sp.get');
  const htmls = callsites(f).filter((c) => c.calleeFqn === 'jsx:html');

  it('auto-detects the react adapter', () => {
    expect(d.stats.adapters).toEqual(['react']);
  });

  it('a destructured hook result carries the source into the tuple element', () => {
    // `const [sp] = useSearchParams(); sp.get('q')` — the result port reaches
    // the receiver port of the (syntactically named) `.get`
    const get = siteOf(f, 'react-router.useSearchParams.$ret.sp.get');
    expect(get.arg0IsReceiver).toBe(true);
    expect(connected(f, resultOf(src), argOf(get, 0))).toBe(true);
  });

  it('setS(v) writes v into s (useState)', () => {
    expect(connected(f, resultOf(q), argOf(htmls[0]!, 0))).toBe(true);
  });

  it('a functional update reads the state and writes the callback result; useMemo returns its callback result', () => {
    const trim = siteOf(f, '.trim');
    expect(connected(f, resultOf(trim), argOf(htmls[1]!, 0))).toBe(true);
    expect(connected(f, resultOf(siteOf(f, 'react.useMemo')), argOf(htmls[1]!, 0))).toBe(true);
  });

  it("useReducer's dispatch carries its action into the state", () => {
    expect(connected(f, resultOf(q), argOf(htmls[2]!, 0))).toBe(true);
  });

  it('lazy(() => import(…)) binds the element to the module default export', () => {
    const lazy = siteOf(f, 'src/LazyPage.tsx:LazyPage');
    expect(lazy.opaque).toBe(false);
    expect(connected(f, resultOf(q), argOf(lazy, 0))).toBe(true);
  });

  it('a setter is matched by its binding, not its name (review probe `hooks`)', () => {
    const h = extract(
      {
        'package.json': '{"dependencies":{"react":"^19.0.0"}}',
        'src/A.tsx': `
import { useState } from 'react';
declare function src(): string;
declare function sink(x: string): void;
export function Three() {
  const [a, setX] = useState('');
  function Inner() {
    const [b, setX] = useState('');
    setX(src());
    sink(b);
    return null;
  }
  sink(a);
  return <Inner />;
}
export function Six() {
  const [v, setV] = useState('');
  {
    const setV = (x: string) => sink(x);
    setV(src());
  }
  sink(v);
  return null;
}
`,
      },
      { adapters: [] },
    );
    const sinkArgs = (f: Record<string, unknown>) => callsites(f).filter((c) => c.calleeFqn === 'sink');
    const three = fn(h, 'A.tsx:Three');
    const src3 = siteOf(three, 'src');
    const [sinkB, sinkA] = sinkArgs(three); // sink(b) comes first in source order
    expect(connected(three, resultOf(src3), argOf(sinkB!, 0))).toBe(true);
    expect(connected(three, resultOf(src3), argOf(sinkA!, 0))).toBe(false);
    // a shadowing `const setV = …` is an ordinary function, not the setter
    const six = fn(h, 'A.tsx:Six');
    const last = sinkArgs(six).pop()!;
    expect(connected(six, resultOf(siteOf(six, 'src')), argOf(last, 0))).toBe(false);
  });

  it('--no-adapter react: no state, thunk or lazy modelling', () => {
    const off = extract(HOOKS, { adapters: [], excludeAdapters: ['react'] });
    expect(off.stats.adapters).toEqual([]);
    const g = fn(off, 'Hooks.tsx:Hooks');
    const hs = callsites(g).filter((c) => c.calleeFqn === 'jsx:html');
    const get = siteOf(g, 'react-router.useSearchParams.$ret.sp.get');
    expect(connected(g, resultOf(get), argOf(hs[0]!, 0))).toBe(false);
    expect(siteOf(g, 'src/Hooks.tsx:Lazy').opaque).toBe(false); // the thunk, as before
  });
});

// ---------------------------------------------------------------------------
// fixtures/reactapp — the §5 acceptance shapes, frontend half
// ---------------------------------------------------------------------------

describe('fixtures/reactapp', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'reactapp');
  const d = extractDir(dir, { repoId: 'reactapp' });
  const search = fn(d, 'SearchPage.tsx:SearchPage');
  const q = siteOf(search, 'react-router.useSearchParams.$ret.params.get');

  it('auto-detects react, and react ^19 names URL attributes jsx:attr:*', () => {
    expect(d.stats.adapters).toEqual(['react']);
    expect(d.stats.reactMajor).toBe(19);
    expect(names(fn(d, 'UserPage.tsx:UserPage'))).toContain('jsx:attr:href');
  });

  it('useSearchParams -> prop -> prop -> dangerouslySetInnerHTML, hop by hop', () => {
    expect(connected(search, resultOf(siteOf(search, 'react-router.useSearchParams')), argOf(q, 0))).toBe(true);
    const results = siteOf(search, 'src/components/Results.tsx:Results');
    expect(connected(search, resultOf(q), argOf(results, 0))).toBe(true);
    const r = fn(d, 'Results.tsx:Results');
    const highlight = siteOf(r, 'src/components/Highlight.tsx:Highlight'); // through memo()
    expect(connected(r, param(0), argOf(highlight, 0))).toBe(true);
    const h = fn(d, 'Highlight.tsx:Highlight');
    expect(connected(h, param(0), argOf(siteOf(h, 'jsx:html'), 0))).toBe(true);
  });

  it('the onClick body sink is found', () => {
    expect(connected(search, resultOf(q), argOf(siteOf(search, 'assign:location.href'), 0))).toBe(true);
  });

  it('a useState setter carries the value into the state rendered as HTML', () => {
    expect(connected(search, resultOf(q), argOf(siteOf(search, 'jsx:html'), 0))).toBe(true);
  });

  it('fetch with an env base: http:GET /{}/api/users/{} fed by useParams', () => {
    const u = fn(d, 'UserPage.tsx:UserPage');
    const site = siteOf(u, 'http:GET /{}/api/users/{}');
    expect(site.httpCall).toEqual({ method: 'GET', path: '/{}/api/users/{}' });
    expect(connected(u, resultOf(siteOf(u, 'react-router-dom.useParams')), argOf(site, 0))).toBe(true);
  });

  it('axios.post body from a form input, through state', () => {
    const s = fn(d, 'SignupPage.tsx:SignupPage');
    const post = siteOf(s, 'http:POST /api/users');
    expect(connected(s, resultOf(siteOf(s, 'read:event.target.value')), argOf(post, 0))).toBe(true);
  });

  it('double extract is byte-identical', () => {
    const again = extractDir(dir, { repoId: 'reactapp' });
    const read = (x: typeof d): Array<[string, string]> =>
      fs.readdirSync(x.outDir).sort().map((f) => [f, fs.readFileSync(path.join(x.outDir, f)).toString('base64')]);
    expect(read(again)).toEqual(read(d));
  });

  it('every new switch off: none of the above exists', () => {
    const off = extractDir(dir, {
      repoId: 'reactapp',
      jsx: false,
      httpCalls: false,
      httpRoutes: false,
      excludeAdapters: ['react'],
    });
    const all = off.functions.flatMap((f) => names(f));
    expect(all.filter((n) => /^(jsx:|http:|assign:)|Results|Highlight/.test(n))).toEqual([]);
  });
});
