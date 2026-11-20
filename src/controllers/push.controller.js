import { PushSubscription } from '../models/PushSubscription.js';
import { env } from '../config/env.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { deviceLabel } from '../utils/device.js';
import { mailEnabled } from '../utils/mailer.js';
import { pushEnabled, testDevices } from '../utils/push.js';

export const publicKey = asyncHandler(async (_req, res) => {
  res.json({ enabled: pushEnabled(), key: env.vapid.publicKey || null, mail: mailEnabled() });
});

// The browser's subscription is tied to whoever is logged in on it right now.
export const subscribe = asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body?.subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) throw new HttpError(400, 'Invalid subscription');
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { user: req.user._id, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: ua, label: deviceLabel(ua), fails: 0 },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.json({ message: 'Notifications are on' });
});

export const unsubscribe = asyncHandler(async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await PushSubscription.deleteOne({ endpoint, user: req.user._id });
  else await PushSubscription.deleteMany({ user: req.user._id });
  res.json({ message: 'Notifications are off' });
});

// Tries every device of the logged-in person and reports what happened to each.
export const test = asyncHandler(async (req, res) => {
  if (!pushEnabled()) throw new HttpError(400, 'Notifications are not set up on the server yet (VAPID keys are missing)');
  const devices = await testDevices(req.user._id);
  res.json({ sent: devices.filter((d) => d.ok).length, devices });
});
