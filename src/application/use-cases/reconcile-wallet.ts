import { Inject, Injectable } from '@nestjs/common';
import { LoggerPort, MetricsPort, TOKENS, TransactionRunner } from '../ports/ports';
import { WalletNotFoundError } from '../../domain/errors';
import { Money, MoneyProps } from '../../domain/money';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialised balance with the one rebuilt from the ledger, on ONE consistent
 * snapshot (REPEATABLE READ). Divergences are never "fixed": they are logged, counted and reported.
 */
@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(TOKENS.TransactionRunner) private readonly runner: TransactionRunner,
    @Inject(TOKENS.Metrics) private readonly metrics: MetricsPort,
    @Inject(TOKENS.Logger) private readonly logger: LoggerPort,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationResult> {
    const result = await this.runner.runSnapshot(async (uow) => {
      const wallet = await uow.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(`wallet ${walletId} not found`);
      const agg = await uow.ledger.aggregate(walletId);
      const calculated = Money.fromMinorUnits(BigInt(agg.calculatedMinor), wallet.currency);
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: agg.count,
      } satisfies ReconciliationResult;
    });

    if (!result.consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('wallet reconciliation divergence', {
        walletId,
        correlationId,
        checkedEntries: result.checkedEntries,
        difference: result.difference.amount,
      });
    }
    return result;
  }
}
