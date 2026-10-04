// Content addressing — byte-compatible with the Go frontend's
// `frontend/internal/hash/hash.go`.
//
//   writeField(h, b) = u64 little-endian len(b) || b
//   IIDFromParts(repo, pkgPath, symbol, signature)
//       = sha256(field(repo) field(pkgPath) field(symbol) field(signature))
//   ContractIID(fullName) = IIDFromParts("", "", fullName, "grpc")
//
// ContractIID MUST stay byte-equal to Go's: it is the cross-repo join key the
// Rust core composes on (`compose.rs`). Verified in test/hash.test.ts against
// the reference digests produced by the Go implementation.
import { createHash, type Hash } from 'node:crypto';

export function field(s: string | Uint8Array): Buffer {
  const b = typeof s === 'string' ? Buffer.from(s, 'utf8') : Buffer.from(s);
  const l = Buffer.alloc(8);
  l.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([l, b]);
}

function writeField(h: Hash, s: string | Uint8Array): void {
  h.update(field(s));
}

export function iidFromParts(
  repo: string,
  pkgPath: string,
  symbol: string,
  signature: string,
): Uint8Array {
  const h = createHash('sha256');
  writeField(h, repo);
  writeField(h, pkgPath);
  writeField(h, symbol);
  writeField(h, signature);
  return new Uint8Array(h.digest());
}

/** Cross-repo contract join key. Byte-equal to Go `hash.ContractIID`. */
export function contractIID(fullName: string): Uint8Array {
  return iidFromParts('', '', fullName, 'grpc');
}

/** Function identity for a TS symbol. Only needs to be stable + unique. */
export function fnIID(repo: string, pkgPath: string, fqn: string): Uint8Array {
  return iidFromParts(repo, pkgPath, fqn, 'ts');
}

/** Endpoint identity (HTTP routes). */
export function endpointIID(repo: string, name: string): Uint8Array {
  return iidFromParts(repo, '', name, 'http');
}

export function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}
