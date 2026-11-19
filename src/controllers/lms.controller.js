import { sendPush } from '../utils/push.js';
import { audit } from '../utils/audit.js';
import crypto from 'crypto';
import { Course, Enrollment, Assignment, Submission, Quiz, QuizAttempt, Announcement, StoredFile, Presentation, PresentationEntry } from '../models/lms.js';
import mongoose from 'mongoose';
import { User, STAFF_ROLES } from '../models/User.js';
import { Batch } from '../models/Batch.js';
import { StudentAttendance } from '../models/StudentAttendance.js';
import { deleteStoredFiles } from '../utils/fileStore.js';
import { computeProgress, progressKey, visibleForBatch } from '../utils/progress.js';
import { nextSeq } from '../models/Counter.js';
import { HttpError, asyncHandler, pick, randomPassword } from '../utils/helpers.js';
import { dateKey, DATE_RE } from '../utils/time.js';

const isAdmin = (u) => u.role === 'admin';
const isStudent = (u) => u.role === 'student';
const sid = (v) => String(v?._id || v);

const lessonIds = (course) => course.sections.flatMap((s) => s.lessons.map((l) => sid(l._id)));
const percent = (done, total) => (total ? Math.round((done / total) * 100) : 0);
const COURSE_FIELDS = ['title', 'category', 'level', 'summary', 'description', 'color', 'durationWeeks', 'autoCertificate'];

// Who can be a course instructor: a teacher-only login, or an employee/intern who was given teacher access.
const TEACHER_FILTER = { isActive: true, $or: [{ role: 'teacher' }, { role: { $in: STAFF_ROLES }, isTeacher: true }] };
async function onlyTeachers(ids, keep = []) {
  const wanted = [...new Set((ids || []).map(String))].filter((i) => mongoose.isValidObjectId(i));
  const ok = await User.find({ _id: { $in: wanted }, ...TEACHER_FILTER }).select('_id').lean();
  const keepSet = new Set(keep.map(String)); // someone already teaching the course is never dropped silently
  return wanted.filter((i) => keepSet.has(i) || ok.some((o) => String(o._id) === i));
}

const canManage = (user, course) =>
  isAdmin(user) || (!isStudent(user) && course.instructors.some((i) => sid(i) === sid(user._id)));

// Loads a course and checks the caller may see it. Returns { course, manage, enrollment }.
async function access(req, id = req.params.id) {
  const course = await Course.findById(id);
  if (!course) throw new HttpError(404, 'Course not found');
  const manage = canManage(req.user, course);
  let enrollment = null;
  if (isStudent(req.user)) {
    enrollment = await Enrollment.findOne({ course: course._id, student: req.user._id });
    if (!enrollment || course.status !== 'published') throw new HttpError(403, 'You are not enrolled in this course');
  } else if (!manage) {
    throw new HttpError(403, 'You do not teach this course');
  }
  return { course, manage, enrollment };
}

export { access as courseAccess };
export { batchFor, cleanBatches, withBatchNames, planFiles, applyPlan, cleanLinks }; // shared with the presentation module

// The batch a student sits in for this course: their own enrolment first, then their general batch.
// A batch that belongs to another course is ignored.
async function batchFor(course, enrollment, user) {
  const bid = enrollment?.batch || user.batch;
  if (!bid) return null;
  if (enrollment?.batch) return sid(bid);
  const b = await Batch.findById(bid).select('courseId').lean();
  return b && (!b.courseId || sid(b.courseId) === sid(course._id)) ? sid(bid) : null;
}

// Which batches an assignment or quiz is for. An empty list means every batch of the course.
async function cleanBatches(course, raw) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(String))];
  if (!ids.length) return [];
  if (ids.some((i) => !mongoose.isValidObjectId(i))) throw new HttpError(400, 'Invalid batch');
  const found = await Batch.find({ _id: { $in: ids }, courseId: course._id }).select('_id').lean();
  if (found.length !== ids.length) throw new HttpError(400, 'Choose batches of this course only');
  return ids;
}

// Adds batchNames (for the teacher screens) to a list of assignments or quizzes.
async function withBatchNames(items) {
  const ids = [...new Set(items.flatMap((i) => (i.batches || []).map(sid)))];
  const names = new Map((ids.length ? await Batch.find({ _id: { $in: ids } }).select('name').lean() : []).map((b) => [sid(b._id), b.name]));
  return items.map((i) => ({ ...i, batchNames: (i.batches || []).map((b) => names.get(sid(b))).filter(Boolean) }));
}

// ----- courses -----
export const listCourses = asyncHandler(async (req, res) => {
  const u = req.user;
  let courses;
  let enrollMap = new Map();
  if (isStudent(u)) {
    const en = await Enrollment.find({ student: u._id }).lean();
    enrollMap = new Map(en.map((e) => [sid(e.course), e]));
    courses = await Course.find({ _id: { $in: [...enrollMap.keys()] }, status: 'published' }).sort({ createdAt: -1 }).lean();
  } else {
    courses = await Course.find(isAdmin(u) ? {} : { instructors: u._id }).sort({ createdAt: -1 }).lean();
  }
  const counts = await Enrollment.aggregate([
    { $match: { course: { $in: courses.map((c) => c._id) } } },
    { $group: { _id: '$course', n: { $sum: 1 } } },
  ]);
  const cmap = new Map(counts.map((c) => [sid(c._id), c.n]));
  const prog = isStudent(u)
    ? await computeProgress(courses.map((c) => ({ course: c, enrollment: enrollMap.get(sid(c._id)), student: u })))
    : new Map();
  const items = courses.map((c) => {
    const total = c.sections.reduce((a, s) => a + s.lessons.length, 0);
    const e = enrollMap.get(sid(c._id));
    return {
      _id: c._id, code: c.code, title: c.title, category: c.category, level: c.level, summary: c.summary,
      color: c.color, durationWeeks: c.durationWeeks, status: c.status, lessonCount: total,
      studentCount: cmap.get(sid(c._id)) || 0,
      ...(e ? { progress: prog.get(progressKey(c, u))?.overall ?? 0, completed: !!e.completedAt, certificate: e.certificate?.code } : {}),
    };
  });
  res.json({ items });
});

export const createCourse = asyncHandler(async (req, res) => {
  if (!req.body?.title) throw new HttpError(400, 'Course title is required');
  const n = await nextSeq('course');
  const data = pick(req.body, COURSE_FIELDS);
  if (Array.isArray(req.body.instructors)) data.instructors = await onlyTeachers(req.body.instructors);
  const course = await Course.create({ ...data, code: `NZL-${String(n).padStart(3, '0')}` });
  res.status(201).json({ course });
});

export const getCourse = asyncHandler(async (req, res) => {
  const { course, manage, enrollment } = await access(req);
  await course.populate('instructors', 'name email role');
  const obj = course.toObject();
  const total = lessonIds(course).length;
  let overall = 0;
  if (enrollment) overall = (await computeProgress([{ course, enrollment, student: req.user }])).get(progressKey(course, req.user))?.overall ?? 0;
  res.json({
    course: obj,
    manage,
    lessonCount: total,
    enrollment: enrollment
      ? {
        completedLessons: enrollment.completedLessons.map(String), lastLesson: enrollment.lastLesson,
        progress: overall, // attendance + assignments + quizzes
        lessons: { done: enrollment.completedLessons.length, total, percent: percent(enrollment.completedLessons.length, total) },
        completedAt: enrollment.completedAt, certificate: enrollment.certificate?.code ? enrollment.certificate : undefined,
      }
      : undefined,
  });
});

