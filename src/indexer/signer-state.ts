/**
 * Account Signer State Interpreter
 *
 * Parses the authorization entries of a Soroban transaction to determine:
 *  - Which signers were present and their weights
 *  - Which signers were absent
 *  - Whether the transaction met the low / medium / high threshold
 *  - How close it was to the next threshold level
 *
 * Results are persisted as SignerSnapshot rows for later querying.
 */

import { prismaWrite as prisma } from '../db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignerConfig {
  key: string;    // Stellar public key (G...)
  weight: number; // signing weight assigned to this key
}

export interface AccountThresholds {
  low: number;
  medium: number;
  high: number;
}

export interface SignerParticipation extends SignerConfig {
  signed: boolean;
}

export type ThresholdLevel = 'high' | 'medium' | 'low' | 'none';

export interface SignerStateResult {
  signers: SignerParticipation[];
  weightAchieved: number;
  thresholdMet: ThresholdLevel;
  passed: boolean;
  marginToNext: number | null; // null when already at highest met level
}

// ---------------------------------------------------------------------------
// Core interpreter
// ---------------------------------------------------------------------------

/**
 * Determine which threshold level is met by `weight` given the account's
 * threshold configuration.
 */
export function resolveThresholdLevel(
  weight: number,
  thresholds: AccountThresholds,
): ThresholdLevel {
  if (weight >= thresholds.high)   return 'high';
  if (weight >= thresholds.medium) return 'medium';
  if (weight >= thresholds.low)    return 'low';
  return 'none';
}

/**
 * Compute the weight margin to the next threshold level above the current one.
 * Returns null if already at 'high'.
 */
export function marginToNextLevel(
  weight: number,
  thresholds: AccountThresholds,
  current: ThresholdLevel,
): number | null {
  if (current === 'high') return null;
  if (current === 'medium') return thresholds.high - weight;
  if (current === 'low')    return thresholds.medium - weight;
  return thresholds.low - weight;
}

/**
 * Interpret signer participation for a transaction.
 *
 * @param allSigners   Full signer list from the account's current state
 * @param presentKeys  Keys that actually signed this transaction
 * @param thresholds   Account threshold configuration
 */
export function interpretSignerState(
  allSigners: SignerConfig[],
  presentKeys: string[],
  thresholds: AccountThresholds,
): SignerStateResult {
  const presentSet = new Set(presentKeys);

  const signers: SignerParticipation[] = allSigners.map((s) => ({
    ...s,
    signed: presentSet.has(s.key),
  }));

  const weightAchieved = signers
    .filter((s) => s.signed)
    .reduce((sum, s) => sum + s.weight, 0);

  const thresholdMet = resolveThresholdLevel(weightAchieved, thresholds);
  // A transaction "passes" if it meets at least the medium threshold
  // (Stellar's default for most operations).  Callers can override this logic.
  const passed = thresholdMet === 'medium' || thresholdMet === 'high';
  const margin = marginToNextLevel(weightAchieved, thresholds, thresholdMet);

  return { signers, weightAchieved, thresholdMet, passed, marginToNext: margin };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist a signer state snapshot for a transaction.
 */
export async function saveSignerSnapshot(
  transactionHash: string,
  contractAddress: string,
  ledgerSequence: number,
  thresholds: AccountThresholds,
  result: SignerStateResult,
): Promise<void> {
  await prisma.signerSnapshot.upsert({
    where: { transactionHash },
    update: {
      lowThreshold:   thresholds.low,
      medThreshold:   thresholds.medium,
      highThreshold:  thresholds.high,
      signers:        result.signers as any,
      weightAchieved: result.weightAchieved,
      thresholdMet:   result.thresholdMet,
      passed:         result.passed,
      marginToNext:   result.marginToNext ?? undefined,
    },
    create: {
      transactionHash,
      contractAddress,
      ledgerSequence,
      lowThreshold:   thresholds.low,
      medThreshold:   thresholds.medium,
      highThreshold:  thresholds.high,
      signers:        result.signers as any,
      weightAchieved: result.weightAchieved,
      thresholdMet:   result.thresholdMet,
      passed:         result.passed,
      marginToNext:   result.marginToNext ?? undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// XDR extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the list of signing keys from a Soroban transaction's auth entries.
 * The Stellar SDK exposes these as `SorobanAuthorizationEntry` objects.
 */
export function extractPresentSigners(txMeta: any): string[] {
  const auths: any[] = txMeta?.sorobanMeta?.auth ?? txMeta?.auth ?? [];
  const keys: string[] = [];

  for (const entry of auths) {
    // Signed auth entries carry a `credentials.address.signature` field
    const addr =
      entry?.credentials?.address?.address?.accountId?.ed25519 ??
      entry?.credentials?.address?.address ??
      entry?.credentials?.sourceAccount;

    if (typeof addr === 'string' && addr.startsWith('G')) {
      keys.push(addr);
    }
  }

  return [...new Set(keys)];
}

/**
 * Extract account thresholds from a Horizon account response or a cached
 * account entry object.
 */
export function extractThresholds(accountData: any): AccountThresholds {
  const t = accountData?.thresholds ?? accountData;
  return {
    low:    Number(t?.low_threshold  ?? t?.lowThreshold  ?? 0),
    medium: Number(t?.med_threshold  ?? t?.medThreshold  ?? 0),
    high:   Number(t?.high_threshold ?? t?.highThreshold ?? 0),
  };
}

/**
 * Extract the full signer list from a Horizon account response.
 */
export function extractSigners(accountData: any): SignerConfig[] {
  const raw: any[] = accountData?.signers ?? [];
  return raw.map((s) => ({
    key:    s.key ?? s.public_key ?? '',
    weight: Number(s.weight ?? 0),
  })).filter((s) => s.key.length > 0);
}
