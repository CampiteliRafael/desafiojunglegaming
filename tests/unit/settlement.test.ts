import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { settle } from '../../src/domain/settlement';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/domain/wager-transaction';

const m = (a: string, c = 'BRL') => Money.from({ amount: a, currency: c });
const NOW = new Date('2026-08-01T00:00:00Z');
let seq = 0;

const wallet = (balance = '100.00') =>
  Wallet.rehydrate({ id: 'w1', playerId: 'p1', currency: 'BRL', balance: m(balance), version: 1, createdAt: NOW, updatedAt: NOW });

function tx(kind: K, amount = '10.00', over: Partial<{ ref: string; round: string; player: string; currency: string; wallet: string; ext: string }> = {}) {
  seq++;
  return WagerTransaction.create({
    id: `tx-${seq}`,
    providerId: 'prov',
    externalTransactionId: over.ext ?? `ext-${seq}`,
    idempotencyKey: `key-${seq}`,
    payloadHash: 'h',
    walletId: over.wallet ?? 'w1',
    playerId: over.player ?? 'p1',
    roundId: over.round ?? 'r1',
    gameId: 'g',
    kind,
    money: m(amount, over.currency ?? 'BRL'),
    referenceExternalTransactionId: over.ref,
    now: NOW,
  });
}

/** Processes a BET through the domain and returns it (as a persisted, PROCESSED reference). */
function processed(kind: K, w: Wallet, amount = '10.00', over = {}) {
  const t = tx(kind, amount, over);
  const o = settle({ tx: t, wallet: w, reference: undefined, referenceAlreadyReversed: false, now: NOW });
  expect(o.type).toBe('processed');
  return t;
}

const run = (t: WagerTransaction, w: Wallet, reference?: WagerTransaction, reversed = false) =>
  settle({ tx: t, wallet: w, reference, referenceAlreadyReversed: reversed, now: NOW });

describe('BET / WIN / LOSS', () => {
  test('BET debits and records one DEBIT entry', () => {
    const w = wallet();
    const t = tx(K.Bet, '25.00');
    const o = run(t, w);
    expect(o.type).toBe('processed');
    expect(w.balance.toString()).toBe('75.00');
    expect(t.status).toBe(S.Processed);
    expect(o.type === 'processed' && o.entry?.direction).toBe(LedgerDirection.Debit);
  });

  test('BET without funds is REJECTED with INSUFFICIENT_FUNDS and does not touch the wallet', () => {
    const w = wallet('20.00');
    const t = tx(K.Bet, '80.00');
    expect(run(t, w)).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    expect(t.status).toBe(S.Rejected);
    expect(w.balance.toString()).toBe('20.00');
    expect(w.version).toBe(1);
  });

  test('WIN credits; LOSS moves nothing and creates no ledger entry', () => {
    const w = wallet();
    run(tx(K.Win, '40.00'), w);
    expect(w.balance.toString()).toBe('140.00');
    const loss = tx(K.Loss, '10.00');
    const o = run(loss, w);
    expect(o.type === 'processed' && o.entry).toBeUndefined();
    expect(loss.status).toBe(S.Processed);
    expect(loss.affectsBalance()).toBe(false);
    expect(w.balance.toString()).toBe('140.00');
  });

  test('currency mismatch and player mismatch are auditable rejections', () => {
    expect(run(tx(K.Bet, '1.00', { currency: 'USD' }), wallet())).toEqual({ type: 'rejected', code: FailureCode.CurrencyMismatch });
    expect(run(tx(K.Bet, '1.00', { player: 'other' }), wallet())).toEqual({ type: 'rejected', code: FailureCode.WalletPlayerMismatch });
  });
});

