import '../config'; // load dotenv
import { prismaWrite as prisma } from '../db';
import { runIndexer } from './indexer';

async function main() {
  await prisma.$connect();
  await runIndexer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
