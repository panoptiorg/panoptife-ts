import { describe, expect, it } from 'vitest';
import { CALL_ARG_PORT, callsites, connected, extract, fn, kindOf } from './helpers.js';

// Library write-back: at a call with no in-repo target, an argument naming a
// variable writes back into it, so a core-side [[propagators]] rule that
// writes the port (`parts.push(x)` fills `parts`) reaches the later uses.
const SRC = `
export function viaPush(el: HTMLElement, q: string) {
  const parts: string[] = [];
  parts.push(q);
  el.innerHTML = parts.join(',');
}
export function viaMap(q: string) {
  const m = new Map<string, string>();
  m.set('k', q);
  return m.get('k');
}
export function viaAssign(q: string) {
  const target: { v?: string } = {};
  Object.assign(target, { v: q });
  return target.v;
}
export function viaCallResult(q: string) {
  make().push(q);
}
declare function make(): string[];
`;

const port = (f: Record<string, unknown>, fqn: string, idx: number) => (v: Record<string, unknown>) => {
  if (kindOf(v) !== CALL_ARG_PORT || Number(v.index ?? 0) !== idx) return false;
  const cs = callsites(f)[Number(v.callsiteId ?? 0)];
  return String(cs?.calleeFqn) === fqn;
};

describe('library write-back', () => {
  const on = extract({ 'src/lib.ts': SRC }, { noAdapters: true });
  const off = extract({ 'src/lib.ts': SRC }, { noAdapters: true, libraryWriteback: false });

  it('names built-in container receivers so a rule can select them', () => {
    const names = (d: typeof on, f: string) => callsites(fn(d, f)).map((c) => String(c.calleeFqn));
    expect(names(on, 'viaPush')).toEqual(expect.arrayContaining(['Array.push', 'Array.join']));
    expect(names(on, 'viaMap')).toEqual(expect.arrayContaining(['Map.set', 'Map.get']));
    // off: exactly the previous (untyped) names
    expect(names(off, 'viaPush')).toEqual(expect.arrayContaining(['.push', '.join']));
  });

  it('wires the receiver port of a library call back into the variable', () => {
    const f = fn(on, 'viaPush');
    expect(connected(f, port(f, 'Array.push', 0), port(f, 'Array.join', 0))).toBe(true);
    const g = fn(off, 'viaPush');
    expect(connected(g, port(g, '.push', 0), port(g, '.join', 0))).toBe(false);
  });

  it('writes back through a plain argument too (Object.assign target)', () => {
    const f = fn(on, 'viaAssign');
    // port 1 is `target` (port 0 is the `Object` receiver); its write-back
    // reaches the function's return of target.v
    const tgt = port(f, 'Object.assign', 1);
    const ret = (v: Record<string, unknown>) => kindOf(v) === 'OUT_RETURN';
    expect(connected(f, tgt, ret)).toBe(true);
    // the global receiver `Object` never becomes a write-back source
    expect(connected(f, port(f, 'Object.assign', 0), ret)).toBe(false);
  });

  it('does not invent a variable for a call-result receiver', () => {
    const f = fn(on, 'viaCallResult');
    const push = callsites(f).findIndex((c) => String(c.calleeFqn).endsWith('.push'));
    expect(push).toBeGreaterThanOrEqual(0);
    expect(connected(f, port(f, String(callsites(f)[push]!.calleeFqn), 0), () => true)).toBe(false);
  });
});
