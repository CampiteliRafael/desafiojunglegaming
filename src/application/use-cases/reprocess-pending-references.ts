import { Inject, Injectable } from '@nestjs/common';
import { eventContextFactory } from '../event-factory';
import { settleAndPersist } from '../settle-and-persist';
import { Clock, LoggerPort, MetricsPort, TOKENS, TransactionRunner } from '../ports/ports';
import { FailureCode } from '../../domain/failure-code';
import { WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import { newId } from '../../shared/ids';
import { isConcurrencyConflict } from '../../shared/error-classification';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction';

const statusOf = (t: WagerTransaction): WagerTransactionStatus => t.status;

export type ReprocessOutcome = 'skipped' | 'processed' | 'rejected' | 'still_pending' | 'failed';

/**
 * Re-evaluates transactions parked in PENDING_REFERENCE (REFUND/ROLLBACK/WIN that arrived before
 * the transaction they reference). Safe with many workers: the wallet lock serialises them and the
 * status is re-read under that lock, so only one worker ever settles a given transaction.
 */
@Injectable()
export class ReprocessPendingReferencesUseCase {
  constructor(
    @Inject(TOKENS.TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(TOKENS.Clock) private readonly clock: Clock,
    @Inject(TOKENS.Metrics) private readonly metrics: MetricsPort,
    @Inject(TOKENS.Logger) private readonly logger: LoggerPort,
    @Inject(SubmitWagerTransactionUseCase) private readonly submit: SubmitWagerTransactionUseCase,
  ) {}

  async runBatch(limit: number): Promise<Record<ReprocessOutcome, number>> {
    const totals: Record<ReprocessOutcome, number> = { skipped: 0, processed: 0, rejected: 0, still_pending: 0, failed: 0 };
    const ids = await this.runner.run((uow) => uow.transactions.findDuePendingReferenceIds(this.clock.now(), limit));
    for (const id of ids) {
      totals[await this.reprocessOne(id)]++;
    }
    return totals;
  }

  async reprocessOne(transactionId: string): Promise<ReprocessOutcome> {
    try {
      return await this.runner.run(async (uow) => {
        const peek = await uow.transactions.findById(transactionId);
        if (!peek || peek.status !== WagerTransactionStatus.PendingReference) return 'skipped';

        const wallet = await uow.wallets.findByIdForUpdate(peek.walletId);
        if (!wallet) throw new Error(`wallet ${peek.walletId} vanished`);
        // re-read under the lock: another worker may have settled it meanwhile
        const tx = await uow.transactions.findById(transactionId);
        if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return 'skipped';

        const now = this.clock.now();
        await settleAndPersist(uow, {
          tx,
          wallet,
          isNew: false,
          now,
          policy: this.submit.pendingReferencePolicy,
          events: eventContextFactory({ correlationId: newId(), causationId: `pending-reference:${tx.id}`, now }),
        });

        const finalStatus = statusOf(tx); // re-read: settleAndPersist mutated the aggregate
        const outcome: ReprocessOutcome =
          finalStatus === WagerTransactionStatus.Processed
            ? 'processed'
            : finalStatus === WagerTransactionStatus.Rejected
              ? 'rejected'
              : 'still_pending';
        if (outcome !== 'still_pending') this.metrics.transactionProcessed(finalStatus, tx.kind);
        this.logger.info('pending reference re-evaluated', {
          transactionId: tx.id,
          walletId: tx.walletId,
          providerId: tx.providerId,
          outcome,
          attempts: tx.referenceAttempts,
          failureCode: tx.failureCode,
        });
        return outcome;
      });
    } catch (err) {
      if (isConcurrencyConflict(err)) {
        this.metrics.lockConflict('pending_reference');
        return 'skipped'; // another worker is on it; it stays due and is retried next tick
      }
      this.logger.error('pending reference reprocessing failed', {
        transactionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.metrics.retry('pending_reference');
      return 'failed';
    }
  }

  /** Terminal, auditable FAILED state for permanent internal errors (never for business rules). */
  async markFailed(transactionId: string, code: FailureCode = FailureCode.InternalPermanentError): Promise<boolean> {
    return this.runner.run(async (uow) => {
      const peek = await uow.transactions.findById(transactionId);
      if (!peek || peek.isTerminal()) return false;
      await uow.wallets.findByIdForUpdate(peek.walletId);
      const tx = await uow.transactions.findById(transactionId);
      if (!tx || tx.isTerminal()) return false;
      tx.fail(code, this.clock.now());
      await uow.transactions.update(tx);
      return true;
    });
  }
}
