import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../config/app-config';
import { buildOrmConfig } from '../orm-config';

const direction = process.argv[2] ?? 'up';

const orm = await MikroORM.init(buildOrmConfig(loadConfig()));
try {
  const migrator = orm.migrator;
  if (direction === 'up') {
    const done = await migrator.up();
    console.log(JSON.stringify({ msg: 'migrations applied', migrations: done.map((m) => m.name) }));
  } else if (direction === 'down') {
    const done = await migrator.down();
    console.log(JSON.stringify({ msg: 'migration reverted', migrations: done.map((m) => m.name) }));
  } else {
    throw new Error(`unknown direction "${direction}" (use up|down)`);
  }
} finally {
  await orm.close(true);
}
