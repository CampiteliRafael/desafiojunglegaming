import { UnitOfWork } from './ports/ports';
import { EventContextFactory } from './event-factory';
import { IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wager-events';
import { FailureCode } from '../domain/failure-code';
import { OutboxMessage } from '../domain/messaging';
import { settle } from '../domain/settlement';
import { Wallet } from '../domain/wallet';
import { PendingReferencePolicy, WagerTransaction } from '../domain/wager-transaction';

/**
 * Runs the domain decision for `tx` against the (already locked) `wallet` and persists
 * transaction + wallet + ledger + outbox events through the given unit of work.
 * Caller owns the SQL transaction, so everything below commits (or rolls back) atomically.
 */
export async function settleAndPersist(
  uow: UnitOfWork,
  p: {
    tx: WagerTransaction;
    wallet: Wallet;
    isNew: boolean;
    now: Date;
    policy: PendingReferencePolicy;
    events: EventContextFactory;
  },
): Promise<void> {
  const { tx, wallet, now } = p;

  const reference = tx.referenceExternalTransactionId
    ? ((await uow.transactions.findByProviderAndExternalId(tx.providerId, tx.referenceExternalTransactionId)) ?? undefined)
    : undefined;
  const referenceAlreadyReversed =
    reference !== undefined && tx.requiresReference() ? await uow.transactions.isReverted(reference.id) : false;

  const outcome = settle({ tx, wallet, reference, referenceAlreadyReversed, now });

  const events: IntegrationEvent<unknown>[] = [];
  const ledgerEntry = outcome.type === 'processed' ? outcome.entry : undefined;

  if (outcome.type === 'pending_reference') {
    if (!p.isNew && tx.isReferenceExhausted(now, p.policy)) {
      tx.reject(FailureCode.ReferenceNotFound, now);
      events.push(WagerTransactionRejected.from(tx, p.events()));
    } else {
      tx.markPendingReference(now, p.policy);
      if (p.isNew) events.push(WagerTransactionPendingReference.from(tx, p.events()));
    }
  } else if (outcome.type === 'rejected') {
    events.push(WagerTransactionRejected.from(tx, p.events()));
  } else {
    events.push(WagerTransactionProcessed.from(tx, p.events()));
    if (ledgerEntry) events.push(WalletBalanceChanged.from(wallet, ledgerEntry, p.events()));
  }

  tx.observeBalance(wallet.balance);

  // order matters for foreign keys: transaction first, then wallet, then ledger line
  if (p.isNew) await uow.transactions.insert(tx);
  else await uow.transactions.update(tx);

  if (ledgerEntry) {
    await uow.wallets.saveBalance(wallet);
    await uow.ledger.insert(ledgerEntry);
  }

  if (events.length > 0) await uow.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));
}
