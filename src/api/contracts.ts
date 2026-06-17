import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { z } from 'zod';
import { fetchContractSpec } from '../indexer/wasm-spec';
import { abiRouter } from './abi';
import { validateAddressParam, isValidStellarAddress } from '../middleware/sanitize';

export const contractRouter = Router();

const abiSchema = z.object({
  address: z.string().refine(isValidStellarAddress, { message: 'Invalid Stellar contract address' }),
  name: z.string().max(256).optional(),
  description: z.string().max(2048).optional(),
  abi: z.record(z.unknown()).optional(),
});

const contractStatsQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
});

export async function getContractFunctionStats(address: string, since?: Date) {
  const contract = await prismaRead.contract.findUnique({
    where: { address },
    select: { address: true },
  });

  if (!contract) {
    return null;
  }

  const stats = await prismaRead.transaction.groupBy({
    by: ['functionName'],
    where: {
      contractAddress: address,
      functionName: { not: null },
      ...(since ? { ledgerCloseTime: { gte: since } } : {}),
    },
    _count: {
      functionName: true,
    },
    _max: {
      ledgerCloseTime: true,
    },
    orderBy: [
      { _count: { functionName: 'desc' } },
      { functionName: 'asc' },
    ],
  });

  return stats.map((stat) => ({
    functionName: stat.functionName!,
    callCount: stat._count.functionName,
    lastCalledAt: stat._max.ledgerCloseTime,
  }));
}

