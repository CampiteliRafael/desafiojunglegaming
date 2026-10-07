import { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TOKENS } from './application/ports/ports';
import { HttpExceptionFilter } from './http/http-exception.filter';
import { APP_CONFIG, AppConfig } from './infrastructure/config/app-config';
import { AppLogger } from './infrastructure/observability/logger';
import { RequestContext } from './infrastructure/observability/request-context';
import { newId } from './shared/ids';

/** Shared by main.ts and the test harness so tests exercise the real HTTP pipeline. */
export function configureApp(app: INestApplication): AppConfig {
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.useGlobalFilters(new HttpExceptionFilter(app.get(TOKENS.Logger)));

  // correlation id + access log (no bodies: payloads are financial data)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers['x-correlation-id'];
    const correlationId = (Array.isArray(header) ? header[0] : header) || newId();
    res.setHeader('x-correlation-id', correlationId);
    const startedAt = performance.now();
    RequestContext.run({ correlationId }, () => {
      res.on('finish', () => {
        if (req.path.startsWith('/health') || req.path === '/metrics') return;
        logger.info('http request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
      next();
    });
  });
  return config;
}
