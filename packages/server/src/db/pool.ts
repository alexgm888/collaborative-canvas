import pg from 'pg';

/** Anything that can run a query: the pool itself or a client checked out of it. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });

  // An idle client can lose its connection (database restart, network blip).
  // Without a listener that error would crash the process; the pool already
  // discards the broken client and opens a new one on the next query.
  pool.on('error', (err) => {
    console.error('Idle PostgreSQL client error:', err.message);
  });

  return pool;
}

export async function isDatabaseUp(db: Queryable): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