export const updateCourse = asyncHandler(async (req, res) => {
  const { course } = await access(req);
  if (!canManage(req.user, course)) throw new HttpError(403, 'Not allowed');
  // Certificates are the admin's call: a teacher cannot switch automatic certificates on or off.
  Object.assign(course, pick(req.body, isAdmin(req.user) ? COURSE_FIELDS : COURSE_FIELDS.filter((f) => f !== 'autoCertificate')));
  if (req.body.status && ['draft', 'published'].includes(req.body.status)) course.status = req.body.status;
  if (isAdmin(req.user) && Array.isArray(req.body.instructors)) course.instructors = await onlyTeachers(req.body.instructors, course.instructors);
  await course.save();
  res.json({ course });
});

export const saveCurriculum = asyncHandler(async (req, res) => {
  const { course } = await access(req);
  const sections = req.body?.sections;
  if (!Array.isArray(sections)) throw new HttpError(400, 'sections must be a list');
  course.sections = sections.map((s) => ({
    ...(s._id ? { _id: s._id } : {}),
    title: s.title,
    lessons: (s.lessons || []).map((l) => ({ ...(l._id ? { _id: l._id } : {}), ...pick(l, ['title', 'type', 'content', 'url', 'durationMin']) })),
  }));
  await course.save();
  // keep progress consistent if lessons were removed
  const valid = new Set(lessonIds(course));
  const ens = await Enrollment.find({ course: course._id, completedLessons: { $exists: true, $ne: [] } });
  await Promise.all(ens.map((e) => {
    const kept = e.completedLessons.filter((l) => valid.has(String(l)));
    if (kept.length === e.completedLessons.length) return null;
    e.completedLessons = kept;
    return e.save();
  }));
  res.json({ course });
});

export const deleteCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) throw new HttpError(404, 'Course not found');
  const f = { course: course._id };
  await Promise.all([Enrollment.deleteMany(f), Assignment.deleteMany(f), Submission.deleteMany(f), Quiz.deleteMany(f), QuizAttempt.deleteMany(f), Announcement.deleteMany(f), Presentation.deleteMany(f), PresentationEntry.deleteMany(f), deleteStoredFiles(f)]);
  await Batch.updateMany({ courseId: course._id }, { $unset: { courseId: '' } }).catch(() => {});
  await course.deleteOne();
  res.json({ message: 'Deleted' });
});

// ----- enrolment -----
export const listStudents = asyncHandler(async (req, res) => {
  const { course } = await access(req);
  const total = lessonIds(course).length;
  const ens = (await Enrollment.find({ course: course._id }).populate('student', 'name code email batch isActive').lean()).filter((e) => e.student);
  const prog = await computeProgress(ens.map((e) => ({ course, enrollment: e, student: e.student })));
  const batchIds = [...new Set(ens.map((e) => e.batch || e.student.batch).filter(Boolean).map(sid))];
  const batchName = new Map((await Batch.find({ _id: { $in: batchIds } }).select('name').lean()).map((b) => [sid(b._id), b.name]));
  res.json({
    items: ens.map((e) => {
      const p = prog.get(progressKey(course, e.student));
      const bid = e.batch || e.student.batch;
      return {
        _id: e._id, student: e.student,
        progress: p.overall, hasData: p.hasData, weakest: p.weakest,
        parts: { attendance: p.parts.attendance.percent, assignments: p.parts.assignments.percent, quizzes: p.parts.quizzes.percent },
        lessons: { done: e.completedLessons.length, total, percent: percent(e.completedLessons.length, total) },
        batch: bid ? { _id: bid, name: batchName.get(sid(bid)) || '' } : null,
        completedAt: e.completedAt, certificate: e.certificate?.code, enrolledAt: e.createdAt,
      };
    }),
  });
});

export const enroll = asyncHandler(async (req, res) => {
  const { course } = await access(req);
  const ids = new Set((req.body.studentIds || []).map(String));
  if (req.body.batchId) {
    const b = await Batch.findById(req.body.batchId).select('courseId');
    if (!b) throw new HttpError(400, 'Batch not found');
    if (b.courseId && sid(b.courseId) !== sid(course._id)) throw new HttpError(400, 'That batch belongs to another course');
    const inBatch = await User.find({ role: 'student', isActive: true, batch: req.body.batchId }).select('_id');
    inBatch.forEach((s) => ids.add(sid(s)));
  }
  if (!ids.size) throw new HttpError(400, 'Choose at least one student or a batch');
  const students = await User.find({ _id: { $in: [...ids] }, role: 'student' }).select('_id');
  let added = 0;
  for (const s of students) {
    const r = await Enrollment.updateOne({ course: course._id, student: s._id }, { $setOnInsert: { course: course._id, student: s._id, completedLessons: [] } }, { upsert: true });
    if (r.upsertedCount) added++;
  }
  res.json({ added, skipped: students.length - added });
});

export const unenroll = asyncHandler(async (req, res) => {
  const { course } = await access(req);
  await Enrollment.deleteOne({ course: course._id, student: req.params.studentId });
  res.json({ message: 'Removed' });
});

