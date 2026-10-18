import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from './migrate.js';

/**
 * Where tests that need a real PostgreSQL connect, or undefined to skip them.
 * Opt-in, so `npm test` keeps working on a machine without a database.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface TestDatabase {
  pool: pg.Pool;
  /** Drops everything the tests created. */
  drop(): Promise<void>;
}

/**
 * A fresh schema with every migration applied, so tests never see each
 * other's rows nor the development data in the same database. Each test file
 * gets its own, which also lets files run in parallel.
 */
export async function createTestDatabase(url: string): Promise<TestDatabase> {
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  // Unqualified table names resolve to the test schema on every connection.
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 });
  await migrate(pool);

  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
