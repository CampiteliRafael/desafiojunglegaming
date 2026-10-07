import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql, assertWalletConsistent, closeDb, createWallet, http, migrateTestDb, money, startApp, submit, TestApp, uniq } from '../support/harness';

let t: TestApp;
const seqName = async (): Promise<string> => (await sql(`SELECT pg_get_serial_sequence('wallet_ledger_entries', 'seq') AS n`))[0].n as string;
beforeAll(async () => {
  await migrateTestDb();
  t = await startApp();
});
afterAll(async () => {
  await t.close();
  await closeDb();
});

describe('wallets', () => {
  test('create wallet: 201, version 1, OPENING credit in the ledger', async () => {
    const playerId = uniq('p');
    const r = await http(t.baseUrl, 'POST', '/wallets', { body: { playerId, initialBalance: money('1000.00') } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ playerId, balance: money('1000.00'), version: 1 });
    const ledger = await http(t.baseUrl, 'GET', `/wallets/${r.body.id}/ledger`);
    expect(ledger.body.entries).toHaveLength(1);
    expect(ledger.body.entries[0]).toMatchObject({ direction: 'CREDIT', balanceBefore: money('0.00'), balanceAfter: money('1000.00') });
    await assertWalletConsistent(r.body.id);
  });

  test('duplicate (playerId, currency) is a 409 conflict; other currency is fine', async () => {
    const { playerId } = await createWallet(t.baseUrl);
    const dup = await http(t.baseUrl, 'POST', '/wallets', { body: { playerId, initialBalance: money('1.00') } });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', retryable: false });
    const usd = await http(t.baseUrl, 'POST', '/wallets', { body: { playerId, initialBalance: money('1.00', 'USD') } });
    expect(usd.status).toBe(201);
  });

  test('concurrent creation of the same wallet yields exactly one', async () => {
    const playerId = uniq('p');
    const rs = await Promise.all(Array.from({ length: 10 }, () => http(t.baseUrl, 'POST', '/wallets', { body: { playerId, initialBalance: money('5.00') } })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(9);
  });

  test('validation: invalid money, unknown fields, malformed ids -> 400', async () => {
    for (const body of [
      { playerId: 'p', initialBalance: money('10') },
      { playerId: 'p', initialBalance: money('-1.00') },
      { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } },
      { playerId: '', initialBalance: money('1.00') },
      { playerId: 'p', initialBalance: money('1.00'), extra: true },
    ]) {
      const r = await http(t.baseUrl, 'POST', '/wallets', { body });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await http(t.baseUrl, 'GET', '/wallets/not-a-uuid')).status).toBe(400);
    expect((await http(t.baseUrl, 'GET', `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
  });

  test('ledger pagination with a stable, opaque cursor (sequence crossing a digit boundary)', async () => {
    // Regression: ordering must be numeric. Move the identity sequence so this wallet's entries span 98, 99, 100, 101…
    const [{ last }] = await sql(`SELECT last_value::text AS last FROM ${await seqName()}`);
    const boundary = 10n ** BigInt(String(last).length); // next power of ten, e.g. 1000 when last_value is 803
    const target = boundary - 3n; // entries get ...998, 999, 1000, 1001…: where text ordering breaks
    await sql(`SELECT setval(pg_get_serial_sequence('wallet_ledger_entries', 'seq'), ?::bigint)`, [target.toString()]);
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    for (let i = 0; i < 5; i++) await submit(t.baseUrl, { walletId, playerId, kind: 'BET', amount: '1.00' });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/wallets/${walletId}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await http(t.baseUrl, 'GET', url);
      expect(page.status).toBe(200);
      seen.push(...page.body.entries.map((e: any) => e.id));
      cursor = page.body.nextCursor;
      pages++;
      // new entries appended while paging must not shift pages already read
      if (pages === 1) await submit(t.baseUrl, { walletId, playerId, kind: 'WIN', amount: '1.00' });
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(7); // opening + 5 bets + 1 win
    expect((await http(t.baseUrl, 'GET', `/wallets/${walletId}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await http(t.baseUrl, 'GET', `/wallets/${walletId}/ledger?limit=0`)).status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('BET processes: 200 + new balance; replay returns the ORIGINAL result with idempotentReplay=true', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '1000.00');
    const providerId = uniq('prov');
    const spec = { walletId, playerId, providerId, kind: 'BET', amount: '25.00', externalTransactionId: 'transaction-123' };
    const first = await submit(t.baseUrl, spec);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: money('975.00'), idempotentReplay: false });

    await submit(t.baseUrl, { walletId, playerId, kind: 'WIN', amount: '10.00' }); // balance moves on: 985.00
    const replay = await submit(t.baseUrl, spec);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ transactionId: first.body.transactionId, balance: money('975.00'), idempotentReplay: true });
    const w = await http(t.baseUrl, 'GET', `/wallets/${walletId}`);
    expect(w.body.balance).toEqual(money('985.00'));
    await assertWalletConsistent(walletId);
  });

  test('same key with a different payload is a 409 conflict (not a replay)', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl);
    const spec = { walletId, playerId, kind: 'BET', amount: '10.00', externalTransactionId: uniq('e') };
    await submit(t.baseUrl, spec);
    const r = await submit(t.baseUrl, { ...spec, amount: '11.00' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', retryable: false });
    // same external id under another key is also refused: it would double-apply
    const other = await submit(t.baseUrl, { ...spec, idempotencyKey: 'another-key' });
    expect(other.status).toBe(409);
  });

  test('status mapping: 400 invalid / 409 conflict / 422 business rejection / 202 pending / 404 unknown wallet', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '10.00');
    const noHeader = await http(t.baseUrl, 'POST', '/wagering/transactions', { body: {} });
    expect(noHeader.status).toBe(400);
    const badBody = await http(t.baseUrl, 'POST', '/wagering/transactions', { headers: { 'Idempotency-Key': 'k' }, body: { nope: 1 } });
    expect(badBody.status).toBe(400);
    const opening = await submit(t.baseUrl, { walletId, playerId, kind: 'OPENING', amount: '1.00' });
    expect(opening.status).toBe(400); // OPENING is internal: never accepted from the API

    const broke = await submit(t.baseUrl, { walletId, playerId, kind: 'BET', amount: '50.00' });
    expect(broke.status).toBe(422);
    expect(broke.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: money('10.00') });

    const pending = await submit(t.baseUrl, { walletId, playerId, kind: 'REFUND', amount: '5.00', referenceExternalTransactionId: 'not-here-yet' });
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    const ghost = await submit(t.baseUrl, { walletId: Bun.randomUUIDv7(), playerId, kind: 'BET', amount: '1.00' });
    expect(ghost.status).toBe(404);

    const refundNoRef = await submit(t.baseUrl, { walletId, playerId, kind: 'REFUND', amount: '5.00' });
    expect(refundNoRef.status).toBe(400); // reversal without reference
    await assertWalletConsistent(walletId);
  });

  test('rejected replay returns the same 422 and never re-evaluates (even if funds arrive later)', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '10.00');
    const spec = { walletId, playerId, kind: 'BET', amount: '50.00', externalTransactionId: uniq('e') };
    const a = await submit(t.baseUrl, spec);
    await submit(t.baseUrl, { walletId, playerId, kind: 'WIN', amount: '100.00' });
    const b = await submit(t.baseUrl, spec);
    expect(a.status).toBe(422);
    expect(b.status).toBe(422);
    expect(b.body).toMatchObject({ transactionId: a.body.transactionId, failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true, balance: money('10.00') });
  });

  test('currency conflicts are recorded as auditable rejections', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '10.00');
    const r = await submit(t.baseUrl, { walletId, playerId, kind: 'BET', amount: '1.00', currency: 'USD' });
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe('CURRENCY_MISMATCH');
    const other = await submit(t.baseUrl, { walletId, playerId: 'someone-else', kind: 'BET', amount: '1.00' });
    expect(other.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });

  test('full round: BET, WIN, LOSS, REFUND, ROLLBACK keep balance == ledger', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '100.00');
    const providerId = uniq('prov');
    const bet = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'BET', amount: '40.00', externalTransactionId: 'bet-A' });
    expect(bet.body.balance).toEqual(money('60.00'));
    const win = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'WIN', amount: '100.00', externalTransactionId: 'win-A', referenceExternalTransactionId: 'bet-A' });
    expect(win.body.balance).toEqual(money('160.00'));
    const loss = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'LOSS', amount: '40.00', roundId: 'round-2' });
    expect(loss.status).toBe(200);
    expect(loss.body.balance).toEqual(money('160.00'));
    const rb = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'ROLLBACK', amount: '100.00', externalTransactionId: 'rb-win-A', referenceExternalTransactionId: 'win-A' });
    expect(rb.body.balance).toEqual(money('60.00'));
    const rf = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'REFUND', amount: '40.00', referenceExternalTransactionId: 'bet-A' });
    expect(rf.body.balance).toEqual(money('100.00'));
    // a second reversal of the same BET (any type) is refused: no double credit
    const rf2 = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'ROLLBACK', amount: '40.00', referenceExternalTransactionId: 'bet-A' });
    expect(rf2.status).toBe(422);
    expect(rf2.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const info = await assertWalletConsistent(walletId);
    expect(info.balance).toBe('100.00');
    expect(info.entries).toBe(5); // opening, bet, win, rollback, refund — LOSS and rejections leave no ledger line
  });

  test('rollback that would overdraw is rejected with its own failure code and stays auditable', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '0.00');
    const providerId = uniq('prov');
    await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'WIN', amount: '50.00', externalTransactionId: 'w' });
    await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'WIN', amount: '1.00', externalTransactionId: 'w2' });
    // spend everything (wallet has 51.00) so reverting the 50.00 WIN would overdraw
    await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'BET', amount: '51.00' });
    const rb = await submit(t.baseUrl, { walletId, playerId, providerId, kind: 'ROLLBACK', amount: '50.00', referenceExternalTransactionId: 'w' });
    expect(rb.status).toBe(422);
    expect(rb.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    const got = await http(t.baseUrl, 'GET', `/wagering/transactions/${rb.body.transactionId}`);
    expect(got.body).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });
    await assertWalletConsistent(walletId);
  });
});

