import { Inject, Injectable } from '@nestjs/common';
import { eventContextFactory } from '../event-factory';
import { Clock, TOKENS, TransactionRunner } from '../ports/ports';
import { DuplicateWalletError, ValidationError } from '../../domain/errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events/wager-events';
import { OutboxMessage } from '../../domain/messaging';
import { Money, MoneyProps } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import {
  computePayloadHash,
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wager-transaction';
import { isUniqueViolation } from '../../shared/error-classification';
import { newId } from '../../shared/ids';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(TOKENS.TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(TOKENS.Clock) private readonly clock: Clock,
  ) {}

  async execute(cmd: CreateWalletCommand): Promise<WalletView> {
    let initialBalance: Money;
    try {
      initialBalance = Money.from(cmd.initialBalance);
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : 'invalid initialBalance');
    }
    try {
      return await this.runner.run(async (uow) => {
        const now = this.clock.now();
        if (await uow.wallets.findByPlayerAndCurrency(cmd.playerId, initialBalance.currency)) {
          throw new DuplicateWalletError(`player ${cmd.playerId} already has a ${initialBalance.currency} wallet`);
        }

        const walletId = newId();
        const openingTransactionId = newId();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: cmd.playerId,
          initialBalance,
          openingTransactionId,
          now,
        });

        // wallet -> OPENING transaction -> ledger CREDIT -> events: all in ONE SQL transaction
        await uow.wallets.insert(wallet);

        if (openingEntry) {
          const fields = {
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId: walletId,
            playerId: cmd.playerId,
            walletId,
            roundId: 'opening',
            gameId: 'opening',
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
          };
          const opening = WagerTransaction.create({
            id: openingTransactionId,
            idempotencyKey: `opening:${walletId}`,
            payloadHash: computePayloadHash(fields),
            now,
            internal: true,
            ...fields,
          });
          opening.markProcessed(undefined, now);
          opening.observeBalance(wallet.balance);
          await uow.transactions.insert(opening);
          await uow.ledger.insert(openingEntry);

          const ctx = eventContextFactory({ correlationId: cmd.correlationId, causationId: `wallet-open:${walletId}`, now });
          await uow.outbox.enqueue([
            OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx())),
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx())),
          ]);
        }

        return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'uq_wallets_player_currency')) {
        throw new DuplicateWalletError(`player ${cmd.playerId} already has a ${initialBalance.currency} wallet`);
      }
      throw err;
    }
  }
}
