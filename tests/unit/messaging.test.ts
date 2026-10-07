import { describe, expect, test } from 'bun:test';
import { WagerTransactionRejected, WalletBalanceChanged } from '../../src/domain/events/wager-events';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { InboxMessage, OutboxMessage } from '../../src/domain/messaging';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction, WagerTransactionKind as K } from '../../src/domain/wager-transaction';

const m = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const NOW = new Date('2026-08-01T00:00:00Z');
const ctx = { eventId: '0192f298-345e-7e38-af88-e43f851a819d', correlationId: 'c1', causationId: 'm1', occurredAt: NOW };

describe('Outbox', () => {
  test('enqueue serialises the event envelope; money is a decimal string, never a number', () => {
    const { wallet } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: m('100.00'), openingTransactionId: 't', now: NOW });
    const entry = wallet.debit(m('25.00'), 'tx1', NOW);
    const evt = WalletBalanceChanged.from(wallet, entry, ctx);
    const msg = OutboxMessage.enqueue(evt);
    expect(msg.id).toBe(ctx.eventId);
    expect(msg.aggregateId).toBe('w');
    expect(msg.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      correlationId: 'c1',
      causationId: 'm1',
      occurredAt: NOW.toISOString(),
      data: { direction: LedgerDirection.Debit, money: { amount: '25.00', currency: 'BRL' }, balanceAfter: { amount: '75.00', currency: 'BRL' }, walletVersion: 2 },
    });
    expect(JSON.parse(JSON.stringify(msg.payload))).toEqual(msg.payload);
  });

  test('retry backoff doubles and publishing is final', () => {
    const tx = WagerTransaction.create({ id: 'i', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h', walletId: 'w', playerId: 'p', roundId: 'r', gameId: 'g', kind: K.Bet, money: m('1.00'), now: NOW });
    tx.reject(FailureCode.InsufficientFunds, NOW);
    const msg = OutboxMessage.enqueue(WagerTransactionRejected.from(tx, ctx));
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(NOW)).toBe(true);
    msg.scheduleRetry(NOW);
    expect(msg.attempts).toBe(1);
    expect(msg.isDue(NOW)).toBe(false);
    expect(msg.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 1000);
    msg.scheduleRetry(NOW);
    expect(msg.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 2000);
    expect(msg.isDue(new Date(NOW.getTime() + 2000))).toBe(true);
    msg.markPublished(NOW);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.markPublished(NOW)).toThrow();
  });
});

describe('Inbox', () => {
  test('receive then markProcessed once', () => {
    const i = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', now: NOW });
    expect(i.isProcessed()).toBe(false);
    i.markProcessed(NOW);
    expect(i.isProcessed()).toBe(true);
    expect(() => i.markProcessed(NOW)).toThrow();
  });
});

void WalletLedgerEntry;
