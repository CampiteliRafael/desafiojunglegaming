import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { ALL_SCHEMAS } from './entities/records';
import { MIGRATIONS } from './migrations';
import { AppConfig } from '../config/app-config';

export function buildOrmConfig(config: Pick<AppConfig, 'DATABASE_URL' | 'DB_POOL_MAX'>) {
  return defineConfig({
    clientUrl: config.DATABASE_URL,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    // Schema is owned by versioned migrations — never auto-generated.
    allowGlobalContext: false,
    forceUtcTimezone: true,
    pool: { min: 2, max: config.DB_POOL_MAX, acquireTimeoutMillis: 10_000 },
    migrations: {
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      disableForeignKeys: false,
      snapshot: false,
    },
    debug: false,
  });
}
