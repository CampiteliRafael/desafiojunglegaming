import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { LoggerPort, TOKENS } from '../../application/ports/ports';
import { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { BackgroundLoop } from './background-loop';

/** Runs in every instance; correctness with N publishers comes from FOR UPDATE SKIP LOCKED. */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly loop: BackgroundLoop;

  constructor(
    @Inject(PublishOutboxUseCase) private readonly publish: PublishOutboxUseCase,
    @Inject(TOKENS.Logger) private readonly logger: LoggerPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.loop = new BackgroundLoop(
      'outbox-publisher',
      config.OUTBOX_POLL_INTERVAL_MS,
      async () => {
        const n = await this.publish.runOnce(config.OUTBOX_BATCH_SIZE);
        await this.publish.sampleLag();
        return n >= config.OUTBOX_BATCH_SIZE; // full batch => likely more waiting
      },
      (name, err) => this.logger.warn(`${name} tick failed`, { error: err instanceof Error ? err.message : String(err) }),
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.ENABLE_OUTBOX_PUBLISHER) this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop(this.config.SHUTDOWN_GRACE_MS);
  }
}
