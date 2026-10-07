import { LedgerDirection, WalletLedgerEntry } from '../../../domain/ledger-entry';
import { InboxMessage, OutboxMessage } from '../../../domain/messaging';
import { Money } from '../../../domain/money';
import { Wallet } from '../../../domain/wallet';
import { FailureCode } from '../../../domain/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction';
import { LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from '../entities/records';

/** Raw SQL (outside the entity hydrator) may hand back timestamps as strings; normalise. */
export const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

export const walletToDomain = (r: WalletRecord): Wallet =>
  Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.fromPersisted(r.balance, r.currency),
    version: Number(r.version),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

export const walletToRecord = (w: Wallet): WalletRecord => ({
  id: w.id,
  playerId: w.playerId,
  currency: w.currency,
  balance: w.balance.toString(),
  version: w.version,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt,
});

export const txToDomain = (r: WagerTransactionRecord): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: Money.fromPersisted(r.amount, r.currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode as FailureCode | null) ?? undefined,
    referenceAttempts: Number(r.referenceAttempts),
    nextReferenceAttemptAt: r.nextReferenceAttemptAt ?? undefined,
    referenceDeadline: r.referenceDeadline ?? undefined,
    observedBalance: r.observedBalance !== null ? Money.fromPersisted(r.observedBalance, r.currency) : undefined,
    createdAt: r.createdAt,
    processedAt: r.processedAt ?? undefined,
  });

export const txToRecord = (t: WagerTransaction): WagerTransactionRecord => ({
  id: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  idempotencyKey: t.idempotencyKey,
  payloadHash: t.payloadHash,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  amount: t.money.toString(),
  currency: t.money.currency,
  referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
  referenceTransactionId: t.referenceTransactionId ?? null,
  status: t.status,
  failureCode: t.failureCode ?? null,
  observedBalance: t.observedBalance ? t.observedBalance.toString() : null,
  referenceAttempts: t.referenceAttempts,
  nextReferenceAttemptAt: t.nextReferenceAttemptAt ?? null,
  referenceDeadline: t.referenceDeadline ?? null,
  createdAt: t.createdAt,
  processedAt: t.processedAt ?? null,
});

/** Row shape returned by raw SQL on wallet_ledger_entries (snake_case columns). */
export interface LedgerSqlRow {
  seq: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

export const ledgerRowToDomain = (r: LedgerSqlRow): WalletLedgerEntry =>
  WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.wallet_id,
    transactionId: r.transaction_id,
    direction: r.direction as LedgerDirection,
    money: Money.fromPersisted(r.amount, r.currency.trim()),
    balanceBefore: Money.fromPersisted(r.balance_before, r.currency.trim()),
    balanceAfter: Money.fromPersisted(r.balance_after, r.currency.trim()),
    createdAt: toDate(r.created_at),
  });

export const ledgerToRecord = (e: WalletLedgerEntry): LedgerEntryRecord => ({
  id: e.id,
  walletId: e.walletId,
  transactionId: e.transactionId,
  direction: e.direction,
  amount: e.money.toString(),
  currency: e.money.currency,
  balanceBefore: e.balanceBefore.toString(),
  balanceAfter: e.balanceAfter.toString(),
  createdAt: e.createdAt,
});

export interface OutboxSqlRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}

export const outboxRowToDomain = (r: OutboxSqlRow): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregate_id,
    eventType: r.event_type,
    payload: r.payload,
    occurredAt: toDate(r.occurred_at),
    attempts: Number(r.attempts),
    nextAttemptAt: r.next_attempt_at ? toDate(r.next_attempt_at) : undefined,
    publishedAt: r.published_at ? toDate(r.published_at) : undefined,
  });

export const outboxToRecord = (m: OutboxMessage): OutboxRecord => ({
  id: m.id,
  aggregateId: m.aggregateId,
  eventType: m.eventType,
  payload: m.payload as Record<string, unknown>,
  occurredAt: m.occurredAt,
  attempts: m.attempts,
  nextAttemptAt: m.nextAttemptAt ?? null,
  publishedAt: m.publishedAt ?? null,
});

export const inboxToRecord = (m: InboxMessage) => ({
  consumerName: m.consumerName,
  messageId: m.messageId,
  payloadHash: m.payloadHash,
  receivedAt: m.receivedAt,
  processedAt: m.processedAt ?? null,
});
