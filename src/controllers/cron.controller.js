import crypto from 'crypto';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { runReminders } from '../utils/reminders.js';

// An outside timer (for example the free cron-job.org) can call this once a day. Free hosting may put the server
// to sleep, and this call also wakes it. Protected by CRON_KEY from the environment.
export const reminders = asyncHandler(async (req, res) => {
  const key = process.env.CRON_KEY;
  if (!key) throw new HttpError(503, 'CRON_KEY is not set on the server');
  const given = String(req.query.key || req.headers['x-cron-key'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Wrong key');
  res.json({ ok: true, ...(await runReminders()) });
});
