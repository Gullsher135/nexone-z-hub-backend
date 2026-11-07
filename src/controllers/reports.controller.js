import { User, STAFF_ROLES } from '../models/User.js';
import { Attendance } from '../models/Attendance.js';
import { StudentAttendance } from '../models/StudentAttendance.js';
import { Batch } from '../models/Batch.js';
import { Leave } from '../models/Leave.js';
import { getSettings } from '../models/Setting.js';
import { HttpError, asyncHandler, csvEscape } from '../utils/helpers.js';
import { MONTH_RE, addDays, currentMonth, dateKey, timeKey } from '../utils/time.js';
import { employedOn, isOffDay } from '../utils/attendanceCalc.js';
import { monthSummaryFor, userMonthRows } from '../utils/reports.js';

const monthParam = (req) => {
  const month = req.query.month || currentMonth();
  if (!MONTH_RE.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
  return month;
};

async function staffFor(req) {
  const filter = { role: { $in: STAFF_ROLES } };
  if (req.query.role && STAFF_ROLES.includes(req.query.role)) filter.role = req.query.role;
  if (req.query.includeInactive !== 'true') filter.isActive = true;
  return User.find(filter).sort({ name: 1 });
}

export const summary = asyncHandler(async (req, res) => {
  const month = monthParam(req);
  const settings = await getSettings();
  const users = await staffFor(req);
  res.json({ month, items: await monthSummaryFor(users, month, settings) });
});

export const userReport = asyncHandler(async (req, res) => {
  const month = monthParam(req);
  const user = await User.findById(req.params.id);
  if (!user || !STAFF_ROLES.includes(user.role)) throw new HttpError(404, 'Employee or intern not found');
  const settings = await getSettings();
  res.json({ user, ...(await userMonthRows(user, month, settings)) });
});

const hours = (mins) => (mins / 60).toFixed(1);

export const exportCsv = asyncHandler(async (req, res) => {
  const month = monthParam(req);
  const settings = await getSettings();
  const users = await staffFor(req);

  // detailed = one line per day, otherwise one line per person
  let lines;
  if (req.query.detail === 'daily') {
    lines = [['Code', 'Name', 'Role', 'Date', 'Status', 'Check in', 'Check out', 'Hours', 'Late (min)', 'Note']];
    for (const u of users) {
      const { rows } = await userMonthRows(u, month, settings);
      rows
        .filter((r) => !['na', 'upcoming'].includes(r.status))
        .forEach((r) =>
          lines.push([u.code, u.name, u.role, r.date, r.status, r.checkIn, r.checkOut,
            r.workMinutes ? hours(r.workMinutes) : '', r.lateMinutes || '', r.note])
        );
    }
  } else {
    const items = await monthSummaryFor(users, month, settings);
    lines = [['Code', 'Name', 'Role', 'Working days', 'Present', 'Late', 'Absent', 'Leave',
      'Missed checkouts', 'Total hours', 'Avg check in', 'Avg check out', 'Attendance %']];
    items.forEach(({ user, summary: s }) =>
      lines.push([user.code, user.name, user.role, s.workingDaysElapsed, s.present, s.late, s.absent,
        s.leave, s.missedCheckouts, hours(s.totalWorkMinutes), s.avgCheckIn, s.avgCheckOut, s.attendancePercent]));
  }

  const csv = lines.map((l) => l.map(csvEscape).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${month}.csv"`);
  res.send(`\uFEFF${csv}`);
});

export const dashboard = asyncHandler(async (_req, res) => {
  const today = dateKey();
  const settings = await getSettings();
  const off = isOffDay(settings, today);

  const staff = (await User.find({ role: { $in: STAFF_ROLES }, isActive: true })).filter((u) =>
    employedOn(u, today)
  );
  const ids = staff.map((u) => u._id);

  const from7 = addDays(today, -6);
  const [records, leaves, last7, pendingLeaves, studentsTotal, batches, studentsPresent, recent] = await Promise.all([
    Attendance.find({ date: today, user: { $in: ids } }),
    Leave.find({ status: 'approved', fromDate: { $lte: today }, toDate: { $gte: today }, user: { $in: ids } }),
    Attendance.aggregate([
      { $match: { date: { $gte: from7, $lte: today }, status: { $in: ['present', 'late'] } } },
      { $group: { _id: '$date', n: { $sum: 1 } } },
    ]),
    Leave.countDocuments({ status: 'pending' }),
    User.countDocuments({ role: 'student', isActive: true }),
    Batch.countDocuments({ isActive: true }),
    StudentAttendance.countDocuments({ date: today, status: { $in: ['present', 'late'] } }),
    Attendance.find({ date: today }).sort({ updatedAt: -1 }).limit(8).populate('user', 'name role code'),
  ]);

  const recSet = new Set(records.map((r) => String(r.user)));
  const present = records.filter((r) => ['present', 'late'].includes(r.status)).length;
  const late = records.filter((r) => r.status === 'late').length;
  const onLeave = leaves.filter((l) => !recSet.has(String(l.user))).length;
  const notIn = off ? 0 : Math.max(0, staff.length - recSet.size - onLeave);

  const map = new Map(last7.map((x) => [x._id, x.n]));
  const trend = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(from7, i);
    return { date: d, present: map.get(d) || 0 };
  });

  res.json({
    date: today,
    isOffDay: off,
    staff: {
      total: staff.length,
      employees: staff.filter((u) => u.role === 'employee').length,
      interns: staff.filter((u) => u.role === 'intern').length,
      present, late, onLeave, notIn,
    },
    students: { total: studentsTotal, batches, presentToday: studentsPresent },
    pendingLeaves,
    trend,
    recent: recent.map((r) => ({
      user: r.user, status: r.status, checkIn: timeKey(r.checkIn), checkOut: timeKey(r.checkOut),
    })),
  });
});
