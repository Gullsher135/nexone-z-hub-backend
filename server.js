import { env, assertEnv } from './src/config/env.js';
import { connectDB } from './src/config/db.js';
import { createApp } from './src/app.js';
import { ensureAdmin } from './src/seed/ensureAdmin.js';
import { migrateTeachers } from './src/seed/migrateTeachers.js';
import { storageLabel } from './src/utils/storage.js';
import { startReminderLoop } from './src/utils/reminders.js';

async function start() {
  assertEnv();
  await connectDB();
  await ensureAdmin();
  await migrateTeachers().catch((e) => console.warn('Teacher migration skipped:', e.message));
  createApp().listen(env.port, () => console.log(`API listening on port ${env.port}. File storage: ${storageLabel()}`));
  startReminderLoop();
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
