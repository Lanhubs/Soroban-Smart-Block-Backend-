import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { prismaRead } from '../db';

/**
 * Rate Limiting Middleware
 *
 * Combines the token bucket (Redis-backed distributed rate limiter) with
 * API key auth context. Falls back to express-rate-limit for non-Redis env.
 *
 * Tier resolution order:
 *  1. req.apiKey.tier (set by apiKeyAuth middleware)
 *  2. X-API-Key matches legacy env key sets (backward compat)
 *  3. 'unauthenticated'
 *
 * Attaches rate limit headers + req.rateLimitResult for audit logging.
 */

/**
 * API-key tiers (set via X-API-Key header).
 * Keys are loaded from env: API_KEYS_DEVELOPER, API_KEYS_PREMIUM (comma-separated).
 */
const developerKeys = new Set(
  (process.env.API_KEYS_DEVELOPER ?? '').split(',').filter(Boolean)
);
const premiumKeys = new Set(
  (process.env.API_KEYS_PREMIUM ?? '').split(',').filter(Boolean)
);

const DEFAULT_TIERS = {
  premium: { windowMs: 60_000, max: 1000 },
  developer: { windowMs: 60_000, max: 300 },
  public: { windowMs: 60_000, max: 100 },
} as const;

type TierName = keyof typeof DEFAULT_TIERS;
type TierConfig = { windowMs: number; max: number };

type BucketState = { count: number; resetAt: number };

const overrideCache = new Map<string, { config: TierConfig; expiresAt: number }>();
const requestBuckets = new Map<string, BucketState>();

function sanitizeTierValue(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return fallback;
  return value > 0 ? Math.floor(value) : fallback;
}

export function normalizeTierConfig(input: Partial<Record<TierName, TierConfig>> = {}): Record<TierName, TierConfig> {
  const raw = {
    public: input.public ?? { windowMs: config.rateLimitPublicWindowMs, max: config.rateLimitPublicMax },
    developer: input.developer ?? { windowMs: config.rateLimitDeveloperWindowMs, max: config.rateLimitDeveloperMax },
    premium: input.premium ?? { windowMs: config.rateLimitPremiumWindowMs, max: config.rateLimitPremiumMax },
  };

  return {
    public: {
      windowMs: sanitizeTierValue(raw.public?.windowMs, DEFAULT_TIERS.public.windowMs),
      max: sanitizeTierValue(raw.public?.max, DEFAULT_TIERS.public.max),
    },
    developer: {
      windowMs: sanitizeTierValue(raw.developer?.windowMs, DEFAULT_TIERS.developer.windowMs),
      max: sanitizeTierValue(raw.developer?.max, DEFAULT_TIERS.developer.max),
    },
    premium: {
      windowMs: sanitizeTierValue(raw.premium?.windowMs, DEFAULT_TIERS.premium.windowMs),
      max: sanitizeTierValue(raw.premium?.max, DEFAULT_TIERS.premium.max),
    },
  };
}

export function getRateLimitTier(apiKey: string | undefined, developerApiKeys = developerKeys, premiumApiKeys = premiumKeys): TierName {
  if (apiKey && premiumApiKeys.has(apiKey)) return 'premium';
  if (apiKey && developerApiKeys.has(apiKey)) return 'developer';
  return 'public';
}

function applyAdaptiveThrottle(req: Request, res: Response, tierConfigValue: TierConfig) {
  if (!config.rateLimitAdaptiveEnabled) return tierConfigValue;

  const load = Number(process.env.RATE_LIMIT_LOAD_FACTOR ?? '0');
  if (Number.isNaN(load) || load <= 0) return tierConfigValue;

  const threshold = config.rateLimitAdaptiveThreshold;
  if (load < threshold) return tierConfigValue;

  const throttledMax = Math.max(1, Math.floor(tierConfigValue.max * config.rateLimitAdaptiveMultiplier));
  const currentMax = Math.min(throttledMax, tierConfigValue.max);
  res.setHeader('X-RateLimit-Warn', 'true');
  res.setHeader('X-RateLimit-Predicted', `${currentMax}`);
  req.app.locals.rateLimitPredictedMax = currentMax;
  return { ...tierConfigValue, max: currentMax };
}

