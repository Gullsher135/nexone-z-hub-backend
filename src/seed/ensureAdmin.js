import { User } from '../models/User.js';
import { env } from '../config/env.js';

// Creates the first admin from ADMIN_* env vars when the database has no admin yet.
export async function ensureAdmin() {
  const exists = await User.exists({ role: 'admin' });
  if (exists) return;
  if (!env.adminEmail || !env.adminPassword) {
    console.warn('No admin exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set. Set them and restart.');
    return;
  }
  await User.create({
    name: env.adminName,
    email: env.adminEmail,
    password: env.adminPassword,
    role: 'admin',
    designation: 'Administrator',
  });
  console.log(`Admin created: ${env.adminEmail}`);
}
