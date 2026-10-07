import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { buildOrmConfig } from '../../src/infrastructure/persistence/orm-config';
import { TEST_ENV } from './env';

export type EnvOverrides = Record<string, string>;

/** Applies the test env (+ overrides) to process.env: AppModule reads configuration from there. */
export function applyEnv(overrides: EnvOverrides = {}): void {
  Object.assign(process.env, TEST_ENV, overrides);
}

/** Brings the test database to the latest migration (idempotent). */
export async function migrateTestDb(): Promise<void> {
  const orm = await MikroORM.init(buildOrmConfig({ DATABASE_URL: TEST_ENV.DATABASE_URL, DB_POOL_MAX: 2 }));
  try {
    await orm.migrator.up();
  } finally {
    await orm.close(true);
  }
}

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  get<T>(token: Type<T> | symbol | string): T;
  close(): Promise<void>;
}

export async function startApp(overrides: EnvOverrides = {}): Promise<TestApp> {
  applyEnv(overrides);
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as { port: number }).port;
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    get: (token) => app.get(token as never, { strict: false }),
    close: () => app.close(),
  };
}

let counter = 0;
export const uniq = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export async function http<T = any>(baseUrl: string, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<HttpResult<T>> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

export const money = (amount: string, currency = 'BRL') => ({ amount, currency });

export async function createWallet(baseUrl: string, initial = '100.00', playerId = uniq('player')) {
  const r = await http(baseUrl, 'POST', '/wallets', { body: { playerId, initialBalance: money(initial) } });
  if (r.status !== 201) throw new Error(`createWallet failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { walletId: r.body.id as string, playerId };
}

export interface TxSpec {
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  providerId?: string;
  externalTransactionId?: string;
  roundId?: string;
  idempotencyKey?: string;
  referenceExternalTransactionId?: string;
  currency?: string;
}

export function submit(baseUrl: string, s: TxSpec) {
  const providerId = s.providerId ?? 'prov-a';
  const externalTransactionId = s.externalTransactionId ?? uniq('ext');
  return http(baseUrl, 'POST', '/wagering/transactions', {
    headers: { 'Idempotency-Key': s.idempotencyKey ?? `${providerId}:${externalTransactionId}` },
    body: {
      providerId,
      externalTransactionId,
      playerId: s.playerId,
      walletId: s.walletId,
      roundId: s.roundId ?? 'round-1',
      gameId: 'fortune-chimp',
      kind: s.kind,
      money: money(s.amount, s.currency ?? 'BRL'),
      ...(s.referenceExternalTransactionId ? { referenceExternalTransactionId: s.referenceExternalTransactionId } : {}),
    },
  });
}

// ------------------------------------------------------------------ direct SQL (assertions bypass the app)
let sharedOrm: MikroORM | undefined;
export async function db(): Promise<MikroORM> {
  sharedOrm ??= await MikroORM.init(buildOrmConfig({ DATABASE_URL: TEST_ENV.DATABASE_URL, DB_POOL_MAX: 5 }));
  return sharedOrm;
}
export async function closeDb(): Promise<void> {
  await sharedOrm?.close(true);
  sharedOrm = undefined;
}
export async function sql<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
  const orm = await db();
  return orm.em.getConnection().execute<T[]>(query, params, 'all');
}

/**
 * The invariant every test must end with:  wallet.balance == balance rebuilt from the ledger,
 * the ledger chain is contiguous, and nothing is negative.
 */
export async function assertWalletConsistent(walletId: string): Promise<{ balance: string; entries: number }> {
  const [w] = await sql<{ balance: string }>(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId]);
  const rows = await sql<{ direction: string; amount: string; balance_before: string; balance_after: string }>(
    `SELECT direction, amount::text AS amount, balance_before::text AS balance_before, balance_after::text AS balance_after
       FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq`,
    [walletId],
  );
  let running = 0n;
  for (const r of rows) {
    if (toMinor(r.balance_before) !== running) throw new Error(`ledger chain broken at wallet ${walletId}`);
    running += (r.direction === 'CREDIT' ? 1n : -1n) * toMinor(r.amount);
    if (toMinor(r.balance_after) !== running) throw new Error(`ledger arithmetic broken at wallet ${walletId}`);
    if (running < 0n) throw new Error(`negative balance in ledger of wallet ${walletId}`);
  }
  const stored = toMinor((w as { balance: string }).balance);
  if (stored !== running) throw new Error(`wallet ${walletId}: stored ${stored} != ledger ${running}`);
  return { balance: (w as { balance: string }).balance, entries: rows.length };
}

export const toMinor = (decimal: string): bigint => {
  const [whole, frac = '00'] = decimal.split('.');
  return BigInt(whole as string) * 100n + BigInt(frac.padEnd(2, '0'));
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns a truthy value (or throws on timeout) — for assertions on async workers. */
export async function eventually<T>(fn: () => Promise<T | false | undefined | null>, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`eventually timed out${last ? `: ${String(last)}` : ''}`);
    await sleep(intervalMs);
  }
}
