import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Clock, EventPublisher, EventPublishResult, TOKENS, TransactionRunner } from '../../src/application/ports/ports';
import { PublishOutboxUseCase } from '../../src/application/use-cases/publish-outbox';
import { OutboxMessage } from '../../src/domain/messaging';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { assertWalletConsistent, closeDb, createWallet, migrateTestDb, sleep, sql, startApp, submit, TestApp, uniq } from '../support/harness';

let t: TestApp;
beforeAll(async () => {
  await migrateTestDb();
  t = await startApp();
});
afterAll(async () => {
  await t.close();
  await closeDb();
});

const eventTypes = async (walletId: string) =>
  (await sql<{ event_type: string }>(`SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at, id`, [walletId])).map((r) => r.event_type).sort();

/** Records what a (fake) broker received — this exercises the PORT; real SQS delivery is covered in sqs.test.ts. */
class RecordingPublisher implements EventPublisher {
  readonly received: string[] = [];
  constructor(private readonly latencyMs = 0, private readonly failIds = new Set<string>()) {}
  async publishBatch(messages: OutboxMessage[]): Promise<EventPublishResult> {
    if (this.latencyMs) await sleep(this.latencyMs);
    const result: EventPublishResult = { published: [], failed: [] };
    for (const m of messages) {
      if (this.failIds.has(m.id)) result.failed.push({ id: m.id, reason: 'boom' });
      else {
        this.received.push(m.id);
        result.published.push(m.id);
      }
    }
    return result;
  }
}

const relay = (publisher: EventPublisher, runner?: TransactionRunner) =>
  new PublishOutboxUseCase(runner ?? t.get<TransactionRunner>(TOKENS.TransactionRunner), publisher, t.get<Clock>(TOKENS.Clock), t.get(TOKENS.Metrics), t.get(TOKENS.Logger));

describe('events emitted with the financial transaction', () => {
  test('opening, BET, LOSS, rejection and pending reference emit exactly the documented events', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '10.00');
    expect(await eventTypes(walletId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']); // OPENING

    await submit(t.baseUrl, { walletId, playerId, kind: 'BET', amount: '4.00' });
    expect(await eventTypes(walletId)).toEqual(['WagerTransactionProcessed', 'WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);

    await submit(t.baseUrl, { walletId, playerId, kind: 'LOSS', amount: '4.00' }); // Processed, but NO balance event
    expect((await eventTypes(walletId)).filter((e) => e === 'WalletBalanceChanged')).toHaveLength(2);
    expect((await eventTypes(walletId)).filter((e) => e === 'WagerTransactionProcessed')).toHaveLength(3);

    await submit(t.baseUrl, { walletId, playerId, kind: 'BET', amount: '999.00' });
    expect(await eventTypes(walletId)).toContain('WagerTransactionRejected');
    await submit(t.baseUrl, { walletId, playerId, kind: 'REFUND', amount: '1.00', referenceExternalTransactionId: 'later' });
    expect(await eventTypes(walletId)).toContain('WagerTransactionPendingReference');
  });

  test('WalletBalanceChanged carries MoneyProps strings and the wallet version', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    await submit(t.baseUrl, { walletId, playerId, kind: 'BET', amount: '25.00' });
    const rows = await sql(`SELECT payload FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged' ORDER BY occurred_at, id`, [walletId]);
    const bet = rows[1].payload;
    expect(bet).toMatchObject({ eventType: 'WalletBalanceChanged', version: 1, aggregateId: walletId });
    expect(bet.data).toMatchObject({ direction: 'DEBIT', money: { amount: '25.00', currency: 'BRL' }, balanceBefore: { amount: '100.00' }, balanceAfter: { amount: '75.00' }, walletVersion: 2 });
    expect(bet.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bet.correlationId).toBeTruthy();
  });

  test('replays do not emit duplicate events', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '10.00');
    const spec = { walletId, playerId, kind: 'BET', amount: '1.00', externalTransactionId: uniq('e') };
    await submit(t.baseUrl, spec);
    const before = (await eventTypes(walletId)).length;
    await Promise.all(Array.from({ length: 10 }, () => submit(t.baseUrl, spec)));
    expect((await eventTypes(walletId)).length).toBe(before);
  });
});

