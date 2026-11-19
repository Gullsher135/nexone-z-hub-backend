import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Presentation, PresentationEntry, Enrollment } from '../models/lms.js';
import { User } from '../models/User.js';
import { Batch } from '../models/Batch.js';
import { courseAccess, batchFor, cleanBatches, withBatchNames, planFiles, applyPlan, cleanLinks } from './lms.controller.js';
import { deleteStoredFiles } from '../utils/fileStore.js';
import { audit } from '../utils/audit.js';
import { DATE_RE } from '../utils/time.js';
import { HttpError, asyncHandler, pick } from '../utils/helpers.js';

const sid = (v) => String(v?._id || v);
const isStudent = (u) => u.role === 'student';
const half = (n) => Math.round(n * 2) / 2;
const maxTotal = (p) => p.rubric.reduce((s, c) => s + c.maxMarks, 0);
const visibleTo = (p, batchId) => !p.batches?.length || (!!batchId && p.batches.some((b) => sid(b) === sid(batchId)));

function cleanRubric(list) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Add at least one marking item, for example "Content" out of 10');
  if (list.length > 15) throw new HttpError(400, 'Use 15 marking items or fewer');
  return list.map((c, i) => {
    const name = String(c.name || '').trim();
    const maxMarks = Number(c.maxMarks);
    if (!name) throw new HttpError(400, `Marking item ${i + 1} needs a name`);
    if (!Number.isInteger(maxMarks) || maxMarks < 1 || maxMarks > 100) throw new HttpError(400, `"${name}": marks must be a whole number from 1 to 100`);
    return { ...(c._id ? { _id: c._id } : {}), name: name.slice(0, 80), maxMarks };
  });
}

