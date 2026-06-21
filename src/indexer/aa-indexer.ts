/**
 * Account Abstraction Indexer
 *
 * Processes transactions to detect smart wallets, decompose auth trees,
 * and record sponsored transactions. Called from ledgerProcessor after
 * a transaction is persisted.
 */

import { prismaWrite as prisma } from '../db';
import { parseInvokeHostFunction } from './xdr-parser';
import { rpc } from './rpc';
import { parseWasmSpec } from './wasm-spec';
import {
  classifyWallet,
  extractSponsorInfo,
  extractWasmAaIndicators,
  buildAuthDecomposition,
  isContractAddress,
} from './aa-classifier';

// Per-process in-memory cache: wasmHash → indicators.
// Avoids repeated RPC fetches for the same contract within a catch-up batch.
const wasmCache = new Map<string, ReturnType<typeof extractWasmAaIndicators> & { threshold: number | null }>();

/**
 * Fetch WASM for a contract address, extract AA indicators AND threshold.
 * Returns null if WASM is unavailable or not a valid Wasm binary.
 */
async function fetchWasmIndicators(
  contractAddress: string,
  wasmHash: string | null,
): Promise<(ReturnType<typeof extractWasmAaIndicators> & { threshold: number | null }) | null> {
  const cacheKey = wasmHash ?? contractAddress;
  if (wasmCache.has(cacheKey)) return wasmCache.get(cacheKey)!;

  let wasm: Buffer;
  try {
    wasm = await (rpc as any).getContractWasmByContractId(contractAddress);
  } catch {
    return null;
  }

  const indicators = extractWasmAaIndicators(wasm);

  // Extract threshold from contractspecv0 spec entries.
  // A multi-sig wallet typically exports __check_auth(auth_context, args, signers: Vec<Address>, threshold: u32).
  // We read the threshold parameter default or look for it in the spec.
  let threshold: number | null = null;
  try {
    const specEntries = parseWasmSpec(wasm);
    for (const entry of specEntries) {
      if (entry.switch().name !== 'scSpecEntryFunctionV0') continue;
      const fn = entry.functionV0();
      const name = fn.name().toString();
      if (!['__check_auth', 'validate_signature'].includes(name)) continue;
      // Look for a u32 parameter named "threshold" or "min_signers"
      for (const input of fn.inputs()) {
        const paramName = input.name().toString();
        if (paramName === 'threshold' || paramName === 'min_signers') {
          // We found the threshold parameter — default value not in spec,
          // but its presence confirms multi-sig and we flag threshold as ≥1
          threshold = 1;
          break;
        }
      }
    }
  } catch {
    // spec parsing failure is non-fatal
  }

  const result = { ...indicators, threshold };
  wasmCache.set(cacheKey, result);
  // Evict oldest entries to prevent unbounded growth
  if (wasmCache.size > 500) {
    wasmCache.delete(wasmCache.keys().next().value!);
  }
  return result;
}

/**
 * Process a single transaction for AA signals.
 * Safe to call concurrently — all writes are upserts.
 */
