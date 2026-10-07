import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { EventPublishResult, EventPublisher } from '../../application/ports/ports';
import { OutboxMessage } from '../../domain/messaging';
import { SqsQueues } from './sqs-queues';

/**
 * Publishes integration events to the FIFO events queue.
 * MessageGroupId = aggregateId (walletId) keeps per-wallet ordering; MessageDeduplicationId = eventId
 * lets SQS drop duplicates within its 5-minute window. Beyond that window consumers dedupe by eventId.
 */
@Injectable()
export class SqsEventPublisher implements EventPublisher {
  constructor(@Inject(SqsQueues) private readonly queues: SqsQueues) {}

  async publishBatch(messages: OutboxMessage[]): Promise<EventPublishResult> {
    const { events } = await this.queues.ensure();
    const result: EventPublishResult = { published: [], failed: [] };

    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      const response = await this.queues.client.send(
        new SendMessageBatchCommand({
          QueueUrl: events,
          Entries: chunk.map((m, idx) => ({
            Id: String(idx),
            MessageBody: JSON.stringify(m.payload),
            MessageGroupId: m.aggregateId,
            MessageDeduplicationId: m.id,
            MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
          })),
        }),
      );
      for (const ok of response.Successful ?? []) {
        const m = chunk[Number(ok.Id)];
        if (m) result.published.push(m.id);
      }
      for (const bad of response.Failed ?? []) {
        const m = chunk[Number(bad.Id)];
        if (m) result.failed.push({ id: m.id, reason: bad.Message ?? bad.Code ?? 'unknown' });
      }
    }
    return result;
  }
}
