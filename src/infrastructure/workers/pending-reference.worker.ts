import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { LoggerPort, TOKENS } from '../../application/ports/ports';
import { ReprocessPendingReferencesUseCase } from '../../application/use-cases/reprocess-pending-references';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { BackgroundLoop } from './background-loop';

/** Scheduled worker that re-evaluates PENDING_REFERENCE transactions (exponential backoff lives in the aggregate). */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly loop: BackgroundLoop;

  constructor(
    @Inject(ReprocessPendingReferencesUseCase) private readonly reprocess: ReprocessPendingReferencesUseCase,
    @Inject(TOKENS.Logger) private readonly logger: LoggerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.loop = new BackgroundLoop(
      'pending-reference-worker',
      config.PENDING_REF_POLL_INTERVAL_MS,
      async () => {
        const r = await this.reprocess.runBatch(config.PENDING_REF_BATCH_SIZE);
        return r.processed + r.rejected + r.still_pending + r.failed + r.skipped >= config.PENDING_REF_BATCH_SIZE;
      },
      (name, err) => this.logger.warn(`${name} tick failed`, { error: err instanceof Error ? err.message : String(err) }),
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.ENABLE_PENDING_REFERENCE_WORKER) this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop(this.config.SHUTDOWN_GRACE_MS);
  }
}