function presentationFields(body) {
  const out = pick(body, ['title', 'description', 'durationMin', 'askSlides', 'published']);
  if (body.date !== undefined) {
    if (body.date && !DATE_RE.test(body.date)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
    out.date = body.date || undefined;
  }
  if (body.time !== undefined) {
    if (body.time && !/^\d{2}:\d{2}$/.test(body.time)) throw new HttpError(400, 'Time must be HH:MM');
    out.time = body.time || undefined;
  }
  if (out.durationMin !== undefined) {
    out.durationMin = Number(out.durationMin);
    if (!Number.isInteger(out.durationMin) || out.durationMin < 1 || out.durationMin > 180) throw new HttpError(400, 'Minutes per student must be from 1 to 180');
  }
  return out;
}

// Students who may present: enrolled in the course and in one of the chosen batches (or any batch if none chosen).
async function eligibleStudents(p) {
  const enr = await Enrollment.find({ course: p.course }).select('student batch').lean();
  const users = await User.find({ _id: { $in: enr.map((e) => e.student) }, role: 'student' }).select('name code batch').lean();
  const byUser = new Map(users.map((u) => [sid(u._id), u]));
  const batchIds = [...new Set(enr.map((e) => e.batch || byUser.get(sid(e.student))?.batch).filter(Boolean).map(sid))];
  const batches = new Map((batchIds.length ? await Batch.find({ _id: { $in: batchIds } }).select('name courseId').lean() : []).map((b) => [sid(b._id), b]));
  return enr.map((e) => {
    const u = byUser.get(sid(e.student));
    if (!u) return null;
    let bid = e.batch || u.batch;
    const b = bid ? batches.get(sid(bid)) : null;
    if (!e.batch && b && b.courseId && sid(b.courseId) !== sid(p.course)) bid = null; // batch of another course
    return { student: u, batchId: bid ? sid(bid) : null, batchName: bid ? batches.get(sid(bid))?.name || '' : '' };
  }).filter((x) => x && visibleTo(p, x.batchId));
}

// Makes sure every eligible student has a row to hold their topic and marks.
async function syncEntries(p) {
  const people = await eligibleStudents(p);
  const have = new Set((await PresentationEntry.find({ presentation: p._id }).select('student').lean()).map((e) => sid(e.student)));
  const missing = people.filter((x) => !have.has(sid(x.student._id)));
  if (missing.length) {
    await PresentationEntry.insertMany(missing.map((x) => ({ presentation: p._id, course: p.course, student: x.student._id })), { ordered: false }).catch((e) => { if (e.code !== 11000 && !e.writeErrors) throw e; });
  }
  return people;
}

const entryView = (e, people) => {
  const who = people.get(sid(e.student));
  return {
    _id: e._id, student: { _id: e.student, name: who?.student.name || 'Student', code: who?.student.code }, batchName: who?.batchName || '',
    topic: e.topic || '', status: e.status, scores: e.scores || [], total: e.total || 0, comment: e.comment || '',
    slideFiles: e.slideFiles || [], slideLinks: e.slideLinks || [], graded: !!e.gradedAt, gradedAt: e.gradedAt,
  };
};

export const listPresentations = asyncHandler(async (req, res) => {
  const { course, manage, enrollment } = await courseAccess(req);
  let items = await Presentation.find(manage ? { course: course._id } : { course: course._id, published: true }).sort({ date: 1, createdAt: -1 }).lean();
  if (manage) {
    items = await withBatchNames(items);
    const stats = await PresentationEntry.aggregate([
      { $match: { presentation: { $in: items.map((i) => i._id) } } },
      { $group: { _id: '$presentation', students: { $sum: 1 }, withTopic: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$topic', ''] } }, 0] }, 1, 0] } }, marked: { $sum: { $cond: [{ $ifNull: ['$gradedAt', false] }, 1, 0] } } } },
    ]);
    const by = new Map(stats.map((s) => [sid(s._id), s]));
    return res.json({ items: items.map((p) => ({ ...p, maxTotal: maxTotal(p), students: by.get(sid(p._id))?.students || 0, withTopic: by.get(sid(p._id))?.withTopic || 0, marked: by.get(sid(p._id))?.marked || 0 })) });
  }
  const eb = await batchFor(course, enrollment, req.user);
  items = items.filter((p) => visibleTo(p, eb));
  const mine = await PresentationEntry.find({ student: req.user._id, presentation: { $in: items.map((i) => i._id) } }).lean();
  const byP = new Map(mine.map((e) => [sid(e.presentation), e]));
  res.json({
    items: items.map((p) => {
      const e = byP.get(sid(p._id));
      return {
        _id: p._id, course: p.course, title: p.title, description: p.description, date: p.date, time: p.time, durationMin: p.durationMin, askSlides: p.askSlides, rubric: p.rubric, maxTotal: maxTotal(p),
        entry: e ? { _id: e._id, topic: e.topic || '', status: e.status, graded: !!e.gradedAt, total: e.gradedAt ? e.total : null, scores: e.gradedAt ? e.scores : [], comment: e.gradedAt ? e.comment || '' : '', slideFiles: e.slideFiles || [], slideLinks: e.slideLinks || [] } : null,
      };
    }),
  });
});

export const createPresentation = asyncHandler(async (req, res) => {
  const { course } = await courseAccess(req);
  if (!req.body?.title?.trim()) throw new HttpError(400, 'Title is required');
  const p = await Presentation.create({ ...presentationFields(req.body), rubric: cleanRubric(req.body.rubric), batches: await cleanBatches(course, req.body.batches), course: course._id, createdBy: req.user._id });
  res.status(201).json({ presentation: p });
});

async function ownPresentation(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Presentation not found');
  const p = await Presentation.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Presentation not found');
  return { p, ...(await courseAccess(req, p.course)) };
}

export const updatePresentation = asyncHandler(async (req, res) => {
  const { p, manage, course } = await ownPresentation(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  Object.assign(p, presentationFields(req.body));
  if (req.body.batches !== undefined) p.batches = await cleanBatches(course, req.body.batches);
  if (req.body.rubric) {
    const next = cleanRubric(req.body.rubric);
    if (await PresentationEntry.exists({ presentation: p._id, $or: [{ gradedAt: { $ne: null } }, { 'scores.0': { $exists: true } }] })) {
      // Marks already given must stay meaningful: only the wording of a marking item may change.
      const same = next.length === p.rubric.length && next.every((n, i) => n._id && sid(n._id) === sid(p.rubric[i]._id) && n.maxMarks === p.rubric[i].maxMarks);
      if (!same) throw new HttpError(409, 'Marks have already been given, so marking items and their marks cannot change. You can rename them, or create a new presentation.');
    }
    p.rubric = next;
  }
  await p.save();
  res.json({ presentation: p });
});

export const deletePresentation = asyncHandler(async (req, res) => {
  const { p, manage } = await ownPresentation(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  const entries = await PresentationEntry.find({ presentation: p._id }).select('slideFiles').lean();
  const fileIds = entries.flatMap((e) => (e.slideFiles || []).map((f) => f.file));
  await PresentationEntry.deleteMany({ presentation: p._id });
  if (fileIds.length) await deleteStoredFiles({ _id: { $in: fileIds } });
  await p.deleteOne();
  res.json({ message: 'Deleted' });
});

// Teacher: every student of the batch(es) with their topic, status and marks.
export const listEntries = asyncHandler(async (req, res) => {
  const { p, manage } = await ownPresentation(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  const people = new Map((await syncEntries(p)).map((x) => [sid(x.student._id), x]));
  const entries = (await PresentationEntry.find({ presentation: p._id }).lean())
    .filter((e) => people.has(sid(e.student)) || e.topic || e.gradedAt) // keep anyone who already has a topic or marks
    .map((e) => entryView(e, people))
    .sort((a, b) => a.batchName.localeCompare(b.batchName) || a.student.name.localeCompare(b.student.name));
  const topics = entries.map((e) => e.topic.trim().toLowerCase()).filter(Boolean);
  const duplicates = [...new Set(topics.filter((t, i) => topics.indexOf(t) !== i))];
  res.json({ presentation: { ...p.toObject(), maxTotal: maxTotal(p) }, entries, duplicates });
});

// Teacher: set topics by hand. Body { topics: [{ student, topic }] }. An empty topic clears it.
export const setTopics = asyncHandler(async (req, res) => {
  const { p, manage } = await ownPresentation(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  const list = Array.isArray(req.body?.topics) ? req.body.topics : [];
  const people = new Set((await syncEntries(p)).map((x) => sid(x.student._id)));
  const ops = list.map((t) => {
    if (!people.has(String(t.student))) throw new HttpError(400, 'A student in the list is not part of this presentation');
    return { updateOne: { filter: { presentation: p._id, student: t.student }, update: { $set: { topic: String(t.topic || '').trim().slice(0, 300) } } } };
  });
  if (ops.length) await PresentationEntry.bulkWrite(ops);
  res.json({ updated: ops.length });
});

// Teacher: hand out a list of topics at random, one per student. Body { topics: [string], overwrite }.
export const autoAssign = asyncHandler(async (req, res) => {
  const { p, manage } = await ownPresentation(req);
  if (!manage) throw new HttpError(403, 'Not allowed');
  const pool = [...new Set((Array.isArray(req.body?.topics) ? req.body.topics : []).map((t) => String(t || '').trim().slice(0, 300)).filter(Boolean))];
  if (!pool.length) throw new HttpError(400, 'Enter at least one topic');
  await syncEntries(p);
  const filter = { presentation: p._id, ...(req.body?.overwrite ? {} : { $or: [{ topic: { $exists: false } }, { topic: '' }] }) };
  const targets = await PresentationEntry.find(filter).select('_id student').lean();
  const people = new Set((await eligibleStudents(p)).map((x) => sid(x.student._id)));
  const rows = targets.filter((t) => people.has(sid(t.student)));
  for (let i = pool.length - 1; i > 0; i -= 1) { const j = crypto.randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; } // fair shuffle
  const n = Math.min(rows.length, pool.length);
  if (n) await PresentationEntry.bulkWrite(rows.slice(0, n).map((r, i) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { topic: pool[i] } } } })));
  res.json({ assigned: n, withoutTopic: Math.max(0, rows.length - n), unusedTopics: Math.max(0, pool.length - n) });
});

// Teacher marks one student: body { status, scores: [{ criterion, marks }], comment }.
export const gradeEntry = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Not found');
  const e = await PresentationEntry.findById(req.params.id);
  if (!e) throw new HttpError(404, 'Not found');
  const p = await Presentation.findById(e.presentation);
  if (!p) throw new HttpError(404, 'Presentation not found');
  const { manage } = await courseAccess(req, p.course);
  if (!manage) throw new HttpError(403, 'Not allowed');

  const beforeTotal = e.gradedAt ? e.total : null;
  const status = ['assigned', 'presented', 'absent'].includes(req.body?.status) ? req.body.status : 'presented';
  const given = new Map((Array.isArray(req.body?.scores) ? req.body.scores : []).map((s) => [String(s.criterion), s]));
  let total = 0;
  let allMarked = true;
  const scores = [];
  if (status === 'presented') {
    p.rubric.forEach((c) => {
      const g = given.get(sid(c._id));
      if (g && g.marks !== undefined && g.marks !== null && g.marks !== '') {
        const m = Number(g.marks);
        if (!Number.isFinite(m) || m < 0 || m > c.maxMarks) throw new HttpError(400, `Marks for "${c.name}" must be between 0 and ${c.maxMarks}`);
        scores.push({ criterion: c._id, marks: half(m) });
        total += half(m);
      } else allMarked = false;
    });
  }
  e.status = status;
  e.scores = scores;
  e.total = total; // an absent student scores 0
  if (req.body?.comment !== undefined) e.comment = String(req.body.comment || '').slice(0, 2000);
  e.gradedAt = status === 'absent' || (status === 'presented' && allMarked) ? new Date() : undefined;
  e.gradedBy = req.user._id;
  await e.save();
  await audit(req, 'grade.presentation', { entity: 'PresentationEntry', entityId: e._id, summary: `Presentation "${p.title}": ${status === 'absent' ? 'marked absent' : `marked ${total}/${maxTotal(p)}`}${beforeTotal !== null ? ` (was ${beforeTotal})` : ''}`, details: { student: e.student, presentation: p._id, status, before: beforeTotal, after: total } });
  res.json({ entry: e });
});

// Student: add slides (files and links) to their own entry until it is marked.
export const submitSlides = asyncHandler(async (req, res) => {
  if (!isStudent(req.user)) throw new HttpError(403, 'Only students upload slides');
  const { p, course, enrollment } = await ownPresentation(req);
  if (!p.published || !p.askSlides || !visibleTo(p, await batchFor(course, enrollment, req.user))) throw new HttpError(404, 'Presentation not found');
  let e = await PresentationEntry.findOne({ presentation: p._id, student: req.user._id });
  if (!e) e = new PresentationEntry({ presentation: p._id, course: p.course, student: req.user._id });
  if (e.gradedAt) throw new HttpError(409, 'This presentation is already marked, so slides cannot change');
  const links = cleanLinks(req.body?.links);
  const plan = await planFiles(req.body?.fileIds, { course: p.course, owner: req.user._id, kind: 'submission', existing: e.slideFiles || [] });
  if (!plan.refs.length && !links.length) throw new HttpError(400, 'Upload your slides or add a link');
  e.slideFiles = plan.refs;
  e.slideLinks = links;
  await e.save();
  await applyPlan(plan);
  res.json({ entry: e });
});
