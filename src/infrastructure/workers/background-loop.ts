/**
 * Minimal supervised polling loop: runs `tick` repeatedly, never dies on errors,
 * and `stop()` waits for the in-flight tick (graceful shutdown).
 */
export class BackgroundLoop {
  private running = false;
  private current: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean | void>,
    private readonly onError: (name: string, err: unknown) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.run();
  }

  async stop(graceMs = 25_000): Promise<void> {
    this.running = false;
    this.wake?.();
    const grace = new Promise<void>((r) => setTimeout(r, graceMs).unref());
    await Promise.race([this.current ?? Promise.resolve(), grace]);
  }

  private async run(): Promise<void> {
    while (this.running) {
      let didWork = false;
      try {
        didWork = (await this.tick()) === true;
      } catch (err) {
        this.onError(this.name, err);
      }
      // drained a full batch? go again immediately; otherwise sleep (interruptible by stop())
      if (this.running && !didWork) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
    }
  }
}
