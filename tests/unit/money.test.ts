import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const m = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

describe('Money', () => {
  test('parses and serialises with fixed scale 2', () => {
    expect(m('25.00').toString()).toBe('25.00');
    expect(m('0.05').toJSON()).toEqual({ amount: '0.05', currency: 'BRL' });
  });

  test('arithmetic is exact (no float drift)', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(m('0.10'));
    expect(total.toString()).toBe('100.00'); // 0.1 * 1000 in floats would be 100.00000000000007
    expect(m('0.30').subtract(m('0.10')).toString()).toBe('0.20');
  });

  test('is immutable: operations return new instances', () => {
    const a = m('10.00');
    const b = a.add(m('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('15.00');
    expect(a.negate().toString()).toBe('-10.00');
    expect(a.negate().isNegative()).toBe(true);
  });

  test('comparisons', () => {
    expect(m('1.00').isLessThan(m('2.00'))).toBe(true);
    expect(m('2.00').isLessThan(m('2.00'))).toBe(false);
    expect(m('2.00').equals(m('2.00'))).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(m('0.01').isPositive()).toBe(true);
  });

  test('handles amounts beyond 2^53 exactly', () => {
    expect(m('9007199254740993.01').add(m('0.01')).toString()).toBe('9007199254740993.02');
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['1e3'],
    [''],
    ['25'],
    ['25.0'],
    ['25.001'],
    ['-1.00'],
    ['+1.00'],
    [' 1.00'],
    ['1,00'],
    ['01.00'],
    ['.50'],
    ['0x10'],
  ])('rejects invalid amount %p', (amount) => {
    expect(() => m(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects non-string amounts and invalid currency', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => m('1.00', 'brl')).toThrow(InvalidMoneyError);
    expect(() => m('1.00', 'BRLL')).toThrow(InvalidMoneyError);
  });

  test('currency conflicts raise a domain error', () => {
    expect(() => m('1.00', 'BRL').add(m('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => m('1.00', 'BRL').subtract(m('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => m('1.00', 'BRL').isLessThan(m('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(m('1.00', 'BRL').equals(m('1.00', 'USD'))).toBe(false);
  });
});
