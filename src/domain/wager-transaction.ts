import { createHash } from 'node:crypto';
import { InvalidTransactionStateError, InvariantViolationError, ValidationError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING', // internal: wallet opening credit
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Kinds a provider may submit (OPENING is internal only). */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** Reserved providerId used by internal OPENING transactions. */
export const INTERNAL_PROVIDER_ID = 'internal';

/**
 * Valid transitions (anything else throws InvalidTransactionStateError):
 *
 *   PENDING            -> PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 *   PENDING_REFERENCE  -> PROCESSED | REJECTED | PENDING_REFERENCE (retry) | FAILED
 *   PROCESSED | REJECTED | FAILED -> (terminal, no transitions)
 */
export const VALID_TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

export interface BusinessFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

export interface CreateWagerTransactionProps extends BusinessFields {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  now: Date;
  /** Only the wallet-opening flow may create OPENING transactions. */
  internal?: boolean;
}

export interface WagerTransactionState extends BusinessFields {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | undefined;
  referenceDeadline?: Date | undefined;
  /** Wallet balance observed when the transaction was decided (returned verbatim on replays). */
  observedBalance?: Money | undefined;
  createdAt: Date;
  processedAt?: Date | undefined;
}

/**
 * Canonical JSON (sorted keys) hash of the *business* fields only.
 * Algorithm: SHA-256 over `JSON.stringify` of the object with keys sorted
 * lexicographically at every level; transport metadata (headers, messageId,
 * occurredAt) and the idempotency key itself are excluded.
 */
export function computePayloadHash(fields: BusinessFields): string {
  const canonical = {
    externalTransactionId: fields.externalTransactionId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.toString(), currency: fields.money.currency },
    playerId: fields.playerId,
    providerId: fields.providerId,
    ...(fields.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: fields.referenceExternalTransactionId }
      : {}),
    roundId: fields.roundId,
    walletId: fields.walletId,
  };
  // keys above are already inserted in lexicographic order; sort defensively.
  const sorted = Object.fromEntries(Object.entries(canonical).sort(([a], [b]) => (a < b ? -1 : 1)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
    private _referenceDeadline?: Date,
    private _observedBalance?: Money,
  ) {}

  /** Born PENDING. Validates the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening && !props.internal) {
      throw new ValidationError('OPENING transactions are internal and cannot be submitted');
    }
    if (props.kind !== WagerTransactionKind.Opening && props.providerId === INTERNAL_PROVIDER_ID && !props.internal) {
      throw new ValidationError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    if (props.money.isNegative()) throw new ValidationError('amount must not be negative');
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new ValidationError('amount must be greater than zero');
    }
    const needsRef = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsRef && !props.referenceExternalTransactionId) {
      throw new ValidationError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (
      props.referenceExternalTransactionId &&
      (props.kind === WagerTransactionKind.Bet || props.kind === WagerTransactionKind.Opening)
    ) {
      throw new ValidationError(`${props.kind} must not carry a reference`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.now,
      WagerTransactionStatus.Pending,
    );
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.referenceAttempts,
      s.nextReferenceAttemptAt,
      s.referenceDeadline,
      s.observedBalance,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }
  get referenceDeadline(): Date | undefined {
    return this._referenceDeadline;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  /** Records the wallet balance seen at decision time so a replay can return the original result. */
  observeBalance(balance: Money): void {
    this._observedBalance = balance;
  }

  // ---- transitions (throw InvalidTransactionStateError if not allowed / terminal)

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  /**
   * Parks the transaction waiting for its reference. First call fixes the TTL
   * deadline; every call counts one attempt and schedules the next one.
   */
  markPendingReference(now: Date, policy: PendingReferencePolicy): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    if (!this._referenceDeadline) this._referenceDeadline = new Date(now.getTime() + policy.ttlMs);
    this._referenceAttempts += 1;
    const delay = Math.min(policy.baseDelayMs * 2 ** (this._referenceAttempts - 1), policy.maxDelayMs);
    this._nextReferenceAttemptAt = new Date(now.getTime() + delay);
  }

  /** True once the attempt limit or the TTL is exhausted. */
  isReferenceExhausted(now: Date, policy: PendingReferencePolicy): boolean {
    return (
      this._referenceAttempts >= policy.maxAttempts ||
      (this._referenceDeadline !== undefined && now >= this._referenceDeadline)
    );
  }

  reject(code: FailureCode, at: Date = new Date()): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date = new Date()): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return VALID_TRANSITIONS[this._status].length === 0;
  }

  /** false for LOSS (and anything that never moves money) */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direction of the ledger line this transaction produces.
   * ROLLBACK is the inverse of the reference's own direction.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvariantViolationError('ROLLBACK direction needs its reference');
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS has no ledger direction');
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!VALID_TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(`invalid transition ${this._status} -> ${next} (tx ${this.id})`);
    }
    this._status = next;
  }
}

export interface PendingReferencePolicy {
  maxAttempts: number;
  ttlMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
