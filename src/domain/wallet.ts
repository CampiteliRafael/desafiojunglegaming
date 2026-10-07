import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';
import { newId } from '../shared/ids';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  now: Date;
}

/**
 * Aggregate root. Balance changes *only* through `debit`/`credit`, which return
 * the matching ledger entry — so balance and ledger can never drift apart.
 */
export class Wallet {
  /** Version read from the database; used as the optimistic-lock guard when persisting. */
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
    public readonly loadedVersion: number,
  ) {}

  /**
   * Opens a wallet. `version` starts at 1. If the initial balance is positive the
   * accompanying OPENING ledger entry (0 -> initial) is returned for atomic persistence.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    if (props.initialBalance.isNegative()) throw new InvariantViolationError('initial balance cannot be negative');
    const { currency } = props.initialBalance;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
      0, // not yet persisted
    );
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: newId(),
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: props.initialBalance,
          createdAt: props.now,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
      state.version,
    );
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  get hasUnpersistedChanges(): boolean {
    return this._version !== this.loadedVersion;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    this.assertPositive(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(`wallet ${this.id} has insufficient funds`);
    }
    return this.apply(LedgerDirection.Debit, money, this._balance.subtract(money), transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    this.assertPositive(money);
    return this.apply(LedgerDirection.Credit, money, this._balance.add(money), transactionId, at);
  }

  private apply(
    direction: LedgerDirection,
    money: Money,
    balanceAfter: Money,
    transactionId: string,
    at: Date,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: newId(),
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: at,
    });
    this._balance = balanceAfter;
    this._version += 1; // increments only when the balance actually changes
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet currency ${this.currency} != ${money.currency}`);
    }
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) throw new InvariantViolationError('movement amount must be positive');
  }
}
