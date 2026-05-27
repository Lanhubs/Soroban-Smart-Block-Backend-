import { xdr } from '@stellar/stellar-sdk';
import { prismaRead as prisma } from '../db';
import { decodeTypedArgs, formatAmount } from './args-decoder';
import { renderTemplate } from './template-engine';

export interface ContractAbi {
  functions: AbiFunction[];
}

export interface AbiFunction {
  name: string;
  inputs: AbiParam[];
  humanTemplate?: string; // e.g. "{from} swapped {amount_in} {token_in} → {amount_out} {token_out}"
}

export interface AbiParam {
  name: string;
  type: string;
}

// Built-in ABI for SEP-41 token standard
export const SEP41_ABI: ContractAbi = {
  functions: [
    {
      name: 'transfer',
      inputs: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'i128' },
      ],
      humanTemplate: '{from} transferred {amount} tokens to {to}',
    },
    {
      name: 'transfer_from',
      inputs: [
        { name: 'spender', type: 'address' },
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'i128' },
      ],
      humanTemplate: '{spender} transferred {amount} tokens from {from} to {to}',
    },
    {
      name: 'mint',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'i128' },
      ],
      humanTemplate: 'Minted {amount} tokens to {to}',
    },
    {
      name: 'burn',
      inputs: [
        { name: 'from', type: 'address' },
        { name: 'amount', type: 'i128' },
      ],
      humanTemplate: '{from} burned {amount} tokens',
    },
    {
      name: 'approve',
      inputs: [
        { name: 'from', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'amount', type: 'i128' },
        { name: 'expiration_ledger', type: 'u32' },
      ],
      humanTemplate: '{from} approved {spender} to spend {amount} tokens',
    },
  ],
};

/**
 * Get ABI for a contract address. Falls back to SEP-41 for token contracts.
 */
export async function getContractAbi(contractAddress: string): Promise<ContractAbi | null> {
  const contract = await prisma.contract.findUnique({ where: { address: contractAddress } });
  if (!contract) return null;
  if (contract.isToken) return SEP41_ABI;
  if (contract.abi) return contract.abi as unknown as ContractAbi;
  return null;
}

/**
 * Decode raw XDR ScVal arguments into a named map using the ABI.
 * Values are the formatted strings from the typed decoder.
 */
export function decodeArgs(
  fnName: string,
  rawArgs: xdr.ScVal[],
  abi: ContractAbi,
  decimals?: number
): Record<string, unknown> | null {
  const fn = abi.functions.find((f) => f.name === fnName);
  if (!fn) return null;
  const typed = decodeTypedArgs(fn.inputs, rawArgs, decimals);
  // Expose { raw, formatted } per key so callers can choose
  return Object.fromEntries(
    Object.entries(typed).map(([k, v]) => [k, v])
  );
}

/**
 * Render a human-readable string from decoded args and a template.
 * Delegates to the standalone template engine.
 */
export function renderHuman(
  fnName: string,
  args: Record<string, unknown>,
  abi: ContractAbi,
  contractName?: string | null,
  decimals?: number
): string {
  const fn = abi.functions.find((f) => f.name === fnName);
  if (!fn?.humanTemplate) return `Called ${fnName} on ${contractName ?? 'contract'}`;
  return renderTemplate(fn.humanTemplate, { args, decimals, contractName: contractName ?? undefined });
}
