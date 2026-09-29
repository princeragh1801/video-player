import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { migrate } from './migrate.js';
import { pool } from './db.js';
import { ensureBucket } from './setupBucket.js';
import { seedDemo } from './seed.js';

await migrate();
// Local-dev conveniences; leave off in production (bucket setup needs admin storage credentials).
if (process.env.STORAGE_AUTO_SETUP === 'true') await ensureBucket();
if (process.env.SEED_DEMO_DATA === 'true') await seedDemo();
const server = createApp().listen(config.port, () => logger.info({ port: config.port }, 'API listening'));

// Graceful shutdown so in-flight segment streams finish during deploys.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    logger.info({ sig }, 'shutting down');
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}
