import webpush from 'web-push';
import { env } from '../config/env.js';
import { PushSubscription } from '../models/PushSubscription.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { clip, emailAllowed, urlFor } from './notifyCalc.js';
import { mailEnabled, sendMail } from './mailer.js';
import { renderEmail } from './mailTemplate.js';
import { DeviceToken } from '../models/DeviceToken.js';
import { fcmEnabled, sendFcm } from './fcm.js';

export const pushEnabled = () => Boolean(env.vapid.publicKey && env.vapid.privateKey);

let ready = false;
function init() {
  if (ready) return true;
  if (!pushEnabled()) return false;
  webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
  ready = true;
  return true;
}

// The push service keeps a message for up to 4 weeks, so a phone that was off or offline gets it as soon as it is back.
const TTL_SECONDS = 60 * 60 * 24 * 28;
const PEOPLE = '_id role name contactEmail emailNotifications';

// Sends to devices and records what happened to each one (so the admin can see which devices fail).
async function sendWeb(subs, bodyOf) {
  if (!subs.length || !init()) return [];
  const results = [];
  const run = async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(bodyOf(s)), { TTL: TTL_SECONDS, urgency: 'high' });
      results.push({ id: s._id, ok: true });
    } catch (e) {
      results.push({ id: s._id, ok: false, status: e.statusCode, error: clip(e.body || e.message, 160) });
    }
  };
  for (let i = 0; i < subs.length; i += 25) await Promise.all(subs.slice(i, i + 25).map(run));
  const now = new Date();
  const ops = results.map((r) => {
    if (r.ok) return { updateOne: { filter: { _id: r.id }, update: { $set: { lastOkAt: now, fails: 0 }, $unset: { lastError: '', lastErrorAt: '' } } } };
    if (r.status === 404 || r.status === 410) return { deleteOne: { filter: { _id: r.id } } }; // the device is gone for good
    return { updateOne: { filter: { _id: r.id }, update: { $set: { lastError: clip(`${r.status || ''} ${r.error}`, 240), lastErrorAt: now }, $inc: { fails: 1 } } } };
  });
  await PushSubscription.bulkWrite(ops, { ordered: false }).catch((e) => console.error('push log failed', e.message));
  return results;
}

async function saveInbox(users, payload) {
  const ops = users.map((u) => {
    const doc = { title: clip(payload.title, 200), body: clip(payload.body, 500), url: urlFor(u.role, payload), createdAt: new Date() };
    // an unread message with the same tag is updated instead of piling up
    return payload.tag
      ? { updateOne: { filter: { user: u._id, tag: payload.tag, readAt: null }, update: { $set: doc }, upsert: true } }
      : { insertOne: { document: { user: u._id, ...doc } } };
  });
  if (ops.length) await Notification.bulkWrite(ops, { ordered: false });
}

async function emailUsers(users, payload) {
  const list = users.filter((u) => emailAllowed(u, payload, mailEnabled()));
  for (let i = 0; i < list.length; i += 3) {
    await Promise.all(list.slice(i, i + 3).map(async (u) => {
      const m = renderEmail({ title: payload.title, body: payload.body, url: urlFor(u.role, payload), appUrl: env.appUrl, name: u.name });
      const r = await sendMail({ to: u.contactEmail, toName: u.name, ...m });
      if (!r.ok) console.warn(`email to ${u.contactEmail} failed: ${r.error}`);
    }));
  }
}

// Inbox first (always), then phone/computer alerts, then email for important messages. `users` are lean User rows.
async function deliver(users, payload) {
  if (!users.length) return { sent: 0 };
  try { await saveInbox(users, payload); } catch (e) { console.error('inbox failed', e.message); }
  let sent = 0;
  if (init()) {
    const role = new Map(users.map((u) => [String(u._id), u.role]));
    const subs = await PushSubscription.find({ user: { $in: users.map((u) => u._id) } }).lean();
    const results = await sendWeb(subs, (s) => ({ title: clip(payload.title, 120), body: clip(payload.body, 200), tag: payload.tag, url: urlFor(role.get(String(s.user)), payload) }));
    sent = results.filter((r) => r.ok).length;
  }
  if (fcmEnabled()) {
    try {
      const role = new Map(users.map((u) => [String(u._id), u.role]));
      const tokens = await DeviceToken.find({ user: { $in: users.map((u) => u._id) } }).lean();
      sent += await sendFcm(tokens.map((t) => ({ token: t.token, title: clip(payload.title, 120), body: clip(payload.body, 200), tag: payload.tag, url: urlFor(role.get(String(t.user)), payload) })));
    } catch (e) { console.error('app push failed', e.message); }
  }
  emailUsers(users, payload).catch((e) => console.error('email failed', e.message));
  return { sent };
}

// Sends to every active person with one of the roles; each role is opened on its own page. Never throws.
export async function notifyRoles(roles, payload, { excludeId } = {}) {
  try {
    if (!roles?.length) return { sent: 0 };
    const users = await User.find({ isActive: true, role: { $in: roles } }).select(PEOPLE).lean();
    return await deliver(users.filter((u) => String(u._id) !== String(excludeId || '')), payload);
  } catch (e) {
    console.error('notify failed', e.message);
    return { sent: 0 };
  }
}

// Sends to specific people (ids may repeat or be empty). exclude = the person who did the action. Never throws.
export async function notifyUsers(userIds, payload, { exclude } = {}) {
  try {
    const ids = [...new Set((userIds || []).filter(Boolean).map((v) => String(v?._id || v)))].filter((v) => v !== String(exclude || ''));
    if (!ids.length) return { sent: 0 };
    const users = await User.find({ _id: { $in: ids }, isActive: true }).select(PEOPLE).lean();
    return await deliver(users, payload);
  } catch (e) {
    console.error('notify failed', e.message);
    return { sent: 0 };
  }
}

export const notifyAdmins = (payload, opts) => notifyRoles(['admin'], payload, opts);

// "Send me a test": tries every device of one person and says what happened to each.
export async function testDevices(userId) {
  const subs = await PushSubscription.find({ user: userId }).lean();
  if (!subs.length) return [];
  const results = await sendWeb(subs, () => ({ title: 'NexoneZ Hub', body: 'Notifications are working on this device.', tag: 'test', url: '/' }));
  const by = new Map(results.map((r) => [String(r.id), r]));
  return subs.map((s) => ({ id: s._id, label: s.label || 'Device', ok: by.get(String(s._id))?.ok || false, error: by.get(String(s._id))?.error }));
}