// GET /contracts
contractRouter.get('/', async (_req: Request, res: Response) => {
  const contracts = await prismaRead.contract.findMany({
    select: { address: true, name: true, description: true, isToken: true, tokenSymbol: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(contracts);
});

// GET /contracts/:address/stats
contractRouter.get('/:address/stats', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const { since } = contractStatsQuerySchema.parse(req.query);
    const stats = await getContractFunctionStats(
      req.params.address,
      since ? new Date(since) : undefined,
    );

    if (stats === null) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    return res.json(stats);
  } catch (e) {
    return res.status(400).json({ error: String(e) });
  }
});

// GET /contracts/:address
contractRouter.get('/:address', validateAddressParam('address'), async (req: Request, res: Response) => {
  const contract = await prismaRead.contract.findUnique({
    where: { address: req.params.address },
    include: {
      transactions: { take: 10, orderBy: { ledgerSequence: 'desc' }, select: { hash: true, functionName: true, humanReadable: true, ledgerSequence: true } },
      events: { take: 10, orderBy: { ledgerSequence: 'desc' }, select: { id: true, eventType: true, decoded: true, ledgerSequence: true } },
    },
  });
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  res.json(contract);
});

// POST /contracts — register ABI metadata
contractRouter.post('/', async (req: Request, res: Response) => {
  try {
    const data = abiSchema.parse(req.body);
    const contract = await prismaWrite.contract.upsert({
      where: { address: data.address },
      update: { name: data.name, description: data.description, abi: data.abi as object },
      create: { address: data.address, name: data.name, description: data.description, abi: data.abi as object },
    });
    res.status(201).json(contract);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ── Contract Simulation Routes ────────────────────────────────────────────────

import { rpc as sorobanRpc } from '../indexer/rpc';
import { SorobanRpc, Transaction, FeeBumpTransaction } from '@stellar/stellar-sdk';
import { buildTrace, extractDiagnosticEvents } from '../indexer/trace-engine';
import { analyzeSimulationFailure } from '../indexer/revert-analyzer';
import { config } from '../config';

import { analyzeWasmContract, decompileWasm } from '../indexer/wasm-decompiler';

/**
 * GET /contracts/:address/simulate/functions
 * Lists functions that can be simulated for a registered contract.
 * Combines ABI metadata with on-chain contract spec (WASM).
 */
contractRouter.get('/:address/simulate/functions', validateAddressParam('address'), async (req: Request, res: Response) => {
  const { address } = req.params;

  const [contract, wasmSpec] = await Promise.all([
    prismaRead.contract.findUnique({ where: { address }, select: { address: true, name: true, abi: true, isToken: true } }),
    fetchContractSpec(address).catch(() => null),
  ]);

  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  // Merge ABI functions with WASM spec
  const abiFunctions: Array<{ name: string; inputs: unknown[]; simulatable: boolean }> = [];

  const abi = contract.abi as { functions?: Array<{ name: string; inputs: unknown[] }> } | null;
  if (abi?.functions) {
    for (const fn of abi.functions) {
      abiFunctions.push({ name: fn.name, inputs: fn.inputs ?? [], simulatable: true });
    }
  }

  if (wasmSpec && typeof wasmSpec === 'object') {
    const schema = wasmSpec as Record<string, unknown>;
    const definitions = (schema.definitions ?? schema.$defs ?? {}) as Record<string, unknown>;
    for (const [name, def] of Object.entries(definitions)) {
      if (abiFunctions.find((f) => f.name === name)) continue; // already in ABI
      const d = def as Record<string, unknown>;
      if (d.type === 'object' || d.properties) {
        abiFunctions.push({
          name,
          inputs: Object.entries((d.properties as Record<string, unknown>) ?? {}).map(([k, v]) => ({ name: k, type: (v as any)?.type ?? 'unknown' })),
          simulatable: true,
        });
      }
    }
  }

  return res.json({
    address,
    name: contract.name ?? null,
    isToken: contract.isToken,
    functions: abiFunctions,
    wasmSpecAvailable: wasmSpec !== null,
  });
});

// ── Contract Source / Decompilation Endpoints ───────────────────────────────

// Helper: fetch on-chain Wasm bytes for a contract address
async function fetchOnChainWasm(contractAddress: string): Promise<Buffer> {
  try {
    return await sorobanRpc.getContractWasmByContractId(contractAddress);
  } catch (err) {
    throw new Error('Failed to fetch on-chain Wasm for contract');
  }
}

// GET /contracts/:address/source — full source/decompiled view (on-chain)
contractRouter.get('/:address/source', validateAddressParam('address'), async (req: Request, res: Response) => {
  const { address } = req.params;
  try {
    const wasm = await fetchOnChainWasm(address);
    const analysis = analyzeWasmContract(wasm);

    // Persist analysis to DB (upsert ContractSource)
    try {
      const cs = await (prismaWrite as any).contractSource.upsert({
        where: { contractAddress: address },
        create: {
          contractAddress: address,
          sourceType: analysis.sourceType,
          language: analysis.language,
          compilerVersion: analysis.compilerVersion ?? undefined,
          wasmHash: analysis.wasmHash,
          bytecodeSize: analysis.bytecodeSize,
          functions: analysis.functions as any,
          imports: analysis.imports as any,
          exports: analysis.exports as any,
          storageVariables: analysis.storageVariables as any,
          events: analysis.events as any,
          errors: analysis.errors as any,
          metadata: analysis.metadata as any,
          decompiledAt: new Date(analysis.decompiledAt),
          verifiedAt: analysis.verifiedAt ? new Date(analysis.verifiedAt) : undefined,
        },
        update: {
          language: analysis.language,
          compilerVersion: analysis.compilerVersion ?? undefined,
          wasmHash: analysis.wasmHash,
          bytecodeSize: analysis.bytecodeSize,
          functions: analysis.functions as any,
          imports: analysis.imports as any,
          exports: analysis.exports as any,
          storageVariables: analysis.storageVariables as any,
          events: analysis.events as any,
          errors: analysis.errors as any,
          metadata: analysis.metadata as any,
          verifiedAt: analysis.verifiedAt ? new Date(analysis.verifiedAt) : undefined,
        },
      });

      // Upsert function details
      for (const fn of analysis.functions) {
        await (prismaWrite as any).functionDetail.upsert({
          where: { contractId_name: { contractId: cs.id, name: fn.name } },
          create: {
            contractId: cs.id,
            name: fn.name,
            selector: fn.selector ?? undefined,
            visibility: 'public',
            params: fn.params as any,
            returns: fn.returns as any,
            pseudoCode: fn.pseudoCode ?? undefined,
            cfg: fn.cfg as any,
            complexity: fn.complexity ?? undefined,
            linesOfCode: fn.linesOfCode ?? 0,
            cyclomaticComplexity: fn.cyclomaticComplexity ?? 0,
            calls: fn.calls as any,
            storageOperations: fn.storageOperations as any,
            hostCalls: fn.hostCalls as any,
            sourceMap: fn.sourceMap as any,
          },
          update: {
            pseudoCode: fn.pseudoCode ?? undefined,
            cfg: fn.cfg as any,
            complexity: fn.complexity ?? undefined,
            linesOfCode: fn.linesOfCode ?? 0,
            cyclomaticComplexity: fn.cyclomaticComplexity ?? 0,
            calls: fn.calls as any,
            storageOperations: fn.storageOperations as any,
            hostCalls: fn.hostCalls as any,
            sourceMap: fn.sourceMap as any,
          },
        });
      }
    } catch (dbErr) {
      // Non-fatal: log and continue returning analysis
      // eslint-disable-next-line no-console
      console.warn('Failed to persist contract analysis', String(dbErr));
    }

    return res.json(analysis);
  } catch (err: any) {
    return res.status(404).json({ error: 'Could not retrieve or analyze contract Wasm', detail: String(err) });
  }
});

// POST /contracts/source/decompile — accept raw Wasm (multipart field 'wasm' or JSON body { wasmBase64 })
contractRouter.post('/source/decompile', async (req: Request, res: Response) => {
  // support JSON body with base64 wasm
  try {
    if (req.body && typeof req.body.wasmBase64 === 'string') {
      const buf = Buffer.from(req.body.wasmBase64, 'base64');
      const analysis = analyzeWasmContract(buf);

      // Persist if contractAddress supplied
      const maybeAddress = typeof req.body.contractAddress === 'string' ? req.body.contractAddress : null;
      if (maybeAddress) {
        try {
          const cs = await (prismaWrite as any).contractSource.upsert({
            where: { contractAddress: maybeAddress },
            create: {
              contractAddress: maybeAddress,
              sourceType: analysis.sourceType,
              language: analysis.language,
              compilerVersion: analysis.compilerVersion ?? undefined,
              wasmHash: analysis.wasmHash,
              bytecodeSize: analysis.bytecodeSize,
              functions: analysis.functions as any,
              imports: analysis.imports as any,
              exports: analysis.exports as any,
              storageVariables: analysis.storageVariables as any,
              events: analysis.events as any,
              errors: analysis.errors as any,
              metadata: analysis.metadata as any,
              decompiledAt: new Date(analysis.decompiledAt),
              verifiedAt: analysis.verifiedAt ? new Date(analysis.verifiedAt) : undefined,
            },
            update: {
              language: analysis.language,
              compilerVersion: analysis.compilerVersion ?? undefined,
              wasmHash: analysis.wasmHash,
              bytecodeSize: analysis.bytecodeSize,
              functions: analysis.functions as any,
              imports: analysis.imports as any,
              exports: analysis.exports as any,
              storageVariables: analysis.storageVariables as any,
              events: analysis.events as any,
              errors: analysis.errors as any,
              metadata: analysis.metadata as any,
              verifiedAt: analysis.verifiedAt ? new Date(analysis.verifiedAt) : undefined,
            },
          });

          for (const fn of analysis.functions) {
            await (prismaWrite as any).functionDetail.upsert({
              where: { contractId_name: { contractId: cs.id, name: fn.name } },
              create: {
                contractId: cs.id,
                name: fn.name,
                selector: fn.selector ?? undefined,
                visibility: 'public',
                params: fn.params as any,
                returns: fn.returns as any,
                pseudoCode: fn.pseudoCode ?? undefined,
                cfg: fn.cfg as any,
                complexity: fn.complexity ?? undefined,
                linesOfCode: fn.linesOfCode ?? 0,
                cyclomaticComplexity: fn.cyclomaticComplexity ?? 0,
                calls: fn.calls as any,
                storageOperations: fn.storageOperations as any,
                hostCalls: fn.hostCalls as any,
                sourceMap: fn.sourceMap as any,
              },
              update: {
                pseudoCode: fn.pseudoCode ?? undefined,
                cfg: fn.cfg as any,
                complexity: fn.complexity ?? undefined,
                linesOfCode: fn.linesOfCode ?? 0,
                cyclomaticComplexity: fn.cyclomaticComplexity ?? 0,
                calls: fn.calls as any,
                storageOperations: fn.storageOperations as any,
                hostCalls: fn.hostCalls as any,
                sourceMap: fn.sourceMap as any,
              },
            });
          }
        } catch (dbErr) {
          // eslint-disable-next-line no-console
          console.warn('Failed to persist uploaded contract analysis', String(dbErr));
        }
      }

      return res.json(analysis);
    }
    return res.status(400).json({ error: 'Provide wasmBase64 in request body' });
  } catch (err: any) {
    return res.status(422).json({ error: 'Failed to decompile Wasm', detail: String(err) });
  }
});

// GET /contracts/:address/source/functions — list functions with signatures and complexity
contractRouter.get('/:address/source/functions', validateAddressParam('address'), async (req: Request, res: Response) => {
  const { address } = req.params;
  try {
    const wasm = await fetchOnChainWasm(address);
    const analysis = analyzeWasmContract(wasm);
    const list = analysis.functions.map((f) => ({ name: f.name, selector: f.selector, params: f.params, returns: f.returns, complexity: f.complexity, linesOfCode: f.linesOfCode }));
    return res.json({ address, functions: list });
  } catch (err: any) {
    return res.status(404).json({ error: 'Could not retrieve or analyze contract Wasm', detail: String(err) });
  }
});

// GET /contracts/:address/source/functions/:functionName — single function detail
contractRouter.get('/:address/source/functions/:functionName', validateAddressParam('address'), async (req: Request, res: Response) => {
  const { address, functionName } = req.params;
  try {
    const wasm = await fetchOnChainWasm(address);
    const analysis = analyzeWasmContract(wasm);
    const fn = analysis.functions.find((f) => f.name === functionName || f.exportName === functionName);
    if (!fn) return res.status(404).json({ error: 'Function not found' });
    return res.json(fn);
  } catch (err: any) {
    return res.status(404).json({ error: 'Could not retrieve or analyze contract Wasm', detail: String(err) });
  }
});

// GET /contracts/:address/source/functions/:functionName/cfg — control flow graph for function
contractRouter.get('/:address/source/functions/:functionName/cfg', validateAddressParam('address'), async (req: Request, res: Response) => {
  const { address, functionName } = req.params;
  try {
    const wasm = await fetchOnChainWasm(address);
    const analysis = analyzeWasmContract(wasm);
    const fn = analysis.functions.find((f) => f.name === functionName || f.exportName === functionName);
    if (!fn) return res.status(404).json({ error: 'Function not found' });
    return res.json({ cfg: fn.cfg });
  } catch (err: any) {
    return res.status(404).json({ error: 'Could not retrieve or analyze contract Wasm', detail: String(err) });
  }
});

// Exports / Imports / Events / Errors / Storage endpoints
contractRouter.get('/:address/source/exports', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const wasm = await fetchOnChainWasm(req.params.address);
    const analysis = analyzeWasmContract(wasm);
    return res.json(analysis.exports);
  } catch (err: any) {
    return res.status(404).json({ error: 'Could not retrieve exports', detail: String(err) });
  }
});

contractRouter.get('/:address/source/imports', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const wasm = await fetchOnChainWasm(req.params.address);
    const analysis = analyzeWasmContract(wasm);
    return res.json(analysis.imports);
  } catch (err: any) {
    return res.status(404).json({ error: 'Could not retrieve imports', detail: String(err) });
  }
});

