import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';

/**
 * @swagger
 * tags:
 *   name: VirtualList
 *   description: Optimized transaction payloads for infinite scroll components
 */

export const virtualListRouter = Router();

interface VirtualListItem {
  id: string;
  hash: string;
  contractAddress: string;
  status: string;
  ledger: number;
  timestamp: number;
  rowHeight: number;
  decoded?: string;
}

interface VirtualListPayload {
  items: VirtualListItem[];
  totalCount: number;
  hasMore: boolean;
  estimatedRowHeight: number;
}

const ESTIMATED_ROW_HEIGHT = 64; // pixels

/**
 * @swagger
 * /api/v1/virtual-list/transactions:
 *   get:
 *     summary: Get transactions in virtual list format for infinite scroll
 *     tags: [VirtualList]
 *     parameters:
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Starting position in result set
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of items to return
 *       - in: query
 *         name: contract
 *         schema:
 *           type: string
 *         description: Filter by contract address
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [success, failed, pending]
 *         description: Filter by transaction status
 *     responses:
 *       200:
 *         description: Virtual list payload with flat structure
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       hash: { type: string }
 *                       contractAddress: { type: string }
 *                       status: { type: string }
 *                       ledger: { type: integer }
 *                       timestamp: { type: number }
 *                       rowHeight: { type: number }
 *                       decoded: { type: string }
 *                 totalCount: { type: integer }
 *                 hasMore: { type: boolean }
 *                 estimatedRowHeight: { type: number }
 */
virtualListRouter.get('/transactions', async (req: Request, res: Response) => {
  const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10)));
  const contractFilter = req.query.contract as string | undefined;
  const statusFilter = req.query.status as string | undefined;

  const where: Record<string, unknown> = {};
  if (contractFilter) where.contractAddress = contractFilter;
  if (statusFilter) where.status = statusFilter;

  const [transactions, totalCount] = await Promise.all([
    prisma.transaction.findMany({
      where,
      select: {
        id: true,
        hash: true,
        contractAddress: true,
        status: true,
        ledgerSequence: true,
        ledgerCloseTime: true,
        decodedDescription: true,
      },
      orderBy: { ledgerCloseTime: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.transaction.count({ where }),
  ]);

  const items: VirtualListItem[] = transactions.map((tx) => ({
    id: tx.id,
    hash: tx.hash,
    contractAddress: tx.contractAddress || '',
    status: tx.status,
    ledger: tx.ledgerSequence,
    timestamp: tx.ledgerCloseTime.getTime(),
    rowHeight: ESTIMATED_ROW_HEIGHT,
    decoded: tx.decodedDescription || undefined,
  }));

  const payload: VirtualListPayload = {
    items,
    totalCount,
    hasMore: offset + limit < totalCount,
    estimatedRowHeight: ESTIMATED_ROW_HEIGHT,
  };

  res.json(payload);
});

/**
 * @swagger
 * /api/v1/virtual-list/events:
 *   get:
 *     summary: Get events in virtual list format for infinite scroll
 *     tags: [VirtualList]
 *     parameters:
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: contract
 *         schema:
 *           type: string
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Virtual list payload
 */
virtualListRouter.get('/events', async (req: Request, res: Response) => {
  const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10)));
  const contractFilter = req.query.contract as string | undefined;
  const typeFilter = req.query.type as string | undefined;

  const where: Record<string, unknown> = {};
  if (contractFilter) where.contractAddress = contractFilter;
  if (typeFilter) where.eventType = typeFilter;

  const [events, totalCount] = await Promise.all([
    prisma.event.findMany({
      where,
      select: {
        id: true,
        contractAddress: true,
        eventType: true,
        ledgerSequence: true,
        ledgerCloseTime: true,
        decoded: true,
      },
      orderBy: { ledgerCloseTime: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.event.count({ where }),
  ]);

  const items: VirtualListItem[] = events.map((event) => ({
    id: event.id,
    hash: event.id,
    contractAddress: event.contractAddress,
    status: event.eventType,
    ledger: event.ledgerSequence,
    timestamp: event.ledgerCloseTime.getTime(),
    rowHeight: ESTIMATED_ROW_HEIGHT,
    decoded: JSON.stringify(event.decoded),
  }));

  const payload: VirtualListPayload = {
    items,
    totalCount,
    hasMore: offset + limit < totalCount,
    estimatedRowHeight: ESTIMATED_ROW_HEIGHT,
  };

  res.json(payload);
});
