/**
 * Transaction Reorder Buffer
 *
 * Soroban parallel execution can produce transaction outputs in non-deterministic
 * order within a single ledger.  This buffer accepts transactions as they arrive
 * and emits them in strict deterministic execution-index order so the API always
 * presents a linear ledger state sequence.
 *
 * Usage:
 *   const buf = new ReorderBuffer(onOrdered);
 *   buf.insert({ executionIndex: 2, ... });
 *   buf.insert({ executionIndex: 0, ... });
 *   buf.insert({ executionIndex: 1, ... });
 *   // onOrdered is called with [0, 1, 2] in order
 */

export interface OrderedTransaction {
  /** Deterministic position within the ledger (0-based). */
  executionIndex: number;
  hash: string;
  ledgerSequence: number;
  [key: string]: unknown;
}

export type OrderedCallback = (txs: OrderedTransaction[]) => void | Promise<void>;

export class ReorderBuffer {
  /** Pending transactions keyed by executionIndex. */
  private pending = new Map<number, OrderedTransaction>();
  /** Next index we expect to emit. */
  private nextIndex = 0;
  /** Total transactions expected in this ledger (set when known). */
  private expectedCount: number | undefined;

  constructor(private readonly onOrdered: OrderedCallback) {}

  /**
   * Reset the buffer for a new ledger.
   * @param expectedCount  Optional: total tx count in the ledger.
   */
  reset(expectedCount?: number): void {
    this.pending.clear();
    this.nextIndex = 0;
    this.expectedCount = expectedCount;
  }

  /**
   * Insert a transaction.  Flushes any contiguous run starting at nextIndex.
   */
  insert(tx: OrderedTransaction): void {
    if (tx.executionIndex < this.nextIndex) {
      // Duplicate or already-emitted index — ignore
      return;
    }
    this.pending.set(tx.executionIndex, tx);
    this.flush();
  }

  /**
   * Force-flush all buffered transactions in index order, filling gaps with
   * whatever is available.  Call this when the ledger is fully received but
   * some indices may be missing (e.g. failed transactions not reported).
   */
  drain(): OrderedTransaction[] {
    const sorted = [...this.pending.values()].sort(
      (a, b) => a.executionIndex - b.executionIndex,
    );
    this.pending.clear();
    this.nextIndex = sorted.length > 0
      ? sorted[sorted.length - 1].executionIndex + 1
      : this.nextIndex;
    return sorted;
  }

  /** Number of transactions still waiting in the buffer. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** True when all expected transactions have been emitted. */
  get isComplete(): boolean {
    return this.expectedCount !== undefined && this.nextIndex >= this.expectedCount;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private flush(): void {
    const ready: OrderedTransaction[] = [];

    while (this.pending.has(this.nextIndex)) {
      ready.push(this.pending.get(this.nextIndex)!);
      this.pending.delete(this.nextIndex);
      this.nextIndex++;
    }

    if (ready.length > 0) {
      const result = this.onOrdered(ready);
      if (result instanceof Promise) {
        result.catch((err) =>
          console.error('[reorder-buffer] onOrdered callback error:', err),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Ledger-scoped factory
// ---------------------------------------------------------------------------

/**
 * Build a ReorderBuffer for a single ledger and return a helper that accepts
 * raw parallel outputs and resolves with the fully-ordered array once all
 * `totalCount` transactions have been received.
 */
export function createLedgerBuffer(totalCount: number): {
  insert: (tx: OrderedTransaction) => void;
  result: Promise<OrderedTransaction[]>;
} {
  let resolve!: (txs: OrderedTransaction[]) => void;
  const result = new Promise<OrderedTransaction[]>((res) => { resolve = res; });

  const collected: OrderedTransaction[] = [];

  const buf = new ReorderBuffer((txs) => {
    collected.push(...txs);
    if (collected.length >= totalCount) {
      resolve(collected);
    }
  });

  buf.reset(totalCount);

  return {
    insert: (tx) => buf.insert(tx),
    result,
  };
}
