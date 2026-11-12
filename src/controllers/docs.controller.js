import crypto from 'crypto';
import { Letter, SEVERITY } from '../models/docs.js';
import { Project, WorkItem } from '../models/flow.js';
import { User } from '../models/User.js';
import { nextSeq } from '../models/Counter.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { DATE_RE, dateKey } from '../utils/time.js';

const sid = (v) => String(v?._id || v);
const isAdmin = (u) => u.role === 'admin';
const GRADES = ['Outstanding', 'Excellent', 'Very good', 'Good', 'Satisfactory'];
const letterCode = () => `NZL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const dateOrNull = (v, label) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (!DATE_RE.test(v)) throw new HttpError(400, `${label} must be a date`);
  return v;
};

// Projects a person has been part of, with how many of their cards are done.
async function projectsOf(userId) {
  const projects = await Project.find({ $or: [{ lead: userId }, { members: userId }] }).populate('client', 'name').sort({ createdAt: -1 }).lean();
  const cards = await WorkItem.find({ assignee: userId, project: { $in: projects.map((p) => p._id) } }).select('project status').lean();
  return projects.map((p) => {
    const mine = cards.filter((c) => sid(c.project) === sid(p._id));
    return { _id: p._id, name: p.name, client: p.client?.name || '', status: p.status, role: sid(p.lead) === sid(userId) ? 'Project lead' : 'Team member', cardsDone: mine.filter((c) => c.status === 'done').length, cardsTotal: mine.length };
  });
}

// Admin: what the issue form needs about one person.
export const suggest = asyncHandler(async (req, res) => {
  const u = await User.findById(req.params.userId).lean();
  if (!u || !['employee', 'intern'].includes(u.role)) throw new HttpError(404, 'Staff member not found');
  res.json({
    user: { _id: u._id, name: u.name, code: u.code, role: u.role, designation: u.designation, department: u.department, joiningDate: u.joiningDate, internship: u.internship, isActive: u.isActive },
    projects: await projectsOf(u._id),
    grades: GRADES,
  });
});

// Interns whose internship period has ended and who have no internship certificate yet.
export const eligible = asyncHandler(async (_req, res) => {
  const today = dateKey();
  const interns = await User.find({ role: 'intern', isActive: true, 'internship.endDate': { $lte: today, $exists: true } }).select('name code designation internship').lean();
  const have = await Letter.find({ type: 'internship', status: 'issued', user: { $in: interns.map((i) => i._id) } }).select('user').lean();
  const done = new Set(have.map((l) => sid(l.user)));
  res.json({ items: interns.filter((i) => i.internship?.endDate && !done.has(sid(i._id))) });
});

export const createLetter = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!['internship', 'experience', 'warning'].includes(b.type)) throw new HttpError(400, 'Choose the type of letter');
  const u = await User.findById(b.userId);
  if (!u || !['employee', 'intern'].includes(u.role)) throw new HttpError(404, 'Choose an employee or intern');
  if (b.type === 'internship' && u.role !== 'intern') throw new HttpError(400, 'Internship certificates are for interns');
  const today = dateKey();
  const data = {};
  data.designation = String(b.designation || u.designation || '').trim().slice(0, 80) || undefined;

  if (b.type === 'warning') {
    if (!u.isActive) throw new HttpError(400, 'This person is no longer active');
    if (!SEVERITY.includes(b.severity)) throw new HttpError(400, 'Choose how serious this is');
    if (!String(b.subject || '').trim()) throw new HttpError(400, 'Write a subject');
    if (String(b.reason || '').trim().length < 10) throw new HttpError(400, 'Explain what happened (at least a sentence)');
    data.severity = b.severity;
    data.subject = b.subject.trim().slice(0, 140);
    data.reason = b.reason.trim().slice(0, 3000);
  } else {
    data.from = dateOrNull(b.from, 'Start date') || (b.type === 'internship' ? u.internship?.startDate : u.joiningDate);
    data.to = dateOrNull(b.to, 'End date') || (b.type === 'internship' ? u.internship?.endDate : undefined);
    if (!data.from) throw new HttpError(400, 'Start date is required');
    if (data.to && data.to < data.from) throw new HttpError(400, 'End date cannot be before the start date');
    if (b.grade) { if (!GRADES.includes(b.grade)) throw new HttpError(400, 'Invalid grade'); data.grade = b.grade; }
    data.remark = String(b.remark || '').trim().slice(0, 1500) || undefined;
    if (b.type === 'internship') {
      if (!data.to) throw new HttpError(400, 'Set the internship end date first');
      if (data.to > today) throw new HttpError(409, `The internship period ends on ${data.to}. The certificate can be issued after that.`);
      if (await Letter.exists({ user: u._id, type: 'internship', status: 'issued' })) throw new HttpError(409, 'An internship certificate was already issued. Revoke it first to issue a new one.');
    }
    const ids = (Array.isArray(b.projectIds) ? b.projectIds : []).map(String).slice(0, 15);
    if (ids.length) {
      const all = await projectsOf(u._id);
      data.projects = ids.map((id) => all.find((p) => sid(p._id) === id)).filter(Boolean).map((p) => ({ name: p.name, client: p.client, role: p.role, cardsDone: p.cardsDone }));
    }
  }

  const n = await nextSeq('letter');
  const letter = await Letter.create({
    refNo: `NZH-${today.slice(0, 4)}-${String(n).padStart(4, '0')}`,
    code: b.type === 'warning' ? undefined : letterCode(),
    type: b.type, user: u._id, person: { name: u.name, code: u.code, designation: u.designation, role: u.role },
    data, issuedBy: req.user._id,
  });
  res.status(201).json({ letter });
});

export const listLetters = asyncHandler(async (req, res) => {
  const f = {};
  if (req.query.type) f.type = req.query.type;
  if (req.query.user) f.user = req.query.user;
  const items = await Letter.find(f).sort({ issuedAt: -1 }).limit(300).lean();
  res.json({ items });
});

export const myLetters = asyncHandler(async (req, res) => {
  const items = await Letter.find({ user: req.user._id, status: 'issued' }).sort({ issuedAt: -1 }).lean();
  res.json({ items });
});

export const getLetter = asyncHandler(async (req, res) => {
  const l = await Letter.findById(req.params.id).populate('issuedBy', 'name').lean();
  if (!l) throw new HttpError(404, 'Letter not found');
  if (!isAdmin(req.user) && sid(l.user) !== sid(req.user._id)) throw new HttpError(403, 'This letter is not yours');
  if (!isAdmin(req.user) && l.status === 'revoked') throw new HttpError(404, 'Letter not found');
  res.json({ letter: l });
});

export const revokeLetter = asyncHandler(async (req, res) => {
  const l = await Letter.findById(req.params.id);
  if (!l) throw new HttpError(404, 'Letter not found');
  if (l.status === 'revoked') throw new HttpError(409, 'Already revoked');
  const reason = String(req.body?.reason || '').trim();
  if (!reason) throw new HttpError(400, 'Write the reason for revoking');
  l.status = 'revoked';
  l.revokedReason = reason.slice(0, 300);
  l.revokedAt = new Date();
  await l.save();
  res.json({ letter: l });
});

export const acknowledge = asyncHandler(async (req, res) => {
  const l = await Letter.findById(req.params.id);
  if (!l || sid(l.user) !== sid(req.user._id) || l.status !== 'issued') throw new HttpError(404, 'Letter not found');
  if (l.type !== 'warning') throw new HttpError(400, 'Only warnings need to be acknowledged');
  if (l.acknowledgedAt) throw new HttpError(409, 'Already acknowledged');
  l.acknowledgedAt = new Date();
  l.reply = String(req.body?.reply || '').trim().slice(0, 1500) || undefined;
  await l.save();
  res.json({ letter: l });
});

// Public: anyone who scans the QR code. Warnings are never public.
export const verify = asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const l = await Letter.findOne({ code, type: { $ne: 'warning' } }).lean();
  if (!l) throw new HttpError(404, 'No document found with this code');
  res.json({
    valid: l.status === 'issued', revoked: l.status === 'revoked', code, refNo: l.refNo, type: l.type, name: l.person?.name, designation: l.data?.designation || l.person?.designation,
    from: l.data?.from, to: l.data?.to, grade: l.data?.grade, projects: (l.data?.projects || []).map((p) => p.name), issuedAt: l.issuedAt,
  });
});
