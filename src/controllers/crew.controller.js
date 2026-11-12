import { Notice, Task } from '../models/crew.js';
import { Leave } from '../models/Leave.js';
import { Attendance } from '../models/Attendance.js';
import { User, STAFF_ROLES } from '../models/User.js';
import { getSettings } from '../models/Setting.js';
import { HttpError, asyncHandler, pick } from '../utils/helpers.js';
import { DATE_RE, dateKey, datesBetween, weekdayOfKey } from '../utils/time.js';

const isAdmin = (u) => u.role === 'admin';
const sid = (v) => String(v?._id || v);
const audienceFor = (role) => ({ audience: { $in: ['all', role] } });

// Working days in a leave that fall inside [from, to], skipping weekly off days and holidays.
function workingDays(l, from, to, settings) {
  const hol = new Set(settings.holidays.map((h) => h.date));
  const off = new Set(settings.weekendDays);
  const a = l.fromDate < from ? from : l.fromDate;
  const b = l.toDate > to ? to : l.toDate;
  if (a > b) return 0;
  return datesBetween(a, b).filter((d) => !hol.has(d) && !off.has(weekdayOfKey(d))).length;
}

async function leaveBalance(userId, settings) {
  const year = dateKey().slice(0, 4);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const leaves = await Leave.find({ user: userId, status: { $in: ['approved', 'pending'] }, fromDate: { $lte: to }, toDate: { $gte: from } }).lean();
  const out = {};
  for (const k of ['casual', 'sick']) {
    const quota = settings.leaveQuota?.[k] ?? 0;
    const mine = leaves.filter((l) => l.type === k);
    const used = mine.filter((l) => l.status === 'approved').reduce((s, l) => s + workingDays(l, from, to, settings), 0);
    const pending = mine.filter((l) => l.status === 'pending').reduce((s, l) => s + workingDays(l, from, to, settings), 0);
    out[k] = { quota, used, pending, left: Math.max(0, quota - used - pending) };
  }
  out.other = { used: leaves.filter((l) => l.type === 'other' && l.status === 'approved').reduce((s, l) => s + workingDays(l, from, to, settings), 0) };
  return out;
}

