import { Inject, Injectable } from '@nestjs/common';
import { eventContextFactory } from '../event-factory';
import { settleAndPersist } from '../settle-and-persist';
import { Clock, LoggerPort, MetricsPort, TOKENS, TransactionRunner, UnitOfWork } from '../ports/ports';
import { IdempotencyConflictError, InvariantViolationError, WalletNotFoundError } from '../../domain/errors';
import { FailureCode } from '../../domain/failure-code';
import { InboxMessage } from '../../domain/messaging';
import { Money } from '../../domain/money';
import {
  BusinessFields,
  computePayloadHash,
  PendingReferencePolicy,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { APP_CONFIG, AppConfig } from '../../infrastructure/config/app-config';
import { isConcurrencyConflict, isUniqueViolation } from '../../shared/error-classification';
import { newId } from '../../shared/ids';

export type CommandSource =
  | { type: 'http' }
  | { type: 'sqs'; consumerName: string; messageId: string; causationId?: string };

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  fields: BusinessFields;
  correlationId: string;
  source: CommandSource;
}

export interface SubmitWagerTransactionResult {
  transactionId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  balance: Money;
  failureCode?: FailureCode | undefined;
  idempotentReplay: boolean;
}

const MAX_ATTEMPTS = 4;

/**
 * Single entry point for provider transactions — used by BOTH the HTTP controller and the SQS consumer.
 *
 * Concurrency: unit of concurrency is walletId. The wallet row is locked with SELECT ... FOR UPDATE
 * (different wallets never contend), the version guard + DB triggers are the safety nets.
 * Idempotency: persistent. Fast-path lookup by key, then re-check under the wallet lock; unique
 * constraints on (idempotency_key) and (provider_id, external_transaction_id) are the final arbiter.
 */
@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    @Inject(TOKENS.TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(TOKENS.Clock) private readonly clock: Clock,
    @Inject(TOKENS.Metrics) private readonly metrics: MetricsPort,
    @Inject(TOKENS.Logger) private readonly logger: LoggerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get pendingReferencePolicy(): PendingReferencePolicy {
    return {
      maxAttempts: this.config.PENDING_REF_MAX_ATTEMPTS,
      ttlMs: this.config.PENDING_REF_TTL_MS,
      baseDelayMs: this.config.PENDING_REF_BASE_DELAY_MS,
      maxDelayMs: this.config.PENDING_REF_MAX_DELAY_MS,
    };
  }

  async execute(cmd: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const startedAt = performance.now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await this.runner.run((uow) => this.handle(uow, cmd));
        // metrics only after COMMIT, so rolled-back attempts are never counted
        if (result.idempotentReplay) this.metrics.duplicateDetected(cmd.source.type);
        else this.metrics.transactionProcessed(result.status, result.kind);
        this.metrics.processingLatency((performance.now() - startedAt) / 1000, cmd.source.type);
        return result;
      } catch (err) {
        lastError = err;
        const conflict = isConcurrencyConflict(err);
        // lost the race on a unique key (same idempotency key / external id from another instance)
        const raced = isUniqueViolation(err, 'uq_wager_tx_idempotency_key') || isUniqueViolation(err, 'uq_wager_tx_provider_external');
        if (!(conflict || raced) || attempt === MAX_ATTEMPTS) throw err;
        this.metrics.lockConflict(raced ? 'unique_race' : 'lock');
        this.metrics.retry('submit_transaction');
        await sleep(Math.min(20 * 2 ** attempt, 400) * (0.5 + Math.random()));
      }
    }
    throw lastError;
  }

  private async handle(uow: UnitOfWork, cmd: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const now = this.clock.now();
    const { fields } = cmd;
    const payloadHash = computePayloadHash(fields);

    // 1. persistent inbox dedup (SQS only): same row participates in the financial transaction
    if (cmd.source.type === 'sqs') {
      const inbox = InboxMessage.receive({
        messageId: cmd.source.messageId,
        consumerName: cmd.source.consumerName,
        payloadHash,
        now,
      });
      inbox.markProcessed(now);
      const firstTime = await uow.inbox.tryReceive(inbox);
      if (!firstTime) {
        const existing = await uow.transactions.findByIdempotencyKey(cmd.idempotencyKey);
        if (!existing) throw new InvariantViolationError(`inbox ${cmd.source.messageId} exists without a transaction`);
        return this.replay(existing, payloadHash);
      }
    }

    // 2. fast path: already known (no lock needed)
    const known = await this.findExisting(uow, cmd.idempotencyKey, fields);
    if (known) return this.replay(known, payloadHash);

    // 3. lock the wallet: from here on, every writer of this wallet is serialised
    const wallet = await uow.wallets.findByIdForUpdate(fields.walletId);
    if (!wallet) throw new WalletNotFoundError(`wallet ${fields.walletId} not found`);

    // 4. re-check under the lock: a concurrent instance may have committed while we waited
    const knownUnderLock = await this.findExisting(uow, cmd.idempotencyKey, fields);
    if (knownUnderLock) return this.replay(knownUnderLock, payloadHash);

    // 5. decide + persist atomically (tx, wallet, ledger, outbox, inbox share this SQL transaction)
    const tx = WagerTransaction.create({
      id: newId(),
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      now,
      ...fields,
    });
    await settleAndPersist(uow, {
      tx,
      wallet,
      isNew: true,
      now,
      policy: this.pendingReferencePolicy,
      events: eventContextFactory({
        correlationId: cmd.correlationId,
        causationId: cmd.source.type === 'sqs' ? cmd.source.messageId : cmd.idempotencyKey,
        now,
      }),
    });

    this.logger.info('wager transaction decided', {
      transactionId: tx.id,
      walletId: tx.walletId,
      providerId: tx.providerId,
      correlationId: cmd.correlationId,
      kind: tx.kind,
      status: tx.status,
      failureCode: tx.failureCode,
    });
    return this.toResult(tx, false);
  }

  /** Same key => the stored transaction; same (provider, externalId) under another key => conflict. */
  private async findExisting(
    uow: UnitOfWork,
    idempotencyKey: string,
    fields: BusinessFields,
  ): Promise<WagerTransaction | null> {
    const byKey = await uow.transactions.findByIdempotencyKey(idempotencyKey);
    if (byKey) return byKey;
    const byExternal = await uow.transactions.findByProviderAndExternalId(fields.providerId, fields.externalTransactionId);
    if (byExternal) {
      // The key lookup above may have missed because this very transaction committed in between (TOCTOU):
      // same key => it IS the same request, hand it back for the replay/payload check.
      if (byExternal.idempotencyKey === idempotencyKey) return byExternal;
      throw new IdempotencyConflictError(
        `externalTransactionId "${fields.externalTransactionId}" was already submitted under a different idempotency key`,
      );
    }
    return null;
  }

  private replay(existing: WagerTransaction, payloadHash: string): SubmitWagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        `idempotency key "${existing.idempotencyKey}" was already used with a different payload`,
      );
    }
    return this.toResult(existing, true);
  }

  private toResult(tx: WagerTransaction, idempotentReplay: boolean): SubmitWagerTransactionResult {
    if (!tx.observedBalance) throw new InvariantViolationError(`transaction ${tx.id} has no observed balance`);
    return {
      transactionId: tx.id,
      kind: tx.kind,
      status: tx.status,
      balance: tx.observedBalance,
      failureCode: tx.failureCode,
      idempotentReplay,
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
