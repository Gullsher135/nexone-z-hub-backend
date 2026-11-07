import { isIP } from 'node:net';

// ---------- Google Maps helpers ----------
// The admin can paste a Google Maps link (long or short) or plain "lat, lng" text.
// We pull the coordinates out of it so nobody has to type them by hand.

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const PATTERNS = [
  new RegExp(`!3d${NUM}!4d${NUM}`), // the exact pin of a place (most accurate)
  new RegExp(`@${NUM},${NUM}`), // map centre in the address bar
  new RegExp(`[?&](?:q|ll|query|center|destination|daddr)=${NUM}\\s*,\\s*${NUM}`),
  new RegExp(`^\\s*${NUM}\\s*[,;\\s]\\s*${NUM}\\s*$`), // plain "33.6844, 73.0479"
];

const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

function decodeAll(s) {
  let out = String(s);
  for (let i = 0; i < 3; i++) {
    try {
      const d = decodeURIComponent(out.replace(/\+/g, ' '));
      if (d === out) break;
      out = d;
    } catch {
      break;
    }
  }
  return out;
}

export function parseCoordinates(text) {
  if (!text) return null;
  const s = decodeAll(text);
  for (const re of PATTERNS) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (valid(lat, lng)) return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
    }
  }
  return null;
}

const placeName = (url) => {
  const m = decodeAll(url).match(/\/maps\/place\/([^/@?]+)/);
  return m ? m[1].replace(/\+/g, ' ').trim() : '';
};

// Only Google Maps hosts are followed, so this cannot be used to reach other servers.
const hostOk = (host) => /(^|\.)google\.[a-z.]{2,6}$/i.test(host) || /^(maps\.app\.)?goo\.gl$/i.test(host);

export async function resolveMapLink(input) {
  const direct = parseCoordinates(input);
  if (direct && !/^https?:/i.test(String(input).trim())) return direct;

  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !hostOk(url.hostname)) return null;

  let current = url.toString();
  for (let hop = 0; hop < 6; hop++) {
    const found = parseCoordinates(current);
    if (found) return { ...found, name: placeName(current) };
    const u = new URL(current);
    if (!hostOk(u.hostname)) return null;
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NexoneZTime/1.0)', 'accept-language': 'en' },
    });
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) {
      current = new URL(next, current).toString();
      continue;
    }
    // Final page: look in the page text as a last resort.
    const body = (await res.text()).slice(0, 600000);
    const m = body.match(new RegExp(`!3d${NUM}!4d${NUM}`)) || body.match(new RegExp(`center=${NUM}%2C${NUM}`)) || body.match(new RegExp(`\\[null,null,${NUM},${NUM}\\]`));
    if (m && valid(Number(m[1]), Number(m[2]))) return { lat: Number(Number(m[1]).toFixed(6)), lng: Number(Number(m[2]).toFixed(6)), name: placeName(current) };
    return null;
  }
  return null;
}

// ---------- IP helpers ----------
export const isPrivateIp = (ip) => {
  const v = String(ip).replace(/^::ffff:/, '');
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT, shared by many customers
    );
  }
  if (isIP(v) === 6) return v === '::1' || /^f[cd]/i.test(v) || /^fe80/i.test(v);
  return false;
};

// Accepts "203.0.113.25", "203.0.113.*" and IPv6. Returns the cleaned value or null.
export function normalizeIpRule(raw) {
  const v = String(raw).trim().replace(/^::ffff:/, '');
  if (!v) return null;
  if (v.endsWith('*')) {
    const prefix = v.slice(0, -1);
    if (/^\d{1,3}(\.\d{1,3}){0,2}\.$/.test(prefix) && prefix.split('.').filter(Boolean).every((n) => Number(n) <= 255)) return v;
    if (/^[0-9a-f:]+:$/i.test(prefix)) return v.toLowerCase();
    return null;
  }
  return isIP(v) ? v : null;
}