export async function processAaTransaction(
  transactionHash: string,
  sourceAccount: string,
  rawXdr: string,
  ledgerSequence: number,
  ledgerCloseTime: Date,
  feeCharged?: string,
): Promise<void> {
  // 1. Parse auth entries from XDR
  const parsed = rawXdr ? parseInvokeHostFunction(rawXdr) : null;
  const authEntries = parsed?.auth ?? [];
  const functionName = parsed?.functionName ?? null;

  // 2. Fetch WASM indicators for contract-source accounts
  let wasmResult: (ReturnType<typeof extractWasmAaIndicators> & { threshold: number | null }) | null = null;
  if (isContractAddress(sourceAccount)) {
    const contract = await prisma.contract.findUnique({
      where: { address: sourceAccount },
      select: { wasmHash: true, functionSignatures: true },
    });
    // Try live WASM first, fall back to stored function signatures
    wasmResult = await fetchWasmIndicators(sourceAccount, contract?.wasmHash ?? null);
    if (!wasmResult && contract?.functionSignatures) {
      const fns = Object.keys(contract.functionSignatures as Record<string, unknown>);
      wasmResult = { exportedFunctions: fns, hasPasskeyIndicators: false, threshold: null };
    }
  }

  // 3. Classify the wallet
  const classification = classifyWallet(sourceAccount, authEntries, functionName, wasmResult ?? undefined);

  // Apply threshold from WASM spec if available and not already set
  if (wasmResult?.threshold !== null && wasmResult?.threshold !== undefined) {
    classification.threshold = wasmResult.threshold;
  }

  // Only track smart wallets and sponsored transactions
  if (!classification.isSmartWallet) {
    const sponsorInfo = extractSponsorInfo(rawXdr);
    if (sponsorInfo.isFeeSponsored) {
      await recordSponsoredTransaction(
        transactionHash, sponsorInfo.sponsorAccount!, sponsorInfo.sourceAccount!,
        null, feeCharged, ledgerSequence, ledgerCloseTime,
      );
    }
    return;
  }

  const walletAddress = isContractAddress(sourceAccount) ? sourceAccount : null;

  // 4. Enrich session key expiry from SessionAuthorization records
  if (classification.sessionKeys.length > 0) {
    const sessionAuths = await prisma.sessionAuthorization.findMany({
      where: { contractAddress: walletAddress ?? sourceAccount },
      orderBy: { expiryLedger: 'desc' },
      take: classification.sessionKeys.length * 2,
      select: { hotSigner: true, expiryLedger: true },
    });
    const expiryMap = new Map(sessionAuths.map((s) => [s.hotSigner, s.expiryLedger]));
    for (const sk of classification.sessionKeys) {
      sk.expiryLedger = expiryMap.get(sk.address) ?? null;
    }
  }

  // 5. Upsert SmartWallet
  await prisma.smartWallet.upsert({
    where: { address: walletAddress ?? sourceAccount },
    update: {
      lastSeenLedger: ledgerSequence,
      txCount: { increment: 1 },
      walletType: classification.walletType,
      authMethods: classification.authMethods,
      ...(classification.signerCount !== null && { signerCount: classification.signerCount }),
      ...(classification.threshold !== null && { threshold: classification.threshold }),
      ...(classification.guardians.length > 0 && { guardians: classification.guardians }),
      ...(classification.sessionKeys.length > 0 && {
        sessionKeys: classification.sessionKeys as unknown as object[],
      }),
    },
    create: {
      address: walletAddress ?? sourceAccount,
      walletType: classification.walletType,
      signerCount: classification.signerCount ?? undefined,
      threshold: classification.threshold ?? undefined,
      guardians: classification.guardians,
      sessionKeys: classification.sessionKeys as unknown as object[],
      authMethods: classification.authMethods,
      deployedAtLedger: ledgerSequence,
      deployedByAccount: isContractAddress(sourceAccount) ? null : sourceAccount,
      wasmHash: wasmResult ? (await prisma.contract.findUnique({
        where: { address: sourceAccount },
        select: { wasmHash: true },
      }))?.wasmHash ?? undefined : undefined,
      firstSeenLedger: ledgerSequence,
      lastSeenLedger: ledgerSequence,
      txCount: 1,
    },
  });

  // 6. Auth decomposition
  if (authEntries.length > 0) {
    const decomp = buildAuthDecomposition(
      transactionHash, sourceAccount, authEntries, classification, ledgerSequence,
      functionName, parsed?.contractId ?? null,
    );
    await prisma.authDecomposition.upsert({
      where: { transactionHash },
      update: {},
      create: {
        transactionHash: decomp.transactionHash,
        walletAddress: decomp.walletAddress,
        authTree: decomp.authTree as unknown as object[],
        authMethods: decomp.authMethods,
        signerCount: decomp.signerCount,
        hasSubCalls: decomp.hasSubCalls,
        humanReadable: decomp.humanReadable,
        ledgerSequence: decomp.ledgerSequence,
      },
    });
  }

  // 7. Fee-bump sponsorship
  const sponsorInfo = extractSponsorInfo(rawXdr);
  if (sponsorInfo.isFeeSponsored) {
    await recordSponsoredTransaction(
      transactionHash, sponsorInfo.sponsorAccount!, sponsorInfo.sourceAccount!,
      walletAddress, feeCharged, ledgerSequence, ledgerCloseTime,
    );
    if (walletAddress) {
      await prisma.smartWallet.update({
        where: { address: walletAddress },
        data: { sponsoredTxCount: { increment: 1 } },
      });
    }
  }
}

async function recordSponsoredTransaction(
  transactionHash: string,
  sponsorAccount: string,
  sourceAccount: string,
  walletAddress: string | null,
  feeCharged: string | undefined,
  ledgerSequence: number,
  ledgerCloseTime: Date,
) {
  await prisma.sponsoredTransaction.upsert({
    where: { transactionHash },
    update: {},
    create: { transactionHash, sponsorAccount, sourceAccount, walletAddress, feeCharged, ledgerSequence, ledgerCloseTime },
  });
}
