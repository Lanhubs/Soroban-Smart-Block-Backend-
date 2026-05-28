/**
 * Token Metadata Micro-Service
 *
 * Single source of truth for token decimals, symbol, and name.
 * Covers both Soroban SEP-41 tokens and classic Stellar assets (SAC-wrapped).
 *
 * Resolution order for a given contract address:
 *   1. In-process LRU cache (instant)
 *   2. DB — Contract table (tokenSymbol / tokenName / tokenDecimals)
 *   3. DB — SacMapping table → Horizon /assets for classic asset metadata
 *   4. Soroban RPC simulation of decimals(), symbol(), name() calls
 *   5. null (unknown token — caller decides how to handle)
 *
 * The `formatTokenAmount` helper is the primary consumer: it converts a raw
 * on-chain integer (e.g. 10_000_000) into a human string (e.g. "1.0000000 USDC")
 * using the resolved decimal configuration.
 */

import axios from 'axios';
import { SorobanRpc, xdr, scValToNative, Address, nativeToScVal } from '@stellar/stellar-sdk';
import { prismaRead } from '../db';
import { config } from '../config';
import { formatAmount } from './args-decoder';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TokenSource = 'db' | 'sac' | 'rpc' | 'classic';

export interface TokenMetadata {
  /** Contract address (Soroban) or asset code (classic). */
  address: string;
  symbol: string | null;
  name: string | null;
  /** Decimal places. Stellar native default is 7. */
  decimals: number;
  /** Where the metadata was resolved from. */
  source: TokenSource;
}

// ─── In-process LRU cache ─────────────────────────────────────────────────────

const CACHE_MAX = 1024;
const metaCache = new Map<string, TokenMetadata>();

function cacheEvictIfFull(): void {
  if (metaCache.size >= CACHE_MAX) {
    // Map preserves insertion order — evict the oldest entry
    metaCache.delete(metaCache.keys().next().value!);
  }
}

function cacheSet(meta: TokenMetadata): void {
  metaCache.delete(meta.address); // move to end on update
  cacheEvictIfFull();
  metaCache.set(meta.address, meta);
}

/** Evict a single entry (e.g. after an on-chain upgrade). */
export function invalidateTokenMetadata(address: string): void {
  metaCache.delete(address);
}

/** Evict all cached entries. */
export function clearTokenMetadataCache(): void {
  metaCache.clear();
}

// ─── RPC client ───────────────────────────────────────────────────────────────

const rpcClient = new SorobanRpc.Server(config.stellarRpcUrl, { allowHttp: true });

/**
 * Simulate a no-arg SEP-41 view function (decimals / symbol / name) on-chain.
 * Returns the native JS value or null on any error.
 */
async function simulateViewCall(
  contractAddress: string,
  fnName: 'decimals' | 'symbol' | 'name',
): Promise<unknown> {
  try {
    const invokeArgs: xdr.ScVal[] = [];

    const op = SorobanRpc.assembleTransaction as unknown as any;

    // Build a minimal InvokeHostFunction operation
    const invokeHostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractAddress).toScAddress(),
        functionName: fnName,
        args: invokeArgs,
      }),
    );

    const result = await rpcClient.simulateTransaction(
      // We only need the result, not a valid signed tx — use a dummy source
      buildSimulateTx(invokeHostFn),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return null;
    if (!('result' in result) || !result.result) return null;

    const retVal = (result.result as any).retval as xdr.ScVal | undefined;
    if (!retVal) return null;

    return scValToNative(retVal);
  } catch {
    return null;
  }
}

/**
 * Build a minimal transaction envelope for simulation.
 * We use a well-known testnet keypair placeholder — simulation doesn't
 * require a valid signature, only a valid envelope structure.
 */
function buildSimulateTx(hostFn: xdr.HostFunction): any {
  // Import lazily to avoid circular deps at module load time
  const { TransactionBuilder, Account, Operation, BASE_FEE } = require('@stellar/stellar-sdk');
  const DUMMY_SOURCE = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
  const account = new Account(DUMMY_SOURCE, '0');
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func: hostFn, auth: [] }))
    .setTimeout(30)
    .build();
}

