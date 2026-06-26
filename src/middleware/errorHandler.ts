import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Any error that carries a numeric statusCode is treated as an HTTP error. */
function hasStatusCode(err: unknown): err is { statusCode: number; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as Record<string, unknown>).statusCode === 'number'
  );
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, requestId });
    return;
  }

  if (hasStatusCode(err)) {
    logger.warn('Service error', { status: err.statusCode, error: err.message });
    res.status(err.statusCode).json({ error: err.message, requestId });
    return;
  }

  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error', requestId });
}
