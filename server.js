import { env, assertEnv } from './src/config/env.js';
import { connectDB } from './src/config/db.js';
import { createApp } from './src/app.js';
import { ensureAdmin } from './src/seed/ensureAdmin.js';

async function start() {
  assertEnv();
  await connectDB();
  await ensureAdmin();
  createApp().listen(env.port, () => console.log(`API listening on port ${env.port}`));
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
