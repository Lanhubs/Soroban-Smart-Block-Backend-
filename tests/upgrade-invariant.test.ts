import { describe, it, expect } from 'vitest';
import {
  xdr,
  Keypair,
  Account,
  TransactionBuilder,
  Networks,
  Operation,
  Address,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { verifyUpgradeInvariants, gateUpgrade, CandidateXdrs } from '../src/indexer/upgrade-invariant';

// ── helpers ──────────────────────────────────────────────────────────────────

const FAKE_CONTRACT_ID = Buffer.alloc(32, 0xab);

function buildEnvelopeXdr(): string {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), '100');
  const contractAddress = xdr.ScAddress.scAddressTypeContract(FAKE_CONTRACT_ID);
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress,
    functionName: Buffer.from('swap'),
    args: [nativeToScVal(100n, { type: 'i128' })],
  });
  const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
  const op = Operation.invokeHostFunction({ func: hostFn, auth: [] });
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(30)
    .build();
  return tx.toEnvelope().toXDR('base64');
}

function buildResultXdr(): string {
  const result = new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('100'),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: xdr.TransactionResultExt.fromXDR('AAAAAA==', 'base64'),
  });
  return result.toXDR('base64');
}

// ── verifyUpgradeInvariants ───────────────────────────────────────────────────

describe('verifyUpgradeInvariants', () => {
  it('returns safe=true with all passed when valid envelope is provided', () => {
    const candidates: CandidateXdrs = { envelopeXdr: buildEnvelopeXdr() };
    const result = verifyUpgradeInvariants(candidates, 21);

    expect(result.safe).toBe(true);
    expect(result.protocolVersion).toBe(21);
    expect(result.violations).toHaveLength(0);
    expect(result.passed).toContain('envelope:decodable');
    expect(result.passed).toContain('envelope:known-switch');
    expect(result.passed).toContain('envelope:has-operations');
  });

  it('returns safe=true with valid result XDR', () => {
    const candidates: CandidateXdrs = { resultXdr: buildResultXdr() };
    const result = verifyUpgradeInvariants(candidates, 20);

    expect(result.safe).toBe(true);
    expect(result.passed).toContain('result:decodable');
    expect(result.passed).toContain('result:has-result-union');
  });

  it('skips all invariants when no candidates are provided', () => {
    const result = verifyUpgradeInvariants({}, 21);

    expect(result.safe).toBe(true);
    expect(result.passed).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('reports violation for a corrupt envelope XDR', () => {
    const candidates: CandidateXdrs = { envelopeXdr: 'not-valid-base64-xdr==' };
    const result = verifyUpgradeInvariants(candidates, 21);

    expect(result.safe).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].invariant).toBe('envelope:decodable');
  });

  it('reports violation for a corrupt result XDR', () => {
    const candidates: CandidateXdrs = { resultXdr: 'AAAA' };
    const result = verifyUpgradeInvariants(candidates, 20);

    expect(result.safe).toBe(false);
    expect(result.violations.some((v) => v.invariant.startsWith('result:'))).toBe(true);
  });

  it('skips version-specific invariants below their minimum version', () => {
    // envelope:soroban-v1-invoke-host-function-arm requires minVersion 20
    const candidates: CandidateXdrs = { envelopeXdr: buildEnvelopeXdr() };
    const result = verifyUpgradeInvariants(candidates, 19);

    expect(result.skipped).toContain('envelope:soroban-v1-invoke-host-function-arm');
  });

  it('runs version-specific invariants at or above their minimum version', () => {
    const candidates: CandidateXdrs = { envelopeXdr: buildEnvelopeXdr() };
    const result = verifyUpgradeInvariants(candidates, 20);

    // Should be checked (not skipped) and should pass for a valid envelope
    expect(result.skipped).not.toContain('envelope:soroban-v1-invoke-host-function-arm');
    expect(result.passed).toContain('envelope:soroban-v1-invoke-host-function-arm');
  });

  it('includes both passed and skipped in the result', () => {
    const candidates: CandidateXdrs = { envelopeXdr: buildEnvelopeXdr() };
    const result = verifyUpgradeInvariants(candidates, 21);

    // result/resultMeta/ledgerEntry invariants should be skipped (no samples)
    expect(result.skipped).toContain('result:decodable');
    expect(result.skipped).toContain('resultMeta:decodable');
    expect(result.skipped).toContain('ledgerEntry:decodable');
  });
});

// ── gateUpgrade ───────────────────────────────────────────────────────────────

describe('gateUpgrade', () => {
  it('returns true when all provided invariants pass', () => {
    const candidates: CandidateXdrs = { envelopeXdr: buildEnvelopeXdr() };
    expect(gateUpgrade(candidates, 21)).toBe(true);
  });

  it('returns false when an invariant fails', () => {
    const candidates: CandidateXdrs = { envelopeXdr: 'garbage-xdr' };
    expect(gateUpgrade(candidates, 21)).toBe(false);
  });

  it('returns true when no candidates are provided (nothing to fail)', () => {
    expect(gateUpgrade({}, 21)).toBe(true);
  });
});
