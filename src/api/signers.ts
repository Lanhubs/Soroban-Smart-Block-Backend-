/**
 * GET /api/v1/signers                — list signer snapshots (filterable)
 * GET /api/v1/signers/:txHash        — snapshot for a specific transaction
 * GET /api/v1/signers/account/:addr  — all snapshots for a smart-account contract
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';

export const signersRouter = Router();

const listSchema = z.object({
  contract:  z.string().optional(),
  passed:    z.enum(['true', 'false']).optional(),
  threshold: z.enum(['high', 'medium', 'low', 'none']).optional(),
  ledgerMin: z.coerce.number().int().min(0).optional(),
  ledgerMax: z.coerce.number().int().min(0).optional(),
  page:  z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

signersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = listSchema.parse(req.query);
    const where = {
      ...(q.contract  && { contractAddress: q.contract }),
      ...(q.passed !== undefined && { passed: q.passed === 'true' }),
      ...(q.threshold && { thresholdMet: q.threshold }),
      ...((q.ledgerMin !== undefined || q.ledgerMax !== undefined) && {
        ledgerSequence: {
          ...(q.ledgerMin !== undefined && { gte: q.ledgerMin }),
          ...(q.ledgerMax !== undefined && { lte: q.ledgerMax }),
        },
      }),
    };

    const skip = (q.page - 1) * q.limit;
    const [data, total] = await Promise.all([
      prisma.signerSnapshot.findMany({
        where,
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: q.limit,
      }),
      prisma.signerSnapshot.count({ where }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

signersRouter.get('/account/:addr', async (req: Request, res: Response) => {
  try {
    const q = listSchema.parse(req.query);
    const skip = (q.page - 1) * q.limit;
    const where = { contractAddress: req.params.addr };
    const [data, total] = await Promise.all([
      prisma.signerSnapshot.findMany({
        where,
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: q.limit,
      }),
      prisma.signerSnapshot.count({ where }),
    ]);
    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

signersRouter.get('/:txHash', async (req: Request, res: Response) => {
  const row = await prisma.signerSnapshot.findUnique({
    where: { transactionHash: req.params.txHash },
  });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});
