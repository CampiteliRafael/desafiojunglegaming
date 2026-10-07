import { Inject, Injectable } from '@nestjs/common';
import { Clock, TOKENS, TransactionRunner } from '../ports/ports';
import { TransactionNotFoundError, ValidationError, WalletNotFoundError } from '../../domain/errors';
import { LedgerDirection } from '../../domain/ledger-entry';
import { MoneyProps } from '../../domain/money';
import { WagerTransaction } from '../../domain/wager-transaction';

export interface WalletDetails {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export const toTransactionView = (t: WagerTransaction): TransactionView => ({
  transactionId: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  status: t.status,
  failureCode: t.failureCode ?? null,
  referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
  referenceTransactionId: t.referenceTransactionId ?? null,
  balance: t.observedBalance ? t.observedBalance.toJSON() : null,
  createdAt: t.createdAt.toISOString(),
  processedAt: t.processedAt ? t.processedAt.toISOString() : null,
});

/** Opaque cursor: base64url of a versioned JSON holding the last seen ledger sequence. */
export const encodeCursor = (seq: string): string => Buffer.from(JSON.stringify({ v: 1, s: seq })).toString('base64url');
export function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: number; s?: string };
    if (parsed.v === 1 && typeof parsed.s === 'string' && /^\d{1,19}$/.test(parsed.s)) return parsed.s;
  } catch {
    /* fall through */
  }
  throw new ValidationError('invalid cursor');
}

@Injectable()
export class WalletQueries {
  constructor(
    @Inject(TOKENS.TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(TOKENS.Clock) private readonly clock: Clock,
  ) {}

  async getWallet(walletId: string): Promise<WalletDetails> {
    return this.runner.runSnapshot(async (uow) => {
      const w = await uow.wallets.findById(walletId);
      if (!w) throw new WalletNotFoundError(`wallet ${walletId} not found`);
      return {
        id: w.id,
        playerId: w.playerId,
        balance: w.balance.toJSON(),
        version: w.version,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
      };
    });
  }

  async listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const afterSeq = cursor ? decodeCursor(cursor) : null;
    return this.runner.runSnapshot(async (uow) => {
      if (!(await uow.wallets.findById(walletId))) throw new WalletNotFoundError(`wallet ${walletId} not found`);
      const { entries, hasMore } = await uow.ledger.list(walletId, afterSeq, limit);
      const last = entries[entries.length - 1];
      return {
        entries: entries.map(({ entry: e }) => ({
          id: e.id,
          transactionId: e.transactionId,
          direction: e.direction,
          money: e.money.toJSON(),
          balanceBefore: e.balanceBefore.toJSON(),
          balanceAfter: e.balanceAfter.toJSON(),
          createdAt: e.createdAt.toISOString(),
        })),
        nextCursor: hasMore && last ? encodeCursor(last.seq) : null,
      };
    });
  }
}

@Injectable()
export class TransactionQueries {
  constructor(@Inject(TOKENS.TransactionRunner) private readonly runner: TransactionRunner) {}

  async getById(transactionId: string): Promise<TransactionView> {
    return this.runner.runSnapshot(async (uow) => {
      const t = await uow.transactions.findById(transactionId);
      if (!t) throw new TransactionNotFoundError(`transaction ${transactionId} not found`);
      return toTransactionView(t);
    });
  }

  async getByProviderExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.runner.runSnapshot(async (uow) => {
      const t = await uow.transactions.findByProviderAndExternalId(providerId, externalTransactionId);
      if (!t) throw new TransactionNotFoundError(`transaction ${providerId}/${externalTransactionId} not found`);
      return toTransactionView(t);
    });
  }
}
