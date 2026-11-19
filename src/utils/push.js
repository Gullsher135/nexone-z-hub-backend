import webpush from 'web-push';
import { env } from '../config/env.js';
import { PushSubscription } from '../models/PushSubscription.js';
import { User } from '../models/User.js';

export const pushEnabled = () => Boolean(env.vapid.publicKey && env.vapid.privateKey);

let ready = false;
function init() {
  if (ready) return true;
  if (!pushEnabled()) return false;
  webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
  ready = true;
  return true;
}

// Where a tap on the notification opens, per role.
const ROLE_URL = { admin: '/admin/crew', employee: '/notices', intern: '/notices', student: '/learn/notices', teacher: '/teach/notices' };

// Never let a push problem break the request that triggered it.
export const pushSafe = (p) => Promise.resolve(p).catch((e) => console.error('push failed', e.message));

// Sends one payload { title, body, url, tag } to every device of the given users. Dead devices are removed.
export async function sendPush(userIds, payload) {
  if (!userIds?.length || !init()) return { sent: 0 };
  const subs = await PushSubscription.find({ user: { $in: userIds } }).lean();
  const body = JSON.stringify(payload);
  let sent = 0;
  const errors = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 60 * 60 * 24, urgency: 'high' });
        sent += 1;
      } catch (e) {
        errors.push(`${e.statusCode || ''} ${String(e.body || e.message).slice(0, 120)}`.trim());
        if (e.statusCode === 404 || e.statusCode === 410) await PushSubscription.deleteOne({ _id: s._id });
        else console.error('push error', e.statusCode || e.message, String(e.body || '').slice(0, 200));
      }
    })
  );
  console.log(`push "${payload.title}": ${userIds.length} user(s), ${subs.length} device(s), ${sent} delivered`);
  return { sent, devices: subs.length, errors };
}

// One-line helper for every feature: tell these people (never the person who did it), never throw.
// payload.adminUrl, if given, is where an admin lands instead of payload.url (admins use different pages).
export const pushTo = (ids, payload, { exceptId } = {}) =>
  pushSafe((async () => {
    if (!pushEnabled()) return { sent: 0 };
    const list = [...new Set((ids || []).filter(Boolean).map((i) => String(i?._id || i)))].filter((i) => i !== String(exceptId || ''));
    if (!list.length) return { sent: 0 };
    const { adminUrl, ...rest } = payload;
    if (!adminUrl) return sendPush(list, rest);
    const admins = new Set((await User.find({ _id: { $in: list }, role: 'admin' }).select('_id').lean()).map((u) => String(u._id)));
    const [a, o] = await Promise.all([sendPush(list.filter((i) => admins.has(i)), { ...rest, url: adminUrl }), sendPush(list.filter((i) => !admins.has(i)), rest)]);
    return { sent: a.sent + o.sent };
  })());

// Sends to every active person with one of the roles; each role is opened on its own page.
export async function notifyRoles(roles, payload, { excludeId } = {}) {
  if (!roles?.length || !init()) return { sent: 0 };
  const users = await User.find({ isActive: true, role: { $in: roles } }).select('_id role').lean();
  let sent = 0;
  for (const role of roles) {
    const ids = users.filter((u) => u.role === role && String(u._id) !== String(excludeId)).map((u) => u._id);
    const r = await sendPush(ids, { ...payload, url: payload.url || ROLE_URL[role] || '/' });
    sent += r.sent;
  }
  return { sent };
}
