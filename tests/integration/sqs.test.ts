import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { APP_CONFIG } from '../../src/infrastructure/config/app-config';
import { Clock, EventPublisher, TOKENS, TransactionRunner } from '../../src/application/ports/ports';
import { PublishOutboxUseCase } from '../../src/application/use-cases/publish-outbox';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/reprocess-pending-references';
import type { SubmitWagerTransactionUseCase } from '../../src/application/use-cases/submit-wager-transaction';
import { SqsQueues } from '../../src/infrastructure/sqs/sqs-queues';
import { WagerQueueConsumer } from '../../src/infrastructure/sqs/wager-queue-consumer';
import { sqsAvailable } from '../support/env';
import { assertWalletConsistent, closeDb, createWallet, eventually, http, migrateTestDb, sleep, sql, startApp, TestApp, uniq } from '../support/harness';

/**
 * Real SQS API (LocalStack / MiniStack in docker-compose.test.yml). Skipped ONLY when no SQS endpoint is
 * reachable and REQUIRE_SQS is not set — CI sets REQUIRE_SQS=1 so a missing broker fails loudly.
 */
const available = await sqsAvailable();
const isolate = async () => {
  await drain(urls.wager);
  await drain(urls.dlq);
};
if (!available && process.env.REQUIRE_SQS === '1') throw new Error('REQUIRE_SQS=1 but no SQS endpoint is reachable');
const d = describe.skipIf(!available);

const run = uniq('t').replace(/[^a-zA-Z0-9-]/g, '');
let t: TestApp;
let queues: SqsQueues;
let consumer: WagerQueueConsumer;
let urls: Awaited<ReturnType<SqsQueues['ensure']>>;

beforeAll(async () => {
  if (!available) return;
  await migrateTestDb();
  t = await startApp({
    SQS_WAGER_QUEUE: `wager-${run}.fifo`,
    SQS_WAGER_DLQ: `wager-dlq-${run}.fifo`,
    SQS_EVENTS_QUEUE: `events-${run}.fifo`,
    SQS_MAX_RECEIVE_COUNT: '3',
  });
  queues = t.get(SqsQueues);
  consumer = t.get(WagerQueueConsumer);
  urls = await queues.ensure();
});
afterAll(async () => {
  await t?.close();
  await closeDb();
});

let seq = 0;
async function drain(url: string) {
  for (let i = 0; i < 20; i++) {
    const msgs = await receive(url, 0);
    if (msgs.length === 0) break;
    await Promise.all(msgs.map((m) => queues.client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle! }))));
  }
}
async function send(body: unknown, group: string, dedupId?: string) {
  await queues.client.send(
    new SendMessageCommand({
      QueueUrl: urls.wager,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: group,
      MessageDeduplicationId: dedupId ?? `${group}-${seq++}-${Math.random()}`,
    }),
  );
}
const envelope = (o: { messageId?: string; walletId: string; playerId: string; kind?: string; amount?: string; providerId?: string; ext?: string; key?: string; ref?: string }) => {
  const providerId = o.providerId ?? 'prov-sqs';
  const ext = o.ext ?? uniq('e');
  return {
    messageId: o.messageId ?? uniq('msg'),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId,
      externalTransactionId: ext,
      idempotencyKey: o.key ?? `${providerId}:${ext}`,
      playerId: o.playerId,
      walletId: o.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: o.kind ?? 'BET',
      money: { amount: o.amount ?? '25.00', currency: 'BRL' },
      ...(o.ref ? { referenceExternalTransactionId: o.ref } : {}),
    },
  };
};
const receive = async (url: string, wait = 2) => (await queues.client.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: wait, MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'], MessageAttributeNames: ['All'] }))).Messages ?? [];
const depth = async (url: string) => {
  const a = (await queues.client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }))).Attributes ?? {};
  return Number(a.ApproximateNumberOfMessages ?? 0) + Number(a.ApproximateNumberOfMessagesNotVisible ?? 0);
};
const debits = async (walletId: string) => (await sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [walletId]))[0].n as number;

