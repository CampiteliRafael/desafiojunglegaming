import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export const RequestContext = {
  run<T>(ctx: LogContext, fn: () => T): T {
    return storage.run({ ...ctx }, fn);
  },
  get(): LogContext {
    return storage.getStore() ?? {};
  },
  /** Enriches the current context (e.g. once the transaction/wallet ids are known). */
  set(patch: LogContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, patch);
  },
};
