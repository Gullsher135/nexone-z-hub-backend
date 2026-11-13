import { Assignment, Submission, Quiz, QuizAttempt } from '../models/lms.js';
import { StudentAttendance } from '../models/StudentAttendance.js';
import { Batch } from '../models/Batch.js';
import { dateKey } from './time.js';

// ---------------------------------------------------------------------------
// Course progress = attendance + assignment marks + quiz marks, combined.
//
// Each of the three parts gives a percentage. The overall progress is the weighted
// average of the parts that have data. A part with no data yet (for example a course
// with no quizzes, or no class marked so far) is left out instead of counting as zero.
// Change the weights here if the institute wants a different balance.
// ---------------------------------------------------------------------------
export const WEIGHTS = { attendance: 1, assignments: 1, quizzes: 1 };
export const WEAK_BELOW = 60; // a part under this percentage is flagged as a weak area

const sid = (v) => String(v?._id || v);
const pct = (num, den) => (den > 0 ? Math.min(100, Math.round((num / den) * 100)) : null);

function attendancePart(records) {
  const count = (st) => records.filter((r) => r.status === st).length;
  const present = count('present');
  const late = count('late');
  const absent = count('absent');
  const leave = count('leave');
  const counted = records.length - leave; // days on approved leave do not count against the student
  return {
    percent: pct(present + late, counted),
    present, late, absent, leave,
    total: records.length,
    recentAbsences: records.filter((r) => r.status === 'absent').map((r) => r.date).sort().reverse().slice(0, 5),
  };
}

function assignmentsPart(assignments, submissions, today) {
  const byAssignment = new Map(submissions.map((s) => [sid(s.assignment), s]));
  let earned = 0;
  let possible = 0;
  const items = assignments
    .slice()
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'))
    .map((a) => {
      const s = byAssignment.get(sid(a._id));
      const base = { _id: a._id, title: a.title, maxPoints: a.maxPoints, dueDate: a.dueDate || null };
      if (s?.gradedAt) {
        earned += s.grade || 0;
        possible += a.maxPoints;
        return { ...base, status: 'graded', grade: s.grade || 0, late: !!s.late, counted: true };
      }
      if (s) return { ...base, status: 'submitted', late: !!s.late, counted: false }; // waiting for the teacher's marks
      if (a.dueDate && a.dueDate < today) {
        possible += a.maxPoints; // deadline passed and nothing handed in: zero marks
        return { ...base, status: 'missing', grade: 0, counted: true };
      }
      return { ...base, status: 'pending', counted: false }; // still has time
    });
  return {
    percent: pct(earned, possible),
    earned, possible,
    counted: items.filter((i) => i.counted).length,
    total: items.length,
    items,
  };
}

function quizzesPart(quizzes, attempts) {
  const byQuiz = new Map();
  attempts.forEach((a) => byQuiz.set(sid(a.quiz), [...(byQuiz.get(sid(a.quiz)) || []), a]));
  let earned = 0;
  let possible = 0;
  const items = quizzes.map((q) => {
    const maxScore = (q.questions || []).reduce((s, x) => s + (x.points || 1), 0);
    const mine = byQuiz.get(sid(q._id)) || [];
    const best = mine.reduce((m, a) => Math.max(m, a.score), 0); // the best attempt counts
    earned += mine.length ? best : 0; // a published quiz that was never attempted counts as zero
    possible += maxScore;
    return { _id: q._id, title: q.title, maxScore, attempts: mine.length, best: mine.length ? best : null, status: mine.length ? 'attempted' : 'not_attempted', counted: true };
  });
  return { percent: pct(earned, possible), earned, possible, counted: items.length, total: items.length, items };
}

// Pure function: all the data in, the full breakdown out. Easy to test, no database inside.
export function buildProgress({ attendance = [], assignments = [], submissions = [], quizzes = [], attempts = [], today = dateKey() }) {
  const parts = {
    attendance: attendancePart(attendance),
    assignments: assignmentsPart(assignments, submissions, today),
    quizzes: quizzesPart(quizzes, attempts),
  };

  let sum = 0;
  let weights = 0;
  Object.entries(parts).forEach(([key, p]) => {
    p.weight = WEIGHTS[key];
    p.weak = p.percent !== null && p.percent < WEAK_BELOW;
    if (p.percent !== null) {
      sum += p.percent * WEIGHTS[key];
      weights += WEIGHTS[key];
    }
  });

  const available = Object.entries(parts).filter(([, p]) => p.percent !== null);
  const lowest = available.sort((a, b) => a[1].percent - b[1].percent)[0];
  return {
    overall: weights ? Math.round(sum / weights) : 0,
    hasData: weights > 0,
    weakest: lowest && lowest[1].weak ? lowest[0] : null,
    weakBelow: WEAK_BELOW,
    parts,
  };
}

// The batch whose class attendance counts for this enrolment. A batch that belongs to another course is ignored.
const batchOf = (enrollment, student) => enrollment.batch || student?.batch || null;

/**
 * Loads everything needed in a handful of queries and returns Map("courseId:studentId" -> progress).
 * items: [{ course: { _id }, enrollment, student: { _id, batch } }]
 */
export async function computeProgress(items) {
  const out = new Map();
  if (!items.length) return out;
  const courseIds = [...new Set(items.map((i) => sid(i.course)))];
  const studentIds = [...new Set(items.map((i) => sid(i.student)))];
  const today = dateKey();

  const batchIds = [...new Set(items.map((i) => batchOf(i.enrollment, i.student)).filter(Boolean).map(sid))];
  const [assignments, submissions, quizzes, attempts, batches] = await Promise.all([
    Assignment.find({ course: { $in: courseIds } }).select('course title dueDate maxPoints').lean(),
    Submission.find({ course: { $in: courseIds }, student: { $in: studentIds } }).select('assignment course student grade gradedAt late').lean(),
    Quiz.find({ course: { $in: courseIds }, published: true }).select('course title questions.points').lean(),
    QuizAttempt.find({ course: { $in: courseIds }, student: { $in: studentIds } }).select('quiz course student score').lean(),
    batchIds.length ? Batch.find({ _id: { $in: batchIds } }).select('courseId').lean() : [],
  ]);
  const marks = batchIds.length
    ? await StudentAttendance.find({ student: { $in: studentIds }, batch: { $in: batchIds } }).select('student batch date status').lean()
    : [];
  const batchCourse = new Map(batches.map((b) => [sid(b._id), b.courseId ? sid(b.courseId) : null]));

  for (const { course, enrollment, student } of items) {
    const cid = sid(course);
    const stid = sid(student);
    const b = batchOf(enrollment, student);
    // use the batch only when it is free or belongs to this very course
    const bOk = b && (!batchCourse.get(sid(b)) || batchCourse.get(sid(b)) === cid);
    out.set(`${cid}:${stid}`, buildProgress({
      today,
      attendance: bOk ? marks.filter((m) => sid(m.student) === stid && sid(m.batch) === sid(b)) : [],
      assignments: assignments.filter((a) => sid(a.course) === cid),
      submissions: submissions.filter((s) => sid(s.course) === cid && sid(s.student) === stid),
      quizzes: quizzes.filter((q) => sid(q.course) === cid),
      attempts: attempts.filter((a) => sid(a.course) === cid && sid(a.student) === stid),
    }));
  }
  return out;
}

export const progressKey = (course, student) => `${sid(course)}:${sid(student)}`;
