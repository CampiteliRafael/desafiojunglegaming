import { Migration20260801000001_initial_schema } from './Migration20260801000001_initial_schema';

/** Explicit, ordered list: no filesystem discovery, so it works the same under Bun, tests and containers. */
export const MIGRATIONS = [
  { name: 'Migration20260801000001_initial_schema', class: Migration20260801000001_initial_schema },
];
