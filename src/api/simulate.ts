import { Router, Request, Response } from 'express';
import { xdr, Transaction, FeeBumpTransaction, SorobanRpc } from '@stellar/stellar-sdk';
import { rpc } from '../indexer/rpc';
import { config } from '../config';
import { parseInvokeHostFunction } from '../indexer/xdr-parser';
import { getContractAbi } from '../indexer/registry';
import { decodeScVal } from '../indexer/args-decoder';
import { formatFootprint } from '../indexer/footprint-formatter';
import { generateAuthSnapshots } from '../indexer/auth-snippet-gen';
import { xdr } from '@stellar/stellar-sdk';
import { rpc } from '../indexer/rpc';
import { parseInvokeHostFunction } from '../indexer/xdr-parser';
import { getContractAbi } from '../indexer/registry';
import { decodeScVal } from '../indexer/args-decoder';
import { prisma } from '../db';

export const simulateRouter = Router();

// ── Param diagnostics ─────────────────────────────────────────────────────────

interface ParamDiagnostic {
  index: number;
  name: string;
  expectedType: string;
  providedType: string;
  value: unknown;
  issue: string;
}

const XDR_TYPE_MAP: Record<string, string[]> = {
  address: ['scvAddress'], bool: ['scvBool'],
  i128: ['scvI128'], u128: ['scvU128'],
  i64: ['scvI64'],   u64: ['scvU64'],
  i32: ['scvI32'],   u32: ['scvU32'],
  string: ['scvString'], symbol: ['scvSymbol'],
  bytes: ['scvBytes'],   void: ['scvVoid'],
};

function detectTypeMismatch(abiType: string, xdrType: string, value: unknown): string | null {
  const allowed = XDR_TYPE_MAP[abiType.toLowerCase()];
  if (!allowed) return null;
  if (!allowed.includes(xdrType))
    return `Type mismatch: expected ${abiType} (${allowed.join('|')}) but got ${xdrType}`;
  if (['u32','u64','u128'].includes(abiType) && typeof value === 'bigint' && value < 0n)
    return `Value ${value} is negative but ${abiType} must be ≥ 0`;
  return null;
}

/**
 * Validate decoded XDR args against the ABI and return per-param diagnostics
 * for any type mismatches or missing arguments.
 */
function diagnoseArgs(
  fnName: string,
  rawArgs: xdr.ScVal[],
  abi: Awaited<ReturnType<typeof getContractAbi>>,
  decimals?: number,
  decimals?: number
): ParamDiagnostic[] {
  if (!abi) return [];
  const fn = abi.functions.find((f) => f.name === fnName);
  if (!fn) return [];
  const issues: ParamDiagnostic[] = [];
  for (let i = 0; i < fn.inputs.length; i++) {
    const param = fn.inputs[i];
    const val = rawArgs[i];
    if (!val) {
      issues.push({ index: i, name: param.name, expectedType: param.type,
        providedType: 'missing', value: undefined,
        issue: `Missing required argument "${param.name}" (expected ${param.type})` });
      continue;
    }
    const mismatch = detectTypeMismatch(param.type, val.switch().name, decodeScVal(val, param, decimals).raw);
    if (mismatch)
      issues.push({ index: i, name: param.name, expectedType: param.type,
        providedType: val.switch().name, value: decodeScVal(val, param, decimals).formatted, issue: mismatch });
  }
  if (rawArgs.length > fn.inputs.length)
    issues.push({ index: fn.inputs.length, name: '(extra)', expectedType: 'none',
      providedType: 'extra', value: null,
      issue: `${rawArgs.length - fn.inputs.length} unexpected extra argument(s) passed to "${fnName}"` });
  return issues;
}

// ── Route ─────────────────────────────────────────────────────────────────────

  const issues: ParamDiagnostic[] = [];

  // Check for missing arguments
  for (let i = 0; i < fn.inputs.length; i++) {
    const param = fn.inputs[i];
    const val = rawArgs[i];

    if (!val) {
      issues.push({
        index: i,
        name: param.name,
        expectedType: param.type,
        providedType: 'missing',
        value: undefined,
        issue: `Missing required argument "${param.name}" (expected ${param.type})`,
      });
      continue;
    }

    const providedType = val.switch().name;
    const decoded = decodeScVal(val, param, decimals);

    // Type compatibility check
    const mismatch = detectTypeMismatch(param.type, providedType, decoded.raw);
    if (mismatch) {
      issues.push({
        index: i,
        name: param.name,
        expectedType: param.type,
        providedType,
        value: decoded.formatted,
        issue: mismatch,
      });
    }
  }

  // Extra args beyond what ABI expects
  if (rawArgs.length > fn.inputs.length) {
    issues.push({
      index: fn.inputs.length,
      name: '(extra)',
      expectedType: 'none',
      providedType: 'extra',
      value: null,
      issue: `${rawArgs.length - fn.inputs.length} unexpected extra argument(s) passed to "${fnName}"`,
    });
  }

  return issues;
}

