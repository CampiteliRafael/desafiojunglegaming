import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function buildSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
    maxAttempts: 3,
  });
}

export interface QueueUrls {
  wager: string;
  dlq: string;
  events: string;
}

/** Resolves (and optionally creates) the three FIFO queues. URLs are cached after first success. */
@Injectable()
export class SqsQueues {
  private urls: QueueUrls | undefined;
  private inflight: Promise<QueueUrls> | undefined;

  constructor(
    @Inject(SQS_CLIENT) readonly client: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  ensure(): Promise<QueueUrls> {
    if (this.urls) return Promise.resolve(this.urls);
    this.inflight ??= this.resolve()
      .then((u) => (this.urls = u))
      .finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  /** Readiness probe: the main queue must be reachable. */
  async ping(): Promise<void> {
    const { wager } = await this.ensure();
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: wager, AttributeNames: ['QueueArn'] }));
  }

  private async resolve(): Promise<QueueUrls> {
    const c = this.config;
    if (!c.SQS_AUTO_CREATE) {
      const get = async (name: string) => (await this.client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl as string;
      return { wager: await get(c.SQS_WAGER_QUEUE), dlq: await get(c.SQS_WAGER_DLQ), events: await get(c.SQS_EVENTS_QUEUE) };
    }
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
    const dlq = await this.create(c.SQS_WAGER_DLQ, { ...fifo, MessageRetentionPeriod: '1209600' });
    const dlqArn = (
      await this.client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))
    ).Attributes?.QueueArn as string;
    const wager = await this.create(c.SQS_WAGER_QUEUE, {
      ...fifo,
      VisibilityTimeout: String(c.SQS_VISIBILITY_TIMEOUT_S),
      // safety net: even if the consumer never moves a poison message, the broker does after N receives
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: c.SQS_MAX_RECEIVE_COUNT + 2 }),
    });
    const events = await this.create(c.SQS_EVENTS_QUEUE, { ...fifo, MessageRetentionPeriod: '1209600' });
    return { wager, dlq, events };
  }

  private async create(name: string, attributes: Record<string, string>): Promise<string> {
    try {
      return (await this.client.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }))).QueueUrl as string;
    } catch (err) {
      // queue already exists with different attributes (e.g. created by the LocalStack init script)
      if ((err as { name?: string }).name === 'QueueNameExists') {
        return (await this.client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl as string;
      }
      throw err;
    }
  }
}
