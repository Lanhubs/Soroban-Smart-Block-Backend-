/**
 * src/api/router.ts
 *
 * Central API router for the Soroban Block Explorer backend.
 *
 * All routers in src/api/ are registered here. A RouterRegistry CI check
 * (scripts/validate-routes.ts) ensures every exported router is mounted —
 * new routers added without a corresponding entry here will fail CI.
 *
 * Route prefix conventions:
 *   - Kebab-case, matching the file name where possible
 *   - No trailing slashes
 *   - oracle-audit mounts under /oracles/audit (avoids root wildcard conflict)
 */

import { Router } from 'express';

// ── Previously mounted routers ────────────────────────────────────────────────
import { i18nRouter } from './i18n';
import { transactionRouter } from './transactions';
import { eventRouter } from './events';
import { contractRouter } from './contracts';
import { walletRouter } from './wallets';
import { tokenRouter } from './tokens';
import { authorizationRouter } from './authorizations';
import { renderRouter } from './render';
import { simulateRouter } from './simulate';
import { verifyRouter } from './verify';
import { syncStateRouter } from './sync-state';
import { networkRouter } from './network';
import { tokenMetadataRouter } from './token-metadata';
import { protocolRouter } from './protocol';
import { aaRouter } from './aa';

export const router = Router();

// ── i18n ──────────────────────────────────────────────────────────────────────
router.use('/i18n', i18nRouter);

// ── Core Stellar / Soroban ────────────────────────────────────────────────────
router.use('/transactions', transactionRouter);
router.use('/events', eventRouter);
router.use('/contracts', contractRouter);
router.use('/wallets', walletRouter);
router.use('/tokens', tokenRouter);
router.use('/authorizations', authorizationRouter);
router.use('/render', renderRouter);
router.use('/simulate', simulateRouter);
router.use('/verify', verifyRouter);
router.use('/sync-state', syncStateRouter);
router.use('/network', networkRouter);
router.use('/token-metadata', tokenMetadataRouter);
router.use('/protocol', protocolRouter);
router.use('/i18n', i18nRouter);
router.use('/aa', aaRouter);
