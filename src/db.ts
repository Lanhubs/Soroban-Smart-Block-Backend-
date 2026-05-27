import { PrismaClient } from '@prisma/client';
import { config } from './config';

const logLevel = process.env.NODE_ENV === 'development'
  ? (['error', 'warn'] as ('error' | 'warn')[])
  : (['error'] as ('error')[]);

/** Primary instance — used for all writes (indexer). */
export const prismaWrite = new PrismaClient({
  log: logLevel,
});

/** Read-replica instance — used for all API reads. Falls back to primary if READ_REPLICA_URL is unset. */
export const prismaRead = new PrismaClient({
  log: logLevel,
  datasources: { db: { url: config.readReplicaUrl } },
});

/** @deprecated Import prismaWrite or prismaRead explicitly. */
export const prisma = prismaWrite;
