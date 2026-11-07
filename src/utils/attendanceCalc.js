import {
  dateKey, datesBetween, hhmmToMinutes, minutesOfDay, weekdayOfKey,
} from './time.js';

const DEFAULT_SHIFT = { start: '09:00', end: '18:00', graceMinutes: 15 };

export function calcAttendance(user, checkIn, checkOut) {
  const shift = { ...DEFAULT_SHIFT, ...(user.shift?.toObject?.() || user.shift || {}) };
  const start = hhmmToMinutes(shift.start);
  const end = hhmmToMinutes(shift.end);
  const grace = shift.graceMinutes ?? 15;

  const inMin = minutesOfDay(checkIn);
  const lateMinutes = inMin > start + grace ? inMin - start : 0;
  const result = {
    status: lateMinutes > 0 ? 'late' : 'present',
    lateMinutes,
    earlyLeaveMinutes: 0,
    workMinutes: 0,
  };
  if (checkOut) {
    result.workMinutes = Math.max(0, Math.round((checkOut - checkIn) / 60000));
    result.earlyLeaveMinutes = Math.max(0, end - minutesOfDay(checkOut));
  }
  return result;
}

export const holidayOn = (settings, key) =>
  settings.holidays?.find((h) => h.date === key) || null;

export const isOffDay = (settings, key) =>
  (settings.weekendDays || []).includes(weekdayOfKey(key)) || !!holidayOn(settings, key);

export function employedOn(user, d) {
  const joined = user.joiningDate || dateKey(user.createdAt || new Date());
  if (d < joined) return false;
  if (user.role === 'intern') {
    const { startDate, endDate } = user.internship || {};
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
  }
  return true;
}

// Days a staff member was expected to work inside [from, to].
export function workingDaysFor(user, from, to, settings) {
  return datesBetween(from, to).filter((d) => employedOn(user, d) && !isOffDay(settings, d));
}

export function leaveDaySet(leaves, userId) {
  const set = new Set();
  leaves
    .filter((l) => String(l.user) === String(userId))
    .forEach((l) => datesBetween(l.fromDate, l.toDate).forEach((d) => set.add(d)));
  return set;
}

export const internExpired = (user) =>
  user.role === 'intern' && user.internship?.endDate && user.internship.endDate < dateKey();
