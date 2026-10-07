/**
 * Domain errors. `kind` drives how the edges (HTTP / SQS) react:
 *  - validation:  malformed input, never retry as-is
 *  - conflict:    state conflict (idempotency, duplicates)
 *  - not_found:   unknown aggregate
 *  - invariant:   programming error / corrupted state
 */
export type DomainErrorKind = 'validation' | 'conflict' | 'not_found' | 'invariant';

export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly kind = 'validation' as const;
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly kind = 'validation' as const;
  readonly code = 'CURRENCY_MISMATCH';
}

export class InsufficientFundsError extends DomainError {
  readonly kind = 'invariant' as const;
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidTransactionStateError extends DomainError {
  readonly kind = 'invariant' as const;
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class InvariantViolationError extends DomainError {
  readonly kind = 'invariant' as const;
  readonly code = 'INVARIANT_VIOLATION';
}

export class ValidationError extends DomainError {
  readonly kind = 'validation' as const;
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string, readonly details?: unknown) {
    super(message);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly kind = 'conflict' as const;
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
}

export class DuplicateWalletError extends DomainError {
  readonly kind = 'conflict' as const;
  readonly code = 'WALLET_ALREADY_EXISTS';
}

export class WalletNotFoundError extends DomainError {
  readonly kind = 'not_found' as const;
  readonly code = 'WALLET_NOT_FOUND';
}

export class TransactionNotFoundError extends DomainError {
  readonly kind = 'not_found' as const;
  readonly code = 'TRANSACTION_NOT_FOUND';
}
