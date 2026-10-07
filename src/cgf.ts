// CGF wire encoding. `proto/cgf.proto` is loaded at RUNTIME with protobufjs
// (no codegen), so a schema change is picked up automatically — including
// `CallSite.arg_names`, which is emitted only when the loaded descriptor
// actually has the field (protobufjs silently drops unknown keys, so a blind
// write would be a lie).
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
// protobufjs is CJS; a default import through ESM interop is unreliable here.
const protobuf = require_('protobufjs') as typeof import('protobufjs');

export const SCHEMA_VERSION = 1;

// Enum constants (cgf.proto). Kept as literals so the emitter reads the same
// whether or not the descriptor is loaded.
export const VertexKind = {
  IN_PARAM: 0,
  IN_RECEIVER: 1,
  IN_GLOBAL: 2,
  OUT_RETURN: 3,
  OUT_PARAM_BYREF: 4,
  OUT_FIELD: 5,
  CALL_ARG_PORT: 6,
  CALL_RESULT_PORT: 7,
  OUT_RECEIVER_BYREF: 8,
} as const;

export const CallKind = {
  STATIC: 0,
  VIRTUAL: 1,
  INVOKES_REMOTE: 2,
  GO: 3,
  DEFER: 4,
  BUILTIN: 5,
} as const;

export const EndpointKind = { GRPC: 0, GRAPHQL: 1, HTTP: 2 } as const;

export interface CgfCodec {
  encodePackage(pkg: unknown): Uint8Array;
  /** true when the loaded cgf.proto declares CallSite.arg_names. */
  hasArgNames: boolean;
  /** true when the loaded cgf.proto declares GraphqlField.args. */
  hasGraphqlArgs: boolean;
  protoPath: string;
}

/**
 * Locate `cgf.proto`, in order:
 *   1. `$PC_CGF_PROTO` — point at another checkout's canonical copy;
 *   2. this repo's own vendored `proto/cgf.proto`, resolved relative to the
 *      module, so it works from `src/` (tests) and from `dist/` alike;
 *   3. a walk up from the module, for a checkout nested in a larger tree.
 */
export function findProto(start?: string): string {
  const env = process.env.PC_CGF_PROTO;
  if (env && fs.existsSync(env)) return env;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const vendored = path.resolve(here, '..', 'proto', 'cgf.proto');
  if (fs.existsSync(vendored)) return vendored;
  let dir = start ?? here;
  for (let i = 0; i < 12; i++) {
    const p = path.join(dir, 'proto', 'cgf.proto');
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('cannot locate proto/cgf.proto (set PC_CGF_PROTO)');
}

export function loadCodec(protoPath?: string): CgfCodec {
  const p = protoPath ?? findProto();
  const root = protobuf.loadSync(p);
  root.resolveAll();
  const Pkg = root.lookupType('panopticode.cgf.CgfPackage');
  const CallSite = root.lookupType('panopticode.cgf.CallSite');
  let hasGraphqlArgs = false;
  try {
    hasGraphqlArgs = !!root.lookupType('panopticode.cgf.GraphqlField').fields['args'];
  } catch {
    hasGraphqlArgs = false;
  }
  const hasArgNames = !!CallSite.fields['arg_names'] || !!CallSite.fields['argNames'];
  return {
    protoPath: p,
    hasArgNames,
    hasGraphqlArgs,
    encodePackage(pkg: unknown): Uint8Array {
      const err = Pkg.verify(pkg as Record<string, unknown>);
      if (err) throw new Error(`cgf verify: ${err}`);
      // encode() straight off the plain object: field order is the descriptor's
      // declaration order and repeated fields keep array order, so the bytes are
      // a pure function of the facts (double-extract must be byte-identical).
      return Pkg.encode(pkg as never).finish();
    },
  };
}