function getRequestBucketKey(req: Request, tier: TierName, userIdentifier?: string) {
  const endpoint = req.path || req.originalUrl || '/';
  const keySource = userIdentifier ?? req.ip ?? 'unknown';
  return `${tier}:${keySource}:${endpoint}`;
}

async function getUserOverride(identifier: string, endpoint: string): Promise<TierConfig | null> {
  const cacheKey = `override:${identifier}:${endpoint}`;
  const cached = overrideCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  try {
    const prisma = prismaRead as any;
    const override = await prisma.rateLimitOverride.findUnique({
      where: { identifier_endpoint: { identifier, endpoint: endpoint || '/' } },
    });
    if (!override) {
      overrideCache.set(cacheKey, { config: { windowMs: DEFAULT_TIERS.public.windowMs, max: DEFAULT_TIERS.public.max }, expiresAt: Date.now() + 60_000 });
      return null;
    }

    overrideCache.set(cacheKey, {
      config: { windowMs: override.windowMs, max: override.max },
      expiresAt: Date.now() + 60_000,
    });
    return { windowMs: override.windowMs, max: override.max };
  } catch (error) {
    console.warn('[rate-limit] unable to read overrides', error);
    return null;
  }
}

export function clearRateLimitOverrideCache(identifier?: string) {
  if (identifier) {
    overrideCache.clear();
    return;
  }
  overrideCache.clear();
}

/**
 * Middleware: reads X-API-Key, selects the appropriate rate limiter tier,
 * and delegates to it.
 */
export function tieredRateLimit(req: Request, res: Response, next: NextFunction) {
  void (async () => {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const tier = getRateLimitTier(apiKey);
    const userIdentifier = req.headers['x-user-id'] as string | undefined;
    const endpoint = req.path || req.originalUrl || '/';
    const configOverride = userIdentifier ? await getUserOverride(userIdentifier, endpoint) : null;
    const baseConfig = configOverride ?? normalizeTierConfig()[tier];
    const effectiveConfig = applyAdaptiveThrottle(req, res, baseConfig);
    const now = Date.now();
    const bucketKey = getRequestBucketKey(req, tier, userIdentifier);
    const existing = requestBuckets.get(bucketKey);

    if (!existing || existing.resetAt <= now) {
      requestBuckets.set(bucketKey, { count: 1, resetAt: now + effectiveConfig.windowMs });
    } else {
      existing.count += 1;
    }

    const bucket = requestBuckets.get(bucketKey) ?? { count: 1, resetAt: now + effectiveConfig.windowMs };
    const remaining = Math.max(0, effectiveConfig.max - bucket.count);
    res.setHeader('X-RateLimit-Limit', `${effectiveConfig.max}`);
    res.setHeader('X-RateLimit-Remaining', `${remaining}`);
    res.setHeader('X-RateLimit-Reset', `${Math.ceil(bucket.resetAt / 1000)}`);

    if (configOverride && configOverride.max > 0 && configOverride.windowMs > 0) {
      res.setHeader('X-RateLimit-Policy', 'user-override');
    }

    if (bucket.count > effectiveConfig.max) {
      res.setHeader('X-RateLimit-Remaining', '0');
      return res.status(429).json({ error: 'Too many requests' });
    }

    return next();
  })().catch((error) => {
    console.error('[rate-limit] middleware failed', error);
    next(error);
  });
import rateLimit, { Store, RateLimitRequestHandler } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import {
  checkTokenBucket,
  setRateLimitRedisClient,
  RateLimitTier,
  TokenBucketResult,
} from './tokenBucket';
import { logger } from '../logger';

// ─── Backward-compat env-key sets ────────────────────────────────────────────

const developerKeys = new Set((process.env.API_KEYS_DEVELOPER ?? '').split(',').filter(Boolean));
const premiumKeys   = new Set((process.env.API_KEYS_PREMIUM ?? '').split(',').filter(Boolean));

function getTierFromEnvKey(apiKey: string | undefined): RateLimitTier {
  if (apiKey && premiumKeys.has(apiKey))   return 'pro';
  if (apiKey && developerKeys.has(apiKey)) return 'developer';
  return 'unauthenticated';
}

// ─── Legacy fallback (express-rate-limit) ────────────────────────────────────

const TIERS = {
  premium:   { windowMs: 60_000, max: 10000 },
  developer: { windowMs: 60_000, max: 1000 },
  public:    { windowMs: 60_000, max: 60 },
};

type Limiters = Record<'premium' | 'developer' | 'public', RateLimitRequestHandler>;

function buildLimiters(store?: Store): Limiters {
  const make = (tierName: keyof typeof TIERS) =>
    rateLimit({
      ...TIERS[tierName],
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req: Request) => `${tierName}:${req.ip}`,
      ...(store ? { store } : {}),
    });
  return { premium: make('premium'), developer: make('developer'), public: make('public') };
}

