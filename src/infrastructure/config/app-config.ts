import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(3000),
  INSTANCE_ID: z.string().default(() => `inst-${Math.random().toString(36).slice(2, 8)}`),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/wagering'),
  DB_POOL_MAX: z.coerce.number().int().default(20),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().default(5000),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_AUTO_CREATE: bool.default(true),
  SQS_WAGER_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wager-events.fifo'),
  SQS_VISIBILITY_TIMEOUT_S: z.coerce.number().int().default(30),
  SQS_WAIT_TIME_S: z.coerce.number().int().min(0).max(20).default(5),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().default(5),
  SQS_RETRY_BASE_S: z.coerce.number().default(2),
  SQS_RETRY_MAX_S: z.coerce.number().default(120),

  // which background workers run in this instance
  ENABLE_SQS_CONSUMER: bool.default(true),
  ENABLE_OUTBOX_PUBLISHER: bool.default(true),
  ENABLE_PENDING_REFERENCE_WORKER: bool.default(true),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().default(50),
  PENDING_REF_POLL_INTERVAL_MS: z.coerce.number().int().default(1000),
  PENDING_REF_BATCH_SIZE: z.coerce.number().int().default(50),
  PENDING_REF_MAX_ATTEMPTS: z.coerce.number().int().default(8),
  PENDING_REF_TTL_MS: z.coerce.number().int().default(10 * 60_000),
  PENDING_REF_BASE_DELAY_MS: z.coerce.number().int().default(1000),
  PENDING_REF_MAX_DELAY_MS: z.coerce.number().int().default(60_000),

  SHUTDOWN_GRACE_MS: z.coerce.number().int().default(25_000),
});

export type AppConfig = z.infer<typeof schema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}