function detectTypeMismatch(
  abiType: string,
  xdrType: string,
  value: unknown
): string | null {
  const t = abiType.toLowerCase();

  const typeMap: Record<string, string[]> = {
    address: ['scvAddress'],
    bool: ['scvBool'],
    i128: ['scvI128'],
    u128: ['scvU128'],
    i64: ['scvI64'],
    u64: ['scvU64'],
    i32: ['scvI32'],
    u32: ['scvU32'],
    string: ['scvString'],
    symbol: ['scvSymbol'],
    bytes: ['scvBytes'],
    void: ['scvVoid'],
  };

  const allowed = typeMap[t];
  if (!allowed) return null; // unknown/complex type — skip check

  if (!allowed.includes(xdrType)) {
    return `Type mismatch: expected ${abiType} (${allowed.join('|')}) but got ${xdrType}`;
  }

  // Range checks for bounded integers
  if (t === 'u32' && typeof value === 'number' && value < 0) {
    return `Value ${value} is negative but u32 must be ≥ 0`;
  }
  if (t === 'u64' && typeof value === 'bigint' && value < 0n) {
    return `Value ${value} is negative but u64 must be ≥ 0`;
  }
  if (t === 'u128' && typeof value === 'bigint' && value < 0n) {
    return `Value ${value} is negative but u128 must be ≥ 0`;
  }

  return null;
}

/**
 * POST /api/v1/simulate
 * Body: { transaction: "<base64 XDR>" }
 *
 * Proxies to Soroban RPC simulateTransaction and overlays:
 *   - On success: formatted resource footprint + recording-mode auth snapshots
 *     with copy-paste JS/Rust signing snippets.
 *   - On failure: ABI-aware per-param diagnostics.
 */