let legacyLimiters: Limiters = buildLimiters();
let useTokenBucket = false;

// ─── Startup initialisation ───────────────────────────────────────────────────

export async function initRateLimitStore(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;

  try {
    const { createClient } = await import('redis');
    const { RedisStore } = await import('rate-limit-redis');

    const client = createClient({ url: redisUrl });
    client.on('error', (err: unknown) =>
      logger.warn(`[rate-limit] Redis error: ${String(err)}`),
    );
    await client.connect();

    // Wire Redis into token bucket
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRateLimitRedisClient(client as any);
    useTokenBucket = true;

    // Also build legacy limiters with Redis store for backward compat
    const store = new RedisStore({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendCommand: (...args: string[]) => (client as any).sendCommand(args),
      prefix: 'rl:',
    });
    legacyLimiters = buildLimiters(store);

    logger.info('[rate-limit] Redis token bucket active');
  } catch (err) {
    logger.warn(`[rate-limit] Redis unavailable, using in-memory fallback: ${String(err)}`);
  }
}

// ─── Main middleware ──────────────────────────────────────────────────────────

export async function tieredRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Resolve tier + client key
  const keyCtx = req.apiKey;
  const rawKey  = req.headers['x-api-key'] as string | undefined;

  const tier: RateLimitTier = keyCtx?.tier
    ?? getTierFromEnvKey(rawKey);

  const clientKey = keyCtx?.id ?? req.ip ?? 'anonymous';

  if (useTokenBucket) {
    try {
      const result: TokenBucketResult = await checkTokenBucket(
        clientKey,
        tier,
        req.method,
        req.path,
        keyCtx?.rateLimitOverride,
      );

      res.setHeader('X-RateLimit-Limit',     result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset',     result.resetAt);
      res.setHeader('X-RateLimit-Tier',      result.tier);

      (req as Request & { rateLimitResult?: TokenBucketResult }).rateLimitResult = result;

      if (!result.allowed) {
        const retryAfter = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000));
        res.setHeader('Retry-After', retryAfter);
        res.status(429).json({
          error: 'Rate limit exceeded',
          tier: result.tier,
          retryAfter,
          resetAt: new Date(result.resetAt * 1000).toISOString(),
        });
        return;
      }

      return next();
    } catch (err) {
      logger.warn(`[rate-limit] Token bucket error, falling through: ${String(err)}`);
    }
  }

  // Legacy fallback
  const legacyTier =
    tier === 'pro' || tier === 'enterprise' ? 'premium' :
    tier === 'developer' ? 'developer' : 'public';

  return legacyLimiters[legacyTier](req, res, next);
}
