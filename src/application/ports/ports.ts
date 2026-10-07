import { IntegrationEvent } from '../../domain/events/integration-event';
import { WalletLedgerEntry } from '../../domain/ledger-entry';
import { InboxMessage, OutboxMessage } from '../../domain/messaging';
import { Wallet } from '../../domain/wallet';
import { WagerTransaction } from '../../domain/wager-transaction';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** SELECT ... FOR UPDATE: serialises every writer of this wallet (unit of concurrency = walletId). */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  /** Optimistic guard on top of the lock: UPDATE ... WHERE version = loadedVersion. */
  saveBalance(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  insert(tx: WagerTransaction): Promise<void>;
  /** Persists a transition of a non-terminal transaction. */
  update(tx: WagerTransaction): Promise<void>;
  /** True when a PROCESSED REFUND/ROLLBACK already reverts `referenceTransactionId`. */
  isReverted(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  list(walletId: string, afterSeq: string | null, limit: number): Promise<{ entries: LedgerRow[]; hasMore: boolean }>;
  /** Credits minus debits and line count, computed inside the database. */
  aggregate(walletId: string): Promise<{ calculatedMinor: string; count: number }>;
}

export type LedgerRow = { seq: string; entry: WalletLedgerEntry };

export interface InboxRepository {
  /** Inserts the inbox row; returns false when (consumerName, messageId) already exists. */
  tryReceive(message: InboxMessage): Promise<boolean>;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /** FOR UPDATE SKIP LOCKED: concurrent publishers never take the same rows. */
  lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  oldestPendingAt(): Promise<Date | null>;
  pendingCount(): Promise<number>;
}

export interface UnitOfWork {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface TransactionRunner {
  /** Runs `fn` in ONE SQL transaction (commit on success, rollback on throw). */
  run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>;
  /** Consistent read-only snapshot (REPEATABLE READ) for reconciliation and queries. */
  runSnapshot<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}

export interface EventPublishResult {
  published: string[];
  failed: Array<{ id: string; reason: string }>;
}

export interface EventPublisher {
  publishBatch(messages: OutboxMessage[]): Promise<EventPublishResult>;
}

export interface Clock {
  now(): Date;
}

export interface MetricsPort {
  transactionProcessed(status: string, kind: string): void;
  duplicateDetected(source: string): void;
  retry(component: string): void;
  dlqMessage(reason: string): void;
  lockConflict(kind: string): void;
  processingLatency(seconds: number, source: string): void;
  outboxPublished(n: number): void;
  outboxPublishFailed(n: number): void;
  outboxLag(seconds: number, pending: number): void;
  reconciliationDivergence(): void;
}

export interface LoggerPort {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type { IntegrationEvent };

export const TOKENS = {
  TransactionRunner: Symbol('TransactionRunner'),
  EventPublisher: Symbol('EventPublisher'),
  Clock: Symbol('Clock'),
  Metrics: Symbol('Metrics'),
  Logger: Symbol('Logger'),
  ProviderIdentity: Symbol('ProviderIdentityPort'),
} as const;
