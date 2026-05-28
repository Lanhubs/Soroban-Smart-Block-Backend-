import { prismaRead as prisma } from '../db';

interface PoolSnapshot {
  address: string;
  balance: bigint;
}

interface FlashLoanAlert {
  ledger: number;
  poolAddress: string;
  borrowAmount: bigint;
  returnAmount: bigint;
  variance: number;
  severity: 'low' | 'medium' | 'high';
  transactions: string[];
}

/**
 * Detect flash loan patterns within a single ledger:
 * - High-volume borrows and returns in same block
 * - Unusual balance variance on lending pools
 * - Multiple borrow/return cycles
 */
export async function detectFlashLoans(ledgerSequence: number): Promise<FlashLoanAlert[]> {
  const alerts: FlashLoanAlert[] = [];

  // Fetch all events in this ledger
  const events = await prisma.event.findMany({
    where: { ledgerSequence },
    include: { transaction: true },
  });

  if (events.length === 0) return alerts;

  // Group by contract (potential lending pool)
  const poolEvents = new Map<string, typeof events>();
  for (const event of events) {
    const key = event.contractAddress;
    if (!poolEvents.has(key)) poolEvents.set(key, []);
    poolEvents.get(key)!.push(event);
  }

  // Analyze each pool for flash loan signatures
  for (const [poolAddress, poolEventList] of poolEvents) {
    const borrowEvents = poolEventList.filter((e) => e.eventType?.includes('borrow'));
    const returnEvents = poolEventList.filter((e) => e.eventType?.includes('return'));

    if (borrowEvents.length === 0 || returnEvents.length === 0) continue;

    // Extract amounts from decoded data
    const borrowAmounts = borrowEvents
      .map((e) => extractAmount(e.decoded as Record<string, unknown>))
      .filter((a) => a !== null) as bigint[];

    const returnAmounts = returnEvents
      .map((e) => extractAmount(e.decoded as Record<string, unknown>))
      .filter((a) => a !== null) as bigint[];

    if (borrowAmounts.length === 0 || returnAmounts.length === 0) continue;

    const totalBorrow = borrowAmounts.reduce((a, b) => a + b, 0n);
    const totalReturn = returnAmounts.reduce((a, b) => a + b, 0n);

    // Calculate variance: if return is close to borrow, likely flash loan
    const variance = totalBorrow > 0n ? Number((totalReturn * 100n) / totalBorrow) : 0;

    // Flag if variance is between 95-105% (borrow ≈ return) or multiple cycles
    if ((variance >= 95 && variance <= 105) || borrowEvents.length > 1) {
      const severity =
        borrowEvents.length > 3 ? 'high' : borrowEvents.length > 1 ? 'medium' : 'low';

      alerts.push({
        ledger: ledgerSequence,
        poolAddress,
        borrowAmount: totalBorrow,
        returnAmount: totalReturn,
        variance,
        severity,
        transactions: [...new Set(poolEventList.map((e) => e.transactionHash))],
      });
    }
  }

  return alerts;
}

function extractAmount(decoded: Record<string, unknown>): bigint | null {
  // Try common field names for amount values
  const amountFields = ['amount', 'value', 'quantity', 'balance_change'];
  for (const field of amountFields) {
    const val = decoded[field];
    if (typeof val === 'bigint') return val;
    if (typeof val === 'number') return BigInt(val);
    if (typeof val === 'string') {
      try {
        return BigInt(val);
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Store flash loan alert in database and mark associated transactions
 */
export async function storeFlashLoanAlert(alert: FlashLoanAlert): Promise<void> {
  // Update transactions with flash loan flag
  await prisma.transaction.updateMany({
    where: { hash: { in: alert.transactions } },
    data: { flashLoanAlert: true },
  });
}
