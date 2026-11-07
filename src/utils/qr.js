import crypto from 'crypto';
import { env } from '../config/env.js';

// Rotating QR token shown on the office screen (changes every 60 seconds).
export const QR_WINDOW_MS = 60 * 1000;

const tokenFor = (counter) =>
  crypto.createHmac('sha256', env.jwtSecret).update(`nz-qr:${counter}`).digest('hex').slice(0, 24);

export function currentQrToken() {
  const counter = Math.floor(Date.now() / QR_WINDOW_MS);
  const expiresInMs = QR_WINDOW_MS - (Date.now() % QR_WINDOW_MS);
  return { token: tokenFor(counter), expiresInMs };
}

// Accept the current and previous window so a scan right at rollover still works.
export function verifyQrToken(token) {
  if (!token || typeof token !== 'string') return false;
  const counter = Math.floor(Date.now() / QR_WINDOW_MS);
  return [0, -1].some((off) => {
    const expected = tokenFor(counter + off);
    return (
      expected.length === token.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))
    );
  });
}