// ----- employee home -----
export const home = asyncHandler(async (req, res) => {
  const u = req.user;
  const settings = await getSettings();
  const today = dateKey();
  const month = today.slice(0, 7);
  const [notices, tasks, att, leaveToday, balance, today_rec] = await Promise.all([
    Notice.find({ ...audienceFor(u.role) }).sort({ pinned: -1, createdAt: -1 }).limit(5).lean(),
    Task.find({ assignee: u._id, status: { $ne: 'done' } }).sort({ dueDate: 1, createdAt: -1 }).limit(6).lean(),
    Attendance.find({ user: u._id, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).select('status workMinutes').lean(),
    Leave.find({ status: 'approved', fromDate: { $lte: today }, toDate: { $gte: today } }).populate('user', 'name').lean(),
    leaveBalance(u._id, settings),
    Attendance.findOne({ user: u._id, date: today }).select('checkIn checkOut status').lean(),
  ]);
  const unread = await Notice.countDocuments({ ...audienceFor(u.role), readBy: { $ne: u._id } });
  const openTasks = await Task.countDocuments({ assignee: u._id, status: { $ne: 'done' } });
  res.json({
    notices: notices.map((n) => ({ _id: n._id, title: n.title, body: n.body, pinned: n.pinned, createdAt: n.createdAt, read: n.readBy.some((r) => sid(r) === sid(u._id)) })),
    tasks: tasks.map((t) => ({ ...t, overdue: !!t.dueDate && t.dueDate < today })),
    stats: {
      unreadNotices: unread,
      openTasks,
      presentDays: att.filter((a) => a.status === 'present' || a.status === 'late').length,
      lateDays: att.filter((a) => a.status === 'late').length,
      workMinutes: att.reduce((s, a) => s + (a.workMinutes || 0), 0),
    },
    balance,
    today: today_rec ? { checkIn: today_rec.checkIn, checkOut: today_rec.checkOut, status: today_rec.status } : null,
    onLeaveToday: leaveToday.filter((l) => l.user && sid(l.user) !== sid(u._id)).map((l) => l.user.name),
  });
});

export const myBalance = asyncHandler(async (req, res) => {
  res.json({ balance: await leaveBalance(req.user._id, await getSettings()) });
});

// ----- notices -----
export const listNotices = asyncHandler(async (req, res) => {
  const f = isAdmin(req.user) ? {} : audienceFor(req.user.role);
  const items = await Notice.find(f).populate('author', 'name').sort({ pinned: -1, createdAt: -1 }).limit(100).lean();
  res.json({
    items: items.map((n) => ({ _id: n._id, title: n.title, body: n.body, pinned: n.pinned, audience: n.audience, author: n.author?.name, createdAt: n.createdAt, read: n.readBy.some((r) => sid(r) === sid(req.user._id)), readCount: n.readBy.length })),
  });
});

export const markNoticeRead = asyncHandler(async (req, res) => {
  const n = await Notice.findById(req.params.id);
  if (!n) throw new HttpError(404, 'Notice not found');
  if (n.audience !== 'all' && n.audience !== req.user.role && !isAdmin(req.user)) throw new HttpError(403, 'Not for you');
  await Notice.updateOne({ _id: n._id }, { $addToSet: { readBy: req.user._id } });
  res.json({ message: 'Read' });
});

export const markAllRead = asyncHandler(async (req, res) => {
  await Notice.updateMany({ ...audienceFor(req.user.role) }, { $addToSet: { readBy: req.user._id } });
  res.json({ message: 'Read' });
});

const NOTICE_FIELDS = ['title', 'body', 'audience', 'pinned'];
export const createNotice = asyncHandler(async (req, res) => {
  if (!req.body?.title?.trim()) throw new HttpError(400, 'Title is required');
  const n = await Notice.create({ ...pick(req.body, NOTICE_FIELDS), author: req.user._id, readBy: [req.user._id] });
  res.status(201).json({ notice: n });
});
export const updateNotice = asyncHandler(async (req, res) => {
  const n = await Notice.findById(req.params.id);
  if (!n) throw new HttpError(404, 'Notice not found');
  Object.assign(n, pick(req.body, NOTICE_FIELDS));
  await n.save();
  res.json({ notice: n });
});
export const deleteNotice = asyncHandler(async (req, res) => {
  const n = await Notice.findById(req.params.id);
  if (!n) throw new HttpError(404, 'Notice not found');
  await n.deleteOne();
  res.json({ message: 'Deleted' });
});

// ----- tasks -----
const TASK_FIELDS = ['title', 'description', 'priority', 'dueDate'];
function checkTask(d) {
  if (d.dueDate && !DATE_RE.test(d.dueDate)) throw new HttpError(400, 'Due date must be YYYY-MM-DD');
  if (d.priority && !['low', 'medium', 'high'].includes(d.priority)) throw new HttpError(400, 'Invalid priority');
}

export const myTasks = asyncHandler(async (req, res) => {
  const items = await Task.find({ assignee: req.user._id }).populate('createdBy', 'name').populate('comments.author', 'name').sort({ status: 1, dueDate: 1 }).lean();
  const today = dateKey();
  res.json({ items: items.map((t) => ({ ...t, overdue: t.status !== 'done' && !!t.dueDate && t.dueDate < today })) });
});

export const listTasks = asyncHandler(async (req, res) => {
  const f = {};
  if (req.query.assignee) f.assignee = req.query.assignee;
  if (req.query.status) f.status = req.query.status;
  const items = await Task.find(f).populate('assignee', 'name code role').populate('comments.author', 'name').sort({ createdAt: -1 }).limit(300).lean();
  const today = dateKey();
  res.json({ items: items.map((t) => ({ ...t, overdue: t.status !== 'done' && !!t.dueDate && t.dueDate < today })) });
});

export const createTask = asyncHandler(async (req, res) => {
  if (!req.body?.title?.trim()) throw new HttpError(400, 'Title is required');
  const person = await User.findOne({ _id: req.body.assignee, role: { $in: STAFF_ROLES }, isActive: true });
  if (!person) throw new HttpError(400, 'Choose an active employee or intern');
  const d = pick(req.body, TASK_FIELDS);
  checkTask(d);
  const t = await Task.create({ ...d, assignee: person._id, createdBy: req.user._id });
  res.status(201).json({ task: t });
});

export const updateTask = asyncHandler(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t) throw new HttpError(404, 'Task not found');
  const d = pick(req.body, TASK_FIELDS);
  checkTask(d);
  Object.assign(t, d);
  if (req.body.assignee && sid(req.body.assignee) !== sid(t.assignee)) {
    const person = await User.findOne({ _id: req.body.assignee, role: { $in: STAFF_ROLES }, isActive: true });
    if (!person) throw new HttpError(400, 'Choose an active employee or intern');
    t.assignee = person._id;
  }
  await t.save();
  res.json({ task: t });
});

export const deleteTask = asyncHandler(async (req, res) => {
  const t = await Task.findById(req.params.id);
  if (!t) throw new HttpError(404, 'Task not found');
  await t.deleteOne();
  res.json({ message: 'Deleted' });
});

// The assignee (or an admin) moves a task along and may comment on it.
async function mine(req) {
  const t = await Task.findById(req.params.id);
  if (!t) throw new HttpError(404, 'Task not found');
  if (!isAdmin(req.user) && sid(t.assignee) !== sid(req.user._id)) throw new HttpError(403, 'This task is not assigned to you');
  return t;
}

export const setTaskStatus = asyncHandler(async (req, res) => {
  const t = await mine(req);
  const status = req.body?.status;
  if (!['todo', 'doing', 'done'].includes(status)) throw new HttpError(400, 'Invalid status');
  t.status = status;
  t.completedAt = status === 'done' ? t.completedAt || new Date() : undefined;
  await t.save();
  res.json({ task: t });
});

export const commentTask = asyncHandler(async (req, res) => {
  const t = await mine(req);
  const text = String(req.body?.text || '').trim();
  if (!text) throw new HttpError(400, 'Write a comment');
  t.comments.push({ author: req.user._id, text: text.slice(0, 1000) });
  await t.save();
  res.status(201).json({ task: t });
});

// ----- team and profile -----
export const team = asyncHandler(async (_req, res) => {
  const items = await User.find({ role: { $in: ['admin', ...STAFF_ROLES] }, isActive: true }).select('name code role designation department email').sort({ name: 1 }).lean();
  res.json({ items });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const u = await User.findById(req.user._id);
  const b = req.body || {};
  if (b.phone !== undefined) u.phone = String(b.phone).slice(0, 30);
  if (b.address !== undefined) u.address = String(b.address).slice(0, 300);
  if (b.emergencyContact) u.emergencyContact = { name: String(b.emergencyContact.name || '').slice(0, 80), phone: String(b.emergencyContact.phone || '').slice(0, 30) };
  await u.save();
  res.json({ user: u });
});