simulateRouter.post('/', async (req: Request, res: Response) => {
  const { transaction } = req.body as { transaction?: string };
  if (!transaction || typeof transaction !== 'string')
    return res.status(400).json({ error: 'Body must include a base64 XDR "transaction" field.' });

  const parsed = parseInvokeHostFunction(transaction);

  let txObj: Transaction | FeeBumpTransaction;
  try {
    try { txObj = new Transaction(transaction, config.networkPassphrase); }
    catch { txObj = new FeeBumpTransaction(transaction, config.networkPassphrase); }
  } catch (err) {
    return res.status(400).json({ error: 'Invalid transaction XDR', detail: String(err) });
  }

  let rpcResult: SorobanRpc.Api.SimulateTransactionResponse;
  try {
    rpcResult = await rpc.simulateTransaction(txObj);
  } catch (err) {
    return res.status(502).json({ error: 'RPC request failed', detail: String(err) });
  }

  // ── Success ───────────────────────────────────────────────────────────────
  if (SorobanRpc.Api.isSimulationSuccess(rpcResult) || SorobanRpc.Api.isSimulationRestore(rpcResult)) {
    const footprint = formatFootprint(rpcResult);
    const authSnapshots = rpcResult.result?.auth
      ? generateAuthSnapshots(rpcResult.result.auth)
      : [];
    return res.json({ status: 'success', simulation: rpcResult, footprint, authSnapshots, parsed });
  }

  // ── Failure — diagnostic overlay ──────────────────────────────────────────
  const rpcError = (rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
  let paramIssues: ParamDiagnostic[] = [];
  let humanSummary = rpcError;

  if (parsed) {
    const { contractId, functionName } = parsed;
    let rawArgs: xdr.ScVal[] = [];
    try {
      const envelope = xdr.TransactionEnvelope.fromXDR(transaction, 'base64');
      const ops = envelope.switch().name === 'envelopeTypeTx'
        ? envelope.v1().tx().operations() : envelope.v0().tx().operations();
      const invokeOp = ops.find((op) => op.body().switch().name === 'invokeHostFunction');
      if (invokeOp)
        rawArgs = invokeOp.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
    } catch { /* leave empty */ }
 * Proxies to Soroban RPC simulateTransaction. On failure, overlays
 * ABI-aware diagnostics explaining which parameters are breaking the call.
 */
simulateRouter.post('/', async (req: Request, res: Response) => {
  const { transaction } = req.body as { transaction?: string };

  if (!transaction || typeof transaction !== 'string') {
    return res.status(400).json({ error: 'Body must include a base64 XDR "transaction" field.' });
  }

  // Parse the transaction locally before hitting RPC
  const parsed = parseInvokeHostFunction(transaction);

  // Run RPC simulation
  let rpcResult: Awaited<ReturnType<typeof rpc.simulateTransaction>>;
  try {
    // The SDK's simulateTransaction accepts a Transaction or FeeBumpTransaction.
    // We reconstruct it from the raw XDR envelope.
    const { Transaction, FeeBumpTransaction } = await import('@stellar/stellar-sdk');
    let txObj: InstanceType<typeof Transaction> | InstanceType<typeof FeeBumpTransaction>;
    try {
      txObj = new Transaction(transaction, (await import('../config')).config.networkPassphrase);
    } catch {
      txObj = new FeeBumpTransaction(transaction, (await import('../config')).config.networkPassphrase);
    }
    rpcResult = await rpc.simulateTransaction(txObj);
  } catch (err: unknown) {
    return res.status(502).json({
      error: 'RPC request failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // If simulation succeeded, return the raw RPC result with decoded context
  if (!('error' in rpcResult) || !rpcResult.error) {
    return res.json({ status: 'success', simulation: rpcResult, parsed });
  }

  // ── Simulation failed — build diagnostic overlay ──────────────────────────
  const rpcError = (rpcResult as any).error as string;
  const diagnostics: {
    rpcError: string;
    contract: string | null;
    function: string | null;
    paramIssues: ParamDiagnostic[];
    humanSummary: string;
  } = {
    rpcError,
    contract: parsed?.contractId ?? null,
    function: parsed?.functionName ?? null,
    paramIssues: [],
    humanSummary: rpcError,
  };

  if (parsed) {
    const { contractId, functionName } = parsed;

    // Re-extract raw ScVal args from the envelope for type checking
    let rawArgs: xdr.ScVal[] = [];
    try {
      const envelope = xdr.TransactionEnvelope.fromXDR(transaction, 'base64');
      const ops =
        envelope.switch().name === 'envelopeTypeTx'
          ? envelope.v1().tx().operations()
          : envelope.v0().tx().operations();
      const invokeOp = ops.find((op) => op.body().switch().name === 'invokeHostFunction');
      if (invokeOp) {
        rawArgs = invokeOp
          .body()
          .invokeHostFunctionOp()
          .hostFunction()
          .invokeContract()
          .args();
      }
    } catch {
      // leave rawArgs empty
    }

    const [abi, contract] = await Promise.all([
      getContractAbi(contractId),
      prisma.contract.findUnique({ where: { address: contractId } }),
    ]);

    paramIssues = diagnoseArgs(functionName, rawArgs, abi, contract?.tokenDecimals ?? undefined);

    humanSummary = paramIssues.length > 0
      ? `Call to "${functionName}" on ${contract?.name ?? contractId} will fail:\n` +
        paramIssues.map((p) => `  • [arg ${p.index}] ${p.name}: ${p.issue}`).join('\n')
      : abi
        ? `Simulation failed for "${functionName}" on ${contract?.name ?? contractId}. ` +
          `Arguments look structurally valid — likely a contract assertion or missing auth. RPC: ${rpcError}`
        : rpcError;
  }

  return res.status(422).json({
    status: 'failed',
    diagnostics: { rpcError, contract: parsed?.contractId ?? null,
      function: parsed?.functionName ?? null, paramIssues, humanSummary },
  });
    const paramIssues = diagnoseArgs(functionName, rawArgs, abi, contract?.tokenDecimals ?? undefined);
    diagnostics.paramIssues = paramIssues;

    // Build a human-readable summary
    if (paramIssues.length > 0) {
      const lines = paramIssues.map((p) => `  • [arg ${p.index}] ${p.name}: ${p.issue}`);
      diagnostics.humanSummary =
        `Call to "${functionName}" on ${contract?.name ?? contractId} will fail:\n` +
        lines.join('\n');
    } else if (abi) {
      diagnostics.humanSummary =
        `Simulation failed for "${functionName}" on ${contract?.name ?? contractId}. ` +
        `Arguments look structurally valid — the error may be a contract-level assertion or missing auth. ` +
        `RPC detail: ${rpcError}`;
    }
  }

  return res.status(422).json({ status: 'failed', diagnostics });
});
