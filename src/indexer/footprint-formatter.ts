import { SorobanDataBuilder, SorobanRpc } from '@stellar/stellar-sdk';

/** Soroban Protocol-21 per-transaction limits */
const LIMITS = {
  cpuInstructions: 100_000_000,
  memBytes: 40 * 1024 * 1024,
  ledgerReadBytes: 200 * 1024,
  ledgerWriteBytes: 66 * 1024,
  ledgerReadEntries: 40,
  ledgerWriteEntries: 25,
/**
 * Soroban protocol-level per-transaction limits (as of Protocol 21 / mainnet).
 * @see https://developers.stellar.org/docs/networks/resource-limits-fees
 */
const LIMITS = {
  cpuInstructions: 100_000_000,   // 100M instructions per tx
  memBytes: 40 * 1024 * 1024,     // 40 MB RAM
  ledgerReadBytes: 200 * 1024,    // 200 KB read
  ledgerWriteBytes: 66 * 1024,    // 66 KB write
  ledgerReadEntries: 40,          // ledger entries read
  ledgerWriteEntries: 25,         // ledger entries written
} as const;

export interface ResourceMetric {
  label: string;
  value: number;
  limit: number;
  unit: string;
  pct: number;
  human: string;
  pct: number;           // 0–100
  human: string;         // e.g. "Uses 42% of maximum block CPU capacity"
}

export interface FormattedFootprint {
  minResourceFee: string;
  metrics: ResourceMetric[];
  summary: string;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
  summary: string;       // one-line worst-case description
}

function metric(label: string, value: number, limit: number, unit: string): ResourceMetric {
  const pct = limit > 0 ? Math.min(100, Math.round((value / limit) * 100)) : 0;
  const fmt = unit === 'bytes' ? fmtBytes : (n: number) => n.toLocaleString();
  return {
    label, value, limit, unit, pct,
    human: `Uses ${pct}% of maximum ${label.toLowerCase()} (${fmt(value)} / ${fmt(limit)})`,
  };
}

export function formatFootprint(
  sim: SorobanRpc.Api.SimulateTransactionSuccessResponse
): FormattedFootprint {
  const resources = (sim.transactionData as SorobanDataBuilder).build().resources();
  const display = unit === 'bytes' ? fmtBytes(value) : value.toLocaleString();
  const limitDisplay = unit === 'bytes' ? fmtBytes(limit) : limit.toLocaleString();
  return {
    label,
    value,
    limit,
    unit,
    pct,
    human: `Uses ${pct}% of maximum ${label.toLowerCase()} (${display} / ${limitDisplay})`,
  };
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Format the resource footprint from a successful simulateTransaction response.
 */
export function formatFootprint(sim: SorobanRpc.Api.SimulateTransactionSuccessResponse): FormattedFootprint {
  const resources = (sim.transactionData as SorobanDataBuilder).build().resources();

  const cpuInsns = Number(resources.instructions());
  const memBytes = Number((sim.cost as SorobanRpc.Api.Cost).memBytes);
  const readBytes = Number(resources.readBytes());
  const writeBytes = Number(resources.writeBytes());
  const readEntries =
    (sim.transactionData as SorobanDataBuilder).getReadOnly().length +
    (sim.transactionData as SorobanDataBuilder).getReadWrite().length;
  const readEntries = (sim.transactionData as SorobanDataBuilder).getReadOnly().length +
                      (sim.transactionData as SorobanDataBuilder).getReadWrite().length;
  const writeEntries = (sim.transactionData as SorobanDataBuilder).getReadWrite().length;

  const metrics: ResourceMetric[] = [
    metric('CPU Instructions', cpuInsns, LIMITS.cpuInstructions, 'instructions'),
    metric('RAM Allocation', memBytes, LIMITS.memBytes, 'bytes'),
    metric('Ledger Read Bytes', readBytes, LIMITS.ledgerReadBytes, 'bytes'),
    metric('Ledger Write Bytes', writeBytes, LIMITS.ledgerWriteBytes, 'bytes'),
    metric('Ledger Read Entries', readEntries, LIMITS.ledgerReadEntries, 'entries'),
    metric('Ledger Write Entries', writeEntries, LIMITS.ledgerWriteEntries, 'entries'),
  ];

  const worst = metrics.reduce((a, b) => (a.pct >= b.pct ? a : b));
  const summary =
    worst.pct >= 80
      ? `⚠️  High resource usage: ${worst.label} at ${worst.pct}% of limit`
      : `Resource usage nominal — highest is ${worst.label} at ${worst.pct}% of limit`;

  return { minResourceFee: sim.minResourceFee, metrics, summary };
}