// ─── Horizon classic asset lookup ─────────────────────────────────────────────

interface HorizonAssetRecord {
  asset_code: string;
  asset_issuer: string;
  asset_type: string;
  name?: string;
}

/**
 * Fetch classic Stellar asset metadata from Horizon.
 * Returns null if the asset is not found or the request fails.
 */
async function fetchClassicAssetMetadata(
  assetCode: string,
  assetIssuer: string | null,
): Promise<{ name: string | null } | null> {
  // XLM (native) has no Horizon asset record
  if (!assetIssuer) return { name: 'Stellar Lumens' };

  try {
    const url = `${config.horizonUrl}/assets`;
    const { data } = await axios.get<{
      _embedded: { records: HorizonAssetRecord[] };
    }>(url, {
      params: { asset_code: assetCode, asset_issuer: assetIssuer, limit: 1 },
      timeout: 6000,
    });

    const record = data?._embedded?.records?.[0];
    if (!record) return null;

    return { name: record.name ?? null };
  } catch {
    return null;
  }
}

// ─── Core resolution logic ────────────────────────────────────────────────────

/**
 * Resolve token metadata for a Soroban contract address.
 *
 * Resolution order:
 *   1. In-process cache
 *   2. DB Contract row (isToken = true)
 *   3. DB SacMapping row → Horizon for classic asset name
 *   4. Soroban RPC simulation of decimals() / symbol() / name()
 *   5. Returns null if nothing resolves
 */
export async function getTokenMetadata(address: string): Promise<TokenMetadata | null> {
  // 1. Cache hit
  const cached = metaCache.get(address);
  if (cached) return cached;

  // 2. DB — Contract table
  const contract = await prismaRead.contract.findUnique({
    where: { address },
    select: {
      isToken: true,
      tokenSymbol: true,
      tokenName: true,
      tokenDecimals: true,
    },
  });

  if (contract?.isToken) {
    const meta: TokenMetadata = {
      address,
      symbol: contract.tokenSymbol ?? null,
      name: contract.tokenName ?? null,
      decimals: contract.tokenDecimals ?? 7,
      source: 'db',
    };
    cacheSet(meta);
    return meta;
  }

  // 3. DB — SacMapping (classic Stellar asset wrapped as SAC)
  const sac = await prismaRead.sacMapping.findUnique({
    where: { sacAddress: address },
    select: { assetCode: true, assetIssuer: true },
  });

  if (sac) {
    const horizonMeta = await fetchClassicAssetMetadata(sac.assetCode, sac.assetIssuer);
    const meta: TokenMetadata = {
      address,
      symbol: sac.assetCode,
      name: horizonMeta?.name ?? sac.assetCode,
      // Classic Stellar assets use 7 decimal places (stroops)
      decimals: 7,
      source: 'sac',
    };
    cacheSet(meta);
    return meta;
  }

  // 4. Soroban RPC simulation — try to call decimals(), symbol(), name()
  const [rawDecimals, rawSymbol, rawName] = await Promise.all([
    simulateViewCall(address, 'decimals'),
    simulateViewCall(address, 'symbol'),
    simulateViewCall(address, 'name'),
  ]);

  // decimals() must return a number for this to be a valid SEP-41 token
  if (rawDecimals === null || typeof rawDecimals !== 'number') return null;

  const meta: TokenMetadata = {
    address,
    symbol: rawSymbol != null ? String(rawSymbol) : null,
    name: rawName != null ? String(rawName) : null,
    decimals: rawDecimals,
    source: 'rpc',
  };
  cacheSet(meta);
  return meta;
}

/**
 * Resolve metadata for a classic Stellar asset (not a Soroban contract).
 * Useful when you have an asset code + issuer but no contract address.
 */
