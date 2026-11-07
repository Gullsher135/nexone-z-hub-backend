import { isPrivateIp } from './maps.js';
import crypto from 'crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const randomPassword = (len = 10) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
};

export const pick = (obj, keys) =>
  keys.reduce((acc, k) => (obj[k] !== undefined ? { ...acc, [k]: obj[k] } : acc), {});

const stripV6 = (v) => String(v || '').split(',')[0].trim().replace(/^::ffff:/, '');

// The visitor's public IP. On Render the app only sees an internal proxy address (10.x.x.x),
// and the real address arrives in headers set by the platform's edge (Cloudflare). Those headers
// are trusted only when the direct peer is itself a private/internal address, so a visitor who
// reaches the app directly cannot fake them.
export const clientIp = (req) => {
  const peer = stripV6(req.ip);
  if (isPrivateIp(peer)) {
    const real = stripV6(req.headers['cf-connecting-ip']) || stripV6(req.headers['true-client-ip']);
    if (real) return real;
  }
  return peer;
};

export const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
