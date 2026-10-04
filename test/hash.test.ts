import { describe, expect, it } from 'vitest';
import { contractIID, hex, iidFromParts } from '../src/hash.js';

// Reference digests produced by the Go implementation
// (frontend/internal/hash/hash.go — writeField = u64 LE length || bytes).
// If this test ever fails, cross-repo composition is silently broken: the TS
// client and the Go server would compute different join keys for the same
// GraphQL field.
describe('ContractIID is byte-equal to the Go frontend', () => {
  it('graphql:Query.searchByToken', () => {
    expect(hex(contractIID('graphql:Query.searchByToken'))).toBe(
      'fbfd406e63d5ef847b7a837bcaaf8b92e4c79686cfe88a51086cc87c4c6459cf',
    );
  });
  it('graphql:AuthMutations.login', () => {
    expect(hex(contractIID('graphql:AuthMutations.login'))).toBe(
      '126c74c8b33931a4ceae77cec8d2cf2c50c94d9fb1884e86ca6d71f0e6ba8cb6',
    );
  });
  it('pb.Account/GetAccount (gRPC shape, same function)', () => {
    expect(hex(contractIID('pb.Account/GetAccount'))).toBe(
      '2f3f5d36df6f8880addccb7840a4fd4377a695f2f5e3acbd6accf2d5084debe4',
    );
  });
  it('ContractIID is IIDFromParts("", "", name, "grpc")', () => {
    expect(hex(contractIID('x'))).toBe(hex(iidFromParts('', '', 'x', 'grpc')));
  });
});
