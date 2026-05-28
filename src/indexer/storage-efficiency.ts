/**
 * Storage Efficiency Logger
 *
 * Parses the Soroban transaction footprint (declared read/write keys + byte
 * budgets) and compares them against the actual bytes consumed.  The delta
 * is the "unutilised storage" developers are paying rent on.
 */

import { prismaWrite as prisma } from '../db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FootprintEntry {
  key: string;   // ledger-key XDR (base64 or hex)
  bytes: number; // declared byte budget for this key
}

export interface StorageFootprint {
  readOnly: FootprintEntry[];
  readWrite: FootprintEntry[];
}

export interface ActualUsage {
  readBytes: number;
  writeBytes: number;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Compute efficiency metrics and persist a StorageEfficiencyLog row.
 */
export async function logStorageEfficiency(
  transactionHash: string,
  contractAddress: string | null,
  ledgerSequence: number,
  footprint: StorageFootprint,
  actual: ActualUsage,
): Promise<void> {
  const footprintBytes =
    footprint.readOnly.reduce((s, e) => s + e.bytes, 0) +
    footprint.readWrite.reduce((s, e) => s + e.bytes, 0);

  const actualTotal = actual.readBytes + actual.writeBytes;
  const unusedBytes = Math.max(0, footprintBytes - actualTotal);
  const efficiencyPct = footprintBytes > 0
    ? Math.min(100, (actualTotal / footprintBytes) * 100)
    : 100;

  await prisma.storageEfficiencyLog.upsert({
    where: { transactionHash },
    update: {
      footprintBytes,
      readOnlyKeys: footprint.readOnly.length,
      readWriteKeys: footprint.readWrite.length,
      actualReadBytes: actual.readBytes,
      actualWriteBytes: actual.writeBytes,
      unusedBytes,
      efficiencyPct,
    },
    create: {
      transactionHash,
      contractAddress,
      ledgerSequence,
      readOnlyKeys: footprint.readOnly.length,
      readWriteKeys: footprint.readWrite.length,
      footprintBytes,
      actualReadBytes: actual.readBytes,
      actualWriteBytes: actual.writeBytes,
      unusedBytes,
      efficiencyPct,
    },
  });
}

/**
 * Extract a StorageFootprint from a raw Soroban transaction meta object.
 * The meta shape follows the Stellar SDK's `SorobanTransactionData` XDR.
 */
export function extractFootprint(sorobanMeta: any): StorageFootprint {
  const data = sorobanMeta?.sorobanMeta?.transactionData ?? sorobanMeta?.transactionData ?? {};
  const footprint = data?.footprint ?? {};

  const toEntries = (keys: any[]): FootprintEntry[] =>
    (keys ?? []).map((k: any) => ({
      key: typeof k === 'string' ? k : JSON.stringify(k),
      // Soroban charges 48 bytes base + key size; approximate when not provided
      bytes: k?.bytes ?? k?.size ?? 48,
    }));

  return {
    readOnly: toEntries(footprint.readOnly ?? footprint.read_only ?? []),
    readWrite: toEntries(footprint.readWrite ?? footprint.read_write ?? []),
  };
}

/**
 * Extract actual byte usage from Soroban resource stats in the tx meta.
 */
export function extractActualUsage(sorobanMeta: any): ActualUsage {
  const resources = sorobanMeta?.sorobanMeta?.resources ?? sorobanMeta?.resources ?? {};
  return {
    readBytes: resources.readBytes ?? resources.read_bytes ?? 0,
    writeBytes: resources.writeBytes ?? resources.write_bytes ?? 0,
  };
}
