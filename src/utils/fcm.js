import { DeviceToken } from '../models/DeviceToken.js';

// Push to the phone app through Firebase Cloud Messaging (free). Switched on by FIREBASE_SERVICE_ACCOUNT
// (the service account JSON from Firebase, pasted as one line). Without it the phone app still shows the bell inbox.
export const fcmEnabled = () => Boolean(process.env.FIREBASE_SERVICE_ACCOUNT);

let messaging = null;
async function getMessaging() {
  if (messaging) return messaging;
  if (!fcmEnabled()) return null;
  try {
    const admin = (await import('firebase-admin')).default;
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    messaging = admin.messaging();
    return messaging;
  } catch (e) {
    console.error('Firebase could not start:', e.message);
    return null;
  }
}

const GONE = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

// rows: [{ token, title, body, url, tag }]. Returns how many were accepted.
export async function sendFcm(rows) {
  const m = rows.length ? await getMessaging() : null;
  if (!m) return 0;
  let ok = 0;
  const now = new Date();
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const messages = chunk.map((r) => ({
      token: r.token,
      notification: { title: String(r.title || '').slice(0, 120), body: String(r.body || '').slice(0, 200) },
      data: { url: String(r.url || '/'), tag: String(r.tag || '') },
      android: { priority: 'high', ttl: 28 * 24 * 3600 * 1000, notification: { tag: r.tag || undefined } },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
    }));
    try {
      const res = await m.sendEach(messages);
      const ops = [];
      res.responses.forEach((r, n) => {
        if (r.success) { ok += 1; ops.push({ updateOne: { filter: { token: chunk[n].token }, update: { $set: { lastOkAt: now }, $unset: { lastError: '' } } } }); }
        else if (GONE.has(r.error?.code)) ops.push({ deleteOne: { filter: { token: chunk[n].token } } });
        else ops.push({ updateOne: { filter: { token: chunk[n].token }, update: { $set: { lastError: String(r.error?.code || r.error?.message || '').slice(0, 240) } } } });
      });
      if (ops.length) await DeviceToken.bulkWrite(ops, { ordered: false });
    } catch (e) {
      console.error('FCM failed', e.message);
    }
  }
  return ok;
}
