import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { MetricsPort } from '../../application/ports/ports';

@Injectable()
export class PrometheusMetrics implements MetricsPort {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions decided, by final status and kind',
    labelNames: ['status', 'kind'] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_detected_total',
    help: 'Replays / duplicate deliveries detected by idempotency or inbox',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retries performed, by component',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Messages moved to the dead-letter queue',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Concurrency conflicts (lock timeout, deadlock, unique race, optimistic mismatch)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'End-to-end processing latency of a transaction submission',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly published = new Counter({
    name: 'wager_outbox_published_total',
    help: 'Outbox events published',
    registers: [this.registry],
  });
  private readonly publishFailed = new Counter({
    name: 'wager_outbox_publish_failures_total',
    help: 'Outbox publish attempts that failed',
    registers: [this.registry],
  });
  private readonly lag = new Gauge({
    name: 'wager_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event',
    registers: [this.registry],
  });
  private readonly pending = new Gauge({
    name: 'wager_outbox_pending',
    help: 'Unpublished outbox events',
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'wager_reconciliation_divergences_total',
    help: 'Wallet reconciliations where stored balance != ledger balance',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionProcessed(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }
  duplicateDetected(source: string): void {
    this.duplicates.inc({ source });
  }
  retry(component: string): void {
    this.retries.inc({ component });
  }
  dlqMessage(reason: string): void {
    this.dlq.inc({ reason });
  }
  lockConflict(kind: string): void {
    this.lockConflicts.inc({ kind });
  }
  processingLatency(seconds: number, source: string): void {
    this.latency.observe({ source }, seconds);
  }
  outboxPublished(n: number): void {
    if (n > 0) this.published.inc(n);
  }
  outboxPublishFailed(n: number): void {
    if (n > 0) this.publishFailed.inc(n);
  }
  outboxLag(seconds: number, pending: number): void {
    this.lag.set(seconds);
    this.pending.set(pending);
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
}
