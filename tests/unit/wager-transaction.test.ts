import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, ValidationError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import {
  BusinessFields,
  computePayloadHash,
  PendingReferencePolicy,
  VALID_TRANSITIONS,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wager-transaction';

const m = (a: string) => Money.from({ amount: a, currency: 'BRL' });
const NOW = new Date('2026-08-01T00:00:00Z');
const fields = (over: Partial<BusinessFields> = {}): BusinessFields => ({
  providerId: 'prov', externalTransactionId: 'e1', playerId: 'p', walletId: 'w', roundId: 'r', gameId: 'g', kind: K.Bet, money: m('10.00'), ...over,
});
const create = (over: Partial<BusinessFields> = {}) =>
  WagerTransaction.create({ id: 'id', idempotencyKey: 'k', payloadHash: computePayloadHash(fields(over)), now: NOW, ...fields(over) });
const policy: PendingReferencePolicy = { maxAttempts: 3, ttlMs: 60_000, baseDelayMs: 1000, maxDelayMs: 10_000 };

describe('WagerTransaction', () => {
  test('is born PENDING', () => expect(create().status).toBe(S.Pending));

  test('REFUND / ROLLBACK require a reference; BET must not have one', () => {
    expect(() => create({ kind: K.Refund })).toThrow(ValidationError);
    expect(() => create({ kind: K.Rollback })).toThrow(ValidationError);
    expect(() => create({ kind: K.Bet, referenceExternalTransactionId: 'x' })).toThrow(ValidationError);
    expect(create({ kind: K.Refund, referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
    expect(create({ kind: K.Win, referenceExternalTransactionId: 'x' }).requiresReference()).toBe(false);
  });

  test('OPENING and the reserved provider are internal-only', () => {
    expect(() => create({ kind: K.Opening })).toThrow(ValidationError);
    expect(() => create({ providerId: 'internal' })).toThrow(ValidationError);
  });

  test('amounts: positive, except LOSS may be zero', () => {
    expect(() => create({ money: Money.zero('BRL') })).toThrow(ValidationError);
    expect(create({ kind: K.Loss, money: Money.zero('BRL') }).affectsBalance()).toBe(false);
  });

  test('terminal states are final: any transition throws', () => {
    for (const terminal of [S.Processed, S.Rejected, S.Failed]) {
      expect(VALID_TRANSITIONS[terminal]).toEqual([]);
    }
    const t = create();
    t.markProcessed(undefined, NOW);
    expect(t.isTerminal()).toBe(true);
    expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(NOW, policy)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.InternalPermanentError)).toThrow(InvalidTransactionStateError);
    expect(() => t.markProcessed(undefined, NOW)).toThrow(InvalidTransactionStateError);

    const r = create();
    r.reject(FailureCode.InsufficientFunds);
    expect(r.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => r.markProcessed(undefined, NOW)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE backs off exponentially and exhausts by attempts or TTL', () => {
    const t = create({ kind: K.Refund, referenceExternalTransactionId: 'x' });
    t.markPendingReference(NOW, policy);
    expect(t.referenceAttempts).toBe(1);
    expect(t.nextReferenceAttemptAt?.getTime()).toBe(NOW.getTime() + 1000);
    t.markPendingReference(NOW, policy);
    expect(t.nextReferenceAttemptAt?.getTime()).toBe(NOW.getTime() + 2000);
    t.markPendingReference(NOW, policy);
    expect(t.nextReferenceAttemptAt?.getTime()).toBe(NOW.getTime() + 4000);
    expect(t.isReferenceExhausted(NOW, policy)).toBe(true); // 3 attempts
    // TTL
    const u = create({ kind: K.Refund, referenceExternalTransactionId: 'x' });
    u.markPendingReference(NOW, { ...policy, maxAttempts: 99 });
    expect(u.isReferenceExhausted(new Date(NOW.getTime() + 59_000), { ...policy, maxAttempts: 99 })).toBe(false);
    expect(u.isReferenceExhausted(new Date(NOW.getTime() + 60_000), { ...policy, maxAttempts: 99 })).toBe(true);
    // can still be settled
    u.markProcessed('ref-id', NOW);
    expect(u.status).toBe(S.Processed);
  });

  test('matchesPayload / payload hash is canonical and ignores key order and transport metadata', () => {
    const a = computePayloadHash(fields());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computePayloadHash(fields())).toBe(a);
    expect(computePayloadHash(fields({ money: m('10.01') }))).not.toBe(a);
    expect(computePayloadHash(fields({ roundId: 'other' }))).not.toBe(a);
    const t = create();
    expect(t.matchesPayload(a)).toBe(true);
    expect(t.matchesPayload('x'.repeat(64))).toBe(false);
  });

  test('ledgerDirectionFor: BET debit, WIN/REFUND credit, ROLLBACK inverse of reference', () => {
    const bet = create();
    const win = create({ kind: K.Win });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const rb = create({ kind: K.Rollback, referenceExternalTransactionId: 'x' });
    expect(rb.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(() => create({ kind: K.Loss }).ledgerDirectionFor()).toThrow();
  });
});
