// callee naming regressions. The lookup tables in naming.ts are indexed with
// UNTRUSTED source names: on a plain object `ROUTE_SOURCE_CALLS['toString']`
// resolved to the inherited `Object.prototype.toString`, so a repo that exports
// its own `toString` crashed the build with
// `cgf verify: functions.flow.callsites.calleeFqn: string expected`.
import { describe, expect, it } from 'vitest';

import { PROP_TYPE, ROUTE_SOURCE_CALLS } from '../src/naming.js';
import { extract, fn, siteOf } from './helpers.js';

// an in-repo helper with an Object.prototype name, called as a plain identifier
const SRC = `
import { toString } from './converters';
export function mapIssue(v: { email?: string }) {
  return { email: toString(v.email) };
}
export function valueOfIt(v: { n?: number }) {
  return String(valueOf(v.n));
}
`;

const CONVERTERS = `
export const toString = (value?: number | string): string | undefined =>
  value ? String(value).trim() : undefined;
export const valueOf = (value?: number): string | undefined =>
  value === undefined ? undefined : String(value);
`;

describe('callee naming', () => {
  it('does not inherit Object.prototype keys in the lookup tables', () => {
    expect(ROUTE_SOURCE_CALLS['toString']).toBeUndefined();
    expect(ROUTE_SOURCE_CALLS['constructor']).toBeUndefined();
    expect(ROUTE_SOURCE_CALLS['hasOwnProperty']).toBeUndefined();
    expect(PROP_TYPE['toString']).toBeUndefined();
    expect(PROP_TYPE['valueOf']).toBeUndefined();
  });

  it('extracts a repo whose helper is named toString / valueOf', () => {
    const d = extract({ 'src/lib.ts': SRC, 'src/converters.ts': CONVERTERS }, { noAdapters: true });
    const cs = siteOf(fn(d, 'mapIssue'), 'toString');
    // resolved to the in-repo helper (or named opaquely) — a string either way,
    // one argument carried, never the inherited Object.prototype member
    expect(typeof cs.calleeFqn).toBe('string');
    expect(String(cs.calleeFqn)).not.toMatch(/native code/i);
    expect(Number(cs.argc)).toBe(1);
    expect(typeof siteOf(fn(d, 'valueOfIt'), 'valueOf').calleeFqn).toBe('string');
  });
});
