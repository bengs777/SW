const { loadEnvConfig } = require('@next/env');
const { createClient } = require('@libsql/client');

loadEnvConfig(process.cwd());

const LEGACY_MIGRATIONS = [
  '20260520120000_production_orchestration_hardening',
  '20260521110000_add_product_runtime_crud',
];

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

const createTableSQL = `
CREATE TABLE IF NOT EXISTS __drizzle_migrations (
  id integer PRIMARY KEY AUTOINCREMENT,
  migration_name text,
  started_at integer,
  finished_at integer,
  rolled_back_at integer
);
`;

async function run() {
  try {
    if (!process.env.TURSO_DATABASE_URL) {
      console.log('TURSO_DATABASE_URL not set, skipping migration record bootstrap');
      return;
    }

    await client.execute(createTableSQL);
    console.log('Tracking table ensured');

    const existing = await client.execute('SELECT migration_name FROM __drizzle_migrations');
    const applied = new Set(existing.rows.map((row) => String(row.migration_name)));

    for (const name of LEGACY_MIGRATIONS) {
      if (applied.has(name)) continue;
      await client.execute({
        sql: 'INSERT INTO __drizzle_migrations (migration_name, started_at, finished_at) VALUES (?, ?, ?)',
        args: [name, Date.now(), Date.now()],
      });
      console.log(`Migration record inserted: ${name}`);
    }

    const result = await client.execute('SELECT migration_name, finished_at FROM __drizzle_migrations');
    console.log('Migrations:', JSON.stringify(result.rows));
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
}

run();
