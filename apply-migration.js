const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

const migrationFile = path.join(__dirname, 'drizzle', '0000_spicy_princess_powerful.sql');
const sql = fs.readFileSync(migrationFile, 'utf8');
const statements = sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);

async function run() {
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      await client.execute(stmt);
      console.log(`[${i + 1}/${statements.length}] OK`);
    } catch (e) {
      console.error(`[${i + 1}/${statements.length}] FAIL:`, e.message);
    }
  }
  console.log('Done');
}

run().catch(e => { console.error(e); process.exit(1); });
