import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const m = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
const NOW = new Date('2026-08-01T00:00:00Z');
const open = (initial = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: m(initial), openingTransactionId: 'open-1', now: NOW });

describe('Wallet', () => {
  test('opens at version 1 with an OPENING ledger entry 0 -> initial', () => {
    const { wallet, openingEntry } = open();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('100.00');
  });

  test('zero initial balance produces no ledger entry', () => {
    expect(open('0.00').openingEntry).toBeUndefined();
  });

  test('debit and credit return the matching ledger entry and bump version', () => {
    const { wallet } = open();
    const debit = wallet.debit(m('30.00'), 'tx1', NOW);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('70.00');
    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);

    const credit = wallet.credit(m('5.50'), 'tx2', NOW);
    expect(credit.balanceAfter.toString()).toBe('75.50');
    expect(wallet.version).toBe(3);
  });

  test('never goes negative', () => {
    const { wallet } = open('10.00');
    expect(() => wallet.debit(m('10.01'), 'tx', NOW)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1); // failed operation does not change version
    expect(wallet.debit(m('10.00'), 'tx', NOW).balanceAfter.isZero()).toBe(true);
  });

  test('currency of the operation must equal the wallet currency', () => {
    const { wallet } = open();
    expect(() => wallet.debit(m('1.00', 'USD'), 'tx', NOW)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(m('1.00', 'USD'), 'tx', NOW)).toThrow(CurrencyMismatchError);
  });

  test('rejects non-positive movements', () => {
    const { wallet } = open();
    expect(() => wallet.credit(Money.zero('BRL'), 'tx', NOW)).toThrow(InvariantViolationError);
  });

  test('tracks the persisted version for optimistic locking', () => {
    const w = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: m('10.00'), version: 7, createdAt: NOW, updatedAt: NOW });
    expect(w.loadedVersion).toBe(7);
    w.credit(m('1.00'), 't', NOW);
    expect(w.version).toBe(8);
    expect(w.loadedVersion).toBe(7);
    expect(w.hasUnpersistedChanges).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e1',
    walletId: 'w1',
    transactionId: 't1',
    createdAt: NOW,
  };

  test('create verifies the arithmetic', () => {
    const ok = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: m('10.00'), balanceBefore: m('50.00'), balanceAfter: m('40.00') });
    expect(ok.isBalanced()).toBe(true);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: m('10.00'), balanceBefore: m('50.00'), balanceAfter: m('41.00') }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: m('10.00'), balanceBefore: m('50.00'), balanceAfter: m('40.00') }),
    ).toThrow(InvariantViolationError);
  });

  test('is structurally immutable: exposes no mutators', () => {
    const e = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: m('1.00'), balanceBefore: m('0.00'), balanceAfter: m('1.00') });
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(e));
    expect(proto.filter((n) => /^(set|mark|update|change|apply)/.test(n))).toEqual([]);
  });
});
