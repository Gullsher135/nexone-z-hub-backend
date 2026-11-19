// Gives every existing person who has no email / no password the automatic login:
//   NZ-STD-0008 -> nz-std-0008@nexonez.com, starting password nz123 (they must change it on first login).
// People who already have an email and a password are not touched.  Run: npm run backfill:logins
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import { assertEnv, env } from '../config/env.js';
import { User } from '../models/User.js';

assertEnv();
await connectDB();

let fixed = 0;
for (const u of await User.find({}).select('+password')) {
  let changed = false;
  if (!u.email && u.code) { u.email = `${u.code.toLowerCase()}@${env.loginDomain}`; changed = true; }
  if (!u.password) { u.password = env.defaultPassword; u.mustChangePassword = true; changed = true; }
  if (changed) { await u.save(); fixed += 1; console.log(`${u.code}  ${u.email}`); }
}
console.log(`Done. ${fixed} people updated.`);
await mongoose.disconnect();
