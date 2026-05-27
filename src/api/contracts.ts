import { Router, Request, Response } from 'express';
import { prisma } from '../db';
import { z } from 'zod';
import { fetchContractSpec } from '../indexer/wasm-spec';

export const contractRouter = Router();

const abiSchema = z.object({
  address: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  abi: z.record(z.unknown()).optional(),
});

// GET /contracts
contractRouter.get('/', async (_req: Request, res: Response) => {
  const contracts = await prisma.contract.findMany({
    select: { address: true, name: true, description: true, isToken: true, tokenSymbol: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(contracts);
});

// GET /contracts/:address/spec — fetch on-chain Wasm spec / ABI as JSON schema
contractRouter.get('/:address/spec', async (req: Request, res: Response) => {
  const schema = await fetchContractSpec(req.params.address);
  if (!schema) return res.status(404).json({ error: 'Spec not found or contract has no embedded spec' });
  res.json(schema);
});

// GET /contracts/:address
contractRouter.get('/:address', async (req: Request, res: Response) => {
  const contract = await prisma.contract.findUnique({
    where: { address: req.params.address },
    include: {
      transactions: { take: 10, orderBy: { ledger: 'desc' }, select: { hash: true, functionName: true, humanReadable: true, ledger: true } },
      events: { take: 10, orderBy: { ledger: 'desc' }, select: { id: true, eventType: true, decoded: true, ledger: true } },
    },
  });
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  res.json(contract);
});

// POST /contracts — register ABI metadata
contractRouter.post('/', async (req: Request, res: Response) => {
  try {
    const data = abiSchema.parse(req.body);
    const contract = await prisma.contract.upsert({
      where: { address: data.address },
      update: { name: data.name, description: data.description, abi: data.abi as object },
      create: { address: data.address, name: data.name, description: data.description, abi: data.abi as object },
    });
    res.status(201).json(contract);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
