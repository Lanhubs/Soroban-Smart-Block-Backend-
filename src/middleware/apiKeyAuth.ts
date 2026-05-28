import { Request, Response, NextFunction } from 'express';
import { prismaRead as prisma } from '../db';

/**
 * Middleware that enforces API key authentication on developer/dashboard routes.
 *
 * Usage:
 *   router.use('/dashboard', requireApiKey, dashboardRouter);
 *
 * The key is read from the `X-API-Key` header. It is validated against the
 * ApiKey table (active keys only). On success, `req.apiKey` is populated.
 * Public block-data endpoints do NOT use this middleware.
 */
export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['x-api-key'] as string | undefined;
  if (!key) {
    return res.status(401).json({ error: 'API key required. Pass X-API-Key header.' });
  }

  const record = await prisma.apiKey.findUnique({ where: { key } });
  if (!record || !record.active) {
    return res.status(403).json({ error: 'Invalid or inactive API key.' });
  }

  // Attach to request for downstream handlers
  (req as any).apiKey = record;

  // Fire-and-forget last-used update (non-blocking)
  prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  next();
}
