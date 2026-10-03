const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%drizzle%'").then(result => {
  console.log('Drizzle tables:', result.rows);
  return client.execute("SELECT name FROM sqlite_master WHERE type='table'").then(all => {
    console.log('All tables:', all.rows.map(r => r.name));
  });
}).catch(error => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
