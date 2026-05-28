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
import { tieredRateLimit } from './middleware/rateLimit';
import { replicaGuard } from './middleware/replicaGuard';
import { coldStorageRouter } from './middleware/coldStorageRouter';
import { swaggerSpec } from './indexer/swaggerSpec';
import { attachWebSocketServer } from './ws/eventBroadcaster';
import { warmTokenMetadataCache } from './indexer/token-metadata';

const app = express();

app.use(helmet({ contentSecurityPolicy: false })); // CSP off so Swagger UI loads
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(tieredRateLimit);
app.use(replicaGuard);

// #134: Cold storage routing for deep history queries
app.use(coldStorageRouter);

// Interactive API docs
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api/docs.json', (_req, res) => res.json(swaggerSpec));

app.use('/api/v1', router);

app.get('/health', (_req, res) => res.json({ status: 'ok', network: config.stellarNetwork }));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

async function main() {
  await prisma.$connect();
  startIndexerService().catch((err) => console.error('Indexer service failed:', err));

  // Pre-warm token metadata cache from DB so first requests are instant
  warmTokenMetadataCache().catch((err) =>
    console.warn('[token-metadata] Cache warm-up failed:', err),
  );

  const httpServer = createServer(app);
  attachWebSocketServer(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`🚀 Soroban Explorer API running on port ${config.port}`);
    console.log(`🔌 WebSocket event stream available at ws://localhost:${config.port}/ws/events`);
  });
}

main().catch(console.error);
