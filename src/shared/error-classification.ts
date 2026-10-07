/**
 * Duck-typed classification of infrastructure errors so that neither the domain nor the
 * application layer imports ORM / AWS types.
 */
type ErrLike = { code?: unknown; constraint?: unknown; name?: unknown; message?: unknown; errno?: unknown; $metadata?: { httpStatusCode?: number }; $retryable?: unknown; cause?: unknown };

const asErr = (e: unknown): ErrLike => (typeof e === 'object' && e !== null ? (e as ErrLike) : {});

export function pgCode(e: unknown): string | undefined {
  const err = asErr(e);
  if (typeof err.code === 'string') return err.code;
  const cause = asErr(err.cause);
  return typeof cause.code === 'string' ? cause.code : undefined;
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  if (pgCode(e) !== '23505') return false;
  if (!constraint) return true;
  const err = asErr(e);
  const c = typeof err.constraint === 'string' ? err.constraint : asErr(err.cause).constraint;
  return c === constraint || (typeof err.message === 'string' && err.message.includes(constraint));
}

/** Lock timeout (55P03), deadlock (40P01), serialization failure (40001): safe to retry the whole unit of work. */
export function isConcurrencyConflict(e: unknown): boolean {
  const code = pgCode(e);
  return code === '55P03' || code === '40P01' || code === '40001' || (asErr(e).name === 'OptimisticLockError');
}

const TRANSIENT_PG = new Set(['57P01', '57P02', '57P03', '57014', '53300', '53400', '53200', '08000', '08001', '08003', '08004', '08006', '08007', '08P01']);
const TRANSIENT_NET = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

/** PostgreSQL / SQS temporarily unavailable, timeouts, throttling, lock conflicts: retry later. */
export function isTransientInfraError(e: unknown): boolean {
  const err = asErr(e);
  const code = pgCode(e);
  if (isConcurrencyConflict(e)) return true;
  if (code && (TRANSIENT_PG.has(code) || code.startsWith('08'))) return true;
  if (typeof err.code === 'string' && TRANSIENT_NET.has(err.code)) return true;
  if (typeof err.errno === 'string' && TRANSIENT_NET.has(err.errno)) return true;
  const message = typeof err.message === 'string' ? err.message : '';
  if (/timeout acquiring|connection terminated|connection error|ECONNREFUSED|ECONNRESET|socket hang up|Connection is closed|the database system is (starting up|shutting down)/i.test(message)) return true;
  const name = typeof err.name === 'string' ? err.name : '';
  if (/^(ConnectionException|ThrottlingException|ServiceUnavailable|RequestTimeout|TimeoutError|NetworkingError|InternalFailure|QueueDoesNotExist)$/i.test(name)) return true;
  if (err.$retryable) return true;
  const status = err.$metadata?.httpStatusCode;
  if (typeof status === 'number' && status >= 500) return true;
  if (err.cause) return isTransientInfraError(err.cause);
  return false;
}

export class OptimisticLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimisticLockError';
  }
}
