import { createApp } from './app.js';
import { config, productionProblems } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrations.js';

if (process.env.NODE_ENV === 'production') {
  const problems = productionProblems();
  if (problems.length) {
    console.error('[config] refusing to start in production:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
} else if (!process.env.AUTH_SECRET) {
  console.warn('[config] AUTH_SECRET is not set — using a development-only secret (fine locally, never in production)');
}

const db = await createDb(config.databaseUrl, config.pgliteDir);
const ran = await migrate(db);
if (ran.length) console.log(`[db] applied migrations: ${ran.join(', ')}`);

const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
if (rows[0].n === 0) console.log('[setup] no users yet — open the app to create the owner account');

const server = createApp(db).listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} (database: ${db.kind})`);
});

async function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  server.closeAllConnections();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