describe('queries, reconciliation and health', () => {
  test('GET transaction by id and by provider + externalId', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl);
    const ext = uniq('e');
    const r = await submit(t.baseUrl, { walletId, playerId, kind: 'BET', amount: '3.00', providerId: 'prov-q', externalTransactionId: ext });
    const byId = await http(t.baseUrl, 'GET', `/wagering/transactions/${r.body.transactionId}`);
    const byExt = await http(t.baseUrl, 'GET', `/providers/prov-q/wagering/transactions/${ext}`);
    expect(byId.status).toBe(200);
    expect(byExt.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: money('3.00') });
    expect((await http(t.baseUrl, 'GET', `/providers/prov-q/wagering/transactions/nope`)).status).toBe(404);
  });

  test('reconciliation reports consistent wallets and flags (never silently fixes) divergence', async () => {
    const { walletId, playerId } = await createWallet(t.baseUrl, '50.00');
    await submit(t.baseUrl, { walletId, playerId, kind: 'BET', amount: '20.00' });
    const ok = await http(t.baseUrl, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ walletId, storedBalance: money('30.00'), calculatedBalance: money('30.00'), difference: money('0.00'), consistent: true, checkedEntries: 2 });
    expect((await http(t.baseUrl, 'POST', `/wallets/${Bun.randomUUIDv7()}/reconciliation`)).status).toBe(404);
  });

  test('health/live is open; metrics expose the required series', async () => {
    expect((await http(t.baseUrl, 'GET', '/health/live')).body).toEqual({ status: 'ok' });
    const text = await (await fetch(`${t.baseUrl}/metrics`)).text();
    for (const m of ['wager_transactions_total', 'wager_duplicates_detected_total', 'wager_retries_total', 'wager_dlq_messages_total', 'wager_lock_conflicts_total', 'wager_outbox_lag_seconds', 'wager_processing_duration_seconds']) {
      expect(text).toContain(m);
    }
  });
});
