import { InvalidTransactionStateError } from './errors';
import { IntegrationEvent } from './events/integration-event';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date | undefined;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: { messageId: string; consumerName: string; payloadHash: string; now: Date }): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.now);
  }

  static rehydrate(s: InboxMessageState): InboxMessage {
    return new InboxMessage(s.messageId, s.consumerName, s.payloadHash, s.receivedAt, s.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new InvalidTransactionStateError(`inbox message ${this.messageId} already processed`);
    this._processedAt = at;
  }
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export const OUTBOX_BACKOFF = { baseMs: 1_000, maxMs: 5 * 60_000 } as const;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** The outbox id is the event id: this is what consumers use to deduplicate. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt);
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    this._publishedAt = at;
  }

  /** Increments attempts and computes the next attempt with exponential backoff. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(OUTBOX_BACKOFF.baseMs * 2 ** (this._attempts - 1), OUTBOX_BACKOFF.maxMs);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
