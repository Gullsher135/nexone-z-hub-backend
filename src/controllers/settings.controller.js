import { getSettings } from '../models/Setting.js';
import { HttpError, asyncHandler, clientIp } from '../utils/helpers.js';
import { DATE_RE } from '../utils/time.js';
import { isPrivateIp, normalizeIpRule, resolveMapLink } from '../utils/maps.js';

const publicView = (s) => ({
  organization: s.organization,
  weekendDays: s.weekendDays,
  holidays: s.holidays,
  requireQr: s.requireQr,
  office: { name: s.office?.name, enforceGeofence: !!s.office?.enforceGeofence },
});

export const getSettingsHandler = asyncHandler(async (req, res) => {
  const s = await getSettings();
  res.json({ settings: req.user.role === 'admin' ? s : publicView(s) });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const s = await getSettings();
  const b = req.body || {};

  if (b.organization !== undefined) s.organization = String(b.organization).trim() || 'NexoneZ';
  if (b.weekendDays !== undefined) {
    if (!Array.isArray(b.weekendDays) || b.weekendDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new HttpError(400, 'weekendDays must be numbers 0-6');
    }
    s.weekendDays = [...new Set(b.weekendDays)];
  }
  if (b.holidays !== undefined) {
    if (!Array.isArray(b.holidays) || b.holidays.some((h) => !DATE_RE.test(h?.date || ''))) {
      throw new HttpError(400, 'Each holiday needs a date (YYYY-MM-DD)');
    }
    s.holidays = b.holidays.map((h) => ({ date: h.date, name: h.name || 'Holiday' }));
  }
  if (b.office !== undefined) {
    const o = b.office;
    if (o.lat !== undefined && o.lat !== null && o.lat !== '') s.office.lat = Number(o.lat);
    if (o.lng !== undefined && o.lng !== null && o.lng !== '') s.office.lng = Number(o.lng);
    if (o.name !== undefined) s.office.name = o.name;
    if (o.radiusMeters !== undefined) s.office.radiusMeters = Math.max(20, Number(o.radiusMeters) || 150);
    if (o.enforceGeofence !== undefined) s.office.enforceGeofence = !!o.enforceGeofence;
    if (s.office.enforceGeofence && (s.office.lat == null || s.office.lng == null)) {
      throw new HttpError(400, 'Set the office latitude and longitude before enabling the location check');
    }
  }
  if (b.allowedIps !== undefined) {
    const raw = (Array.isArray(b.allowedIps) ? b.allowedIps : String(b.allowedIps).split(/[,\n]/))
      .map((x) => String(x).trim())
      .filter(Boolean);
    const bad = raw.filter((x) => !normalizeIpRule(x));
    if (bad.length) {
      throw new HttpError(400, `Not a valid IP address: ${bad.join(', ')}. Use a form like 203.0.113.25 or 203.0.113.*`);
    }
    s.allowedIps = [...new Set(raw.map(normalizeIpRule))];
  }
  if (b.enforceIp !== undefined) {
    s.enforceIp = !!b.enforceIp;
    if (s.enforceIp && !s.allowedIps.length) {
      throw new HttpError(400, 'Add at least one allowed IP address before enabling the network check');
    }
  }
  if (b.requireQr !== undefined) s.requireQr = !!b.requireQr;

  await s.save();
  res.json({ settings: s });
});

// The address the server sees for this request. The admin uses it at the office to fill the allowed IP list.
export const myIp = asyncHandler(async (req, res) => {
  const ip = clientIp(req);
  res.json({
    ip,
    isPrivate: isPrivateIp(ip),
    // Shown only when the address looks wrong, to help find out which proxy hides the real one.
    seen: { peer: String(req.ip || ''), forwardedFor: String(req.headers['x-forwarded-for'] || ''), cf: String(req.headers['cf-connecting-ip'] || '') },
  });
});

// Turns a pasted Google Maps link (or "lat, lng" text) into coordinates for the office location.
export const resolveMap = asyncHandler(async (req, res) => {
  const link = String(req.body?.link || '').trim();
  if (!link) throw new HttpError(400, 'Paste a Google Maps link or coordinates first');
  let found = null;
  try {
    found = await resolveMapLink(link);
  } catch {
    throw new HttpError(502, 'Could not open that link right now. Open it in Google Maps, copy the coordinates from the address bar and paste them here.');
  }
  if (!found) {
    throw new HttpError(422, 'No location found in that link. Use the Share button in Google Maps, or paste coordinates such as 33.5651, 71.4429.');
  }
  res.json(found);
});
