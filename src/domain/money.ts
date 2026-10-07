import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  /** Decimal string with exactly 2 fraction digits, e.g. "25.00". */
  amount: string;
  /** ISO-4217 code, e.g. "BRL". */
  currency: string;
}

const SCALE = 2;
const INPUT_PATTERN = /^(0|[1-9]\d{0,15})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value.
 *
 * Internally stored as a `bigint` count of minor units (scale 2), so every
 * operation is exact integer arithmetic — no float/double/number ever touches
 * money. The domain does not depend on ORM or framework types.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Parses an *input contract* value. Strict on purpose: exactly two decimals,
   * no sign, no exponent, no whitespace, no NaN/Infinity.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') throw new InvalidMoneyError('money must be an object');
    const { amount, currency } = props;
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid currency: ${String(currency)}`);
    }
    if (typeof amount !== 'string' || !INPUT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `invalid amount "${String(amount)}": expected non-negative decimal string with exactly ${SCALE} fraction digits`,
      );
    }
    return new Money(Money.parseMinor(amount), currency);
  }

  /** Rebuilds a value from a persisted decimal string (may be negative-safe, but DB forbids it). */
  static fromPersisted(amount: string, currency: string): Money {
    if (!/^-?\d+\.\d{2}$/.test(amount)) throw new InvalidMoneyError(`corrupted persisted amount: ${amount}`);
    const negative = amount.startsWith('-');
    const minor = Money.parseMinor(negative ? amount.slice(1) : amount);
    return new Money(negative ? -minor : minor, currency);
  }

  /** Builds a value from an integer count of minor units (cents). Used for ledger aggregation. */
  static fromMinorUnits(minor: bigint, currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) throw new InvalidMoneyError(`invalid currency: ${currency}`);
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) throw new InvalidMoneyError(`invalid currency: ${currency}`);
    return new Money(0n, currency);
  }

  private static parseMinor(decimal: string): bigint {
    const [whole, fraction] = decimal.split('.') as [string, string];
    return BigInt(whole) * 100n + BigInt(fraction);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }
  isPositive(): boolean {
    return this.minor > 0n;
  }
  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Decimal string with fixed scale 2, e.g. "-3.05", "25.00". */
  toString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const whole = abs / 100n;
    const fraction = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
