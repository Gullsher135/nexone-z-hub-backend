import { env, assertEnv } from './src/config/env.js';
import { connectDB } from './src/config/db.js';
import { createApp } from './src/app.js';
import { ensureAdmin } from './src/seed/ensureAdmin.js';
import { migrateTeachers } from './src/seed/migrateTeachers.js';

async function start() {
  assertEnv();
  await connectDB();
  await ensureAdmin();
  await migrateTeachers().catch((e) => console.warn('Teacher migration skipped:', e.message));
  createApp().listen(env.port, () => console.log(`API listening on port ${env.port}`));
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
