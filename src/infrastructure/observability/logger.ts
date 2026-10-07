import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { LoggerPort } from '../../application/ports/ports';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { RequestContext } from './request-context';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/** Fields that must never reach the logs (financial payloads / sensitive data). */
const REDACTED = new Set(['money', 'amount', 'balance', 'payload', 'initialBalance', 'authorization', 'password', 'token']);

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = REDACTED.has(k) ? '[REDACTED]' : v;
  return out;
}

/** Structured JSON logger (one line per event) enriched with the AsyncLocalStorage context. */
@Injectable()
export class AppLogger implements LoggerPort, LoggerService {
  private readonly threshold: number;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.threshold = LEVELS[config.LOG_LEVEL];
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', message, fields);
  }
  error(message: string | Error, fields: Record<string, unknown> | string = {}, ...rest: unknown[]): void {
    // Nest's own calls look like error(message, stack, context); ours like error(message, {fields})
    const extra = typeof fields === 'string' ? { stack: fields, context: rest[0] } : fields;
    this.write('error', message, extra);
  }

  // Nest LoggerService compatibility
  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', String(message), { context: rest[0] });
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, { context: rest[0] });
  }
  /** Nest calls error(message | Error, stack?, context?) */
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('debug', String(message), { context: rest[0] });
  }

  private write(level: Level, rawMessage: unknown, fields: Record<string, unknown>): void {
    if (LEVELS[level] < this.threshold) return;
    // Nest may hand us Error objects / extra args (stack traces): keep them readable in JSON
    const message = rawMessage instanceof Error ? rawMessage.message : typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
    if (rawMessage instanceof Error) fields = { ...fields, stack: rawMessage.stack };
    const ctx = RequestContext.get();
    const line = {
      level,
      time: new Date().toISOString(),
      msg: message,
      instance: this.config.INSTANCE_ID,
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
      ...(ctx.transactionId ? { transactionId: ctx.transactionId } : {}),
      ...(ctx.walletId ? { walletId: ctx.walletId } : {}),
      ...(ctx.providerId ? { providerId: ctx.providerId } : {}),
      ...redact(fields),
    };
    process.stdout.write(JSON.stringify(line) + '\n');
  }
}
