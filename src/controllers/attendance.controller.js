import { Attendance } from '../models/Attendance.js';
import { User, STAFF_ROLES } from '../models/User.js';
import { Leave } from '../models/Leave.js';
import { getSettings } from '../models/Setting.js';
import { HttpError, asyncHandler, clientIp } from '../utils/helpers.js';
import { distanceMeters } from '../utils/geo.js';
import { currentQrToken, verifyQrToken } from '../utils/qr.js';
import {
  DATE_RE, MONTH_RE, TIME_RE, currentMonth, dateFromKey, dateKey, timeKey,
} from '../utils/time.js';
import { calcAttendance, employedOn, holidayOn, isOffDay } from '../utils/attendanceCalc.js';
import { userMonthRows } from '../utils/reports.js';

const ipAllowed = (ip, list) =>
  list.some((rule) => (rule.endsWith('*') ? ip.startsWith(rule.slice(0, -1)) : ip === rule));

// Decide whether this punch is allowed and describe where it came from.
function verifyPunch(req, settings, body) {
  const method = body.method === 'qr' ? 'qr' : 'button';

  if (method === 'qr') {
    if (!verifyQrToken(body.qrToken)) {
      throw new HttpError(400, 'This QR code has expired. Please scan the code currently shown on the office screen.');
    }
    return { method, location: undefined }; // QR proves physical presence
  }

  if (settings.requireQr) {
    throw new HttpError(403, 'Check-in is only allowed by scanning the office QR code.');
  }
  if (settings.enforceIp && settings.allowedIps.length) {
    if (!ipAllowed(clientIp(req), settings.allowedIps)) {
      throw new HttpError(403, 'You must be connected to the office network to check in.');
    }
  }

  let location;
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && body.lat !== null && body.lat !== '';
  const officeSet = settings.office?.lat != null && settings.office?.lng != null;

  if (settings.office?.enforceGeofence && officeSet) {
    if (!hasCoords) {
      throw new HttpError(400, 'Location is required. Please allow location access and try again.');
    }
    const distance = Math.round(distanceMeters(lat, lng, settings.office.lat, settings.office.lng));
    if (distance > settings.office.radiusMeters) {
      throw new HttpError(403, `You are ${distance} m away from the office. Check-in works within ${settings.office.radiusMeters} m.`);
    }
    location = { lat, lng, distance };
  } else if (hasCoords) {
    location = {
      lat,
      lng,
      distance: officeSet
        ? Math.round(distanceMeters(lat, lng, settings.office.lat, settings.office.lng))
        : undefined,
    };
  }
  return { method, location };
}

async function doPunch(req, action) {
  const settings = await getSettings();
  const body = req.body || {};
  const { method, location } = verifyPunch(req, settings, body);

  const user = req.user;
  const now = new Date();
  const date = dateKey(now);
  let record = await Attendance.findOne({ user: user._id, date });

  let act = action;
  if (act === 'auto') act = record?.checkIn ? 'out' : 'in';

  if (act === 'in') {
    if (record?.checkIn) {
      throw new HttpError(409, `You already checked in at ${timeKey(record.checkIn)}.`);
    }
    if (!record) record = new Attendance({ user: user._id, date });
    record.checkIn = now;
    record.checkInMethod = method;
    if (location) record.checkInLocation = location;
    Object.assign(record, calcAttendance(user, now, null));
    await record.save();
    return { record, message: `Checked in at ${timeKey(now)}` };
  }

  if (!record?.checkIn) throw new HttpError(400, 'You have not checked in today.');
  if (record.checkOut) {
    throw new HttpError(409, `You already checked out at ${timeKey(record.checkOut)}.`);
  }
  if (now - record.checkIn < 2 * 60 * 1000) {
    throw new HttpError(400, 'Please wait a couple of minutes before checking out.');
  }
  record.checkOut = now;
  record.checkOutMethod = method;
  if (location) record.checkOutLocation = location;
  Object.assign(record, calcAttendance(user, record.checkIn, now));
  await record.save();
  return { record, message: `Checked out at ${timeKey(now)}` };
}

export const checkIn = asyncHandler(async (req, res) => res.json(await doPunch(req, 'in')));
export const checkOut = asyncHandler(async (req, res) => res.json(await doPunch(req, 'out')));
// Used by the QR scan page: checks in first, then checks out on the next scan.
export const punch = asyncHandler(async (req, res) => res.json(await doPunch(req, 'auto')));

