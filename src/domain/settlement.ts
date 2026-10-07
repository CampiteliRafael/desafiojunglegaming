import { FailureCode } from './failure-code';
import { WalletLedgerEntry } from './ledger-entry';
import { Wallet } from './wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

export type SettlementOutcome =
  | { type: 'processed'; entry: WalletLedgerEntry | undefined; reference: WagerTransaction | undefined }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'pending_reference' };

export interface SettlementInput {
  tx: WagerTransaction;
  wallet: Wallet;
  /** Transaction resolved by (providerId, referenceExternalTransactionId), if it exists. */
  reference: WagerTransaction | undefined;
  /** Whether a PROCESSED REFUND/ROLLBACK already reverted `reference`. */
  referenceAlreadyReversed: boolean;
  now: Date;
}

const REFUND_TARGETS: readonly WagerTransactionKind[] = [WagerTransactionKind.Bet];
const ROLLBACK_TARGETS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
];

/**
 * Pure domain service: decides what a transaction does to the wallet.
 * It mutates `tx` and `wallet` (aggregates) and returns the outcome; persistence
 * and event emission are the caller's job. No I/O.
 *
 * Interpretation notes (documented in ARCHITECTURE.md):
 *  - a reference can be reverted at most ONCE by any REFUND/ROLLBACK (stricter than
 *    "once per type": otherwise BET could be refunded and rolled back => double credit);
 *  - WIN/LOSS may optionally reference a BET of the same round; if the reference is
 *    declared but unknown yet, it waits like REFUND/ROLLBACK.
 */
export function settle(input: SettlementInput): SettlementOutcome {
  const { tx, wallet, reference, now } = input;

  // --- context checks (recorded as REJECTED: they are auditable business outcomes)
  if (wallet.playerId !== tx.playerId) return reject(tx, FailureCode.WalletPlayerMismatch, now);
  if (wallet.currency !== tx.money.currency) return reject(tx, FailureCode.CurrencyMismatch, now);

  const hasReference = tx.referenceExternalTransactionId !== undefined;
  if (hasReference) {
    if (!reference) return { type: 'pending_reference' };

    if (reference.status === WagerTransactionStatus.PendingReference || reference.status === WagerTransactionStatus.Pending) {
      return { type: 'pending_reference' }; // reference itself still waiting
    }
    if (
      reference.providerId !== tx.providerId ||
      reference.playerId !== tx.playerId ||
      reference.walletId !== tx.walletId ||
      reference.roundId !== tx.roundId ||
      reference.money.currency !== tx.money.currency
    ) {
      return reject(tx, FailureCode.ReferenceMismatch, now);
    }
    const allowed =
      tx.kind === WagerTransactionKind.Refund
        ? REFUND_TARGETS
        : tx.kind === WagerTransactionKind.Rollback
          ? ROLLBACK_TARGETS
          : [WagerTransactionKind.Bet]; // WIN / LOSS may only point at a BET
    if (!allowed.includes(reference.kind)) return reject(tx, FailureCode.ReferenceInvalidKind, now);
    if (reference.status !== WagerTransactionStatus.Processed) return reject(tx, FailureCode.ReferenceNotProcessed, now);

    if (tx.requiresReference()) {
      if (input.referenceAlreadyReversed) return reject(tx, FailureCode.ReferenceAlreadyReversed, now);
      if (!tx.money.equals(reference.money)) return reject(tx, FailureCode.ReferenceAmountMismatch, now);
    }
  }

  // --- balance effect
  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now);
    return { type: 'processed', entry: undefined, reference };
  }

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === 'DEBIT') {
    if (!wallet.canDebit(tx.money)) {
      const code =
        tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds;
      return reject(tx, code, now);
    }
    const entry = wallet.debit(tx.money, tx.id, now);
    tx.markProcessed(reference?.id, now);
    return { type: 'processed', entry, reference };
  }
  const entry = wallet.credit(tx.money, tx.id, now);
  tx.markProcessed(reference?.id, now);
  return { type: 'processed', entry, reference };
}

function reject(tx: WagerTransaction, code: FailureCode, now: Date): SettlementOutcome {
  tx.reject(code, now);
  return { type: 'rejected', code };
}
