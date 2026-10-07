import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletConsistent, closeDb, createWallet, http, migrateTestDb, money, sleep, sql, startApp, submit, TestApp, uniq } from '../support/harness';
import { Instance, spawnInstance } from '../support/instances';

/**
 * Real parallelism against a real PostgreSQL:
 *  - in-process HTTP (one instance, many concurrent requests)
 *  - 3+ separate OS processes (multi-instance)
 * Every test ends with:  wallet.balance == balance rebuilt from the ledger.
 */
let single: TestApp;
let instances: Instance[] = [];
const urls = () => instances.map((i) => i.baseUrl);
const rr = <T>(arr: T[], i: number): T => arr[i % arr.length] as T;

beforeAll(async () => {
  await migrateTestDb();
  single = await startApp();
  instances = await Promise.all([spawnInstance(), spawnInstance(), spawnInstance()]);
});
afterAll(async () => {
  await single.close();
  await Promise.all(instances.map((i) => (i.proc.exitCode === null ? i.kill() : undefined)));
  await closeDb();
});

const ledgerLines = async (walletId: string, direction: string) =>
  (await sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = ?`, [walletId, direction]))[0].n as number;

describe('idempotency under concurrency', () => {
  test('the SAME bet sent 50 times in parallel debits exactly once', async () => {
    const { walletId, playerId } = await createWallet(single.baseUrl, '100.00');
    const spec = { walletId, playerId, kind: 'BET', amount: '10.00', providerId: uniq('prov'), externalTransactionId: 'same-bet' };
    const rs = await Promise.all(Array.from({ length: 50 }, () => submit(single.baseUrl, spec)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body.transactionId)).size).toBe(1);
    expect(rs.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(rs.every((r) => r.body.balance.amount === '90.00')).toBe(true); // everyone sees the ORIGINAL result
    expect(await ledgerLines(walletId, 'DEBIT')).toBe(1);
    expect((await assertWalletConsistent(walletId)).balance).toBe('90.00');
  });

  test('the same key hammered through 3 different processes yields one transaction', async () => {
    const { walletId, playerId } = await createWallet(urls()[0] as string, '100.00');
    const spec = { walletId, playerId, kind: 'BET', amount: '7.00', providerId: uniq('prov'), externalTransactionId: 'x-proc' };
    const rs = await Promise.all(Array.from({ length: 90 }, (_, i) => submit(rr(urls(), i), spec)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await ledgerLines(walletId, 'DEBIT')).toBe(1);
    expect((await assertWalletConsistent(walletId)).balance).toBe('93.00');
  });

  test('same key + different payload racing: exactly one wins, the others get 409 (never two debits)', async () => {
    const { walletId, playerId } = await createWallet(single.baseUrl, '1000.00');
    const providerId = uniq('prov');
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        submit(rr(urls(), i), { walletId, playerId, providerId, kind: 'BET', amount: `${i + 1}.00`, externalTransactionId: 'conflicted', idempotencyKey: `${providerId}:conflicted` }),
      ),
    );
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(19);
    expect(await ledgerLines(walletId, 'DEBIT')).toBe(1);
    await assertWalletConsistent(walletId);
  });
});

describe('contention on one wallet', () => {
  test('MANDATORY: 100.00 balance, two simultaneous 80.00 bets => one PROCESSED, one REJECTED, balance 20.00, one debit (x25 rounds, 3 processes)', async () => {
    for (let round = 0; round < 25; round++) {
      const { walletId, playerId } = await createWallet(urls()[0] as string, '100.00');
      const [a, b] = await Promise.all([
        submit(rr(urls(), round), { walletId, playerId, kind: 'BET', amount: '80.00' }),
        submit(rr(urls(), round + 1), { walletId, playerId, kind: 'BET', amount: '80.00' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 422]);
      const rejected = a.status === 422 ? a : b;
      expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await ledgerLines(walletId, 'DEBIT')).toBe(1);
      expect((await assertWalletConsistent(walletId)).balance).toBe('20.00');
      // a late retry of the rejected bet must not turn into a debit
      await submit(rr(urls(), round + 2), { walletId, playerId, kind: 'BET', amount: '80.00', externalTransactionId: uniq('retry') });
      expect(await ledgerLines(walletId, 'DEBIT')).toBe(1);
    }
  });

  test('hot wallet: 200 distinct 10.00 bets over 3 processes on a 500.00 wallet => exactly 50 processed, balance 0.00, never negative', async () => {
    const { walletId, playerId } = await createWallet(urls()[0] as string, '500.00');
    const providerId = uniq('prov');
    const rs = await Promise.all(
      Array.from({ length: 200 }, (_, i) => submit(rr(urls(), i), { walletId, playerId, providerId, kind: 'BET', amount: '10.00', externalTransactionId: `bet-${i}` })),
    );
    const processed = rs.filter((r) => r.status === 200).length;
    const rejected = rs.filter((r) => r.status === 422).length;
    expect(processed).toBe(50);
    expect(rejected).toBe(150);
    expect(rs.filter((r) => r.status !== 200 && r.status !== 422)).toEqual([]); // no 5xx under contention
    expect(await ledgerLines(walletId, 'DEBIT')).toBe(50);
    expect((await assertWalletConsistent(walletId)).balance).toBe('0.00');
  });

  test('mixed hot-wallet traffic (BET/WIN/LOSS) from 3 processes keeps balance == ledger', async () => {
    const { walletId, playerId } = await createWallet(urls()[0] as string, '100.00');
    const providerId = uniq('prov');
    const kinds = ['BET', 'WIN', 'LOSS', 'BET'];
    const rs = await Promise.all(
      Array.from({ length: 240 }, (_, i) => submit(rr(urls(), i), { walletId, playerId, providerId, kind: kinds[i % 4] as string, amount: '3.00', externalTransactionId: `m-${i}` })),
    );
    expect(rs.filter((r) => r.status >= 500)).toEqual([]);
    await assertWalletConsistent(walletId);
    const recon = await http(urls()[1] as string, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(recon.body.consistent).toBe(true);
  });

  test('REFUND and ROLLBACK of the same BET racing across processes credit exactly once', async () => {
    for (let round = 0; round < 10; round++) {
      const { walletId, playerId } = await createWallet(urls()[0] as string, '100.00');
      const providerId = uniq('prov');
      await submit(urls()[0] as string, { walletId, playerId, providerId, kind: 'BET', amount: '25.00', externalTransactionId: 'bet' });
      const rs = await Promise.all([
        submit(rr(urls(), round), { walletId, playerId, providerId, kind: 'REFUND', amount: '25.00', externalTransactionId: 'rf', referenceExternalTransactionId: 'bet' }),
        submit(rr(urls(), round + 1), { walletId, playerId, providerId, kind: 'ROLLBACK', amount: '25.00', externalTransactionId: 'rb', referenceExternalTransactionId: 'bet' }),
        submit(rr(urls(), round + 2), { walletId, playerId, providerId, kind: 'REFUND', amount: '25.00', externalTransactionId: 'rf2', referenceExternalTransactionId: 'bet' }),
      ]);
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 422 && r.body.failureCode === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(2);
      expect((await assertWalletConsistent(walletId)).balance).toBe('100.00');
    }
  });
});

describe('parallelism across wallets', () => {
  test('60 different wallets, 4 operations each, all in parallel over 3 processes: no interference, all consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 60 }, () => createWallet(urls()[0] as string, '100.00')));
    const rs = await Promise.all(
      wallets.flatMap((w, wi) =>
        ['BET', 'WIN', 'BET', 'LOSS'].map((kind, k) => submit(rr(urls(), wi + k), { ...w, kind, amount: '5.00', providerId: uniq('prov'), externalTransactionId: `e${k}` })),
      ),
    );
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const checks = await Promise.all(wallets.map((w) => assertWalletConsistent(w.walletId)));
    for (const c of checks) {
      expect(c.balance).toBe('95.00'); // 100 - 5 + 5 - 5
      expect(c.entries).toBe(4); // opening + 3 balance-affecting
    }
  });

  test('a lock held on a hot wallet does not block other wallets (no global lock)', async () => {
    const hot = await createWallet(single.baseUrl, '100.00');
    const cold = await createWallet(single.baseUrl, '100.00');
    const { db } = await import('../support/harness');
    const orm = await db();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const locker = orm.em.fork().transactional(async (em) => {
      await em.getConnection().execute(`SELECT id FROM wallets WHERE id = ? FOR UPDATE`, [hot.walletId], 'all', em.getTransactionContext());
      await held;
    });
    await sleep(100);
    const started = performance.now();
    const r = await submit(single.baseUrl, { ...cold, kind: 'BET', amount: '1.00' });
    const elapsed = performance.now() - started;
    expect(r.status).toBe(200);
    expect(elapsed).toBeLessThan(2000); // would be >= lock timeout (5 s) if wallets shared a lock
    // while the hot wallet is blocked, a request for it waits and then succeeds after release
    const blocked = submit(single.baseUrl, { ...hot, kind: 'BET', amount: '1.00' });
    await sleep(300);
    release();
    await locker;
    expect((await blocked).status).toBe(200);
    await assertWalletConsistent(hot.walletId);
  });
});

describe('crash and restart', () => {
  test('SIGKILL in the middle of a burst, restart, replay everything: no duplicate, no loss, consistent', async () => {
    const victim = await spawnInstance();
    const survivor = urls()[0] as string;
    const { walletId, playerId } = await createWallet(survivor, '1000.00');
    const providerId = uniq('prov');
    const specs = Array.from({ length: 120 }, (_, i) => ({ walletId, playerId, providerId, kind: 'BET', amount: '5.00', externalTransactionId: `crash-${i}` }));

    // fire a burst at the victim and kill it while requests are in flight
    const inflight = specs.map((s) => submit(victim.baseUrl, s).catch(() => ({ status: 0, body: null })));
    await sleep(60);
    await victim.kill();
    const first = await Promise.all(inflight);
    expect(first.some((r) => r.status === 0)).toBe(true); // some requests really were cut off

    // a clean replacement process (and the survivors) replay the SAME requests with the SAME keys
    const replacement = await spawnInstance();
    try {
      const replay = await Promise.all(specs.map((s, i) => submit(rr([replacement.baseUrl, survivor], i), s)));
      expect(replay.every((r) => r.status === 200)).toBe(true);
      expect(new Set(replay.map((r) => r.body.transactionId)).size).toBe(120); // one transaction per bet
      const info = await assertWalletConsistent(walletId);
      expect(info.balance).toBe('400.00'); // 1000 - 120 * 5, each debited exactly once
      expect(await ledgerLines(walletId, 'DEBIT')).toBe(120);
      const outboxRows = (await sql(`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ?`, [walletId]))[0].n;
      expect(outboxRows).toBe(2 + 120 * 2); // events of committed transactions only: nothing lost, nothing orphaned
    } finally {
      await replacement.kill();
    }
  });

  test('SIGTERM drains in-flight requests and exits 0', async () => {
    const inst = await spawnInstance();
    const { walletId, playerId } = await createWallet(inst.baseUrl, '1000.00');
    const providerId = uniq('prov');
    const inflight = Array.from({ length: 40 }, (_, i) =>
      submit(inst.baseUrl, { walletId, playerId, providerId, kind: 'BET', amount: '1.00', externalTransactionId: `term-${i}` }).catch(() => ({ status: 0, body: null })),
    );
    await sleep(30);
    const code = await inst.terminate();
    const results = await Promise.all(inflight);
    expect(code).toBe(0);
    for (const r of results) expect([0, 200]).toContain(r.status); // accepted requests completed; the rest were refused, never half-applied
    await assertWalletConsistent(walletId);
  });
});

void money;
