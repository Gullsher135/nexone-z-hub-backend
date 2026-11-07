// Usage: npm run seed            -> creates the admin only
//        npm run seed:demo       -> admin + demo batch, students, employees and interns
import mongoose from 'mongoose';
import { env, assertEnv } from '../config/env.js';
import { connectDB } from '../config/db.js';
import { ensureAdmin } from './ensureAdmin.js';
import { User } from '../models/User.js';
import { Batch } from '../models/Batch.js';
import { dateKey, addDays } from '../utils/time.js';

async function run() {
  assertEnv();
  await connectDB();
  await ensureAdmin();

  if (process.argv.includes('--demo')) {
    const today = dateKey();
    const batch = (await Batch.findOne({ name: 'AI Batch 1' })) ||
      (await Batch.create({ name: 'AI Batch 1', course: 'AI & Programming', schedule: 'Mon-Fri 4pm-6pm', startDate: today }));

    const demoStaff = [
      { name: 'Demo Employee', email: 'employee@demo.nexonez.com', role: 'employee', designation: 'Developer' },
      { name: 'Demo Intern', email: 'intern@demo.nexonez.com', role: 'intern', designation: 'Intern',
        internship: { startDate: today, endDate: addDays(today, 90), mentor: 'Gulsher Malik' } },
    ];
    for (const s of demoStaff) {
      if (!(await User.exists({ email: s.email }))) {
        await User.create({ ...s, password: 'Demo@12345', joiningDate: today });
        console.log(`Created ${s.role}: ${s.email} / Demo@12345`);
      }
    }
    if (!(await User.exists({ role: 'student', batch: batch._id }))) {
      for (let i = 1; i <= 5; i++) {
        await User.create({ role: 'student', name: `Demo Student ${i}`, rollNo: String(i), batch: batch._id });
      }
      console.log('Created 5 demo students in AI Batch 1');
    }
  }
  console.log(`Done. Admin login: ${env.adminEmail}`);
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
