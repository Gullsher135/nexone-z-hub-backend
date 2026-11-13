import { Batch } from '../models/Batch.js';
import { User } from '../models/User.js';
import { StudentAttendance } from '../models/StudentAttendance.js';
import { Course, Enrollment } from '../models/lms.js';
import { HttpError, asyncHandler, pick } from '../utils/helpers.js';

const FIELDS = ['name', 'course', 'instructor', 'schedule', 'startDate', 'endDate', 'isActive'];

export const listBatches = asyncHandler(async (req, res) => {
  const filter = req.query.isActive ? { isActive: req.query.isActive === 'true' } : {};
  const batches = await Batch.find(filter).sort({ createdAt: -1 }).lean();
  const counts = await User.aggregate([
    { $match: { role: 'student', isActive: true, batch: { $in: batches.map((b) => b._id) } } },
    { $group: { _id: '$batch', n: { $sum: 1 } } },
  ]);
  const map = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json({ items: batches.map((b) => ({ ...b, studentCount: map.get(String(b._id)) || 0 })) });
});

// A batch may be linked to a course (courseId). The course title is kept in `course` for display.
async function courseLink(body) {
  if (body.courseId === undefined) return {};
  if (!body.courseId) return { courseId: undefined, course: body.course || undefined };
  const c = await Course.findById(body.courseId).select('title');
  if (!c) throw new HttpError(400, 'Course not found');
  return { courseId: c._id, course: c.title };
}

export const createBatch = asyncHandler(async (req, res) => {
  if (!req.body?.name) throw new HttpError(400, 'Batch name is required');
  const batch = await Batch.create({ ...pick(req.body, FIELDS), ...(await courseLink(req.body)) });
  res.status(201).json({ batch });
});

export const updateBatch = asyncHandler(async (req, res) => {
  const batch = await Batch.findById(req.params.id);
  if (!batch) throw new HttpError(404, 'Batch not found');
  Object.assign(batch, pick(req.body, FIELDS), await courseLink(req.body));
  await batch.save();
  res.json({ batch });
});

export const deleteBatch = asyncHandler(async (req, res) => {
  const batch = await Batch.findById(req.params.id);
  if (!batch) throw new HttpError(404, 'Batch not found');
  const [students, marks, enrolled] = await Promise.all([
    User.exists({ batch: batch._id }),
    StudentAttendance.exists({ batch: batch._id }),
    Enrollment.exists({ batch: batch._id }),
  ]);
  if (students || marks || enrolled) {
    throw new HttpError(409, 'This batch has students or attendance. Mark it inactive instead.');
  }
  await batch.deleteOne();
  res.json({ message: 'Deleted' });
});
