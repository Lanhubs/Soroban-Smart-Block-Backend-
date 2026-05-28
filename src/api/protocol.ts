/**
 * GET /api/v1/protocol — current protocol version status (#51)
 * GET /api/v1/protocol/reconciliation — trigger/view reconciliation report (#50)
 */
import { Router, Request, Response } from 'express';
import { getProtocolStatus } from '../indexer/protocol-guard';
import { runReconciliation } from '../indexer/reconciliation';

export const protocolRouter = Router();

// GET /protocol — protocol version and feature status
protocolRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const status = await getProtocolStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /protocol/reconciliation — run reconciliation and return report
protocolRouter.get('/reconciliation', async (req: Request, res: Response) => {
  try {
    const lookback = Math.min(10_000, Math.max(1, Number(req.query.lookback ?? 1000)));
    const report = await runReconciliation(lookback);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
