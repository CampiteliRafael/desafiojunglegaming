import { Inject, Injectable } from '@nestjs/common';
import { Clock, EventPublisher, LoggerPort, MetricsPort, TOKENS, TransactionRunner } from '../ports/ports';

/**
 * Transactional-outbox relay. Rows are claimed with FOR UPDATE SKIP LOCKED inside a SQL transaction:
 * N concurrent publishers never take the same row. A crash after the broker accepted a message but
 * before COMMIT releases the lock and another publisher re-sends it => at-least-once; consumers
 * deduplicate by eventId (the outbox id) and the FIFO queue also dedups by it.
 */
@Injectable()
export class PublishOutboxUseCase {
  constructor(
    @Inject(TOKENS.TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(TOKENS.EventPublisher) private readonly publisher: EventPublisher,
    @Inject(TOKENS.Clock) private readonly clock: Clock,
    @Inject(TOKENS.Metrics) private readonly metrics: MetricsPort,
    @Inject(TOKENS.Logger) private readonly logger: LoggerPort,
  ) {}

  /** Publishes one batch; returns how many events were published. */
  async runOnce(batchSize: number): Promise<number> {
    const published = await this.runner.run(async (uow) => {
      const now = this.clock.now();
      const batch = await uow.outbox.lockDueBatch(now, batchSize);
      if (batch.length === 0) return 0;

      let ok = new Set<string>();
      let failures = new Map<string, string>();
      try {
        const result = await this.publisher.publishBatch(batch);
        ok = new Set(result.published);
        failures = new Map(result.failed.map((f) => [f.id, f.reason]));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        for (const m of batch) failures.set(m.id, reason);
      }

      for (const m of batch) {
        if (ok.has(m.id)) {
          m.markPublished(now);
        } else {
          m.scheduleRetry(now);
          this.logger.warn('outbox publish failed, retry scheduled', {
            eventId: m.id,
            eventType: m.eventType,
            attempts: m.attempts,
            reason: failures.get(m.id) ?? 'unknown',
          });
          this.metrics.retry('outbox');
        }
        await uow.outbox.save(m);
      }
      this.metrics.outboxPublished(ok.size);
      this.metrics.outboxPublishFailed(batch.length - ok.size);
      return ok.size;
    });
    return published;
  }

  /** Samples the pending-age gauge ("outbox lag") — oldest unpublished event. */
  async sampleLag(): Promise<void> {
    const { oldest, pending } = await this.runner.runSnapshot(async (uow) => ({
      oldest: await uow.outbox.oldestPendingAt(),
      pending: await uow.outbox.pendingCount(),
    }));
    const lag = oldest ? Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000) : 0;
    this.metrics.outboxLag(lag, pending);
  }
}