export const myToday = asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const date = dateKey();
  const record = await Attendance.findOne({ user: req.user._id, date });
  const holiday = holidayOn(settings, date);
  res.json({
    date,
    record,
    shift: req.user.shift,
    isOffDay: isOffDay(settings, date),
    holiday: holiday?.name || null,
    rules: {
      requireQr: settings.requireQr,
      needsLocation: !!(settings.office?.enforceGeofence && settings.office?.lat != null),
      needsOfficeNetwork: !!(settings.enforceIp && settings.allowedIps.length),
      officeName: settings.office?.name,
    },
  });
});

export const myMonth = asyncHandler(async (req, res) => {
  const month = req.query.month || currentMonth();
  if (!MONTH_RE.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
  const settings = await getSettings();
  res.json(await userMonthRows(req.user, month, settings));
});

export const qrToken = asyncHandler(async (_req, res) => {
  res.json(currentQrToken());
});

// Admin: everyone's status for one day.
export const board = asyncHandler(async (req, res) => {
  const date = req.query.date || dateKey();
  if (!DATE_RE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const today = dateKey();
  const settings = await getSettings();
  const off = isOffDay(settings, date);

  const roles = req.query.role && STAFF_ROLES.includes(req.query.role) ? [req.query.role] : STAFF_ROLES;
  const staff = (await User.find({ role: { $in: roles }, isActive: true }).sort({ name: 1 })).filter(
    (u) => employedOn(u, date)
  );
  const ids = staff.map((u) => u._id);
  const [records, leaves] = await Promise.all([
    Attendance.find({ date, user: { $in: ids } }),
    Leave.find({ status: 'approved', fromDate: { $lte: date }, toDate: { $gte: date }, user: { $in: ids } }),
  ]);
  const recMap = new Map(records.map((r) => [String(r.user), r]));
  const onLeave = new Set(leaves.map((l) => String(l.user)));

  const counts = { present: 0, late: 0, absent: 0, leave: 0, not_in: 0, off: 0, upcoming: 0 };
  const rows = staff.map((u) => {
    const rec = recMap.get(String(u._id));
    let status;
    if (rec) status = rec.status;
    else if (off) status = 'off';
    else if (onLeave.has(String(u._id))) status = 'leave';
    else if (date > today) status = 'upcoming';
    else if (date === today) status = 'not_in';
    else status = 'absent';
    counts[status] += 1;
    return {
      user: {
        _id: u._id, name: u.name, code: u.code, role: u.role, designation: u.designation, shift: u.shift,
      },
      status,
      record: rec || null,
    };
  });
  res.json({ date, isOffDay: off, holiday: holidayOn(settings, date)?.name || null, counts, rows });
});

// Admin: create or correct a day's record.
export const manualEntry = asyncHandler(async (req, res) => {
  const { user: userId, date, checkIn: inT, checkOut: outT, status, note } = req.body || {};
  if (!DATE_RE.test(date || '')) throw new HttpError(400, 'A valid date is required');
  if (!note || !String(note).trim()) throw new HttpError(400, 'Please give a reason for this manual entry');
  if (date > dateKey()) throw new HttpError(400, 'You cannot record attendance for a future date');

  const user = await User.findById(userId);
  if (!user || !STAFF_ROLES.includes(user.role)) throw new HttpError(404, 'Employee or intern not found');

  let record = await Attendance.findOne({ user: user._id, date });
  if (!record) record = new Attendance({ user: user._id, date });

  if (inT) {
    if (!TIME_RE.test(inT) || (outT && !TIME_RE.test(outT))) throw new HttpError(400, 'Times must be HH:mm');
    const inDate = dateFromKey(date, inT);
    const outDate = outT ? dateFromKey(date, outT) : null;
    if (outDate && outDate <= inDate) throw new HttpError(400, 'Exit time must be after entry time');
    record.checkIn = inDate;
    record.checkOut = outDate || undefined;
    record.checkInMethod = 'manual';
    record.checkOutMethod = outDate ? 'manual' : undefined;
    Object.assign(record, calcAttendance(user, inDate, outDate));
  } else if (['absent', 'leave'].includes(status)) {
    record.checkIn = undefined;
    record.checkOut = undefined;
    Object.assign(record, { status, lateMinutes: 0, earlyLeaveMinutes: 0, workMinutes: 0 });
  } else {
    throw new HttpError(400, 'Provide an entry time, or mark the day as absent / leave');
  }
  record.note = String(note).trim();
  record.editedBy = req.user._id;
  await record.save();
  res.json({ record });
});

export const deleteRecord = asyncHandler(async (req, res) => {
  const rec = await Attendance.findById(req.params.id);
  if (!rec) throw new HttpError(404, 'Record not found');
  await rec.deleteOne();
  res.json({ message: 'Deleted' });
});
