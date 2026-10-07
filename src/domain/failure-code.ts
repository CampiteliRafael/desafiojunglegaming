/**
 * Stable, machine-readable rejection / failure taxonomy.
 *
 * `guidance` tells the provider what to do next:
 *  - CORRECT_AND_RESEND : the payload/reference is wrong; send a new, corrected transaction
 *  - NO_RETRY           : business outcome is final; resending the same thing changes nothing
 *  - CONTACT_SUPPORT    : unexpected internal failure; do not resend blindly
 */
export enum FailureCode {
  /** BET debit exceeds the available balance. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** REFUND/ROLLBACK would push the balance below zero (distinct from a bet without funds). */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId in the operation does not own the wallet. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Referenced transaction never arrived within TTL / attempt limit. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Reference belongs to another provider/player/wallet/currency/round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Reference kind not allowed (e.g. REFUND of a WIN, ROLLBACK of a LOSS). */
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  /** Reference exists but was rejected/failed, so there is nothing to revert. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reference already reverted by a previous REFUND/ROLLBACK. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Reversal amount differs from the referenced amount (partial reversal unsupported). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Permanent internal error (terminal FAILED state). */
  InternalPermanentError = 'INTERNAL_PERMANENT_ERROR',
}

export type FailureGuidance = 'CORRECT_AND_RESEND' | 'NO_RETRY' | 'CONTACT_SUPPORT';

export const FAILURE_GUIDANCE: Readonly<Record<FailureCode, FailureGuidance>> = {
  [FailureCode.InsufficientFunds]: 'NO_RETRY',
  [FailureCode.ReversalInsufficientFunds]: 'NO_RETRY',
  [FailureCode.CurrencyMismatch]: 'CORRECT_AND_RESEND',
  [FailureCode.WalletPlayerMismatch]: 'CORRECT_AND_RESEND',
  [FailureCode.ReferenceNotFound]: 'CORRECT_AND_RESEND',
  [FailureCode.ReferenceMismatch]: 'CORRECT_AND_RESEND',
  [FailureCode.ReferenceInvalidKind]: 'CORRECT_AND_RESEND',
  [FailureCode.ReferenceNotProcessed]: 'NO_RETRY',
  [FailureCode.ReferenceAlreadyReversed]: 'NO_RETRY',
  [FailureCode.ReferenceAmountMismatch]: 'CORRECT_AND_RESEND',
  [FailureCode.InternalPermanentError]: 'CONTACT_SUPPORT',
};
