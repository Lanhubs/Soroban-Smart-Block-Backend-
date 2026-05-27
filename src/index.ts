import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import { router } from './api/router';
import { prismaWrite as prisma } from './db';
import { startIndexerService } from './indexer/indexer';
import { tieredRateLimit } from './middleware/rateLimit';

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(tieredRateLimit);

app.use('/api/v1', router);

app.get('/health', (_req, res) => res.json({ status: 'ok', network: config.stellarNetwork }));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

async function main() {
  await prisma.$connect();
  startIndexerService().catch((err) => console.error('Indexer service failed:', err));

  app.listen(config.port, () => {
    console.log(`🚀 Soroban Explorer API running on port ${config.port}`);
  });
}

main().catch(console.error);
