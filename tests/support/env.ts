/** Test environment: real PostgreSQL (+ LocalStack/MiniStack for SQS). Override with env vars. */
export const TEST_ENV = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/wagering_test',
  AWS_ENDPOINT_URL: process.env.TEST_AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'error',
  // background workers are opt-in per test
  ENABLE_SQS_CONSUMER: 'false',
  ENABLE_OUTBOX_PUBLISHER: 'false',
  ENABLE_PENDING_REFERENCE_WORKER: 'false',
  DB_POOL_MAX: '30',
  SQS_WAIT_TIME_S: '1',
  SQS_VISIBILITY_TIMEOUT_S: '3',
  SQS_RETRY_BASE_S: '1',
} as const;

export async function sqsAvailable(): Promise<boolean> {
  try {
    const res = await fetch(TEST_ENV.AWS_ENDPOINT_URL, { signal: AbortSignal.timeout(1500) });
    return res.status > 0;
  } catch {
    return false;
  }
}