// ----- progress and certificates -----
const certCode = () => `NZ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

async function issueCertificate(enrollment) {
  if (enrollment.certificate?.code) return enrollment.certificate;
  for (let i = 0; i < 5; i++) {
    try {
      enrollment.certificate = { code: certCode(), issuedAt: new Date() };
      await enrollment.save();
      return enrollment.certificate;
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  throw new HttpError(500, 'Could not issue certificate, try again');
}

export const setProgress = asyncHandler(async (req, res) => {
  if (!isStudent(req.user)) throw new HttpError(403, 'Only students track progress');
  const { course, enrollment } = await access(req);
  const { lessonId, done = true } = req.body || {};
  const all = lessonIds(course);
  if (!all.includes(String(lessonId))) throw new HttpError(400, 'Lesson not found');
  const set = new Set(enrollment.completedLessons.map(String));
  done ? set.add(String(lessonId)) : set.delete(String(lessonId));
  enrollment.completedLessons = [...set];
  enrollment.lastLesson = lessonId;
  const complete = all.length > 0 && all.every((l) => set.has(l));
  enrollment.completedAt = complete ? enrollment.completedAt || new Date() : undefined;
  await enrollment.save();
  if (complete && course.autoCertificate) await issueCertificate(enrollment);
  const overall = (await computeProgress([{ course, enrollment, student: req.user }])).get(progressKey(course, req.user))?.overall ?? 0;
  res.json({ progress: overall, lessons: { done: set.size, total: all.length, percent: percent(set.size, all.length) }, completedAt: enrollment.completedAt, certificate: enrollment.certificate?.code ? enrollment.certificate : undefined });
});

export const issueManual = asyncHandler(async (req, res) => {
  const { course } = await access(req);
  const e = await Enrollment.findOne({ course: course._id, student: req.params.studentId });
  if (!e) throw new HttpError(404, 'Student is not enrolled');
  e.completedAt = e.completedAt || new Date();
  const cert = await issueCertificate(e);
  res.json({ certificate: cert });
});

export const verifyCertificate = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const e = await Enrollment.findOne({ 'certificate.code': code }).populate('student', 'name code').populate('course', 'title code durationWeeks category');
  if (!e || !e.student || !e.course) throw new HttpError(404, 'No certificate found with this code');
  res.json({ valid: true, code, student: e.student.name, studentCode: e.student.code, course: e.course.title, courseCode: e.course.code, category: e.course.category || '', issuedAt: e.certificate.issuedAt, completedAt: e.completedAt });
});

// ----- assignments -----
export const listAssignments = asyncHandler(async (req, res) => {
  const { course, manage, enrollment } = await access(req);
  let items = await Assignment.find({ course: course._id }).sort({ dueDate: 1, createdAt: -1 }).lean();
  if (!manage) {
    const eb = await batchFor(course, enrollment, req.user);
    items = items.filter((a) => visibleForBatch(a, eb));
  }
  if (manage) {
    items = await withBatchNames(items);
    const counts = await Submission.aggregate([{ $match: { course: course._id } }, { $group: { _id: '$assignment', n: { $sum: 1 }, graded: { $sum: { $cond: [{ $ifNull: ['$gradedAt', false] }, 1, 0] } } } }]);
    const m = new Map(counts.map((c) => [sid(c._id), c]));
    return res.json({ items: items.map((a) => ({ ...a, submissions: m.get(sid(a._id))?.n || 0, graded: m.get(sid(a._id))?.graded || 0 })) });
  }
  const subs = await Submission.find({ course: course._id, student: req.user._id }).lean();
  const m = new Map(subs.map((s) => [sid(s.assignment), s]));
  res.json({ items: items.map((a) => ({ ...a, submission: m.get(sid(a._id)) || null })) });
});

const ASSIGN_FIELDS = ['title', 'instructions', 'dueDate', 'maxPoints', 'allowLate', 'requireAttachment'];
const MAX_FILES = 5;
const MAX_LINKS = 5;

// Checks the files a teacher or student wants to keep on an assignment or submission.
// Returns the references to save, plus which uploads to mark as used and which old ones to delete.
async function planFiles(rawIds, { course, owner, kind, existing = [] }) {
  const ids = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(String))];
  if (ids.length > MAX_FILES) throw new HttpError(400, `You can attach up to ${MAX_FILES} files`);
  if (ids.some((i) => !mongoose.isValidObjectId(i))) throw new HttpError(400, 'Invalid file');
  const had = new Set(existing.map((x) => sid(x.file)));
  const found = ids.length ? await StoredFile.find({ _id: { $in: ids }, course, kind }).select('-data').lean() : [];
  const byId = new Map(found.map((f) => [sid(f._id), f]));
  const refs = ids.map((id) => {
    const f = byId.get(id);
    const allowed = f && (had.has(id) || (sid(f.owner) === sid(owner) && !f.attached));
    if (!allowed) throw new HttpError(400, 'A file could not be found. Please upload it again.');
    return { file: f._id, name: f.name, size: f.size, mime: f.mime };
  });
  return { refs, add: ids.filter((i) => !had.has(i)), remove: [...had].filter((i) => !ids.includes(i)) };
}
async function applyPlan(plan) {
  if (plan.add.length) await StoredFile.updateMany({ _id: { $in: plan.add } }, { attached: true });
  if (plan.remove.length) await deleteStoredFiles({ _id: { $in: plan.remove } });
}

function cleanLinks(raw) {
  const list = (Array.isArray(raw) ? raw : []).map((l) => String(l || '').trim()).filter(Boolean);
  if (list.length > MAX_LINKS) throw new HttpError(400, `You can add up to ${MAX_LINKS} links`);
  return list.map((l) => {
    let ok = false;
    try { ok = /^https?:$/.test(new URL(l).protocol); } catch { ok = false; }
    if (!ok || l.length > 600) throw new HttpError(400, 'Each link must start with http:// or https://');
    return l;
  });
}
function checkAssign(d) {
  if (d.dueDate && !DATE_RE.test(d.dueDate)) throw new HttpError(400, 'Due date must be YYYY-MM-DD');
}

export const createAssignment = asyncHandler(async (req, res) => {
  const { course } = await access(req);
  if (!req.body?.title) throw new HttpError(400, 'Title is required');
  const data = pick(req.body, ASSIGN_FIELDS);
  checkAssign(data);
  const batches = await cleanBatches(course, req.body.batches);
  const plan = await planFiles(req.body.attachmentIds, { course: course._id, owner: req.user._id, kind: 'assignment' });
  const a = await Assignment.create({ ...data, batches, attachments: plan.refs, course: course._id, createdBy: req.user._id });
  await applyPlan(plan);
  res.status(201).json({ assignment: a });
});

async function ownAssignment(req) {
  const a = await Assignment.findById(req.params.id);
  if (!a) throw new HttpError(404, 'Assignment not found');
  const ctx = await access(req, a.course);
  return { a, ...ctx };
}

export const updateAssignment = asyncHandler(async (req, res) => {
  const { a, manage, course } = await ownAssignment(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  const data = pick(req.body, ASSIGN_FIELDS);
  checkAssign(data);
  if (req.body.batches !== undefined) a.batches = await cleanBatches(course, req.body.batches);
  let plan = null;
  if (req.body.attachmentIds !== undefined) {
    plan = await planFiles(req.body.attachmentIds, { course: a.course, owner: req.user._id, kind: 'assignment', existing: a.attachments });
    a.attachments = plan.refs;
  }
  Object.assign(a, data);
  await a.save();
  if (plan) await applyPlan(plan);
  res.json({ assignment: a });
});

export const deleteAssignment = asyncHandler(async (req, res) => {
  const { a, manage } = await ownAssignment(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  const subs = await Submission.find({ assignment: a._id }).select('files').lean();
  const fileIds = [...a.attachments.map((x) => x.file), ...subs.flatMap((x) => (x.files || []).map((y) => y.file))];
  await Submission.deleteMany({ assignment: a._id });
  if (fileIds.length) await deleteStoredFiles({ _id: { $in: fileIds } });
  await a.deleteOne();
  res.json({ message: 'Deleted' });
});

export const submitAssignment = asyncHandler(async (req, res) => {
  if (!isStudent(req.user)) throw new HttpError(403, 'Only students submit work');
  const { a, course, enrollment } = await ownAssignment(req);
  if (!visibleForBatch(a, await batchFor(course, enrollment, req.user))) throw new HttpError(403, 'This assignment is not for your batch');
  const text = String(req.body?.text || '').trim().slice(0, 10000);
  const links = cleanLinks(req.body?.links ?? (req.body?.link ? [req.body.link] : []));
  const late = !!a.dueDate && dateKey() > a.dueDate;
  if (late && !a.allowLate) throw new HttpError(400, 'The deadline has passed');
  const existing = await Submission.findOne({ assignment: a._id, student: req.user._id });
  if (existing?.gradedAt) throw new HttpError(409, 'This submission is already graded and cannot be changed');
  const plan = await planFiles(req.body?.fileIds, { course: a.course, owner: req.user._id, kind: 'submission', existing: existing?.files || [] });
  if (a.requireAttachment && !plan.refs.length && !links.length) throw new HttpError(400, 'Upload your file or add a link to your work');
  if (!text && !links.length && !plan.refs.length) throw new HttpError(400, 'Upload a file, add a link or write a note');
  const sub = existing || new Submission({ assignment: a._id, course: a.course, student: req.user._id });
  Object.assign(sub, { text, links, link: links[0] || '', files: plan.refs, late, submittedAt: new Date() });
  await sub.save();
  await applyPlan(plan);
  res.status(existing ? 200 : 201).json({ submission: sub });
});

export const listSubmissions = asyncHandler(async (req, res) => {
  const { a, manage } = await ownAssignment(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  const items = await Submission.find({ assignment: a._id }).populate('student', 'name code').sort({ submittedAt: -1 }).lean();
  res.json({ assignment: a, items });
});

export const gradeSubmission = asyncHandler(async (req, res) => {
  const sub = await Submission.findById(req.params.id);
  if (!sub) throw new HttpError(404, 'Submission not found');
  const { manage } = await access(req, sub.course);
  if (!manage) throw new HttpError(403, 'Not allowed');
  const a = await Assignment.findById(sub.assignment);
  const grade = Number(req.body.grade);
  if (!Number.isFinite(grade) || grade < 0 || grade > a.maxPoints) throw new HttpError(400, `Marks must be between 0 and ${a.maxPoints}`);
  const before = sub.gradedAt ? sub.grade : null;
  Object.assign(sub, { grade, feedback: req.body.feedback || '', gradedAt: new Date(), gradedBy: req.user._id });
  await sub.save();
  await audit(req, 'grade.assignment', { entity: 'Submission', entityId: sub._id, summary: `Assignment "${a.title}" marked ${grade}/${a.maxPoints}${before !== null ? ` (was ${before})` : ''}`, details: { student: sub.student, assignment: a._id, before, after: grade } });
  res.json({ submission: sub });
});

// ----- quizzes -----
// Daily quiz: multiple choice / true-false, marked automatically.
// Weekly grand quiz: sections with multiple choice, true-false, short answers and coding questions.
// Choice questions are marked automatically; written ones are marked by the teacher.
const isAuto = (q) => !q.type || q.type === 'mcq' || q.type === 'tf';
const Q_TYPES = ['mcq', 'tf', 'short', 'code'];
const GRACE_MS = 90 * 1000; // a student whose timer just ended can still hand in
const totalOf = (quiz) => quiz.questions.reduce((s, x) => s + x.points, 0);

// Students never get the answer key before they finish (or at all, if the teacher turned reveal off).
const stripAnswers = (q, reveal = false) => ({
  ...q,
  questions: q.questions.map(({ correctIndex, modelAnswer, ...rest }) => (reveal ? { ...rest, correctIndex, modelAnswer } : rest)),
});

// An attempt whose timer ran out long ago and was never handed in is closed with zero marks.
async function settleExpired(filter) {
  await QuizAttempt.updateMany(
    { ...filter, status: 'in_progress', expiresAt: { $lt: new Date(Date.now() - GRACE_MS) } },
    { $set: { status: 'graded', score: 0, autoScore: 0, manualScore: 0, submittedAt: new Date(), comment: 'Not handed in before the time ended.' } }
  );
}

function cleanQuestions(list, kind) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Add at least one question');
  return list.map((q, i) => {
    const n = i + 1;
    const type = Q_TYPES.includes(q.type) ? q.type : 'mcq';
    if (kind !== 'weekly' && !isAuto({ type })) throw new HttpError(400, `Question ${n}: written and coding questions are only for a weekly grand quiz`);
    if (!q.text?.trim()) throw new HttpError(400, `Question ${n} has no text`);
    const points = Number(q.points) || 1;
    if (!Number.isInteger(points) || points < 1 || points > 100) throw new HttpError(400, `Question ${n}: marks must be a whole number from 1 to 100`);
    const base = {
      ...(q._id ? { _id: q._id } : {}),
      type, points,
      section: String(q.section || '').trim().slice(0, 160),
      text: q.text.trim(),
      code: String(q.code || '').slice(0, 4000),
      modelAnswer: String(q.modelAnswer || '').slice(0, 3000),
    };
    if (type === 'tf') {
      const ci = Number(q.correctIndex);
      if (ci !== 0 && ci !== 1) throw new HttpError(400, `Question ${n} needs True or False as the answer`);
      return { ...base, options: ['True', 'False'], correctIndex: ci };
    }
    if (type === 'mcq') {
      const options = (q.options || []).map((o) => String(o).trim()).filter(Boolean);
      if (options.length < 2) throw new HttpError(400, `Question ${n} needs at least two options`);
      const ci = Number(q.correctIndex);
      if (!Number.isInteger(ci) || ci < 0 || ci >= options.length) throw new HttpError(400, `Question ${n} needs a correct answer`);
      return { ...base, options, correctIndex: ci };
    }
    return { ...base, options: [], correctIndex: 0 }; // short / code: marked by the teacher
  });
}

function quizSettings(body) {
  const out = {};
  if (body.kind !== undefined) out.kind = body.kind === 'weekly' ? 'weekly' : 'daily';
  if (body.timeLimit !== undefined) {
    const t = Math.round(Number(body.timeLimit) || 0);
    if (t < 0 || t > 300) throw new HttpError(400, 'Time limit must be between 0 and 300 minutes');
    out.timeLimit = t;
  }
  if (body.revealAnswers !== undefined) out.revealAnswers = !!body.revealAnswers;
  if (body.instructions !== undefined) out.instructions = String(body.instructions || '').slice(0, 3000);
  return out;
}

export const listQuizzes = asyncHandler(async (req, res) => {
  const { course, manage, enrollment } = await access(req);
  await settleExpired(manage ? { course: course._id } : { course: course._id, student: req.user._id });
  let quizzes = await Quiz.find(manage ? { course: course._id } : { course: course._id, published: true }).sort({ createdAt: -1 }).lean();
  if (!manage) {
    const eb = await batchFor(course, enrollment, req.user);
    quizzes = quizzes.filter((q) => visibleForBatch(q, eb));
  } else {
    quizzes = await withBatchNames(quizzes);
  }
  const attempts = await QuizAttempt.find(manage ? { course: course._id } : { course: course._id, student: req.user._id }).select('-responses -answers').lean();
  const by = new Map();
  attempts.forEach((a) => by.set(sid(a.quiz), [...(by.get(sid(a.quiz)) || []), a]));
  res.json({
    items: quizzes.map((q) => {
      const at = by.get(sid(q._id)) || [];
      const done = at.filter((a) => a.status !== 'in_progress');
      const base = {
        _id: q._id, title: q.title, description: q.description, kind: q.kind || 'daily', timeLimit: q.timeLimit || 0,
        maxAttempts: q.maxAttempts, published: q.published, batches: q.batches, batchNames: q.batchNames,
        questionCount: q.questions.length, totalPoints: totalOf(q),
      };
      if (manage) return { ...base, attempts: done.length, toMark: done.filter((a) => a.status === 'pending').length };
      const marked = done.filter((a) => !a.status || a.status === 'graded');
      const last = done.slice().sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))[0];
      return {
        ...base,
        attemptsUsed: at.length,
        best: marked.length ? marked.reduce((m, a) => Math.max(m, a.score), 0) : null,
        maxScore: base.totalPoints,
        awaiting: done.some((a) => a.status === 'pending'),
        inProgress: at.some((a) => a.status === 'in_progress'),
        lastAttemptId: last?._id || null,
      };
    }),
  });
});

export const createQuiz = asyncHandler(async (req, res) => {
  const { course } = await access(req);
  if (!req.body?.title) throw new HttpError(400, 'Title is required');
  const batches = await cleanBatches(course, req.body.batches);
  const settings = quizSettings(req.body);
  const quiz = await Quiz.create({
    batches, ...settings, course: course._id, title: req.body.title, description: req.body.description,
    maxAttempts: req.body.maxAttempts ?? 1, published: req.body.published !== false,
    questions: cleanQuestions(req.body.questions, settings.kind), createdBy: req.user._id,
  });
  res.status(201).json({ quiz });
});

async function ownQuiz(req) {
  const quiz = await Quiz.findById(req.params.id);
  if (!quiz) throw new HttpError(404, 'Quiz not found');
  const ctx = await access(req, quiz.course);
  return { quiz, ...ctx };
}

const studentQuizView = (quiz, withQuestions) => {
  const obj = quiz.toObject();
  const view = { ...stripAnswers(obj), questionCount: obj.questions.length, totalPoints: totalOf(obj) };
  if (!withQuestions) view.questions = []; // a timed paper stays hidden until the student presses Start
  return view;
};

export const getQuiz = asyncHandler(async (req, res) => {
  const { quiz, manage, course, enrollment } = await ownQuiz(req);
  if (manage) return res.json({ quiz });
  if (!quiz.published || !visibleForBatch(quiz, await batchFor(course, enrollment, req.user))) throw new HttpError(404, 'Quiz not found');
  await settleExpired({ quiz: quiz._id, student: req.user._id });
  const mine = await QuizAttempt.find({ quiz: quiz._id, student: req.user._id }).select('-responses -answers').sort({ submittedAt: -1 }).lean();
  const active = mine.find((a) => a.status === 'in_progress');
  res.json({
    quiz: studentQuizView(quiz, !quiz.timeLimit || !!active),
    attempts: mine.filter((a) => a.status !== 'in_progress').map((a) => ({ _id: a._id, score: a.score, maxScore: a.maxScore, status: a.status || 'graded', submittedAt: a.submittedAt })),
    active: active ? { _id: active._id, remainingMs: Math.max(0, +active.expiresAt - Date.now()) } : null,
  });
});

export const updateQuiz = asyncHandler(async (req, res) => {
  const { quiz, manage, course } = await ownQuiz(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  Object.assign(quiz, pick(req.body, ['title', 'description', 'maxAttempts', 'published']), quizSettings(req.body));
  if (req.body.batches !== undefined) quiz.batches = await cleanBatches(course, req.body.batches);
  if (req.body.questions) {
    const next = cleanQuestions(req.body.questions, quiz.kind);
    if (await QuizAttempt.exists({ quiz: quiz._id })) {
      // Marks already given must stay meaningful: only wording may change once students have attempted.
      const same = next.length === quiz.questions.length && next.every((n, i) => {
        const o = quiz.questions[i];
        return n._id && sid(n._id) === sid(o._id) && n.type === (o.type || 'mcq') && n.points === o.points
          && (!isAuto(n) || n.correctIndex === o.correctIndex) && n.options.length === (o.options || []).length;
      });
      if (!same) throw new HttpError(409, 'Students have already attempted this quiz, so questions, marks and correct answers cannot change. You can fix wording, or create a new quiz.');
    }
    quiz.questions = next;
  }
  await quiz.save();
  res.json({ quiz });
});

export const deleteQuiz = asyncHandler(async (req, res) => {
  const { quiz, manage } = await ownQuiz(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  await QuizAttempt.deleteMany({ quiz: quiz._id });
  await quiz.deleteOne();
  res.json({ message: 'Deleted' });
});

// Timed quizzes: pressing Start opens the paper and starts the clock on the server.
export const startQuiz = asyncHandler(async (req, res) => {
  if (!isStudent(req.user)) throw new HttpError(403, 'Only students take quizzes');
  const { quiz, course, enrollment } = await ownQuiz(req);
  if (!quiz.published || !visibleForBatch(quiz, await batchFor(course, enrollment, req.user))) throw new HttpError(404, 'Quiz not found');
  if (!quiz.timeLimit) throw new HttpError(400, 'This quiz has no timer. Just answer and submit.');
  await settleExpired({ quiz: quiz._id, student: req.user._id });
  let open = await QuizAttempt.findOne({ quiz: quiz._id, student: req.user._id, status: 'in_progress' });
  if (!open) {
    const used = await QuizAttempt.countDocuments({ quiz: quiz._id, student: req.user._id });
    if (quiz.maxAttempts && used >= quiz.maxAttempts) throw new HttpError(409, 'You have used all attempts for this quiz');
    const now = new Date();
    try {
      open = await QuizAttempt.create({ quiz: quiz._id, course: quiz.course, student: req.user._id, status: 'in_progress', startedAt: now, expiresAt: new Date(+now + quiz.timeLimit * 60000), score: 0, maxScore: totalOf(quiz) });
    } catch (err) {
      if (err.code !== 11000) throw err; // a double click started it a moment ago: use that attempt
      open = await QuizAttempt.findOne({ quiz: quiz._id, student: req.user._id, status: 'in_progress' });
    }
  }
  res.status(201).json({ attempt: { _id: open._id }, remainingMs: Math.max(0, +open.expiresAt - Date.now()), quiz: studentQuizView(quiz, true) });
});

const cleanChoice = (c, q) => {
  if (c === null || c === undefined || c === '') return null;
  const n = Number(c);
  return Number.isInteger(n) && n >= 0 && n < (q.options || []).length ? n : null;
};

export const attemptQuiz = asyncHandler(async (req, res) => {
  if (!isStudent(req.user)) throw new HttpError(403, 'Only students take quizzes');
  const { quiz, course, enrollment } = await ownQuiz(req);
  if (!quiz.published || !visibleForBatch(quiz, await batchFor(course, enrollment, req.user))) throw new HttpError(404, 'Quiz not found');
  await settleExpired({ quiz: quiz._id, student: req.user._id });
  const open = await QuizAttempt.findOne({ quiz: quiz._id, student: req.user._id, status: 'in_progress' });
  if (quiz.timeLimit > 0 && !open) throw new HttpError(409, 'Your time is over, or the quiz was not started. Open the quiz again.');
  const used = await QuizAttempt.countDocuments({ quiz: quiz._id, student: req.user._id, status: { $ne: 'in_progress' } });
  if (!open && quiz.maxAttempts && used >= quiz.maxAttempts) throw new HttpError(409, 'You have used all attempts for this quiz');

  // Answers arrive as [{ question, choice, text }]. Older clients send a plain list of choices in question order.
  const byQ = new Map((Array.isArray(req.body?.responses) ? req.body.responses : []).map((r) => [String(r.question), r]));
  const legacy = Array.isArray(req.body?.answers) ? req.body.answers : null;

  let auto = 0;
  let max = 0;
  let hasWritten = false;
  const review = [];
  const responses = quiz.questions.map((q, i) => {
    max += q.points;
    const r = byQ.get(sid(q._id)) || (legacy ? { choice: legacy[i] } : {});
    if (isAuto(q)) {
      const choice = cleanChoice(r.choice, q);
      const ok = choice === q.correctIndex;
      if (ok) auto += q.points;
      review.push({ correctIndex: q.correctIndex, chosen: choice, correct: ok });
      return { question: q._id, choice, marks: ok ? q.points : 0 };
    }
    hasWritten = true;
    review.push(null);
    return { question: q._id, text: String(r.text || '').slice(0, 8000) };
  });

  const fields = { responses, autoScore: auto, manualScore: 0, score: auto, maxScore: max, status: hasWritten ? 'pending' : 'graded', submittedAt: new Date() };
  let attempt;
  if (open) { Object.assign(open, fields); attempt = await open.save(); } else attempt = await QuizAttempt.create({ quiz: quiz._id, course: quiz.course, student: req.user._id, ...fields });
  res.status(201).json({
    attempt: { _id: attempt._id, score: auto, maxScore: max, status: attempt.status },
    review: quiz.revealAnswers ? review : null,
    hasWritten,
    attemptsLeft: quiz.maxAttempts ? quiz.maxAttempts - used - 1 : null,
  });
});

export const listAttempts = asyncHandler(async (req, res) => {
  const { quiz, manage } = await ownQuiz(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  await settleExpired({ quiz: quiz._id });
  const items = await QuizAttempt.find({ quiz: quiz._id, status: { $ne: 'in_progress' } }).select('-responses -answers').populate('student', 'name code').lean();
  items.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || new Date(b.submittedAt) - new Date(a.submittedAt));
  res.json({ items: items.map((a) => ({ ...a, status: a.status || 'graded' })) });
});

// One attempt in full: the teacher marks from it, the student reads their result from it.
export const getAttempt = asyncHandler(async (req, res) => {
  const attempt = await QuizAttempt.findById(req.params.id).populate('student', 'name code');
  if (!attempt) throw new HttpError(404, 'Result not found');
  const quiz = await Quiz.findById(attempt.quiz);
  if (!quiz) throw new HttpError(404, 'Quiz not found');
  const { manage } = await access(req, attempt.course);
  if (!manage && sid(attempt.student) !== sid(req.user._id)) throw new HttpError(403, 'Not allowed');
  if (manage) return res.json({ attempt, quiz });
  if (attempt.status === 'in_progress') throw new HttpError(404, 'Result not found');
  const obj = attempt.toObject();
  if (!quiz.revealAnswers) {
    const auto = new Set(quiz.questions.filter(isAuto).map((q) => sid(q._id)));
    obj.responses = (obj.responses || []).map((r) => (auto.has(sid(r.question)) ? { ...r, marks: undefined } : r));
  }
  res.json({ attempt: obj, quiz: stripAnswers(quiz.toObject(), quiz.revealAnswers) });
});

// Teacher marks the written answers: body { marks: [{ question, marks, feedback }], comment }.
export const gradeAttempt = asyncHandler(async (req, res) => {
  const attempt = await QuizAttempt.findById(req.params.id);
  if (!attempt) throw new HttpError(404, 'Result not found');
  const { manage } = await access(req, attempt.course);
  if (!manage) throw new HttpError(403, 'Not allowed');
  if (attempt.status === 'in_progress') throw new HttpError(409, 'The student is still taking this quiz');
  const quiz = await Quiz.findById(attempt.quiz);
  if (!quiz) throw new HttpError(404, 'Quiz not found');

  const before = attempt.score;
  const given = new Map((Array.isArray(req.body?.marks) ? req.body.marks : []).map((m) => [String(m.question), m]));
  let manual = 0;
  let allMarked = true;
  quiz.questions.filter((q) => !isAuto(q)).forEach((q) => {
    let r = attempt.responses.find((x) => sid(x.question) === sid(q._id));
    if (!r) { attempt.responses.push({ question: q._id, text: '' }); r = attempt.responses[attempt.responses.length - 1]; }
    const g = given.get(sid(q._id));
    if (g && g.marks !== undefined && g.marks !== null && g.marks !== '') {
      const m = Number(g.marks);
      if (!Number.isFinite(m) || m < 0 || m > q.points) throw new HttpError(400, `Marks for "${q.text.slice(0, 40)}" must be between 0 and ${q.points}`);
      r.marks = Math.round(m * 2) / 2; // half marks are fine
    }
    if (g && g.feedback !== undefined) r.feedback = String(g.feedback || '').slice(0, 1000);
    if (typeof r.marks === 'number') manual += r.marks; else allMarked = false;
  });
  attempt.manualScore = manual;
  attempt.score = (attempt.autoScore || 0) + manual;
  attempt.status = allMarked ? 'graded' : 'pending';
  if (req.body?.comment !== undefined) attempt.comment = String(req.body.comment || '').slice(0, 2000);
  Object.assign(attempt, { gradedAt: new Date(), gradedBy: req.user._id });
  attempt.markModified('responses');
  await attempt.save();
  await audit(req, 'grade.quiz', { entity: 'QuizAttempt', entityId: attempt._id, summary: `Quiz "${quiz.title}" marked: ${attempt.score}/${attempt.maxScore}${before !== attempt.score ? ` (was ${before})` : ''}`, details: { student: attempt.student, quiz: quiz._id, before, after: attempt.score, status: attempt.status } });
  res.json({ attempt });
});

// ----- announcements -----
export const listAnnouncements = asyncHandler(async (req, res) => {
  const { course } = await access(req);
  const items = await Announcement.find({ course: course._id }).populate('author', 'name').sort({ createdAt: -1 }).lean();
  res.json({ items });
});

export const createAnnouncement = asyncHandler(async (req, res) => {
  const { course } = await access(req);
  if (!req.body?.title) throw new HttpError(400, 'Title is required');
  const a = await Announcement.create({ course: course._id, title: req.body.title, body: req.body.body, author: req.user._id });
  // Tell the enrolled students, even when the site is closed.
  Enrollment.find({ course: course._id }).distinct('student')
    .then((ids) => sendPush(ids, { title: `${course.title}: ${a.title}`, body: (a.body || '').slice(0, 140), url: `/learn/course/${course._id}`, tag: `ann-${a._id}` }))
    .catch((e) => console.error('push failed', e.message));
  res.status(201).json({ announcement: a });
});

export const deleteAnnouncement = asyncHandler(async (req, res) => {
  const a = await Announcement.findById(req.params.id);
  if (!a) throw new HttpError(404, 'Not found');
  const { manage } = await access(req, a.course);
  if (!manage) throw new HttpError(403, 'Not allowed');
  await a.deleteOne();
  res.json({ message: 'Deleted' });
});

// ----- dashboards -----
export const myOverview = asyncHandler(async (req, res) => {
  if (!isStudent(req.user)) throw new HttpError(403, 'Students only');
  const ens = await Enrollment.find({ student: req.user._id }).populate('course').lean();
  const live = ens.filter((e) => e.course && e.course.status === 'published');
  const courseIds = live.map((e) => e.course._id);
  const [assignments, subs, announcements] = await Promise.all([
    Assignment.find({ course: { $in: courseIds } }).lean(),
    Submission.find({ student: req.user._id }).lean(),
    Announcement.find({ course: { $in: courseIds } }).populate('course', 'title').sort({ createdAt: -1 }).limit(5).lean(),
  ]);
  const done = new Set(subs.map((s) => sid(s.assignment)));
  const today = dateKey();
  const myBatch = new Map(await Promise.all(live.map(async (e) => [sid(e.course._id), await batchFor(e.course, e, req.user)])));
  const pending = assignments
    .filter((a) => !done.has(sid(a._id)) && visibleForBatch(a, myBatch.get(sid(a.course))))
    .map((a) => ({ _id: a._id, course: a.course, title: a.title, dueDate: a.dueDate, overdue: !!a.dueDate && a.dueDate < today, courseTitle: live.find((e) => sid(e.course._id) === sid(a.course))?.course.title }))
    .sort((x, y) => (x.dueDate || '9999').localeCompare(y.dueDate || '9999'));
  const prog = await computeProgress(live.map((e) => ({ course: e.course, enrollment: e, student: req.user })));
  const courses = live.map((e) => {
    const total = e.course.sections.reduce((a, s) => a + s.lessons.length, 0);
    return { _id: e.course._id, title: e.course.title, code: e.course.code, color: e.course.color, category: e.course.category, lessonCount: total, progress: prog.get(progressKey(e.course, req.user))?.overall ?? 0, completed: !!e.completedAt, certificate: e.certificate?.code };
  });
  res.json({
    courses,
    pending: pending.slice(0, 8),
    announcements: announcements.map((a) => ({ _id: a._id, title: a.title, body: a.body, createdAt: a.createdAt, courseTitle: a.course?.title })),
    certificates: courses.filter((c) => c.certificate).length,
    graded: subs.filter((s) => s.gradedAt).map((s) => ({ assignment: s.assignment, grade: s.grade })).length,
  });
});

export const adminOverview = asyncHandler(async (req, res) => {
  const f = isAdmin(req.user) ? {} : { instructors: req.user._id };
  const courses = await Course.find(f).select('_id status').lean();
  const ids = courses.map((c) => c._id);
  const [students, ungraded, certs] = await Promise.all([
    Enrollment.distinct('student', { course: { $in: ids } }),
    Submission.countDocuments({ course: { $in: ids }, gradedAt: { $exists: false } }),
    Enrollment.countDocuments({ course: { $in: ids }, 'certificate.code': { $exists: true } }),
  ]);
  res.json({ courses: courses.length, published: courses.filter((c) => c.status === 'published').length, students: students.length, toGrade: ungraded, certificates: certs });
});

// Students and batches an instructor can enrol (instructors cannot use the admin-only /users endpoints).
export const studentPool = asyncHandler(async (_req, res) => {
  const { Batch } = await import('../models/Batch.js');
  const [students, batches] = await Promise.all([
    User.find({ role: 'student', isActive: true }).select('name code rollNo batch email').populate('batch', 'name').sort({ name: 1 }).limit(1000).lean(),
    Batch.find({ isActive: true }).select('name').sort({ name: 1 }).lean(),
  ]);
  res.json({ students, batches });
});

export const staffPool = asyncHandler(async (_req, res) => {
  const items = await User.find(TEACHER_FILTER).select('name code role designation').sort({ name: 1 }).lean();
  res.json({ items });
});

// ----- progress details (attendance + assignments + quizzes) -----
async function progressDetail(course, student) {
  const enrollment = await Enrollment.findOne({ course: course._id, student: student._id });
  if (!enrollment) throw new HttpError(404, 'This student is not enrolled in the course');
  const progress = (await computeProgress([{ course, enrollment, student }])).get(progressKey(course, student));
  const bid = enrollment.batch || student.batch;
  const b = bid ? await Batch.findById(bid).select('name courseId').lean() : null;
  const total = lessonIds(course).length;
  return {
    progress,
    batch: b && (!b.courseId || sid(b.courseId) === sid(course._id)) ? { _id: b._id, name: b.name } : null,
    lessons: { done: enrollment.completedLessons.length, total, percent: percent(enrollment.completedLessons.length, total) },
  };
}

// Teacher / admin: one student's full breakdown.
export const studentProgress = asyncHandler(async (req, res) => {
  const { course, manage } = await access(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  const student = await User.findOne({ _id: req.params.studentId, role: 'student' }).select('name code email batch');
  if (!student) throw new HttpError(404, 'Student not found');
  res.json({ student: { _id: student._id, name: student.name, code: student.code }, ...(await progressDetail(course, student)) });
});

// Student: my own breakdown.
export const myProgress = asyncHandler(async (req, res) => {
  if (!isStudent(req.user)) throw new HttpError(403, 'Only students have a progress report');
  const { course } = await access(req);
  res.json({ student: { _id: req.user._id, name: req.user.name, code: req.user.code }, ...(await progressDetail(course, req.user)) });
});

// ----- batches inside a course -----
const BATCH_FIELDS = ['name', 'instructor', 'schedule', 'startDate', 'endDate', 'isActive'];

async function manageCourse(req) {
  const { course, manage } = await access(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  return course;
}

async function assertBatchNameFree(courseId, name, exceptId) {
  const clash = await Batch.findOne({ courseId, name: String(name).trim() }).select('_id');
  if (clash && sid(clash._id) !== sid(exceptId)) throw new HttpError(409, 'This course already has a batch with this name');
}

export const listCourseBatches = asyncHandler(async (req, res) => {
  const course = await manageCourse(req);
  const batches = await Batch.find({ courseId: course._id }).sort({ createdAt: -1 }).lean();
  const ids = batches.map((b) => b._id);
  const [enrolled, inBatch, withoutBatch, linkable] = await Promise.all([
    Enrollment.aggregate([{ $match: { course: course._id, batch: { $in: ids } } }, { $group: { _id: '$batch', n: { $sum: 1 } } }]),
    User.aggregate([{ $match: { role: 'student', isActive: true, batch: { $in: ids } } }, { $group: { _id: '$batch', n: { $sum: 1 } } }]),
    Enrollment.countDocuments({ course: course._id, batch: null }),
    Batch.find({ courseId: null, isActive: true }).select('name course').sort({ name: 1 }).lean(), // older batches not yet linked to a course
  ]);
  const em = new Map(enrolled.map((x) => [sid(x._id), x.n]));
  const sm = new Map(inBatch.map((x) => [sid(x._id), x.n]));
  res.json({
    items: batches.map((b) => ({ ...b, enrolled: em.get(sid(b._id)) || 0, studentCount: sm.get(sid(b._id)) || 0 })),
    withoutBatch,
    linkable,
  });
});

export const createCourseBatch = asyncHandler(async (req, res) => {
  const course = await manageCourse(req);
  const data = pick(req.body || {}, BATCH_FIELDS);
  if (!data.name?.trim()) throw new HttpError(400, 'Batch name is required');
  await assertBatchNameFree(course._id, data.name);
  const batch = await Batch.create({ ...data, courseId: course._id, course: course.title });
  res.status(201).json({ batch });
});

export const updateCourseBatch = asyncHandler(async (req, res) => {
  const course = await manageCourse(req);
  const batch = await Batch.findOne({ _id: req.params.batchId, courseId: course._id });
  if (!batch) throw new HttpError(404, 'Batch not found in this course');
  const data = pick(req.body || {}, BATCH_FIELDS);
  if (data.name !== undefined) {
    if (!String(data.name).trim()) throw new HttpError(400, 'Batch name is required');
    await assertBatchNameFree(course._id, data.name, batch._id);
  }
  Object.assign(batch, data);
  await batch.save();
  res.json({ batch });
});

export const deleteCourseBatch = asyncHandler(async (req, res) => {
  const course = await manageCourse(req);
  const batch = await Batch.findOne({ _id: req.params.batchId, courseId: course._id });
  if (!batch) throw new HttpError(404, 'Batch not found in this course');
  const [e, u, a, w] = await Promise.all([
    Enrollment.exists({ batch: batch._id }),
    User.exists({ batch: batch._id }),
    StudentAttendance.exists({ batch: batch._id }),
    Promise.all([Assignment.exists({ batches: batch._id }), Quiz.exists({ batches: batch._id })]).then((r) => r.some(Boolean)),
  ]);
  if (w) throw new HttpError(409, 'Assignments or quizzes are set for this batch. Change them first, or mark the batch as finished instead.');
  if (e || u || a) throw new HttpError(409, 'This batch has students or attendance. Mark it as finished instead.');
  await batch.deleteOne();
  res.json({ message: 'Deleted' });
});

// Attach an older batch (created before batches belonged to courses) to this course.
export const linkCourseBatch = asyncHandler(async (req, res) => {
  const course = await manageCourse(req);
  const batch = await Batch.findById(req.body?.batchId);
  if (!batch) throw new HttpError(404, 'Batch not found');
  if (batch.courseId) throw new HttpError(409, 'This batch already belongs to a course');
  await assertBatchNameFree(course._id, batch.name);
  batch.courseId = course._id;
  batch.course = course.title;
  await batch.save();
  // students already sitting in this batch are enrolled in the course and tied to the batch
  const members = await User.find({ role: 'student', isActive: true, batch: batch._id }).select('_id');
  for (const m of members) {
    await Enrollment.updateOne({ course: course._id, student: m._id }, { $set: { batch: batch._id }, $setOnInsert: { course: course._id, student: m._id, completedLessons: [] } }, { upsert: true });
  }
  res.json({ batch, enrolled: members.length });
});

// Enrol students into the course inside one of its batches.
export const addStudentsToBatch = asyncHandler(async (req, res) => {
  const course = await manageCourse(req);
  const batch = await Batch.findOne({ _id: req.params.batchId, courseId: course._id });
  if (!batch) throw new HttpError(404, 'Batch not found in this course');
  const ids = [...new Set((req.body?.studentIds || []).map(String))];
  if (!ids.length) throw new HttpError(400, 'Choose at least one student');
  const students = await User.find({ _id: { $in: ids }, role: 'student', isActive: true }).select('_id batch');
  let added = 0;
  let moved = 0;
  for (const st of students) {
    const r = await Enrollment.updateOne(
      { course: course._id, student: st._id },
      { $set: { batch: batch._id }, $setOnInsert: { course: course._id, student: st._id, completedLessons: [] } },
      { upsert: true }
    );
    if (r.upsertedCount) added++;
    if (st.batch && sid(st.batch) !== sid(batch._id)) moved++;
  }
  // class attendance is taken per batch, and a student sits in one batch at a time
  await User.updateMany({ _id: { $in: students.map((x) => x._id) } }, { $set: { batch: batch._id } });
  res.json({ added, updated: students.length - added, moved });
});

// ----- teachers (admin only) -----
// Two kinds of teacher:
//  - a new person: gets a login with role 'teacher' and only sees the teacher portal;
//  - an existing employee / intern: keeps their own login, and `isTeacher` adds the teacher portal on top.
const TEACHER_FIELDS = 'name code role email phone designation isActive isTeacher mustChangePassword createdAt';

async function setCourseList(userId, courseIds) {
  const ids = [...new Set((courseIds || []).map(String))].filter((i) => mongoose.isValidObjectId(i));
  await Course.updateMany({ _id: { $in: ids } }, { $addToSet: { instructors: userId } });
  await Course.updateMany({ _id: { $nin: ids }, instructors: userId }, { $pull: { instructors: userId } });
}

async function teacherView(user) {
  const courses = await Course.find({ instructors: user._id }).select('title code').lean();
  return { ...(user.toJSON?.() ?? user), type: user.role === 'teacher' ? 'new' : 'employee', courses };
}

export const listTeachers = asyncHandler(async (_req, res) => {
  const [users, candidates, allCourses] = await Promise.all([
    User.find({ $or: [{ role: 'teacher' }, { role: { $in: STAFF_ROLES }, isTeacher: true }] }).select(TEACHER_FIELDS).sort({ name: 1 }).lean(),
    User.find({ role: { $in: STAFF_ROLES }, isActive: true, isTeacher: { $ne: true } }).select('name code role designation email').sort({ name: 1 }).lean(),
    Course.find().select('title code status instructors').sort({ title: 1 }).lean(),
  ]);
  const items = users.map((u) => ({
    ...u,
    type: u.role === 'teacher' ? 'new' : 'employee',
    courses: allCourses.filter((c) => c.instructors.some((i) => sid(i) === sid(u._id))).map((c) => ({ _id: c._id, title: c.title, code: c.code })),
  }));
  res.json({ items, candidates, courses: allCourses.map((c) => ({ _id: c._id, title: c.title, code: c.code, status: c.status })) });
});

export const createTeacher = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (b.mode === 'existing') {
    // Already works here: no new login. They sign in as before and the teacher portal appears for them.
    const u = await User.findOne({ _id: b.userId, role: { $in: STAFF_ROLES }, isActive: true });
    if (!u) throw new HttpError(404, 'Choose an active employee or intern');
    u.isTeacher = true;
    await u.save();
    await setCourseList(u._id, b.courseIds);
    return res.status(201).json({ teacher: await teacherView(u) });
  }

  // A new person: needs a login.
  if (!String(b.name || '').trim()) throw new HttpError(400, 'Name is required');
  const email = String(b.email || '').toLowerCase().trim();
  if (!email) throw new HttpError(400, 'Email is required: it is the teacher\'s login');
  if (await User.exists({ email })) throw new HttpError(409, 'Someone with this email already exists. If they already work here, add them with "Existing employee" instead.');
  const password = b.password || randomPassword();
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const u = await User.create({
    role: 'teacher', name: b.name, email, phone: b.phone || undefined, designation: b.designation || undefined,
    password, mustChangePassword: !b.password, joiningDate: new Date().toISOString().slice(0, 10),
  });
  await setCourseList(u._id, b.courseIds);
  res.status(201).json({ teacher: await teacherView(u), tempPassword: password });
});

async function findTeacher(id) {
  const u = await User.findOne({ _id: id, $or: [{ role: 'teacher' }, { role: { $in: STAFF_ROLES }, isTeacher: true }] });
  if (!u) throw new HttpError(404, 'Teacher not found');
  return u;
}

export const setTeacherCourses = asyncHandler(async (req, res) => {
  const u = await findTeacher(req.params.id);
  await setCourseList(u._id, req.body?.courseIds);
  res.json({ teacher: await teacherView(u) });
});

// Takes teacher access away from an employee / intern. Their own login and employee account stay as they were.
export const removeTeacherAccess = asyncHandler(async (req, res) => {
  const u = await findTeacher(req.params.id);
  if (u.role === 'teacher') throw new HttpError(400, 'This teacher only has a teacher login. Deactivate the account instead.');
  u.isTeacher = false;
  await u.save();
  await setCourseList(u._id, []);
  res.json({ message: 'Teacher access removed' });
});

// Batches of the courses a teacher teaches (the admin sees all), for taking class attendance.
export const myBatches = asyncHandler(async (req, res) => {
  const courses = await Course.find(isAdmin(req.user) ? {} : { instructors: req.user._id }).select('_id').lean();
  const filter = { courseId: { $in: courses.map((c) => c._id) } };
  if (req.query.isActive === 'true' || req.query.isActive === 'false') filter.isActive = req.query.isActive === 'true';
  const items = await Batch.find(filter).sort({ createdAt: -1 }).lean();
  res.json({ items });
});
