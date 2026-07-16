# Soroban Smart Block Explorer — Backend

Human-readable Soroban contract explorer. Decodes raw XDR into plain English:
> "Address GABC... swapped 100 USDC → 98.7 XLM on StellarSwap at ledger 4521983."

## Stack
- **Node.js + Express + TypeScript**
- **PostgreSQL + Prisma ORM**
- **Stellar SDK** — Soroban RPC + XDR decoding
- **Docker Compose** — one-command setup

## Architecture

```
src/
├── index.ts              # Express app entry
├── config.ts             # Env config
├── db.ts                 # Prisma client
├── api/
│   ├── router.ts         # Route aggregator
│   ├── transactions.ts   # GET /transactions
│   ├── events.ts         # GET /events
│   ├── contracts.ts      # GET/POST /contracts (ABI registry)
│   ├── wallets.ts        # GET /wallets/:address
│   └── tokens.ts         # GET /tokens (SEP-41)
└── indexer/
    ├── rpc.ts            # Stellar RPC client
    ├── registry.ts       # ABI registry + SEP-41 built-in ABI
    ├── decoder.ts        # XDR → human-readable decoder
    ├── indexer.ts        # Ledger polling loop
    └── run.ts            # Indexer entry point
```

## Quick Start

### With Docker (recommended)
```bash
cp .env.example .env
docker compose up
```

### Local development
```bash
cp .env.example .env
# edit .env with your DB URL and RPC endpoint

npm install
npx prisma migrate dev
npm run seed          # seed known contracts (StellarSwap etc.)
npm run dev           # start API server
npm run index         # start indexer (separate terminal)
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/transactions` | List transactions (filter: `contract`, `account`, `status`) |
| GET | `/api/v1/transactions/:hash` | Transaction detail + events |
| GET | `/api/v1/events` | List events (filter: `contract`, `type`) |
| GET | `/api/v1/events/:id` | Event detail |
| GET | `/api/v1/contracts` | List registered contracts |
| GET | `/api/v1/contracts/:address` | Contract detail + recent txs/events |
| POST | `/api/v1/contracts` | Register contract ABI metadata |
| GET | `/api/v1/wallets/:address/transactions` | Wallet transaction history |
| GET | `/api/v1/wallets/:address/events` | Wallet event history |
| GET | `/api/v1/tokens` | List SEP-41 tokens |
| GET | `/api/v1/tokens/:address` | Token detail |
| GET | `/api/v1/tokens/:address/transfers` | Token transfer history |
| GET | `/health` | Health check |

## Registering a Contract ABI

```bash
curl -X POST http://localhost:3000/api/v1/contracts \
  -H "Content-Type: application/json" \
  -d '{
    "address": "CXXX...",
    "name": "MyDEX",
    "abi": {
      "functions": [{
        "name": "swap",
        "inputs": [
          { "name": "from", "type": "address" },
          { "name": "amount_in", "type": "i128" },
          { "name": "amount_out", "type": "i128" }
        ],
        "humanTemplate": "{from} swapped {amount_in} → {amount_out} on MyDEX"
      }]
    }
  }'
```

## Sandbox Capabilities

The `src/sandbox/` module provides a **deterministic transactional state simulator** for Soroban contracts.

**What it is:**
- Pure TypeScript simulator — no WebAssembly execution
- Contracts dispatched by `templateId` to hardcoded logic (SEP-41 token, AMM, NFT, multisig, etc.)
- Deterministic by construction: same seed → same accounts, same results
- Gas metering via configurable cost table (`src/sandbox/gas-model.ts`) — approximates Soroban but does **not** match mainnet within 1%
- State isolation via copy-on-write snapshots
- Fuzzing, CI pipelines, invariant verification built on top

**What it is NOT:**
- A WASM JIT sandbox — does not execute WASM bytecode
- A mainnet replay oracle — `replayMainnet()` returns `{ equal: false, reason: 'sandbox substrate is not a WASM runtime' }`
- The sandbox router (`src/api/sandbox.ts`) is exported but **not mounted** in `router.ts`

**Design for a real WASM JIT sandbox** (issue #561):
See `docs/sandbox-jit-design.md` for the target architecture including:
- Tiered Cranelift compilation (baseline → optimizing + OSR)
- Precise per-instruction gas metering with prepay/refund
- Deterministic execution (float trapping, no wall clock, no threads)
- Mainnet replay parity (<10% real execution time)
- Side-channel hardening (constant-time metering, Spectre fences)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `STELLAR_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `STELLAR_RPC_URL` | testnet RPC | Soroban RPC endpoint |
| `HORIZON_URL` | testnet Horizon | Horizon API endpoint |
| `NETWORK_PASSPHRASE` | testnet | Network passphrase |
| `INDEXER_START_LEDGER` | `0` | Ledger to start indexing from |
| `INDEXER_POLL_INTERVAL_MS` | `5000` | Polling interval |
| `INDEXER_BATCH_SIZE` | `100` | Ledgers per batch |

## Mainnet Config

```env
STELLAR_NETWORK=mainnet
STELLAR_RPC_URL=https://mainnet.stellar.validationcloud.io/v1/<API_KEY>
HORIZON_URL=https://horizon.stellar.org
NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
```
