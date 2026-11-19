import { PushSubscription } from '../models/PushSubscription.js';
import { env } from '../config/env.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { pushEnabled, sendPush } from '../utils/push.js';

export const publicKey = asyncHandler(async (_req, res) => {
  res.json({ enabled: pushEnabled(), key: env.vapid.publicKey || null });
});

// The browser's subscription is tied to whoever is logged in on it right now.
export const subscribe = asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body?.subscription || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) throw new HttpError(400, 'Invalid subscription');
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    { user: req.user._id, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) },
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

export const test = asyncHandler(async (req, res) => {
  if (!pushEnabled()) throw new HttpError(400, 'Push is not set up on the server yet');
  const r = await sendPush([req.user._id], { title: 'NexoneZ Hub', body: 'Notifications are working.', url: '/', tag: 'test' });
  res.json({ sent: r.sent });
});
