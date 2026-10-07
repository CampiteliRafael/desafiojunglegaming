import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import {
  InboxRepository,
  LedgerRepository,
  LedgerRow,
  OutboxRepository,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../../../application/ports/ports';
import { InvariantViolationError } from '../../../domain/errors';
import { WalletLedgerEntry } from '../../../domain/ledger-entry';
import { InboxMessage, OutboxMessage } from '../../../domain/messaging';
import { Wallet } from '../../../domain/wallet';
import { WagerTransaction } from '../../../domain/wager-transaction';
import { OptimisticLockError } from '../../../shared/error-classification';
import { InboxSchema, LedgerEntrySchema, OutboxSchema, WagerTransactionSchema, WalletSchema } from '../entities/records';
import {
  inboxToRecord,
  ledgerRowToDomain,
  ledgerToRecord,
  LedgerSqlRow,
  outboxRowToDomain,
  outboxToRecord,
  toDate,
  OutboxSqlRow,
  txToDomain,
  txToRecord,
  walletToDomain,
  walletToRecord,
} from './mappers';

/**
 * Raw SQL bound to the unit of work's transaction (when there is one).
 * NOTE: every entity read uses `refresh: true` — states are re-read after a lock is granted, so the
 * identity map can never hand back a stale pre-lock snapshot.
 */
class Sql {
  constructor(protected readonly em: EntityManager) {}
  protected all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.em.getConnection().execute<T[]>(sql, params, 'all', this.em.getTransactionContext());
  }
}

class MikroWalletRepository extends Sql implements WalletRepository {
  async findById(id: string): Promise<Wallet | null> {
    const r = await this.em.findOne(WalletSchema, { id }, { refresh: true });
    return r ? walletToDomain(r) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    // refresh: the identity map must never serve a row read BEFORE the lock was granted
    const r = await this.em.findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return r ? walletToDomain(r) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const r = await this.em.findOne(WalletSchema, { playerId, currency }, { refresh: true });
    return r ? walletToDomain(r) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletToRecord(wallet));
  }

  async saveBalance(wallet: Wallet): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: wallet.loadedVersion },
      { balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) throw new OptimisticLockError(`wallet ${wallet.id} changed concurrently (expected version ${wallet.loadedVersion})`);
  }
}

class MikroWagerTransactionRepository extends Sql implements WagerTransactionRepository {
  async findById(id: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionSchema, { id }, { refresh: true });
    return r ? txToDomain(r) : null;
  }
  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionSchema, { idempotencyKey: key }, { refresh: true });
    return r ? txToDomain(r) : null;
  }
  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const r = await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId }, { refresh: true });
    return r ? txToDomain(r) : null;
  }
  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, txToRecord(tx));
  }
  async update(tx: WagerTransaction): Promise<void> {
    const r = txToRecord(tx);
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: tx.id, status: { $in: ['PENDING', 'PENDING_REFERENCE'] } },
      {
        status: r.status,
        failureCode: r.failureCode,
        referenceTransactionId: r.referenceTransactionId,
        observedBalance: r.observedBalance,
        referenceAttempts: r.referenceAttempts,
        nextReferenceAttemptAt: r.nextReferenceAttemptAt,
        referenceDeadline: r.referenceDeadline,
        processedAt: r.processedAt,
      },
    );
    if (affected !== 1) throw new InvariantViolationError(`transaction ${tx.id} is not updatable (already terminal?)`);
  }
  async isReverted(referenceTransactionId: string): Promise<boolean> {
    const rows = await this.all<{ one: number }>(
      `SELECT 1 AS one FROM wager_transactions
        WHERE reference_transaction_id = ? AND status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }
  async findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
    const rows = await this.all<{ id: string }>(
      `SELECT id FROM wager_transactions
        WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
        ORDER BY next_reference_attempt_at LIMIT ?`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }
}

class MikroLedgerRepository extends Sql implements LedgerRepository {
  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerToRecord(entry));
  }

  async list(walletId: string, afterSeq: string | null, limit: number): Promise<{ entries: LedgerRow[]; hasMore: boolean }> {
    // ORDER BY is qualified on purpose: a bare ORDER BY seq would bind to the text output alias and sort lexicographically
    const rows = await this.all<LedgerSqlRow>(
      `SELECT seq::text AS seq, id, wallet_id, transaction_id, direction, amount::text AS amount,
              currency, balance_before::text AS balance_before, balance_after::text AS balance_after, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND seq > ?::bigint
        ORDER BY wallet_ledger_entries.seq ASC LIMIT ?`,
      [walletId, afterSeq ?? '0', limit + 1],
    );
    const hasMore = rows.length > limit;
    return { entries: rows.slice(0, limit).map((r) => ({ seq: r.seq, entry: ledgerRowToDomain(r) })), hasMore };
  }

  async aggregate(walletId: string): Promise<{ calculatedMinor: string; count: number }> {
    const [row] = await this.all<{ minor: string | null; n: string }>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) * 100, 0)::bigint::text AS minor,
              COUNT(*)::text AS n
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    return { calculatedMinor: row?.minor ?? '0', count: Number(row?.n ?? 0) };
  }
}

class MikroInboxRepository extends Sql implements InboxRepository {
  async tryReceive(message: InboxMessage): Promise<boolean> {
    const r = inboxToRecord(message);
    const rows = await this.all<{ message_id: string }>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [r.consumerName, r.messageId, r.payloadHash, r.receivedAt, r.processedAt],
    );
    return rows.length === 1;
  }
}

class MikroOutboxRepository extends Sql implements OutboxRepository {
  async enqueue(messages: OutboxMessage[]): Promise<void> {
    for (const m of messages) await this.em.insert(OutboxSchema, outboxToRecord(m));
  }

  async lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.all<OutboxSqlRow>(
      `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
         FROM outbox_messages
        WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY occurred_at
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(outboxRowToDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxSchema,
      { id: message.id },
      { attempts: message.attempts, nextAttemptAt: message.nextAttemptAt ?? null, publishedAt: message.publishedAt ?? null },
    );
  }

  async oldestPendingAt(): Promise<Date | null> {
    const [row] = await this.all<{ oldest: Date | string | null }>(`SELECT MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`);
    return row?.oldest ? toDate(row.oldest) : null;
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.all<{ n: string }>(`SELECT COUNT(*)::text AS n FROM outbox_messages WHERE published_at IS NULL`);
    return Number(row?.n ?? 0);
  }
}

export function buildUnitOfWork(em: EntityManager): UnitOfWork {
  return {
    wallets: new MikroWalletRepository(em),
    transactions: new MikroWagerTransactionRepository(em),
    ledger: new MikroLedgerRepository(em),
    inbox: new MikroInboxRepository(em),
    outbox: new MikroOutboxRepository(em),
  };
}
