import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { z } from 'zod';
import { LoggerPort, MetricsPort, TOKENS } from '../../application/ports/ports';
import { parseZod, queueSubmissionSchema, toBusinessFields } from '../../application/submission-schema';
import { SubmitWagerTransactionUseCase } from '../../application/use-cases/submit-wager-transaction';
import { DomainError } from '../../domain/errors';
import { isTransientInfraError } from '../../shared/error-classification';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { RequestContext } from '../observability/request-context';
import { SqsQueues } from './sqs-queues';

export const CONSUMER_NAME = 'wager-transactions-consumer';

const envelopeSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.string(),
    data: queueSubmissionSchema,
  })
  .strict();

/** What the consumer decided to do with a message after processing it. */
export type Disposition = 'ack' | 'retry' | 'dlq';

@Injectable()
export class WagerQueueConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private running = false;
  private loop: Promise<void> | undefined;
  private abort = new AbortController();

  constructor(
    @Inject(SqsQueues) private readonly queues: SqsQueues,
    @Inject(SubmitWagerTransactionUseCase) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(TOKENS.Metrics) private readonly metrics: MetricsPort,
    @Inject(TOKENS.Logger) private readonly logger: LoggerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.ENABLE_SQS_CONSUMER) return;
    this.start();
  }

  /** SIGTERM: stop polling, let in-flight messages finish (ack) or give them back; bounded by the grace period. */
  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.poll();
    this.logger.info('sqs consumer started', { queue: this.config.SQS_WAGER_QUEUE });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    const grace = new Promise<void>((resolve) => setTimeout(resolve, this.config.SHUTDOWN_GRACE_MS).unref());
    await Promise.race([this.loop ?? Promise.resolve(), grace]);
    this.logger.info('sqs consumer stopped');
  }

  private async poll(): Promise<void> {
    while (this.running) {
      let messages: Message[] = [];
      try {
        const { wager } = await this.queues.ensure();
        const out = await this.queues.client.send(
          new ReceiveMessageCommand({
            QueueUrl: wager,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.SQS_WAIT_TIME_S,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = out.Messages ?? [];
      } catch (err) {
        if (!this.running) break;
        this.logger.warn('sqs receive failed', { error: err instanceof Error ? err.message : String(err) });
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (messages.length > 0) await this.processBatch(messages);
    }
  }

  /**
   * FIFO semantics: messages of one group are processed strictly in order; different groups
   * (= different wallets) run in parallel. After a non-ack, the rest of that group is handed back
   * so ordering is preserved on redelivery.
   */
  async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const key = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'none';
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (let i = 0; i < group.length; i++) {
          const msg = group[i] as Message;
          if (!this.running) {
            await this.giveBack(group.slice(i)); // shutting down: do not start new work
            return;
          }
          const disposition = await this.processMessage(msg);
          if (disposition === 'retry') {
            await this.giveBack(group.slice(i + 1));
            return;
          }
        }
      }),
    );
  }

  /**
   * Handles ONE message end to end and applies the broker-side effect (delete / back-off / DLQ).
   * `ack` is only ever sent after the use case committed.
   */
  async processMessage(msg: Message): Promise<Disposition> {
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? '1');
    const decision = await this.decide(msg, receiveCount);
    await this.apply(msg, decision, receiveCount);
    return decision.action;
  }

  /** Runs the use case; separate from `apply` so tests can simulate "crash after commit, before ack". */
  async decide(msg: Message, receiveCount: number): Promise<{ action: Disposition; reason?: string }> {
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = parseZod(envelopeSchema, JSON.parse(msg.Body ?? ''));
      toBusinessFields(envelope.data); // validates money / kind early: malformed => permanent
    } catch (err) {
      this.logger.warn('invalid queue message', { sqsMessageId: msg.MessageId, error: err instanceof Error ? err.message : String(err) });
      return { action: 'dlq', reason: 'invalid_message' };
    }

    const { idempotencyKey, ...raw } = envelope.data;
    return RequestContext.run(
      { correlationId: envelope.messageId, messageId: envelope.messageId, walletId: raw.walletId, providerId: raw.providerId },
      async () => {
        try {
          await this.submit.execute({
            idempotencyKey,
            fields: toBusinessFields(raw),
            correlationId: envelope.messageId,
            source: { type: 'sqs', consumerName: CONSUMER_NAME, messageId: envelope.messageId },
          });
          // PROCESSED, REJECTED (business outcome), PENDING_REFERENCE and replays are all terminal for the queue: ack
          return { action: 'ack' as const };
        } catch (err) {
          if (err instanceof DomainError) {
            // validation / not found / idempotency conflict: retrying can never succeed
            this.logger.warn('permanent error processing message', { code: err.code, error: err.message });
            return { action: 'dlq' as const, reason: err.code };
          }
          const transient = isTransientInfraError(err);
          this.logger.warn('error processing message', {
            transient,
            receiveCount,
            error: err instanceof Error ? err.message : String(err),
          });
          if (receiveCount >= this.config.SQS_MAX_RECEIVE_COUNT) return { action: 'dlq' as const, reason: 'retries_exhausted' };
          return { action: 'retry' as const, reason: transient ? 'transient' : 'unexpected' };
        }
      },
    );
  }

  async apply(msg: Message, decision: { action: Disposition; reason?: string }, receiveCount: number): Promise<void> {
    const { wager, dlq } = await this.queues.ensure();
    const client = this.queues.client;
    try {
      if (decision.action === 'ack') {
        await client.send(new DeleteMessageCommand({ QueueUrl: wager, ReceiptHandle: msg.ReceiptHandle as string }));
      } else if (decision.action === 'retry') {
        const base = this.config.SQS_RETRY_BASE_S;
        const timeout = Math.min(Math.ceil(base * 2 ** (receiveCount - 1)), this.config.SQS_RETRY_MAX_S);
        this.metrics.retry('sqs_consumer');
        await client.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: wager, ReceiptHandle: msg.ReceiptHandle as string, VisibilityTimeout: timeout }),
        );
      } else {
        // permanent: keep the original body + reason for forensics, then remove from the main queue
        await client.send(
          new SendMessageCommand({
            QueueUrl: dlq,
            MessageBody: msg.Body ?? '',
            MessageGroupId: msg.Attributes?.MessageGroupId ?? 'dlq',
            MessageDeduplicationId: `${msg.MessageId}:${receiveCount}`,
            MessageAttributes: {
              failureReason: { DataType: 'String', StringValue: decision.reason ?? 'unknown' },
              receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
            },
          }),
        );
        this.metrics.dlqMessage(decision.reason ?? 'unknown');
        await client.send(new DeleteMessageCommand({ QueueUrl: wager, ReceiptHandle: msg.ReceiptHandle as string }));
        this.logger.error('message moved to DLQ', { sqsMessageId: msg.MessageId, reason: decision.reason });
      }
    } catch (err) {
      // broker call failed AFTER processing: message simply stays/returns visible; the inbox makes redelivery harmless
      this.logger.warn('failed to apply broker disposition', {
        action: decision.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Makes messages immediately visible again (visibility = 0) without counting as a failure. */
  private async giveBack(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    const { wager } = await this.queues.ensure();
    await Promise.allSettled(
      messages.map((m) =>
        this.queues.client.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: wager, ReceiptHandle: m.ReceiptHandle as string, VisibilityTimeout: 0 }),
        ),
      ),
    );
  }
}
