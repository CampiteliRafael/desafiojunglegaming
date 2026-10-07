import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/reprocess-pending-references';
import { assertWalletConsistent, closeDb, createWallet, http, migrateTestDb, money, sleep, sql, startApp, submit, TestApp, uniq } from '../support/harness';

let t: TestApp;
let reprocess: ReprocessPendingReferencesUseCase;

beforeAll(async () => {
  await migrateTestDb();
  t = await startApp({ PENDING_REF_MAX_ATTEMPTS: '3', PENDING_REF_BASE_DELAY_MS: '1', PENDING_REF_MAX_DELAY_MS: '5', PENDING_REF_TTL_MS: '600000' });
  reprocess = t.get(ReprocessPendingReferencesUseCase);
});
afterAll(async () => {
  await t.close();
  await closeDb();
});

const eventsOf = async (walletId: string) =>
  (await sql<{ event_type: string; payload: any }>(`SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at, id`, [walletId])).map((r) => r.event_type);

describe('out-of-order references', () => {
  test('ROLLBACK delivered BEFORE its BET waits (202), then applies once the BET arrives', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    const providerId = uniq('prov');
    const rb = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'ROLLBACK', amount: '30.00', externalTransactionId: 'rb', referenceExternalTransactionId: 'bet' });
    expect(rb.status).toBe(202);
    expect(rb.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: money('100.00') });

    // a replay of a pending transaction is still 202 and flagged as replay
    const again = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'ROLLBACK', amount: '30.00', externalTransactionId: 'rb', referenceExternalTransactionId: 'bet' });
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ transactionId: rb.body.transactionId, idempotentReplay: true });

    // worker runs while the reference is still missing: stays pending, attempts grow, no balance change
    await sleep(20);
    expect(await reprocess.reprocessOne(rb.body.transactionId)).toBe('still_pending');

    const bet = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'BET', amount: '30.00', externalTransactionId: 'bet' });
    expect(bet.body.balance).toEqual(money('70.00'));

    await sleep(20);
    const totals = await reprocess.runBatch(100);
    expect(totals.processed).toBeGreaterThanOrEqual(1);

    const final = await http(t.baseUrl, 'GET', `/wagering/transactions/${rb.body.transactionId}`);
    expect(final.body).toMatchObject({ status: 'PROCESSED', balance: money('100.00') });
    expect((await http(t.baseUrl, 'GET', `/wallets/${walletId}`)).body.balance).toEqual(money('100.00'));
    await assertWalletConsistent(walletId);

    const events = await eventsOf(walletId);
    expect(events).toContain('WagerTransactionPendingReference');
    expect(events.filter((e) => e === 'WagerTransactionPendingReference')).toHaveLength(1); // not repeated on every retry
  });

  test('REFUND before BET behaves the same', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '50.00');
    const providerId = uniq('prov');
    const rf = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: 'b1' });
    expect(rf.status).toBe(202);
    await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'BET', amount: '20.00', externalTransactionId: 'b1' });
    await sleep(20);
    await reprocess.reprocessOne(rf.body.transactionId);
    expect((await http(t.baseUrl, 'GET', `/wallets/${walletId}`)).body.balance).toEqual(money('50.00'));
    await assertWalletConsistent(walletId);
  });

  test('attempts exhausted: REJECTED with REFERENCE_NOT_FOUND and a WagerTransactionRejected event', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '10.00');
    const r = await submit(t.baseUrl, { walletId, playerId, kind: 'ROLLBACK', amount: '5.00', referenceExternalTransactionId: 'never-comes' });
    expect(r.status).toBe(202);
    const outcomes: string[] = [];
    for (let i = 0; i < 6 && outcomes.at(-1) !== 'rejected'; i++) {
      await sleep(15);
      outcomes.push(await reprocess.reprocessOne(r.body.transactionId));
    }
    expect(outcomes.at(-1)).toBe('rejected');
    const tx = await http(t.baseUrl, 'GET', `/wagering/transactions/${r.body.transactionId}`);
    expect(tx.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    const [evt] = await sql(`SELECT payload FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionRejected'`, [walletId]);
    expect(evt.payload.data).toMatchObject({ transactionId: r.body.transactionId, failureCode: 'REFERENCE_NOT_FOUND' });
    // terminal: reprocessing is a no-op
    expect(await reprocess.reprocessOne(r.body.transactionId)).toBe('skipped');
    await assertWalletConsistent(walletId);
  });

  test('many workers reprocessing the same pending transaction apply it exactly once', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    const providerId = uniq('prov');
    const rb = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'ROLLBACK', amount: '40.00', externalTransactionId: 'rb', referenceExternalTransactionId: 'bet' });
    await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'BET', amount: '40.00', externalTransactionId: 'bet' });
    await sleep(20);
    const results = await Promise.all(Array.from({ length: 12 }, () => reprocess.reprocessOne(rb.body.transactionId)));
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    const info = await assertWalletConsistent(walletId);
    expect(info.balance).toBe('100.00');
    expect(info.entries).toBe(3); // opening, bet, rollback
  });

  test('a pending reversal does not let a second reversal of the same BET through', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    const providerId = uniq('prov');
    await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'BET', amount: '10.00', externalTransactionId: 'bet' });
    const [a, b] = await Promise.all([
      submit(t.baseUrl, { walletId, playerId, providerId, kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: 'bet' }),
      submit(t.baseUrl, { walletId, playerId, providerId, kind: 'ROLLBACK', amount: '10.00', referenceExternalTransactionId: 'bet' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    const info = await assertWalletConsistent(walletId);
    expect(info.balance).toBe('100.00'); // credited back once, not twice
  });
});
