/**
 * Load test: `bun run test:load`
 *
 * Env: TARGETS (comma separated base URLs, default http://localhost:3001,3002,3003)
 *      WALLETS (default 200)  CONCURRENCY (default 64)  DURATION_S (default 30)  HOT_RATIO (share of requests aimed at 5 hot wallets, default 0.2)
 *
 * Workload: BET 50% / WIN 25% / LOSS 15% / REFUND-of-a-recent-BET 10%, spread over N wallets, with a hot-wallet skew.
 * After the run EVERY wallet is reconciled through the API; the run fails if any wallet is inconsistent.
 */
const targets = (process.env.TARGETS ?? 'http://localhost:3001,http://localhost:3002,http://localhost:3003').split(',');
const WALLETS = Number(process.env.WALLETS ?? 200);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 64);
const DURATION_S = Number(process.env.DURATION_S ?? 30);
const HOT_RATIO = Number(process.env.HOT_RATIO ?? 0.2);
const runId = Date.now().toString(36);

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const t0 = performance.now();
  try {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ms: performance.now() - t0, json: json as any };
  } catch {
    return { status: 0, ms: performance.now() - t0, json: {} as any };
  }
};

const metric = async (base: string, name: string): Promise<number> => {
  const text = await (await fetch(`${base}/metrics`)).text();
  return text
    .split('\n')
    .filter((l) => l.startsWith(name) && !l.startsWith('#'))
    .reduce((sum, l) => sum + Number(l.split(' ').pop()), 0);
};

async function main() {
  console.log(`setup: ${WALLETS} wallets, ${targets.length} target(s), concurrency ${CONCURRENCY}, ${DURATION_S}s`);
  const wallets: { walletId: string; playerId: string }[] = [];
  for (let i = 0; i < WALLETS; i += 25) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(25, WALLETS - i) }, async (_, k) => {
        const playerId = `load-${runId}-${i + k}`;
        const r = await post(targets[0] as string, '/wallets', { playerId, initialBalance: { amount: '100000.00', currency: 'BRL' } });
        if (r.status !== 201) throw new Error(`wallet setup failed: ${r.status}`);
        return { walletId: r.json.id as string, playerId };
      }),
    );
    wallets.push(...batch);
  }

  const before = await Promise.all(targets.map(async (t) => ({ conflicts: await metric(t, 'wager_lock_conflicts_total'), dup: await metric(t, 'wager_duplicates_detected_total') })));

  const latencies: number[] = [];
  const statuses = new Map<number, number>();
  const bets: { w: (typeof wallets)[number]; ext: string }[] = [];
  let counter = 0;
  const deadline = Date.now() + DURATION_S * 1000;
  const started = performance.now();

  const worker = async (id: number) => {
    while (Date.now() < deadline) {
      const n = counter++;
      const hot = Math.random() < HOT_RATIO;
      let w = wallets[hot ? Math.floor(Math.random() * Math.min(5, wallets.length)) : Math.floor(Math.random() * wallets.length)] as (typeof wallets)[number];
      const roll = Math.random();
      let kind = roll < 0.5 ? 'BET' : roll < 0.75 ? 'WIN' : roll < 0.9 ? 'LOSS' : 'REFUND';
      let reference: string | undefined;
      if (kind === 'REFUND') {
        const b = bets.pop();
        if (b) {
          reference = b.ext;
          w = b.w; // a reversal must target the wallet of the transaction it reverts
        } else kind = 'BET';
      }
      const ext = `${runId}-${id}-${n}`;
      const target = targets[n % targets.length] as string;
      const r = await post(target, '/wagering/transactions', {
        providerId: 'load', externalTransactionId: ext, playerId: w.playerId, walletId: w.walletId, roundId: `round-${n}`, gameId: 'fortune-chimp', kind,
        money: { amount: kind === 'REFUND' ? '5.00' : '5.00', currency: 'BRL' },
        ...(reference ? { referenceExternalTransactionId: reference } : {}),
      }, { 'Idempotency-Key': `load:${ext}` });
      latencies.push(r.ms);
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      if (kind === 'BET' && r.status === 200 && bets.length < 5000) bets.push({ w, ext });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const elapsed = (performance.now() - started) / 1000;

  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
  const total = latencies.length;
  const errors = [...statuses.entries()].filter(([s]) => s === 0 || s >= 500).reduce((a, [, c]) => a + c, 0);

  // wait for the outbox to drain (lag) and reconcile every wallet
  const lagSamples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const lags = await Promise.all(targets.map((t) => metric(t, 'wager_outbox_lag_seconds')));
    lagSamples.push(Math.max(...lags));
    if (lagSamples.at(-1) === 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  let inconsistent = 0;
  for (let i = 0; i < wallets.length; i += 20) {
    const rs = await Promise.all(wallets.slice(i, i + 20).map((w) => post(targets[0] as string, `/wallets/${w.walletId}/reconciliation`, {})));
    inconsistent += rs.filter((r) => r.status !== 200 || r.json.consistent !== true).length;
  }
  const after = await Promise.all(targets.map(async (t) => ({ conflicts: await metric(t, 'wager_lock_conflicts_total'), dup: await metric(t, 'wager_duplicates_detected_total') })));
  const sum = (k: 'conflicts' | 'dup') => after.reduce((a, x, i) => a + x[k] - (before[i]?.[k] ?? 0), 0);

  const result = {
    runId,
    environment: { runtime: `bun ${Bun.version}`, cpus: navigator.hardwareConcurrency, targets: targets.length, note: 'client and servers share this machine unless TARGETS point elsewhere' },
    methodology: { wallets: WALLETS, concurrency: CONCURRENCY, durationS: DURATION_S, hotWalletRatio: HOT_RATIO, mix: 'BET 50 / WIN 25 / LOSS 15 / REFUND 10', closedLoop: true },
    results: {
      requests: total,
      throughputRps: Math.round(total / elapsed),
      latencyMs: { p50: +pct(50).toFixed(1), p95: +pct(95).toFixed(1), p99: +pct(99).toFixed(1), max: +latencies.at(-1)!.toFixed(1) },
      statusCodes: Object.fromEntries(statuses),
      errorRatePct: +((errors / total) * 100).toFixed(3),
      concurrencyConflicts: sum('conflicts'),
      duplicatesDetected: sum('dup'),
      outboxLagSecondsAfterRun: lagSamples[0],
      outboxDrainedAfterS: lagSamples.at(-1) === 0 ? +(lagSamples.length * 0.5).toFixed(1) : 'not drained within 10s',
      walletsInconsistent: inconsistent,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  await Bun.write(new URL(`./results/${runId}.json`, import.meta.url).pathname, JSON.stringify(result, null, 2));
  if (inconsistent > 0) {
    console.error(`FAIL: ${inconsistent} wallets inconsistent`);
    process.exit(1);
  }
}

await main();
