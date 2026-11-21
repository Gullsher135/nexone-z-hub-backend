import crypto from 'crypto';
import mongoose from 'mongoose';
import { Competition } from '../models/Competition.js';
import { Quiz, QuizAttempt } from '../models/lms.js';
import { User } from '../models/User.js';
import { nextSeq } from '../models/Counter.js';
import { DATE_RE } from '../utils/time.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { audit } from '../utils/audit.js';
import { notifyUsers } from '../utils/push.js';
import { AWARDS, awardText, certificateTargets, isWinner, rankParticipants, resultMessage } from '../utils/competition.js';

const sid = (v) => String(v?._id || v);
const isAdmin = (u) => u.role === 'admin';
const MY_PAGE = { student: '/learn/competitions' };
const certCode = () => `NZC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

async function load(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Competition not found');
  const c = await Competition.findById(req.params.id);
  if (!c) throw new HttpError(404, 'Competition not found');
  if (!isAdmin(req.user) && sid(c.createdBy) !== sid(req.user._id)) throw new HttpError(403, 'This competition belongs to someone else');
  return c;
}

const summary = (c) => ({
  _id: c._id, code: c.code, title: c.title, date: c.date, status: c.status, published: c.published,
  participants: c.participants.length,
  winners: c.participants.filter(isWinner).length,
  certificates: c.participants.filter((p) => p.certificate?.code).length,
});

async function studentIds(raw) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(String))];
  if (ids.some((i) => !mongoose.isValidObjectId(i))) throw new HttpError(400, 'Invalid student');
  if (ids.length > 500) throw new HttpError(400, 'A competition can have at most 500 students');
  const found = await User.find({ _id: { $in: ids }, role: 'student', isActive: true }).select('_id').lean();
  if (found.length !== ids.length) throw new HttpError(400, 'Choose active students only');
  return ids;
}

const FIELDS = ['title', 'description', 'date', 'status', 'issuer'];
function applyFields(c, b) {
  for (const k of FIELDS) if (b[k] !== undefined) c[k] = typeof b[k] === 'string' ? b[k].trim() : b[k];
  if (b.date !== undefined && b.date && !DATE_RE.test(b.date)) throw new HttpError(400, 'Choose a valid date');
  if (b.date === '') c.date = undefined;
  if (b.maxScore !== undefined) {
    const n = Number(b.maxScore);
    if (b.maxScore === '' || b.maxScore === null) c.maxScore = undefined;
    else if (!Number.isFinite(n) || n < 1 || n > 100000) throw new HttpError(400, 'Maximum score must be a number');
    else c.maxScore = n;
  }
}

// ---- teachers and admin ----
export const list = asyncHandler(async (req, res) => {
  const items = await Competition.find(isAdmin(req.user) ? {} : { createdBy: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json({ items: items.map(summary) });
});

export const create = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!String(b.title || '').trim()) throw new HttpError(400, 'Give the competition a title');
  const c = new Competition({ title: String(b.title).trim(), createdBy: req.user._id });
  applyFields(c, b);
  const n = await nextSeq('competition');
  c.code = `CMP-${String(n).padStart(3, '0')}`;
  const ids = await studentIds(b.studentIds);
  c.participants = ids.map((student) => ({ student }));
  await c.save();
  if (ids.length) notifyUsers(ids, { email: true, title: `You are in a competition: ${c.title}`, body: c.date ? `On ${c.date}. Good luck!` : 'Good luck!', tag: `comp-${c._id}`, urls: MY_PAGE });
  audit(req, 'competition.create', { entity: 'Competition', entityId: c._id, summary: `Created ${c.code} ${c.title}` });
  res.status(201).json({ competition: c });
});

export const get = asyncHandler(async (req, res) => {
  const c = await load(req);
  await c.populate('participants.student', 'name code batch');
  await c.populate('quiz', 'title');
  const out = c.toObject();
  out.participants = out.participants.filter((p) => p.student).map((p) => ({ ...p, studentName: p.student.name, studentCode: p.student.code, student: p.student._id }));
  res.json({ competition: out });
});

export const update = asyncHandler(async (req, res) => {
  const c = await load(req);
  if (req.body?.title !== undefined && !String(req.body.title).trim()) throw new HttpError(400, 'Give the competition a title');
  applyFields(c, req.body || {});
  await c.save();
  res.json({ competition: summary(c) });
});

export const remove = asyncHandler(async (req, res) => {
  const c = await load(req);
  await c.deleteOne();
  audit(req, 'competition.delete', { entity: 'Competition', entityId: c._id, summary: `Deleted ${c.code} ${c.title}` });
  res.json({ message: 'Deleted' });
});

// Replaces the list of students. People who stay keep their score, award and certificate.
export const setParticipants = asyncHandler(async (req, res) => {
  const c = await load(req);
  const ids = await studentIds(req.body?.studentIds);
  const keep = new Map(c.participants.map((p) => [sid(p.student), p]));
  const added = ids.filter((i) => !keep.has(i));
  c.participants = ids.map((i) => keep.get(i) || { student: i });
  await c.save();
  if (added.length) notifyUsers(added, { email: true, title: `You are in a competition: ${c.title}`, body: c.date ? `On ${c.date}. Good luck!` : 'Good luck!', tag: `comp-${c._id}`, urls: MY_PAGE });
  res.json({ participants: c.participants.length, added: added.length });
});

// results: [{ student, score, award, awardTitle, note }]
export const saveResults = asyncHandler(async (req, res) => {
  const c = await load(req);
  const rows = Array.isArray(req.body?.results) ? req.body.results : [];
  const by = new Map(c.participants.map((p) => [sid(p.student), p]));
  for (const r of rows) {
    const p = by.get(String(r.student));
    if (!p) continue;
    if (r.score === '' || r.score === null || r.score === undefined) p.score = undefined;
    else {
      const n = Number(r.score);
      if (!Number.isFinite(n) || n < 0 || (c.maxScore && n > c.maxScore)) throw new HttpError(400, c.maxScore ? `Scores must be between 0 and ${c.maxScore}` : 'Scores must be numbers, 0 or more');
      p.score = n;
    }
    if (r.award !== undefined) {
      if (r.award && !AWARDS.includes(r.award)) throw new HttpError(400, 'Invalid award');
      p.award = r.award || undefined;
    }
    if (r.awardTitle !== undefined) p.awardTitle = String(r.awardTitle || '').trim().slice(0, 80) || undefined;
    if (r.note !== undefined) p.note = String(r.note || '').trim().slice(0, 300) || undefined;
  }
  await c.save();
  res.json({ ok: true });
});

// Takes each student's best marked attempt of a quiz as their score.
export const importQuiz = asyncHandler(async (req, res) => {
  const c = await load(req);
  if (!mongoose.isValidObjectId(req.body?.quizId)) throw new HttpError(400, 'Choose a quiz');
  const quiz = await Quiz.findById(req.body.quizId).select('title questions.points').lean();
  if (!quiz) throw new HttpError(404, 'Quiz not found');
  const attempts = await QuizAttempt.find({ quiz: quiz._id, student: { $in: c.participants.map((p) => p.student) }, status: 'graded' }).select('student score maxScore').lean();
  const best = new Map();
  for (const a of attempts) if (!best.has(sid(a.student)) || a.score > best.get(sid(a.student))) best.set(sid(a.student), a.score);
  let imported = 0;
  for (const p of c.participants) if (best.has(sid(p.student))) { p.score = best.get(sid(p.student)); imported += 1; }
  c.quiz = quiz._id;
  const total = (quiz.questions || []).reduce((s, q) => s + (q.points || 1), 0);
  if (!c.maxScore && total) c.maxScore = total;
  await c.save();
  res.json({ imported, missing: c.participants.length - imported });
});

export const rank = asyncHandler(async (req, res) => {
  const c = await load(req);
  const plain = c.participants.map((p) => p.toObject());
  const ranked = rankParticipants(plain, { winners: req.body?.winners ?? 3 });
  c.participants = ranked;
  await c.save();
  res.json({ ranked: ranked.filter((p) => p.rank).length, winners: ranked.filter(isWinner).length });
});

export const publish = asyncHandler(async (req, res) => {
  const c = await load(req);
  const next = req.body?.published !== false;
  const first = next && !c.published;
  c.published = next;
  await c.save();
  if (first) {
    for (const p of c.participants) {
      const m = resultMessage(p.toObject(), c.title);
      await notifyUsers([p.student], { email: true, ...m, tag: `result-${c._id}`, urls: MY_PAGE });
    }
  }
  res.json({ published: c.published });
});

// include: 'winners' (podium and special awards) or 'all' (everyone else gets a participation certificate)
export const issueCertificates = asyncHandler(async (req, res) => {
  const c = await load(req);
  const include = req.body?.include === 'all' ? 'all' : 'winners';
  const targets = certificateTargets(c.participants.map((p) => p.toObject()), include);
  if (!targets.length) return res.json({ issued: 0 });
  const used = new Set();
  for (const t of targets) {
    const p = c.participants.find((x) => sid(x.student) === sid(t.student));
    if (!p.award) p.award = t.award;
    let code;
    for (let i = 0; i < 6; i++) {
      code = certCode();
      if (!used.has(code) && !(await Competition.exists({ 'participants.certificate.code': code }))) break;
      code = null;
    }
    if (!code) throw new HttpError(500, 'Could not make certificate codes, try again');
    used.add(code);
    p.certificate = { code, issuedAt: new Date() };
  }
  await c.save();
  notifyUsers(targets.map((t) => t.student), { email: true, title: `Your certificate is ready: ${c.title}`, body: 'Open Competitions to view and print it.', tag: `ccert-${c._id}`, urls: MY_PAGE });
  audit(req, 'competition.certificates', { entity: 'Competition', entityId: c._id, summary: `Issued ${targets.length} certificates for ${c.code}` });
  res.json({ issued: targets.length });
});

export const revokeCertificate = asyncHandler(async (req, res) => {
  const c = await load(req);
  const p = c.participants.find((x) => sid(x.student) === String(req.params.studentId));
  if (!p) throw new HttpError(404, 'Student is not in this competition');
  p.certificate = undefined;
  await c.save();
  res.json({ ok: true });
});

// ---- students ----
export const mine = asyncHandler(async (req, res) => {
  const items = await Competition.find({ 'participants.student': req.user._id }).sort({ date: -1, createdAt: -1 }).lean();
  res.json({
    items: items.map((c) => {
      const p = c.participants.find((x) => sid(x.student) === sid(req.user._id));
      return {
        _id: c._id, code: c.code, title: c.title, description: c.description, date: c.date, status: c.status, published: c.published,
        count: c.participants.length,
        result: c.published ? { rank: p.rank || null, score: p.score ?? null, maxScore: c.maxScore || null, award: p.award || null, awardText: awardText(p), note: p.note || '' } : null,
        certificate: p.certificate?.code || null,
      };
    }),
  });
});

export const mineOne = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Competition not found');
  const c = await Competition.findOne({ _id: req.params.id, 'participants.student': req.user._id }).populate('participants.student', 'name code').lean();
  if (!c) throw new HttpError(404, 'Competition not found');
  const board = c.published
    ? c.participants.filter((p) => p.student && (p.rank || p.award)).sort((a, b) => (a.rank || 999) - (b.rank || 999)).map((p) => ({ name: p.student.name, rank: p.rank || null, score: p.score ?? null, awardText: awardText(p), me: sid(p.student) === sid(req.user._id) }))
    : [];
  res.json({ title: c.title, code: c.code, date: c.date, published: c.published, maxScore: c.maxScore || null, board });
});

// ---- public: check a competition certificate by its code ----
export const verify = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!/^NZC-[A-F0-9]{8}$/.test(code)) throw new HttpError(404, 'No certificate found with this code');
  const c = await Competition.findOne({ 'participants.certificate.code': code }).populate('participants.student', 'name code').lean();
  const p = c?.participants.find((x) => x.certificate?.code === code);
  if (!p || !p.student) throw new HttpError(404, 'No certificate found with this code');
  res.json({ valid: true, code, student: p.student.name, studentCode: p.student.code, competition: c.title, competitionCode: c.code, date: c.date || null, award: p.award || 'participation', awardText: awardText(p) || 'Participation', rank: p.rank || null, issuedAt: p.certificate.issuedAt, issuer: c.issuer });
});
