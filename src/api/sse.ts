import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';

/**
 * @swagger
 * tags:
 *   name: SSE
 *   description: Server-Sent Events for live transaction notifications
 */

export const sseRouter = Router();

interface SSEClient {
  res: Response;
  contractFilter?: string;
}

const sseClients = new Set<SSEClient>();

/**
 * @swagger
 * /api/v1/sse/subscribe:
 *   get:
 *     summary: Subscribe to live transaction events via SSE
 *     tags: [SSE]
 *     parameters:
 *       - in: query
 *         name: contract
 *         schema:
 *           type: string
 *         description: Optional contract address filter
 *     responses:
 *       200:
 *         description: SSE stream established
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: object
 */
sseRouter.get('/subscribe', (req: Request, res: Response) => {
  const contractFilter = req.query.contract as string | undefined;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const client: SSEClient = { res, contractFilter };
  sseClients.add(client);

  res.write(':connected\n\n');

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(':heartbeat\n\n');
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
});

export function broadcastSSEEvent(event: {
  id: string;
  contractAddress: string;
  eventType: string;
  decoded: unknown;
  ledger: number;
  ledgerCloseTime: Date;
  transactionHash: string;
}) {
  const payload = JSON.stringify({
    id: event.id,
    contract: event.contractAddress,
    type: event.eventType,
    data: event.decoded,
    ledger: event.ledger,
    timestamp: event.ledgerCloseTime.toISOString(),
    txHash: event.transactionHash,
  });

  for (const client of sseClients) {
    if (client.res.writableEnded) {
      sseClients.delete(client);
      continue;
    }

    if (client.contractFilter && client.contractFilter !== event.contractAddress) {
      continue;
    }

    client.res.write(`data: ${payload}\n\n`);
  }
}

/**
 * @swagger
 * /api/v1/sse/stats:
 *   get:
 *     summary: Get SSE connection statistics
 *     tags: [SSE]
 *     responses:
 *       200:
 *         description: Connection stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activeConnections:
 *                   type: integer
 *                 filteredConnections:
 *                   type: integer
 */
sseRouter.get('/stats', (_req: Request, res: Response) => {
  const activeConnections = sseClients.size;
  const filteredConnections = Array.from(sseClients).filter((c) => c.contractFilter).length;

  res.json({ activeConnections, filteredConnections });
});
