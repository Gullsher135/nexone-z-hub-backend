import mongoose from 'mongoose';
import { Notification } from '../models/Notification.js';
import { PushSubscription } from '../models/PushSubscription.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { isEmail } from '../utils/notifyCalc.js';
import { mailEnabled } from '../utils/mailer.js';
import { pushEnabled } from '../utils/push.js';
import { s3Enabled } from '../utils/storage.js';

// ---- the bell (in-app inbox) ----
export const listMine = asyncHandler(async (req, res) => {
  const f = { user: req.user._id };
  if (req.query.before && !Number.isNaN(Date.parse(req.query.before))) f.createdAt = { $lt: new Date(req.query.before) };
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
  const [items, unread] = await Promise.all([Notification.find(f).sort({ createdAt: -1 }).limit(limit).lean(), Notification.countDocuments({ user: req.user._id, readAt: null })]);
  res.json({ items, unread });
});

export const unreadCount = asyncHandler(async (req, res) => {
  res.json({ unread: await Notification.countDocuments({ user: req.user._id, readAt: null }) });
});

export const markRead = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Not found');
  await Notification.updateOne({ _id: req.params.id, user: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
  res.json({ unread: await Notification.countDocuments({ user: req.user._id, readAt: null }) });
});

export const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
  res.json({ unread: 0 });
});

export const clearAll = asyncHandler(async (req, res) => {
  await Notification.deleteMany({ user: req.user._id });
  res.json({ unread: 0 });
});

// ---- my devices ----
export const myDevices = asyncHandler(async (req, res) => {
  const items = await PushSubscription.find({ user: req.user._id }).select('label createdAt lastOkAt lastError lastErrorAt fails endpoint').sort({ createdAt: -1 }).lean();
  res.json({ items: items.map(({ endpoint, ...d }) => ({ ...d, endpointTail: endpoint.slice(-24) })) });
});

export const removeDevice = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Not found');
  await PushSubscription.deleteOne({ _id: req.params.id, user: req.user._id });
  res.json({ message: 'Removed' });
});

// ---- email address for notifications ----
export const setContact = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const user = await User.findById(req.user._id);
  if (b.contactEmail !== undefined) {
    const v = String(b.contactEmail || '').trim().toLowerCase();
    if (v && !isEmail(v)) throw new HttpError(400, 'Enter a valid email address');
    user.contactEmail = v || undefined;
  }
  if (typeof b.emailNotifications === 'boolean') user.emailNotifications = b.emailNotifications;
  await user.save();
  res.json({ contactEmail: user.contactEmail || '', emailNotifications: user.emailNotifications !== false });
});

// How fast the database answers from this server. A high number means the two are far apart (different regions).
async function dbPingMs() {
  const t = [];
  for (let i = 0; i < 3; i++) { const s = Date.now(); await mongoose.connection.db.admin().ping(); t.push(Date.now() - s); }
  return Math.round(t.reduce((a, b) => a + b, 0) / t.length);
}

// ---- admin: who will actually receive notifications? ----
export const health = asyncHandler(async (_req, res) => {
  const perf = { uptimeMinutes: Math.round(process.uptime() / 60), dbPingMs: await dbPingMs().catch(() => null) };
  const [users, devices] = await Promise.all([
    User.find({ isActive: true }).select('name code role contactEmail emailNotifications').lean(),
    PushSubscription.aggregate([{ $group: { _id: '$user', devices: { $sum: 1 }, lastOkAt: { $max: '$lastOkAt' }, lastErrorAt: { $max: '$lastErrorAt' }, failing: { $sum: { $cond: [{ $gt: ['$fails', 2] }, 1, 0] } } } }]),
  ]);
  const by = new Map(devices.map((d) => [String(d._id), d]));
  const roles = {};
  const missing = [];
  const failing = [];
  for (const u of users) {
    const d = by.get(String(u._id));
    const r = (roles[u.role] ||= { people: 0, withDevice: 0, withEmail: 0 });
    r.people += 1;
    if (d) r.withDevice += 1;
    if (u.contactEmail && u.emailNotifications !== false) r.withEmail += 1;
    if (!d) missing.push({ _id: u._id, name: u.name, code: u.code, role: u.role, hasEmail: !!u.contactEmail });
    else if (d.failing) failing.push({ _id: u._id, name: u.name, code: u.code, role: u.role, devices: d.devices });
  }
  res.json({
    perf,
    config: { push: pushEnabled(), email: mailEnabled(), emailFrom: mailEnabled() ? env.mail.fromEmail : null, cron: !!process.env.CRON_KEY, fileStorage: s3Enabled() ? 'bucket' : 'database', appUrl: env.appUrl },
    roles,
    missing: missing.slice(0, 400),
    missingTotal: missing.length,
    failing,
  });
});
