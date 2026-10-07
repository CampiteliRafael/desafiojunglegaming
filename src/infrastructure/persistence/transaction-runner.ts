import { Inject, Injectable } from '@nestjs/common';
import { EntityManager, IsolationLevel, MikroORM } from '@mikro-orm/postgresql';
import { TransactionRunner, UnitOfWork } from '../../application/ports/ports';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { buildUnitOfWork } from './repositories/repositories';

/**
 * One call = one fork of the EntityManager = one SQL transaction (MikroORM `transactional`).
 * Identity map and unit of work are scoped to that fork, so nothing leaks across requests/messages.
 */
@Injectable()
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  run<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      await this.setLocalTimeouts(em);
      return fn(buildUnitOfWork(em));
    });
  }

  runSnapshot<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(
      async (em) => {
        await this.setLocalTimeouts(em);
        return fn(buildUnitOfWork(em));
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }

  private async setLocalTimeouts(em: EntityManager): Promise<void> {
    // numeric config values only (validated by zod): safe to inline, SET does not accept bind parameters
    const lock = Math.trunc(this.config.DB_LOCK_TIMEOUT_MS);
    await em
      .getConnection()
      .execute(`SET LOCAL lock_timeout = '${lock}ms'; SET LOCAL statement_timeout = '30000ms'`, [], 'run', em.getTransactionContext());
  }
}
