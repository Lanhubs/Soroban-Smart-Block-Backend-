import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT ?? '3000'),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  stellarNetwork: process.env.STELLAR_NETWORK ?? 'testnet',
  stellarRpcUrl: process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  stellarRpcWsUrl: process.env.STELLAR_RPC_WS_URL ?? process.env.STELLAR_RPC_URL?.replace(/^http/, 'ws') ?? 'wss://soroban-testnet.stellar.org',
  horizonUrl: process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  networkPassphrase: process.env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
  indexerStartLedger: parseInt(process.env.INDEXER_START_LEDGER ?? '0'),
  indexerPollIntervalMs: parseInt(process.env.INDEXER_POLL_INTERVAL_MS ?? '5000'),
  indexerBatchSize: parseInt(process.env.INDEXER_BATCH_SIZE ?? '100'),
  indexerCatchupWorkers: Math.max(1, parseInt(process.env.INDEXER_CATCHUP_WORKERS ?? '4')),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? '100'),
  readReplicaUrl: process.env.READ_REPLICA_URL ?? process.env.DATABASE_URL ?? '',
};
