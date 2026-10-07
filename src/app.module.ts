import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { TOKENS } from './application/ports/ports';
import { CreateWalletUseCase } from './application/use-cases/create-wallet';
import { PublishOutboxUseCase } from './application/use-cases/publish-outbox';
import { TransactionQueries, WalletQueries } from './application/use-cases/queries';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet';
import { ReprocessPendingReferencesUseCase } from './application/use-cases/reprocess-pending-references';
import { SubmitWagerTransactionUseCase } from './application/use-cases/submit-wager-transaction';
import { SystemClock } from './infrastructure/clock';
import { APP_CONFIG, AppConfig, loadConfig } from './infrastructure/config/app-config';
import { AppLogger } from './infrastructure/observability/logger';
import { PrometheusMetrics } from './infrastructure/observability/metrics';
import { buildOrmConfig } from './infrastructure/persistence/orm-config';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/transaction-runner';
import { buildSqsClient, SQS_CLIENT, SqsQueues } from './infrastructure/sqs/sqs-queues';
import { SqsEventPublisher } from './infrastructure/sqs/sqs-event-publisher';
import { WagerQueueConsumer } from './infrastructure/sqs/wager-queue-consumer';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { ApiAuthGuard, NoopProviderIdentity } from './http/auth';
import { HealthController, MetricsController, WageringController, WalletsController } from './http/controllers';

@Global()
@Module({
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: MikroORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => MikroORM.init(buildOrmConfig(config)),
    },
    { provide: SQS_CLIENT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => buildSqsClient(config) },
    SqsQueues,
    AppLogger,
    PrometheusMetrics,
    SystemClock,
    { provide: TOKENS.Logger, useExisting: AppLogger },
    { provide: TOKENS.Metrics, useExisting: PrometheusMetrics },
    { provide: TOKENS.Clock, useExisting: SystemClock },
    { provide: TOKENS.TransactionRunner, useClass: MikroOrmTransactionRunner },
    { provide: TOKENS.EventPublisher, useClass: SqsEventPublisher },
    // Authentication extension point (no-op by default, see http/auth.ts and ARCHITECTURE.md)
    { provide: TOKENS.ProviderIdentity, useClass: NoopProviderIdentity },
    ApiAuthGuard,
    // use cases
    SubmitWagerTransactionUseCase,
    CreateWalletUseCase,
    WalletQueries,
    TransactionQueries,
    ReconcileWalletUseCase,
    ReprocessPendingReferencesUseCase,
    PublishOutboxUseCase,
    // background workers
    WagerQueueConsumer,
    OutboxPublisherWorker,
    PendingReferenceWorker,
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  /** Runs after workers stopped (Nest shuts providers down in reverse registration order). */
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
