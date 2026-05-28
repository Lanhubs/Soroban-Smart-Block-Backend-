/**
 * GET /api/v1/storage          — list storage efficiency logs (filterable)
 * GET /api/v1/storage/:txHash  — single log by transaction hash
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { z } from 'zod';

export const storageRouter = Router();

const listSchema = z.object({
  contract:    z.string().optional(),
  ledgerMin:   z.coerce.number().int().min(0).optional(),
  ledgerMax:   z.coerce.number().int().min(0).optional(),
  minEfficiency: z.coerce.number().min(0).max(100).optional(),
  maxEfficiency: z.coerce.number().min(0).max(100).optional(),
  page:  z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

storageRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = listSchema.parse(req.query);
    const where = {
      ...(q.contract && { contractAddress: q.contract }),
      ...((q.ledgerMin !== undefined || q.ledgerMax !== undefined) && {
        ledgerSequence: {
          ...(q.ledgerMin !== undefined && { gte: q.ledgerMin }),
          ...(q.ledgerMax !== undefined && { lte: q.ledgerMax }),
        },
      }),
      ...((q.minEfficiency !== undefined || q.maxEfficiency !== undefined) && {
        efficiencyPct: {
          ...(q.minEfficiency !== undefined && { gte: q.minEfficiency }),
          ...(q.maxEfficiency !== undefined && { lte: q.maxEfficiency }),
        },
      }),
    };

    const skip = (q.page - 1) * q.limit;
    const [data, total] = await Promise.all([
      prisma.storageEfficiencyLog.findMany({
        where,
        orderBy: { ledgerSequence: 'desc' },
        skip,
        take: q.limit,
      }),
      prisma.storageEfficiencyLog.count({ where }),
    ]);

    res.json({ data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

storageRouter.get('/:txHash', async (req: Request, res: Response) => {
  const row = await prisma.storageEfficiencyLog.findUnique({
    where: { transactionHash: req.params.txHash },
  });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});