export async function getClassicAssetMetadata(
  assetCode: string,
  assetIssuer: string | null,
): Promise<TokenMetadata> {
  const cacheKey = `classic:${assetCode}:${assetIssuer ?? 'native'}`;
  const cached = metaCache.get(cacheKey);
  if (cached) return cached;

  const horizonMeta = await fetchClassicAssetMetadata(assetCode, assetIssuer);

  const meta: TokenMetadata = {
    address: cacheKey,
    symbol: assetCode,
    name: horizonMeta?.name ?? assetCode,
    decimals: 7,
    source: 'classic',
  };
  cacheSet(meta);
  return meta;
}

// ─── Amount formatting ────────────────────────────────────────────────────────

/**
 * Format a raw on-chain integer amount using the token's decimal configuration.
 *
 * @example
 * // USDC has 6 decimals
 * await formatTokenAmount(10_000_000n, usdcContractAddress)
 * // → "10.000000 USDC"
 *
 * @example
 * // XLM has 7 decimals (Stellar default)
 * await formatTokenAmount(10_000_000n, xlmSacAddress)
 * // → "1.0000000 XLM"
 *
 * @param raw     - Raw integer amount (bigint or number)
 * @param address - Soroban contract address of the token
 * @param opts    - Optional overrides (decimals, symbol) for when metadata is unavailable
 */
export async function formatTokenAmount(
  raw: bigint | number,
  address: string,
  opts?: { fallbackDecimals?: number; fallbackSymbol?: string },
): Promise<string> {
  const amount = typeof raw === 'number' ? BigInt(Math.round(raw)) : raw;
  const meta = await getTokenMetadata(address);

  const decimals = meta?.decimals ?? opts?.fallbackDecimals ?? 7;
  const symbol = meta?.symbol ?? opts?.fallbackSymbol ?? '';

  const formatted = formatAmount(amount, decimals);
  return symbol ? `${formatted} ${symbol}` : formatted;
}

/**
 * Synchronous version — uses only the in-process cache.
 * Returns null if the address is not cached yet.
 * Useful in hot paths where async is not acceptable.
 */
export function formatTokenAmountSync(
  raw: bigint | number,
  address: string,
  fallbackDecimals = 7,
  fallbackSymbol = '',
): string {
  const amount = typeof raw === 'number' ? BigInt(Math.round(raw)) : raw;
  const meta = metaCache.get(address);

  const decimals = meta?.decimals ?? fallbackDecimals;
  const symbol = meta?.symbol ?? fallbackSymbol;

  const formatted = formatAmount(amount, decimals);
  return symbol ? `${formatted} ${symbol}` : formatted;
}

// ─── Cache warm-up ────────────────────────────────────────────────────────────

/**
 * Pre-warm the in-process cache from the DB on startup.
 * Loads all known token contracts and SAC mappings so the first request
 * for any known token is served from cache without a DB round-trip.
 */
export async function warmTokenMetadataCache(): Promise<void> {
  const [tokens, sacMappings] = await Promise.all([
    prismaRead.contract.findMany({
      where: { isToken: true },
      select: { address: true, tokenSymbol: true, tokenName: true, tokenDecimals: true },
    }),
    prismaRead.sacMapping.findMany({
      select: { sacAddress: true, assetCode: true, assetIssuer: true },
    }),
  ]);

  for (const t of tokens) {
    cacheSet({
      address: t.address,
      symbol: t.tokenSymbol ?? null,
      name: t.tokenName ?? null,
      decimals: t.tokenDecimals ?? 7,
      source: 'db',
    });
  }

  for (const s of sacMappings) {
    // Only populate if not already in cache from the Contract table
    if (!metaCache.has(s.sacAddress)) {
      cacheSet({
        address: s.sacAddress,
        symbol: s.assetCode,
        name: s.assetCode,
        decimals: 7,
        source: 'sac',
      });
    }
  }

  console.log(
    `[token-metadata] Cache warmed: ${tokens.length} tokens, ${sacMappings.length} SAC mappings`,
  );
}

/** Expose cache size for health/metrics endpoints. */
export function getTokenMetadataCacheSize(): number {
  return metaCache.size;
}
