import { StudentAttendance } from '../models/StudentAttendance.js';
import { User } from '../models/User.js';
import { Batch } from '../models/Batch.js';
import { Course } from '../models/lms.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { DATE_RE, MONTH_RE, currentMonth, dateKey, monthRange } from '../utils/time.js';

const STATUSES = ['present', 'absent', 'late', 'leave'];

// Admin may mark any batch. A teacher may only work with batches that belong to a course they teach.
async function assertBatchAccess(user, batchId) {
  if (user.role === 'admin') return;
  const b = await Batch.findById(batchId).select('courseId');
  if (!b?.courseId || !(await Course.exists({ _id: b.courseId, instructors: user._id }))) {
    throw new HttpError(403, 'You can only take attendance for batches of your own courses');
  }
}

// Natural sort (roll no. 2 before 10), done in JS so it works on any MongoDB-compatible server.
const studentsOf = async (batch) => {
  const list = await User.find({ role: 'student', isActive: true, batch }).select('name code rollNo phone');
  const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'en', { numeric: true });
  return list.sort((a, b) => cmp(a.rollNo, b.rollNo) || cmp(a.name, b.name));
};

export const getSheet = asyncHandler(async (req, res) => {
  const { batch } = req.query;
  const date = req.query.date || dateKey();
  if (!batch) throw new HttpError(400, 'batch is required');
  if (!DATE_RE.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  await assertBatchAccess(req.user, batch);
  const b = await Batch.findById(batch);
  if (!b) throw new HttpError(404, 'Batch not found');

  const students = await studentsOf(batch);
  const marks = await StudentAttendance.find({ date, student: { $in: students.map((s) => s._id) } });
  const map = new Map(marks.map((m) => [String(m.student), m]));
  res.json({
    batch: b,
    date,
    marked: marks.length > 0,
    rows: students.map((s) => ({
      student: s,
      status: map.get(String(s._id))?.status || null,
      note: map.get(String(s._id))?.note || '',
    })),
  });
});

// Save the whole sheet for one batch and day.
export const saveSheet = asyncHandler(async (req, res) => {
  const { batch, date, records } = req.body || {};
  if (!DATE_RE.test(date || '')) throw new HttpError(400, 'A valid date is required');
  if (date > dateKey()) throw new HttpError(400, 'You cannot mark attendance for a future date');
  if (!Array.isArray(records)) throw new HttpError(400, 'records must be an array');
  await assertBatchAccess(req.user, batch);
  const b = await Batch.findById(batch);
  if (!b) throw new HttpError(404, 'Batch not found');

  const valid = new Set((await User.find({ role: 'student', batch }).select('_id')).map((s) => String(s._id)));
  const ops = [];
  for (const r of records) {
    if (!valid.has(String(r.student))) throw new HttpError(400, 'A student does not belong to this batch');
    if (!r.status) {
      ops.push({ deleteOne: { filter: { student: r.student, date } } });
    } else {
      if (!STATUSES.includes(r.status)) throw new HttpError(400, `Invalid status: ${r.status}`);
      ops.push({
        updateOne: {
          filter: { student: r.student, date },
          update: { $set: { batch, status: r.status, note: r.note || '', markedBy: req.user._id } },
          upsert: true,
        },
      });
    }
  }
  if (ops.length) await StudentAttendance.bulkWrite(ops);
  res.json({ message: 'Attendance saved', saved: ops.length });
});

export const batchSummary = asyncHandler(async (req, res) => {
  const { batch } = req.query;
  const month = req.query.month || currentMonth();
  if (!batch) throw new HttpError(400, 'batch is required');
  if (!MONTH_RE.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
  await assertBatchAccess(req.user, batch);
  const { from, to } = monthRange(month);

  const students = await studentsOf(batch);
  const marks = await StudentAttendance.find({
    batch, date: { $gte: from, $lte: to },
  });
  const classDays = new Set(marks.map((m) => m.date)).size;

  const items = students.map((s) => {
    const mine = marks.filter((m) => String(m.student) === String(s._id));
    const count = (st) => mine.filter((m) => m.status === st).length;
    const attended = count('present') + count('late');
    const counted = mine.length - count('leave');
    return {
      student: s,
      present: count('present'),
      late: count('late'),
      absent: count('absent'),
      leave: count('leave'),
      percent: counted > 0 ? Math.round((attended / counted) * 100) : null,
    };
  });
  res.json({ month, classDays, items });
});

export const studentHistory = asyncHandler(async (req, res) => {
  const student = await User.findOne({ _id: req.params.id, role: 'student' }).populate('batch', 'name');
  if (!student) throw new HttpError(404, 'Student not found');
  const records = await StudentAttendance.find({ student: student._id }).sort({ date: -1 }).limit(200);
  res.json({ student, records });
});