describe('REFUND', () => {
  test('reverts a processed BET exactly once', () => {
    const w = wallet();
    const bet = processed(K.Bet, w, '30.00', { ext: 'bet-1' });
    expect(w.balance.toString()).toBe('70.00');
    const refund = tx(K.Refund, '30.00', { ref: 'bet-1' });
    const o = run(refund, w, bet);
    expect(o.type).toBe('processed');
    expect(w.balance.toString()).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);

    const again = tx(K.Refund, '30.00', { ref: 'bet-1' });
    expect(run(again, w, bet, true)).toEqual({ type: 'rejected', code: FailureCode.ReferenceAlreadyReversed });
    expect(w.balance.toString()).toBe('100.00');
  });

  test('only references a BET; amount must match exactly', () => {
    const w = wallet();
    const win = processed(K.Win, w, '10.00', { ext: 'win-1' });
    expect(run(tx(K.Refund, '10.00', { ref: 'win-1' }), w, win)).toEqual({ type: 'rejected', code: FailureCode.ReferenceInvalidKind });
    const bet = processed(K.Bet, w, '10.00', { ext: 'bet-2' });
    expect(run(tx(K.Refund, '9.99', { ref: 'bet-2' }), w, bet)).toEqual({ type: 'rejected', code: FailureCode.ReferenceAmountMismatch });
  });

  test('missing reference => pending_reference (no state change); rejected reference => REFERENCE_NOT_PROCESSED', () => {
    const w = wallet();
    const refund = tx(K.Refund, '10.00', { ref: 'nope' });
    expect(run(refund, w)).toEqual({ type: 'pending_reference' });
    expect(refund.status).toBe(S.Pending);
    expect(w.version).toBe(1);

    const poorWallet = wallet('1.00');
    const failedBet = tx(K.Bet, '50.00', { ext: 'bet-x' });
    run(failedBet, poorWallet);
    expect(failedBet.status).toBe(S.Rejected);
    expect(run(tx(K.Refund, '50.00', { ref: 'bet-x' }), w, failedBet)).toEqual({ type: 'rejected', code: FailureCode.ReferenceNotProcessed });
  });

  test('reference must share provider, player, wallet, currency and round', () => {
    const w = wallet();
    const bet = processed(K.Bet, w, '10.00', { ext: 'bet-3', round: 'r1' });
    expect(run(tx(K.Refund, '10.00', { ref: 'bet-3', round: 'r2' }), w, bet)).toEqual({ type: 'rejected', code: FailureCode.ReferenceMismatch });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits back; of a WIN debits; of a REFUND debits', () => {
    const w = wallet();
    const bet = processed(K.Bet, w, '10.00', { ext: 'b' }); // 90
    run(tx(K.Rollback, '10.00', { ref: 'b' }), w, bet); // 100
    expect(w.balance.toString()).toBe('100.00');

    const win = processed(K.Win, w, '25.00', { ext: 'w' }); // 125
    run(tx(K.Rollback, '25.00', { ref: 'w' }), w, win); // 100
    expect(w.balance.toString()).toBe('100.00');

    const bet2 = processed(K.Bet, w, '5.00', { ext: 'b2' }); // 95
    const refund = tx(K.Refund, '5.00', { ref: 'b2' });
    run(refund, w, bet2); // 100
    run(tx(K.Rollback, '5.00', { ref: 'r' }), w, refund); // 95
    expect(w.balance.toString()).toBe('95.00');
  });

  test('rollback that would make the balance negative is rejected with its own code', () => {
    const w = wallet('0.00');
    const win = processed(K.Win, w, '50.00', { ext: 'w' }); // 50
    processed(K.Bet, w, '50.00', { ext: 'spent' }); // 0
    const rb = tx(K.Rollback, '50.00', { ref: 'w' });
    expect(run(rb, w, win)).toEqual({ type: 'rejected', code: FailureCode.ReversalInsufficientFunds });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(w.balance.toString()).toBe('0.00');
  });

  test('cannot roll back a LOSS or reuse an already reverted reference', () => {
    const w = wallet();
    const loss = processed(K.Loss, w, '5.00', { ext: 'l' });
    expect(run(tx(K.Rollback, '5.00', { ref: 'l' }), w, loss)).toEqual({ type: 'rejected', code: FailureCode.ReferenceInvalidKind });
    const bet = processed(K.Bet, w, '5.00', { ext: 'bb' });
    expect(run(tx(K.Rollback, '5.00', { ref: 'bb' }), w, bet, true)).toEqual({ type: 'rejected', code: FailureCode.ReferenceAlreadyReversed });
  });
});