describe('atomicity: tx + wallet + ledger + inbox + outbox commit together or not at all', () => {
  const setup = async () => {
    const { walletId } = await createWallet(t.baseUrl, '100.00');
    return walletId;
  };
  const counts = async (walletId: string, inboxId: string) => ({
    ledger: (await sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId]))[0].n,
    txs: (await sql(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ?`, [walletId]))[0].n,
    outbox: (await sql(`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ?`, [walletId]))[0].n,
    inbox: (await sql(`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ?`, [inboxId]))[0].n,
  });

  test('a crash in the middle rolls EVERYTHING back (nothing is visible, nothing is published)', async () => {
    const walletId = await setup();
    const inboxId = uniq('msg');
    const before = await counts(walletId, inboxId);
    const runner = t.get<TransactionRunner>(TOKENS.TransactionRunner);
    await expect(
      runner.run(async (uow) => {
        const { InboxMessage } = await import('../../src/domain/messaging');
        await uow.inbox.tryReceive(InboxMessage.receive({ messageId: inboxId, consumerName: 'c', payloadHash: 'a'.repeat(64), now: new Date() }));
        const wallet = (await uow.wallets.findByIdForUpdate(walletId)) as Wallet;
        const entry = wallet.debit(Money.from({ amount: '10.00', currency: 'BRL' }), Bun.randomUUIDv7(), new Date());
        await uow.wallets.saveBalance(wallet);
        void entry;
        throw new Error('process died before commit');
      }),
    ).rejects.toThrow('died');
    expect(await counts(walletId, inboxId)).toEqual(before);
    expect((await assertWalletConsistent(walletId)).balance).toBe('100.00');
  });

  test('a balance change WITHOUT its ledger entry is refused by the database at COMMIT, taking the outbox row with it', async () => {
    const walletId = await setup();
    const inboxId = uniq('msg');
    const before = await counts(walletId, inboxId);
    const runner = t.get<TransactionRunner>(TOKENS.TransactionRunner);
    await expect(
      runner.run(async (uow) => {
        const wallet = (await uow.wallets.findByIdForUpdate(walletId)) as Wallet;
        wallet.debit(Money.from({ amount: '10.00', currency: 'BRL' }), Bun.randomUUIDv7(), new Date());
        await uow.wallets.saveBalance(wallet); // forgot the ledger line on purpose
      }),
    ).rejects.toThrow(/diverges from ledger/);
    expect(await counts(walletId, inboxId)).toEqual(before);
    await assertWalletConsistent(walletId);
  });
});

describe('outbox relay', () => {
  test('two publishers on the same outbox never publish the same event twice and lose nothing', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '1000.00');
    await Promise.all(Array.from({ length: 30 }, () => submit(t.baseUrl, { walletId, playerId, kind: 'BET', amount: '1.00' })));
    const pendingIds = (await sql<{ id: string }>(`SELECT id FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL`, [walletId])).map((r) => r.id);
    expect(pendingIds.length).toBeGreaterThanOrEqual(61); // 2 per bet + 2 for opening

    // each relay only sees ITS OWN wallet's events through a filter on the recording side
    const pubA = new RecordingPublisher(30);
    const pubB = new RecordingPublisher(30);
    const pendingFor = async () => (await sql(`SELECT 1 FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL`, [walletId])).length;
    const drain = async (p: RecordingPublisher) => {
      const r = relay(p);
      // other tests / earlier runs may have left unrelated pending events: keep going until OUR wallet is drained
      for (let i = 0; i < 2000 && (await pendingFor()) > 0; i++) await r.runOnce(5);
    };
    await Promise.all([drain(pubA), drain(pubB)]);

    const mine = (p: RecordingPublisher) => p.received.filter((id) => pendingIds.includes(id));
    const all = [...mine(pubA), ...mine(pubB)];
    expect(new Set(all).size).toBe(all.length); // no duplicates across publishers
    expect(all.length).toBe(pendingIds.length); // nothing lost
    expect(mine(pubA).length).toBeGreaterThan(0);
    expect(mine(pubB).length).toBeGreaterThan(0); // work really was shared
    const left = await sql(`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL`, [walletId]);
    expect(left[0].n).toBe(0);
  });

  test('crash after the broker accepted but BEFORE commit: another instance re-publishes; duplicate is harmless to an idempotent consumer', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '10.00');
    await submit(t.baseUrl, { walletId, playerId, kind: 'BET', amount: '1.00' });
    const real = t.get<TransactionRunner>(TOKENS.TransactionRunner);
    const dyingRunner: TransactionRunner = {
      run: (fn) =>
        real.run(async (uow) => {
          await fn(uow);
          throw new Error('SIGKILL before COMMIT'); // broker already got the messages; DB rolls back
        }),
      runSnapshot: (fn) => real.runSnapshot(fn),
    };
    const broker: string[] = [];
    const spy = new RecordingPublisher();
    const sharedBroker: EventPublisher = { publishBatch: async (m) => (broker.push(...m.map((x) => x.id)), spy.publishBatch(m)) };

    // instance A dies: rows are still pending (lock released with the rolled back tx)
    const mineIds = (await sql<{ id: string }>(`SELECT id FROM outbox_messages WHERE aggregate_id = ?`, [walletId])).map((r) => r.id);
    while ((await sql(`SELECT 1 FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL`, [walletId])).length > 0) {
      const a = relay(sharedBroker, dyingRunner);
      await a.runOnce(500).catch(() => undefined);
      // instance B takes over
      await relay(sharedBroker).runOnce(500);
    }
    const delivered = broker.filter((id) => mineIds.includes(id));
    expect(new Set(delivered).size).toBe(mineIds.length); // every event reached the broker
    expect(delivered.length).toBeGreaterThan(mineIds.length); // at-least-once: duplicates DID happen…
    const consumerSeen = new Set<string>(); // …and an eventId-deduplicating consumer ends up with exactly one of each
    for (const id of delivered) consumerSeen.add(id);
    expect(consumerSeen.size).toBe(mineIds.length);
  });

  test('failed publications are retried with exponential backoff (not hot-looped)', async () => {
    const { walletId } = await createWallet(t.baseUrl, '10.00');
    const ids = (await sql<{ id: string }>(`SELECT id FROM outbox_messages WHERE aggregate_id = ?`, [walletId])).map((r) => r.id);
    const failing = new RecordingPublisher(0, new Set(ids));
    const r = relay(failing);
    // other tests' events may be pending too; drain until our rows have been attempted
    for (let i = 0; i < 50; i++) if ((await r.runOnce(500)) === 0) break;
    const rows = await sql(`SELECT attempts, next_attempt_at, published_at FROM outbox_messages WHERE aggregate_id = ?`, [walletId]);
    for (const row of rows) {
      expect(row.published_at).toBeNull();
      expect(row.attempts).toBe(1);
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    }
    // not due yet: an immediate second run must not retry them
    for (let i = 0; i < 50; i++) if ((await r.runOnce(500)) === 0) break;
    expect((await sql(`SELECT attempts FROM outbox_messages WHERE aggregate_id = ?`, [walletId]))[0].attempts).toBe(1);
    // publisher that throws entirely (broker down) is also contained
    const down: EventPublisher = { publishBatch: async () => { throw new Error('SQS unavailable'); } };
    await expect(relay(down).runOnce(500)).resolves.toBeGreaterThanOrEqual(0);
  });

  test('outbox lag gauge is sampled', async () => {
    await relay(new RecordingPublisher()).sampleLag();
    const text = await (await fetch(`${t.baseUrl}/metrics`)).text();
    expect(text).toMatch(/wager_outbox_lag_seconds \d/);
  });
});
