import { env } from '../config/env.js';
import { nextSeq } from '../models/Counter.js';
import { dateKey } from './time.js';

export const mailEnabled = () => Boolean(env.mail.apiKey && env.mail.fromEmail);

// Sends one email through Brevo's web API (free plan: 300 a day). A daily limit protects the free quota.
export async function sendMail({ to, toName, subject, text, html }) {
  if (!mailEnabled()) return { ok: false, error: 'Email is not set up on the server' };
  const n = await nextSeq(`mail-${dateKey()}`);
  if (n > env.mail.dailyLimit) return { ok: false, error: 'Daily email limit reached' };
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.mail.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: env.mail.fromName, email: env.mail.fromEmail }, to: [{ email: to, ...(toName ? { name: toName } : {}) }], subject, textContent: text, htmlContent: html }),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 160)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
