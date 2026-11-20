import 'dotenv/config';

const list = (v, fallback) =>
  (v || fallback).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

export const env = {
  port: Number(process.env.PORT || 5000),
  isProd: process.env.NODE_ENV === 'production',
  // How many proxy hops sit in front of the API (Render = 1). Raise to 2 if the IP check sees the wrong address.
  trustProxy: process.env.TRUST_PROXY === undefined ? 1 : /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY === 'true',
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientUrls: list(process.env.CLIENT_URL, 'http://localhost:5173'),
  adminName: process.env.ADMIN_NAME || 'Admin',
  adminEmail: process.env.ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD,
  // Auto-created logins: <ID>@<loginDomain>, e.g. nz-std-0008@nexonez.com, with this starting password.
  loginDomain: (process.env.LOGIN_DOMAIN || 'nexonez.com').toLowerCase().replace(/^@/, ''),
  defaultPassword: process.env.DEFAULT_PASSWORD || 'nz123',
  // The address people open (used for links inside emails).
  appUrl: (process.env.APP_URL || list(process.env.CLIENT_URL, 'http://localhost:5173')[0]).replace(/\/$/, ''),
  // Email for people whose phone is off: free Brevo account (300 emails a day). Leave empty to switch email off.
  mail: {
    apiKey: process.env.BREVO_API_KEY,
    fromEmail: process.env.MAIL_FROM_EMAIL,
    fromName: process.env.MAIL_FROM_NAME || 'NexoneZ Hub',
    dailyLimit: Number(process.env.MAIL_DAILY_LIMIT) || 250,
  },
  // Free browser push notifications (Web Push / VAPID). Generate keys once with: npm run vapid
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@nexonez.com',
  },
};

export function assertEnv() {
  const missing = [];
  if (!env.mongoUri) missing.push('MONGODB_URI');
  if (!env.jwtSecret) missing.push('JWT_SECRET');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
