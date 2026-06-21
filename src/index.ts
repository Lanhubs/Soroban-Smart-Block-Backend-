import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { router } from './api/router';
import { prismaWrite as prisma } from './db';
import { startIndexerService } from './indexer/indexer';
import { tieredRateLimit, initRateLimitStore } from './middleware/rateLimit';
import { metricsMiddleware } from './middleware/metricsMiddleware';
import { sanitizeInputs } from './middleware/sanitize';
import { i18nMiddleware } from './i18n';
import { registry, dbConnectionStatus } from './metrics';
import { replicaGuard } from './middleware/replicaGuard';
import { coldStorageRouter } from './middleware/coldStorageRouter';
import { networkRouter } from './middleware/networkRouter';
import { swaggerSpec } from './indexer/swaggerSpec';
import { attachWebSocketServer } from './ws/eventBroadcaster';
import { warmTokenMetadataCache } from './indexer/token-metadata';
import { cacheConnect } from './cache';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './logger';
import { feedOrchestrator } from './feed/orchestrator';

// Stub functions for features requiring missing Prisma schema models
function attachPrivacyWebSocket(_server: unknown): void {
  logger.debug('Privacy WebSocket disabled — schema models not yet available');
}
function attachComposabilityWebSocket(_server: unknown): void {
  logger.debug('Composability WebSocket disabled — schema models not yet available');
}
function attachArbitrageWebSocket(_server: unknown): void {
  logger.debug('Arbitrage WebSocket disabled — schema models not yet available');
}
function startPoolPriceMonitor(): void {
  logger.debug('Pool price monitor disabled — schema models not yet available');
}
function startArbitrageScanner(): void {
  logger.debug('Arbitrage scanner disabled — schema models not yet available');
}

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(networkRouter);
app.use(tieredRateLimit);
app.use(metricsMiddleware);
app.use(sanitizeInputs);
app.use(i18nMiddleware);
app.use(replicaGuard);

app.use(coldStorageRouter);

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api/docs.json', (_req, res) => res.json(swaggerSpec));

app.use('/api/v1', router);

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.get('/health', (_req, res) => res.json({ status: 'ok', network: config.stellarNetwork }));

app.use(errorHandler);
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

async function main() {
  await initRateLimitStore();
  await cacheConnect();
  await prisma.$connect();
  dbConnectionStatus.set(1);

  if (!process.env.DISABLE_INDEXER) {
    startIndexerService().catch((err) =>
      logger.error('Indexer service failed', { error: String(err) }),
    );
    warmTokenMetadataCache().catch((err) =>
      logger.warn('Token-metadata cache warm-up failed', { error: String(err) }),
    );
  }

  const httpServer = createServer(app);
  attachWebSocketServer(httpServer);
  attachPrivacyWebSocket(httpServer);
  attachComposabilityWebSocket(httpServer);
  attachArbitrageWebSocket(httpServer);

  if (!process.env.DISABLE_INDEXER) {
    try {
      startPoolPriceMonitor();
    } catch (err) {
      logger.warn('Pool price monitor failed to start', { error: String(err) });
    }
    try {
      startArbitrageScanner();
    } catch (err) {
      logger.warn('Arbitrage scanner failed to start', { error: String(err) });
    }
  }

  // Initialize Feed Orchestrator with WebSocket support
  await feedOrchestrator.initialize(httpServer);

  httpServer.listen(config.port, () => {
    logger.info('Soroban Explorer API started', { port: config.port });
  });
}

main().catch((err) => logger.error('Main startup failed', { error: String(err) }));
