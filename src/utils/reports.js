import { Attendance } from '../models/Attendance.js';
import { Leave } from '../models/Leave.js';
import {
  datesBetween, dateKey, minutesOfDay, minutesToHHMM, monthRange, timeKey, weekdayOfKey,
} from './time.js';
import { employedOn, holidayOn, isOffDay, leaveDaySet } from './attendanceCalc.js';

// Build one row per calendar day of the month for a single staff member.
export function buildRows(user, month, settings, records, leaves) {
  const { from, to } = monthRange(month);
  const today = dateKey();
  const recMap = new Map(records.map((r) => [r.date, r]));
  const leaveSet = leaveDaySet(leaves, user._id);

  return datesBetween(from, to).map((d) => {
    const rec = recMap.get(d);
    const employed = employedOn(user, d);
    const off = isOffDay(settings, d);
    let status;
    if (rec) status = rec.status;
    else if (!employed) status = 'na';
    else if (off) status = 'off';
    else if (leaveSet.has(d)) status = 'leave';
    else if (d > today) status = 'upcoming';
    else if (d === today) status = 'not_in';
    else status = 'absent';

    return {
      date: d,
      weekday: weekdayOfKey(d),
      status,
      off,
      holiday: holidayOn(settings, d)?.name || null,
      checkIn: rec?.checkIn ? timeKey(rec.checkIn) : null,
      checkOut: rec?.checkOut ? timeKey(rec.checkOut) : null,
      workMinutes: rec?.workMinutes || 0,
      lateMinutes: rec?.lateMinutes || 0,
      earlyLeaveMinutes: rec?.earlyLeaveMinutes || 0,
      method: rec?.checkInMethod || null,
      note: rec?.note || null,
      missedCheckout: !!(rec?.checkIn && !rec.checkOut && d < today),
      recordId: rec?._id || null,
    };
  });
}

export function summarize(rows) {
  const elapsed = rows.filter((r) => !r.off && !['na', 'upcoming', 'not_in'].includes(r.status));
  const worked = rows.filter((r) => ['present', 'late'].includes(r.status) && r.checkIn);
  const workedOnWorkingDays = elapsed.filter((r) => ['present', 'late'].includes(r.status));
  const leave = elapsed.filter((r) => r.status === 'leave').length;
  const absent = elapsed.filter((r) => r.status === 'absent').length;
  const late = worked.filter((r) => r.status === 'late').length;

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const avgIn = mean(worked.map((r) => minutesOfDay(new Date(`${r.date}T${r.checkIn}:00+05:00`))));
  const outs = worked.filter((r) => r.checkOut);
  const avgOut = mean(outs.map((r) => minutesOfDay(new Date(`${r.date}T${r.checkOut}:00+05:00`))));
  const denom = elapsed.length - leave;

  return {
    workingDaysElapsed: elapsed.length,
    present: worked.length,
    late,
    absent,
    leave,
    missedCheckouts: rows.filter((r) => r.missedCheckout).length,
    totalWorkMinutes: rows.reduce((a, r) => a + r.workMinutes, 0),
    totalLateMinutes: rows.reduce((a, r) => a + r.lateMinutes, 0),
    avgCheckIn: avgIn == null ? null : minutesToHHMM(avgIn),
    avgCheckOut: avgOut == null ? null : minutesToHHMM(avgOut),
    attendancePercent: denom > 0 ? Math.min(100, Math.round((workedOnWorkingDays.length / denom) * 100)) : null,
  };
}

export async function userMonthRows(user, month, settings) {
  const { from, to } = monthRange(month);
  const [records, leaves] = await Promise.all([
    Attendance.find({ user: user._id, date: { $gte: from, $lte: to } }),
    Leave.find({ user: user._id, status: 'approved', fromDate: { $lte: to }, toDate: { $gte: from } }),
  ]);
  const rows = buildRows(user, month, settings, records, leaves);
  return { month, rows, summary: summarize(rows) };
}

export async function monthSummaryFor(users, month, settings) {
  const { from, to } = monthRange(month);
  const ids = users.map((u) => u._id);
  const [records, leaves] = await Promise.all([
    Attendance.find({ user: { $in: ids }, date: { $gte: from, $lte: to } }),
    Leave.find({ user: { $in: ids }, status: 'approved', fromDate: { $lte: to }, toDate: { $gte: from } }),
  ]);
  const byUser = new Map();
  records.forEach((r) => {
    const k = String(r.user);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(r);
  });
  return users.map((u) => {
    const rows = buildRows(u, month, settings, byUser.get(String(u._id)) || [], leaves);
    return {
      user: {
        _id: u._id, name: u.name, code: u.code, role: u.role, designation: u.designation, isActive: u.isActive,
      },
      summary: summarize(rows),
    };
  });
}