contractRouter.get('/:address/source/events', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const wasm = await fetchOnChainWasm(req.params.address);
    const analysis = analyzeWasmContract(wasm);
    return res.json(analysis.events ?? []);
  } catch (err: any) {
    return res.status(404).json({ error: 'Could not retrieve events', detail: String(err) });
  }
});

contractRouter.get('/:address/source/errors', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const wasm = await fetchOnChainWasm(req.params.address);
    const analysis = analyzeWasmContract(wasm);
    return res.json(analysis.errors ?? []);
  } catch (err: any) {
    return res.status(404).json({ error: 'Could not retrieve errors', detail: String(err) });
  }
});

contractRouter.get('/:address/source/storage', validateAddressParam('address'), async (req: Request, res: Response) => {
  try {
    const wasm = await fetchOnChainWasm(req.params.address);
    const analysis = analyzeWasmContract(wasm);
    return res.json(analysis.storageVariables ?? []);
  } catch (err: any) {
    return res.status(404).json({ error: 'Could not retrieve storage layout', detail: String(err) });
  }
});

/**
 * POST /contracts/:address/simulate/:functionName
 * Quick simulation of a specific function by providing args as JSON array.
 * Body: { args: [...ScVal JSON], txEnvelope?: "base64-xdr" }
 */