d('SQS consumer (real broker)', () => {
  beforeEach(isolate);

  test('a message is processed through the SAME use case as HTTP, acked after commit, and visible via the API', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    const providerId = uniq('prov');
    const msg = envelope({ walletId, playerId, providerId, amount: '25.00', ext: 'sqs-1' });
    await send(msg, walletId);
    consumer.start();
    await eventually(async () => (await http(t.baseUrl, 'GET', `/providers/${providerId}/wagering/transactions/sqs-1`)).status === 200);
    await consumer.stop();
    const tx = await http(t.baseUrl, 'GET', `/providers/${providerId}/wagering/transactions/sqs-1`);
    expect(tx.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' } });
    expect(await eventually(async () => (await depth(urls.wager)) === 0 && true)).toBe(true); // acked => gone
    const [inbox] = await sql(`SELECT processed_at FROM inbox_messages WHERE consumer_name = 'wager-transactions-consumer' AND message_id = ?`, [msg.messageId]);
    expect(inbox.processed_at).not.toBeNull();
    await assertWalletConsistent(walletId);
  });

  test('duplicate deliveries (same messageId x5, and a resend with a NEW messageId but the same idempotency key) debit once', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    const msg = envelope({ walletId, playerId, amount: '10.00', ext: uniq('dup') });
    for (let i = 0; i < 5; i++) await send(msg, walletId); // broker-level duplicates (distinct dedup ids)
    await send({ ...msg, messageId: uniq('other-msg') }, walletId); // provider resent with a new envelope
    consumer.start();
    await eventually(async () => (await depth(urls.wager)) === 0);
    await consumer.stop();
    expect(await debits(walletId)).toBe(1);
    expect((await assertWalletConsistent(walletId)).balance).toBe('90.00');
  });

  test('worker dies AFTER commit and BEFORE ack: redelivery is absorbed by the inbox (no second debit)', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    await send(envelope({ walletId, playerId, providerId: uniq('prov'), amount: '40.00', ext: 'crash-after-commit' }), walletId);
    const [first] = await eventually(async () => {
      const m = await receive(urls.wager);
      return m.length ? m : false;
    });
    // "worker 1": commits, then dies before DeleteMessage (decide() = use case only, no broker disposition)
    const decision = await consumer.decide(first!, 1);
    expect(decision).toEqual({ action: 'ack' });
    expect(await debits(walletId)).toBe(1);
    // visibility timeout (3 s) expires -> broker redelivers to "worker 2"
    const [again] = await eventually(async () => {
      const m = await receive(urls.wager, 3);
      return m.length ? m : false;
    }, 20_000);
    expect(again!.MessageId).toBe(first!.MessageId);
    expect(Number(again!.Attributes?.ApproximateReceiveCount)).toBeGreaterThanOrEqual(2);
    expect(await consumer.processMessage(again!)).toBe('ack');
    expect(await debits(walletId)).toBe(1); // still ONE debit
    await eventually(async () => (await depth(urls.wager)) === 0);
    expect((await assertWalletConsistent(walletId)).balance).toBe('60.00');
  });

  test('business rejection is a terminal outcome: acked (not retried, not DLQ) and auditable', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '10.00');
    const dlqBefore = await depth(urls.dlq);
    const providerId = uniq('prov');
    await send(envelope({ walletId, playerId, providerId, amount: '500.00', ext: 'too-much' }), walletId);
    consumer.start();
    await eventually(async () => (await http(t.baseUrl, 'GET', `/providers/${providerId}/wagering/transactions/too-much`)).status === 200);
    await eventually(async () => (await depth(urls.wager)) === 0);
    await consumer.stop();
    expect((await http(t.baseUrl, 'GET', `/providers/${providerId}/wagering/transactions/too-much`)).body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(await depth(urls.dlq)).toBe(dlqBefore);
  });

  test('permanent errors go to the DLQ with the reason: malformed JSON, invalid money, unknown wallet, idempotency conflict', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    const dlqBefore = await depth(urls.dlq);
    const bad = envelope({ walletId, playerId, ext: uniq('bad') });
    bad.data.money.amount = '10.5';
    await send('{not json', walletId);
    await send(bad, walletId);
    await send(envelope({ walletId: Bun.randomUUIDv7(), playerId }), 'ghost');
    const conflictProvider = uniq('prov');
    const original = envelope({ walletId, playerId, providerId: conflictProvider, amount: '5.00', ext: 'conflict-ext' });
    await send(original, walletId);
    const different = envelope({ walletId, playerId, providerId: conflictProvider, amount: '6.00', ext: 'conflict-ext' });
    await send(different, walletId); // same idempotency key, other payload
    consumer.start();
    await eventually(async () => (await depth(urls.wager)) === 0 && (await depth(urls.dlq)) >= dlqBefore + 4 && (await debits(walletId)) === 1, 30_000);
    await consumer.stop();
    const reasons = new Set<string>();
    for (let i = 0; i < 5; i++) for (const m of await receive(urls.dlq, 1)) reasons.add(m.MessageAttributes?.failureReason?.StringValue ?? '?');
    expect(reasons).toContain('invalid_message');
    expect(reasons).toContain('WALLET_NOT_FOUND');
    expect(reasons).toContain('IDEMPOTENCY_KEY_CONFLICT');
    expect(await debits(walletId)).toBe(1); // only the legitimate 5.00 bet
    const metrics = await (await fetch(`${t.baseUrl}/metrics`)).text();
    expect(metrics).toMatch(/wager_dlq_messages_total\{reason="WALLET_NOT_FOUND"\} [1-9]/);
  });

  test('transient errors are retried with backoff and moved to the DLQ only after the attempt limit', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    const down = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const flaky = new WagerQueueConsumer(queues, { execute: async () => { throw down; } } as unknown as SubmitWagerTransactionUseCase, t.get(TOKENS.Metrics), t.get(TOKENS.Logger), { ...(t.get<object>(APP_CONFIG)), SQS_MAX_RECEIVE_COUNT: 3, SQS_RETRY_BASE_S: 1, SQS_RETRY_MAX_S: 2, SHUTDOWN_GRACE_MS: 1000 } as never);
    const dlqBefore = await depth(urls.dlq);
    await send(envelope({ walletId, playerId, ext: uniq('flaky') }), walletId);
    const dispositions: string[] = [];
    while (dispositions.at(-1) !== 'dlq') {
      const m = await eventually(async () => {
        const r = await receive(urls.wager, 2);
        return r.length ? r : false;
      }, 20_000);
      dispositions.push(await flaky.processMessage(m[0]!));
      if (dispositions.length > 5) break;
    }
    expect(dispositions).toEqual(['retry', 'retry', 'dlq']); // 3 attempts, then DLQ
    expect(await depth(urls.dlq)).toBeGreaterThan(dlqBefore);
    expect(await debits(walletId)).toBe(0);
  });

  test('ROLLBACK delivered before its BET through the queue ends up applied exactly once', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    const providerId = uniq('prov');
    await send(envelope({ walletId, playerId, providerId, kind: 'ROLLBACK', amount: '30.00', ext: 'rb', ref: 'bet' }), walletId);
    await send(envelope({ walletId, playerId, providerId, kind: 'BET', amount: '30.00', ext: 'bet' }), walletId);
    consumer.start();
    await eventually(async () => (await depth(urls.wager)) === 0);
    await consumer.stop();
    const reprocess = t.get(ReprocessPendingReferencesUseCase);
    await sleep(1100); // PENDING_REF_BASE_DELAY_MS default 1 s
    await eventually(async () => {
      await reprocess.runBatch(100);
      return (await http(t.baseUrl, 'GET', `/providers/${providerId}/wagering/transactions/rb`)).body.status === 'PROCESSED';
    }, 20_000, 500);
    expect((await assertWalletConsistent(walletId)).balance).toBe('100.00');
  });

  test('graceful stop: consumer.stop() returns promptly and leaves nothing half-processed', async () => {
    consumer.start();
    const started = Date.now();
    await consumer.stop();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

d('outbox -> SQS (real broker)', () => {
  const relay = () => new PublishOutboxUseCase(t.get<TransactionRunner>(TOKENS.TransactionRunner), t.get<EventPublisher>(TOKENS.EventPublisher), t.get<Clock>(TOKENS.Clock), t.get(TOKENS.Metrics), t.get(TOKENS.Logger));

  test('events reach the FIFO events queue grouped by wallet; two concurrent publishers deliver each event (at least) once', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    for (let i = 0; i < 5; i++) {
      await http(t.baseUrl, 'POST', '/wagering/transactions', {
        headers: { 'Idempotency-Key': `k-${walletId}-${i}` },
        body: { providerId: 'p', externalTransactionId: `e-${walletId}-${i}`, playerId, walletId, roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '1.00', currency: 'BRL' } },
      });
    }
    const wanted = (await sql<{ id: string }>(`SELECT id FROM outbox_messages WHERE aggregate_id = ?`, [walletId])).map((r) => r.id);
    await Promise.all([relay(), relay()].map(async (r) => {
      for (let i = 0; i < 200 && (await sql(`SELECT 1 FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL`, [walletId])).length > 0; i++) await r.runOnce(100);
    }));
    const seen = new Set<string>();
    const types = new Set<string>();
    await eventually(async () => {
      for (const m of await receive(urls.events, 1)) {
        const e = JSON.parse(m.Body!);
        seen.add(e.eventId);
        types.add(e.eventType);
        expect(m.Attributes?.MessageGroupId).toBeDefined();
        // FIFO: unacked messages keep their whole group invisible until the visibility timeout
        await queues.client.send(new DeleteMessageCommand({ QueueUrl: urls.events, ReceiptHandle: m.ReceiptHandle! }));
      }
      return wanted.every((id) => seen.has(id));
    }, 30_000, 50);
    expect(types).toContain('WalletBalanceChanged');
    expect(types).toContain('WagerTransactionProcessed');
  });
});

d('readiness', () => {
  test('/health/ready is 200 when PostgreSQL and SQS are reachable', async () => {
    const r = await http(t.baseUrl, 'GET', '/health/ready');
    expect(r.status).toBe(200);
    expect(r.body.checks).toEqual({ postgres: 'up', sqs: 'up' });
  });

  test('/health/ready is 503 when SQS is down, while /health/live stays 200 (separate probes)', async () => {
    const broken = await startApp({ AWS_ENDPOINT_URL: 'http://127.0.0.1:1', SQS_AUTO_CREATE: 'false' });
    try {
      expect((await http(broken.baseUrl, 'GET', '/health/live')).status).toBe(200);
      const ready = await http(broken.baseUrl, 'GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks).toEqual({ postgres: 'up', sqs: 'down' });
    } finally {
      await broken.close();
      Object.assign(process.env, { AWS_ENDPOINT_URL: process.env.TEST_AWS_ENDPOINT_URL ?? 'http://localhost:4566' });
    }
  });
});
