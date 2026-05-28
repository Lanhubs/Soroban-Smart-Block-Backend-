import { prismaWrite as prisma } from '../db';
import { fetchEvents, getTransaction } from './rpc';
import { decodeTransaction } from './decoder';
import { ingestEvents } from './eventIngestor';
import { enqueueFailure } from './errorQueue';
import { extractSorobanResources } from './resource-tracker';
import { parseFailureReason, parseFailureReasonFromString } from './failure-parser';
import { safeXdrParse } from './protocol-guard';

/**
 * Fetch, decode, and persist all transactions and events for [start, end].
 * Safe to call concurrently for non-overlapping ranges — all DB writes use
 * upsert so duplicate execution is idempotent.
 */
export async function processLedgerRange(start: number, end: number): Promise<void> {
  console.log(`[worker] Indexing ledgers ${start} → ${end}`);
  const events = await fetchEvents(start, end);

  for (const event of events) {
    // Upsert the Ledger row before writing transactions/events (FK constraint)
    await prisma.ledger.upsert({
      where: { sequence: event.ledgerSequence },
      update: {},
      create: {
        sequence: event.ledgerSequence,
        hash: '',               // hash not available from event stream; filled in if known
        closeTime: event.ledgerCloseTime,
      },
    });

    await prisma.contract.upsert({
      where: { address: event.contractId },
      update: {},
      create: { address: event.contractId },
    });

    const existingTx = await prisma.transaction.findUnique({ where: { hash: event.transactionHash } });
    if (!existingTx) {
      const txResult = await getTransaction(event.transactionHash).catch(() => null);
      const rawXdr = (txResult as any)?.envelopeXdr?.toXDR('base64') ?? '';
      const decoded = rawXdr
        ? await decodeTransaction(rawXdr).catch(async (err) => {
            await enqueueFailure({
              itemType: 'transaction',
              itemId: event.transactionHash,
              ledger: event.ledgerSequence,
              rawXdr,
              error: err,
            });
            return { contractAddress: event.contractId, functionName: null, functionArgs: null, humanReadable: null };
          })
        : { contractAddress: event.contractId, functionName: null, functionArgs: null, humanReadable: null };

      // #48: Extract Soroban resource consumption from result meta XDR
      const resultMetaXdr = (txResult as any)?.resultMetaXdr?.toXDR?.('base64') ?? '';
      const sorobanResources = resultMetaXdr
        ? safeXdrParse(() => extractSorobanResources(resultMetaXdr), null, 'SorobanResources')
        : null;

      // #49: Parse failure reason for failed transactions
      const txStatus = (txResult as any)?.status === 'SUCCESS' ? 'success' : 'failed';
      let failureReason: string | null = null;
      if (txStatus === 'failed') {
        const resultXdr = (txResult as any)?.resultXdr?.toXDR?.('base64') ?? '';
        if (resultXdr) {
          const parsed = safeXdrParse(() => parseFailureReason(resultXdr), null, 'FailureReason');
          failureReason = parsed ? `${parsed.reason}${parsed.detail ? `: ${parsed.detail}` : ''}` : null;
        }
        // Fallback: parse from error string if available
        if (!failureReason) {
          const errStr = String((txResult as any)?.resultCode ?? (txResult as any)?.error ?? '');
          if (errStr) failureReason = parseFailureReasonFromString(errStr);
        }
      }

      await prisma.transaction.upsert({
        where: { hash: event.transactionHash },
        update: {},
        create: {
          hash: event.transactionHash,
          ledgerSequence: event.ledgerSequence,
          ledgerCloseTime: event.ledgerCloseTime,
          sourceAccount: (txResult as any)?.sourceAccount ?? 'unknown',
          contractAddress: decoded.contractAddress,
          functionName: decoded.functionName,
          functionArgs: decoded.functionArgs as object ?? undefined,
          rawXdr,
          status: txStatus,
          humanReadable: decoded.humanReadable,
          feeCharged: String((txResult as any)?.feeCharged ?? ''),
          sorobanResources: sorobanResources as object ?? undefined,
          failureReason,
        },
      });
    }
  }

  const stored = await ingestEvents(start, end);
  console.log(`[worker] ledgers ${start}–${end}: ${events.length} txs, ${stored} events`);
}
