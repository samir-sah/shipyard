import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';

export async function isolateDatabase(): Promise<() => Promise<void>> {
  if (pool.totalCount) throw new Error('Database isolation must run before the first pooled connection');
  const schema = `shipyard_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: config.databaseUrl });
  await admin.connect();
  try { await admin.query(`CREATE SCHEMA "${schema}"`); }
  finally { await admin.end(); }
  const url = new URL(config.databaseUrl);
  url.searchParams.set('options', `${url.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim());
  pool.options.connectionString = url.toString();
  return async () => {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: config.databaseUrl });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  };
}
