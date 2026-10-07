import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeDb, db, migrateTestDb, sql, uniq } from '../support/harness';

/** Guarantees that must hold at the DATABASE level, whatever the application does. */
const NOW = '2026-08-01T00:00:00Z';
const uuid = () => Bun.randomUUIDv7();

async function insertWallet(balance = '0.00', player = uniq('p')) {
  const id = uuid();
  await sql(`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES (?, ?, 'BRL', ?, 1, ?, ?)`, [id, player, balance, NOW, NOW]);
  return { id, player };
}
async function insertTx(walletId: string, player: string, over: Record<string, unknown> = {}) {
  const id = uuid();
  const v = { kind: 'LOSS', amount: '1.00', status: 'PROCESSED', provider: 'prov', ext: uniq('e'), key: uniq('k'), ref: null, refTx: null, failure: null, ...over };
  await sql(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
       kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code, created_at, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'r', 'g', ?, ?, 'BRL', ?, ?, ?, ?, ?, ?)`,
    [id, v.provider, v.ext, v.key, 'a'.repeat(64), walletId, player, v.kind, v.amount, v.ref, v.refTx, v.status, v.failure, NOW, NOW],
  );
  return { id, ...v };
}
const fails = async (p: Promise<unknown>, pattern: RegExp) => {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(String((err as Error).message)).toMatch(pattern);
};

beforeAll(migrateTestDb);
afterAll(closeDb);

describe('wallets', () => {
  test('balance can never be negative', async () => {
    await fails(sql(`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES (?, 'x', 'BRL', -0.01, 1, now(), now())`, [uuid()]), /ck_wallets_balance_non_negative|check/i);
  });

  test('one wallet per (playerId, currency)', async () => {
    const { player } = await insertWallet();
    await fails(insertWallet('0.00', player), /uq_wallets_player_currency|unique/i);
  });

  test('a balance change without a ledger entry cannot commit', async () => {
    const { id } = await insertWallet();
    await fails(sql(`UPDATE wallets SET balance = 50.00, version = 2 WHERE id = ?`, [id]), /diverges from ledger/);
    const [w] = await sql(`SELECT balance::text AS b FROM wallets WHERE id = ?`, [id]);
    expect(w.b).toBe('0.00');
  });

  test('balance may only change together with version + 1 (lost-update guard)', async () => {
    const { id } = await insertWallet();
    await fails(sql(`UPDATE wallets SET balance = 5.00 WHERE id = ?`, [id]), /version must increment/);
    await fails(sql(`UPDATE wallets SET version = 9 WHERE id = ?`, [id]), /version must increment/);
  });

  test('wallets are never deleted; identity columns are immutable', async () => {
    const { id } = await insertWallet();
    await fails(sql(`DELETE FROM wallets WHERE id = ?`, [id]), /cannot be deleted/);
    await fails(sql(`UPDATE wallets SET player_id = 'other' WHERE id = ?`, [id]), /immutable/);
  });
});

describe('ledger', () => {
  /** wallet row + WIN transaction + ledger line (+ optional wallet balance update) inside ONE SQL transaction. */
  async function ledgerTx(walletId: string, player: string, line: { before: string; after: string; amount: string }, updateWallet: boolean) {
    const orm = await db();
    return orm.em.fork().transactional(async (em) => {
      const c = em.getConnection();
      const ctx = em.getTransactionContext();
      const tx = await insertTxVia(c, ctx, walletId, player, line.amount);
      await c.execute(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'CREDIT', ?, 'BRL', ?, ?, ?)`,
        [uuid(), walletId, tx, line.amount, line.before, line.after, NOW],
        'run',
        ctx,
      );
      if (updateWallet) await c.execute(`UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?`, [line.after, walletId], 'run', ctx);
      return tx;
    });
  }

  test('arithmetic of every line is enforced by the database', async () => {
    const { id, player } = await insertWallet();
    await fails(ledgerTx(id, player, { before: '0.00', after: '11.00', amount: '10.00' }, true), /ck_ledger_balanced/);
  });

  test('append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    const { id, player } = await insertWallet();
    await ledgerTx(id, player, { before: '0.00', after: '5.00', amount: '5.00' }, true);
    await fails(sql(`UPDATE wallet_ledger_entries SET amount = 99.00 WHERE wallet_id = ?`, [id]), /append-only/);
    await fails(sql(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [id]), /append-only/);
    await fails(sql(`TRUNCATE wallet_ledger_entries`), /append-only/);
  });

  test('a ledger line without the matching wallet balance change cannot commit', async () => {
    const { id, player } = await insertWallet();
    await fails(ledgerTx(id, player, { before: '0.00', after: '5.00', amount: '5.00' }, false), /diverges from ledger/);
    expect((await sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?`, [id]))[0].n).toBe(0);
  });

  test('at most one ledger line per wallet per transaction', async () => {
    const { id, player } = await insertWallet();
    const orm = await db();
    await fails(
      orm.em.fork().transactional(async (em) => {
        const c = em.getConnection();
        const ctx = em.getTransactionContext();
        const tx = await insertTxVia(c, ctx, id, player, '5.00');
        for (const [b, a] of [['0.00', '5.00'], ['5.00', '10.00']] as const) {
          await c.execute(
            `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at) VALUES (?, ?, ?, 'CREDIT', 5.00, 'BRL', ?, ?, ?)`,
            [uuid(), id, tx, b, a, NOW],
            'run',
            ctx,
          );
        }
      }),
      /uq_ledger_wallet_transaction/,
    );
  });

  test('a PROCESSED balance-affecting transaction must have its ledger line', async () => {
    const { id, player } = await insertWallet();
    await fails(insertTx(id, player, { kind: 'BET', amount: '1.00' }), /ledger entry are inconsistent/);
  });
});

async function insertTxVia(c: any, ctx: unknown, walletId: string, player: string, amount = '5.00'): Promise<string> {
  const id = uuid();
  await c.execute(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at)
     VALUES (?, 'prov', ?, ?, ?, ?, ?, 'r', 'g', 'WIN', ?, 'BRL', 'PROCESSED', ?, ?)`,
    [id, uniq('e'), uniq('k'), 'a'.repeat(64), walletId, player, amount, NOW, NOW],
    'run',
    ctx,
  );
  return id;
}

describe('wager_transactions', () => {
  test('idempotency key and (provider, externalId) are unique', async () => {
    const { id, player } = await insertWallet();
    const dupKey = uniq('dup-key');
    const a = await insertTx(id, player, { key: dupKey, ext: uniq('e') });
    await fails(insertTx(id, player, { key: dupKey, ext: uniq('e') }), /uq_wager_tx_idempotency_key/);
    await fails(insertTx(id, player, { key: uniq('k'), ext: a.ext }), /uq_wager_tx_provider_external/);
  });

  test('REFUND/ROLLBACK need a reference; OPENING is internal only; failure code iff REJECTED/FAILED', async () => {
    const { id, player } = await insertWallet();
    await fails(insertTx(id, player, { kind: 'REFUND', status: 'PENDING_REFERENCE', ref: null }), /ck_wager_tx_reference_required/);
    await fails(insertTx(id, player, { kind: 'OPENING', provider: 'prov' }), /ck_wager_tx_opening_internal/);
    await fails(insertTx(id, player, { status: 'REJECTED', failure: null }), /ck_wager_tx_failure_code/);
    await fails(insertTx(id, player, { status: 'PROCESSED', failure: 'X' }), /ck_wager_tx_failure_code|ck_wager_tx_processed/);
  });

  test('terminal states are final and business fields immutable; rows are never deleted', async () => {
    const { id, player } = await insertWallet();
    const t = await insertTx(id, player, { status: 'REJECTED', failure: 'INSUFFICIENT_FUNDS', kind: 'BET' });
    await fails(sql(`UPDATE wager_transactions SET status = 'PROCESSED', failure_code = NULL, processed_at = now() WHERE id = ?`, [t.id]), /terminal state/);
    await fails(sql(`DELETE FROM wager_transactions WHERE id = ?`, [t.id]), /cannot be deleted/);
    const p = await insertTx(id, player, { status: 'PENDING_REFERENCE', kind: 'WIN' });
    await fails(sql(`UPDATE wager_transactions SET amount = 9.00 WHERE id = ?`, [p.id]), /immutable/);
  });

  test('a reference can be reverted by only ONE processed REFUND/ROLLBACK (no double debit/credit)', async () => {
    const { id, player } = await insertWallet();
    const orm = await db();
    await fails(
      orm.em.fork().transactional(async (em) => {
        const c = em.getConnection();
        const ctx = em.getTransactionContext();
        const line = async (txId: string, dir: 'CREDIT' | 'DEBIT', before: string, after: string) =>
          c.execute(
            `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at) VALUES (?, ?, ?, ?, 10.00, 'BRL', ?, ?, ?)`,
            [uuid(), id, txId, dir, before, after, NOW],
            'run',
            ctx,
          );
        const mk = async (kind: string, ref: string | null, refTx: string | null) => {
          const txId = uuid();
          await c.execute(
            `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency,
               reference_external_transaction_id, reference_transaction_id, status, created_at, processed_at)
             VALUES (?, 'prov', ?, ?, ?, ?, ?, 'r', 'g', ?, 10.00, 'BRL', ?, ?, 'PROCESSED', ?, ?)`,
            [txId, uniq('e'), uniq('k'), 'a'.repeat(64), id, player, kind, ref, refTx, NOW, NOW],
            'run',
            ctx,
          );
          return txId;
        };
        const winA = await mk('WIN', null, null);
        await line(winA, 'CREDIT', '0.00', '10.00');
        const winB = await mk('WIN', null, null);
        await line(winB, 'CREDIT', '10.00', '20.00');
        const rb1 = await mk('ROLLBACK', 'x', winA);
        await line(rb1, 'DEBIT', '20.00', '10.00');
        const rb2 = await mk('ROLLBACK', 'x', winA); // second reversal of the same reference
        await line(rb2, 'DEBIT', '10.00', '0.00');
      }),
      /uq_wager_tx_single_reversal/,
    );
  });
});

describe('outbox / inbox', () => {
  test('inbox is unique per (consumer, messageId); outbox content is immutable', async () => {
    const msg = uniq('m');
    await sql(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('c', ?, ?, now())`, [msg, 'a'.repeat(64)]);
    await fails(sql(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES ('c', ?, ?, now())`, [msg, 'a'.repeat(64)]), /duplicate key|unique/i);
    const id = uuid();
    await sql(`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at) VALUES (?, 'w', 'T', '{"a":1}'::jsonb, now())`, [id]);
    await fails(sql(`UPDATE outbox_messages SET payload = '{"a":2}'::jsonb WHERE id = ?`, [id]), /immutable/);
    await sql(`UPDATE outbox_messages SET attempts = 1 WHERE id = ?`, [id]); // delivery bookkeeping is allowed
  });
});
