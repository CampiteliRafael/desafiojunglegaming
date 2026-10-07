import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppLogger } from './infrastructure/observability/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, logger: false });
  const config = configureApp(app);
  await app.listen(config.PORT, '0.0.0.0');
  const logger = app.get(AppLogger);
  logger.info('wagering processor listening', { port: config.PORT, instance: config.INSTANCE_ID });

  // Graceful shutdown: stop accepting HTTP, finish in-flight requests, stop the SQS consumer / relays
  // (in-flight messages are acked or handed back), then close the pool. Exit code 0 on success.
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info('shutdown requested', { signal });
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, config.SHUTDOWN_GRACE_MS + 5_000);
    force.unref();
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error('error during shutdown', { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'bootstrap failed', error: err instanceof Error ? err.stack : String(err) }));
  process.exit(1);
});
