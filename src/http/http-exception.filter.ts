import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { LoggerPort, TOKENS } from '../application/ports/ports';
import { DomainError, ValidationError } from '../domain/errors';
import { isTransientInfraError } from '../shared/error-classification';
import { RequestContext } from '../infrastructure/observability/request-context';

export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; details?: unknown };
  correlationId: string | undefined;
}

/**
 * One error contract for every endpoint:
 *   400 payload invalid            (retryable: false — fix the request)
 *   404 unknown wallet/transaction (retryable: false)
 *   409 idempotency / duplicate    (retryable: false — never resend the same key with another payload)
 *   422 business rejection         (built by the controller from the transaction, not an error)
 *   202 accepted, pending          (not an error)
 *   503 transient infrastructure   (retryable: true, Retry-After header)
 *   500 unexpected                 (retryable: false until investigated)
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(TOKENS.Logger) private readonly logger: LoggerPort) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = RequestContext.get().correlationId;
    const send = (status: number, error: ErrorBody['error']) => {
      if (error.retryable) res.setHeader('Retry-After', '1');
      res.status(status).json({ error, correlationId } satisfies ErrorBody);
    };

    if (exception instanceof ValidationError) {
      return send(400, { code: exception.code, message: exception.message, retryable: false, details: exception.details });
    }
    if (exception instanceof DomainError) {
      const status = exception.kind === 'not_found' ? 404 : exception.kind === 'conflict' ? 409 : exception.kind === 'validation' ? 400 : 500;
      return send(status, { code: exception.code, message: exception.message, retryable: false });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHORIZED' : status === 400 ? 'VALIDATION_ERROR' : 'HTTP_ERROR';
      return send(status, { code, message: exception.message, retryable: status >= 500 });
    }
    if (isTransientInfraError(exception)) {
      this.logger.warn('transient infrastructure failure', { error: exception instanceof Error ? exception.message : String(exception) });
      return send(503, { code: 'SERVICE_UNAVAILABLE', message: 'temporary infrastructure failure, retry later', retryable: true });
    }
    this.logger.error('unhandled error', { error: exception instanceof Error ? exception.stack : String(exception) });
    return send(500, { code: 'INTERNAL_ERROR', message: 'internal error', retryable: false });
  }
}