contractRouter.post('/:address/simulate/:functionName', validateAddressParam('address'), async (req: Request, res: Response) => {
  const { address, functionName } = req.params;
  const { txEnvelope } = req.body as { txEnvelope?: string };

  if (!txEnvelope) {
    return res.status(400).json({
      error: 'txEnvelope (base64 XDR) is required. Build a transaction calling the function and pass the XDR.',
      hint: `Simulate ${functionName} on ${address} by constructing a TransactionEnvelope XDR that invokes this function.`,
    });
  }

  let txObj: Transaction | FeeBumpTransaction;
  try {
    try { txObj = new Transaction(txEnvelope, config.networkPassphrase); }
    catch { txObj = new FeeBumpTransaction(txEnvelope, config.networkPassphrase); }
  } catch (err) {
    return res.status(400).json({ error: 'Invalid transaction XDR', detail: String(err) });
  }

  let rpcResult: SorobanRpc.Api.SimulateTransactionResponse;
  try {
    rpcResult = await Promise.race([
      sorobanRpc.simulateTransaction(txObj),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
    ]);
  } catch (err) {
    return res.status(502).json({ error: 'RPC simulation failed', detail: String(err) });
  }

  const diagnosticEvents = extractDiagnosticEvents(rpcResult);
  const isSuccess = SorobanRpc.Api.isSimulationSuccess(rpcResult) || SorobanRpc.Api.isSimulationRestore(rpcResult);
  const cost = isSuccess ? (rpcResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).cost : undefined;
  const simEvents = isSuccess ? (rpcResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).events : undefined;
  const errorMsg = isSuccess ? undefined : (rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse).error;

  const trace = buildTrace(diagnosticEvents, cost, simEvents, 'full', isSuccess, errorMsg);
  const revertAnalysis = isSuccess
    ? null
    : analyzeSimulationFailure(rpcResult as SorobanRpc.Api.SimulateTransactionErrorResponse, diagnosticEvents);

  return res.status(isSuccess ? 200 : 422).json({
    contract: address,
    function: functionName,
    status: isSuccess ? 'success' : 'failed',
    trace,
    revertAnalysis,
  });
});
