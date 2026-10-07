import { TEST_ENV } from './env';
import { sleep } from './harness';

export interface Instance {
  id: string;
  baseUrl: string;
  proc: ReturnType<typeof Bun.spawn>;
  logs: () => string;
  /** SIGKILL: simulates a crash (no graceful shutdown, no cleanup). */
  kill(): Promise<void>;
  /** SIGTERM: graceful shutdown; resolves with the exit code. */
  terminate(): Promise<number | null>;
}

let nextPort = 4100 + Math.floor(Math.random() * 500);

/** Spawns a REAL separate OS process of the service (own pool, own memory): the multi-instance guarantee. */
export async function spawnInstance(extraEnv: Record<string, string> = {}): Promise<Instance> {
  const port = nextPort++;
  const id = `inst-${port}`;
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, ...TEST_ENV, LOG_LEVEL: 'warn', PORT: String(port), INSTANCE_ID: id, ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let buffer = '';
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) buffer += decoder.decode(chunk);
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`instance ${id} did not start:\n${buffer}`);
    if (proc.exitCode !== null) throw new Error(`instance ${id} exited early (${proc.exitCode}):\n${buffer}`);
    await sleep(100);
  }
  return {
    id,
    baseUrl,
    proc,
    logs: () => buffer,
    async kill() {
      proc.kill('SIGKILL');
      await proc.exited;
    },
    async terminate() {
      proc.kill('SIGTERM');
      const timeout = sleep(30_000).then(() => 'timeout' as const);
      const r = await Promise.race([proc.exited, timeout]);
      if (r === 'timeout') {
        proc.kill('SIGKILL');
        return null;
      }
      return r;
    },
  };
}
