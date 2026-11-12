import { Client, Project, WorkItem, PROJECT_STATUS, ITEM_STATUS } from '../models/flow.js';
import { User } from '../models/User.js';
import { nextSeq } from '../models/Counter.js';
import { HttpError, asyncHandler, pick } from '../utils/helpers.js';
import { DATE_RE, dateKey } from '../utils/time.js';

const sid = (v) => String(v?._id || v);
const isAdmin = (u) => u.role === 'admin';
const PRIORITY = ['low', 'medium', 'high'];
const dateOrNull = (v, label) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (!DATE_RE.test(v)) throw new HttpError(400, `${label} must be a date`);
  return v;
};

// Percent of cards that are done, plus overdue count.
function progress(items, today = dateKey()) {
  const total = items.length;
  const done = items.filter((i) => i.status === 'done').length;
  const overdue = items.filter((i) => i.status !== 'done' && i.dueDate && i.dueDate < today).length;
  return { total, done, overdue, percent: total ? Math.round((done / total) * 100) : 0 };
}

const withProgress = (p, items) => ({ ...p, progress: progress(items) });

// Can this user see / work in this project?
const isMember = (p, u) => isAdmin(u) || sid(p.lead) === sid(u._id) || (p.members || []).some((m) => sid(m) === sid(u._id));
// Admin or the project lead can manage cards freely.
const canManage = (p, u) => isAdmin(u) || sid(p.lead) === sid(u._id);

async function loadProject(id, user) {
  const p = await Project.findById(id).populate('client', 'name company').populate('lead', 'name code').populate('members', 'name code designation role').lean();
  if (!p) throw new HttpError(404, 'Project not found');
  if (!isMember(p, user)) throw new HttpError(403, 'You are not part of this project');
  return p;
}

async function staffIds(ids) {
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!list.length) return [];
  const found = await User.find({ _id: { $in: list }, role: { $in: ['admin', 'employee', 'intern'] }, isActive: true }).select('_id').lean();
  if (found.length !== list.length) throw new HttpError(400, 'Only active staff can be added to a project');
  return list;
}

// ===================== clients =====================
export const listClients = asyncHandler(async (_req, res) => {
  const [clients, projects] = await Promise.all([Client.find().sort({ name: 1 }).lean(), Project.find().select('client status').lean()]);
  res.json({ items: clients.map((c) => ({ ...c, projects: projects.filter((p) => sid(p.client) === sid(c._id)).length, activeProjects: projects.filter((p) => sid(p.client) === sid(c._id) && p.status === 'active').length })) });
});
export const createClient = asyncHandler(async (req, res) => {
  const b = pick(req.body || {}, ['name', 'company', 'email', 'phone', 'notes']);
  if (!b.name?.trim()) throw new HttpError(400, 'Client name is required');
  res.status(201).json({ client: await Client.create(b) });
});
export const updateClient = asyncHandler(async (req, res) => {
  const c = await Client.findById(req.params.id);
  if (!c) throw new HttpError(404, 'Client not found');
  const b = pick(req.body || {}, ['name', 'company', 'email', 'phone', 'notes']);
  if (b.name !== undefined && !String(b.name).trim()) throw new HttpError(400, 'Client name is required');
  Object.assign(c, b);
  await c.save();
  res.json({ client: c });
});
export const deleteClient = asyncHandler(async (req, res) => {
  const c = await Client.findById(req.params.id);
  if (!c) throw new HttpError(404, 'Client not found');
  if (await Project.exists({ client: c._id })) throw new HttpError(409, 'This client has projects. Remove or reassign those projects first.');
  await c.deleteOne();
  res.json({ message: 'Deleted' });
});

// ===================== projects =====================
export const listProjects = asyncHandler(async (req, res) => {
  const f = {};
  if (req.query.status) f.status = req.query.status;
  if (req.query.client) f.client = req.query.client;
  if (!isAdmin(req.user)) f.$or = [{ lead: req.user._id }, { members: req.user._id }];
  const projects = await Project.find(f).populate('client', 'name company').populate('lead', 'name').sort({ createdAt: -1 }).lean();
  const items = await WorkItem.find({ project: { $in: projects.map((p) => p._id) } }).select('project status dueDate').lean();
  res.json({
    items: projects.map((p) => {
      const mine = withProgress(p, items.filter((i) => sid(i.project) === sid(p._id)));
      if (!isAdmin(req.user)) delete mine.budget;
      return mine;
    }),
  });
});

export const createProject = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name?.trim()) throw new HttpError(400, 'Project name is required');
  if (b.status && !PROJECT_STATUS.includes(b.status)) throw new HttpError(400, 'Invalid status');
  const startDate = dateOrNull(b.startDate, 'Start date');
  const dueDate = dateOrNull(b.dueDate, 'Due date');
  if (startDate && dueDate && dueDate < startDate) throw new HttpError(400, 'Due date cannot be before the start date');
  if (b.client && !(await Client.exists({ _id: b.client }))) throw new HttpError(400, 'Client not found');
  const members = await staffIds([...(b.members || []), b.lead]);
  const n = await nextSeq('project');
  const p = await Project.create({
    code: `PRJ-${String(n).padStart(3, '0')}`,
    name: b.name.trim(), description: b.description, client: b.client || undefined, status: b.status || 'planning',
    startDate, dueDate, budget: Math.max(0, Number(b.budget) || 0), lead: b.lead || undefined, members, createdBy: req.user._id,
  });
  res.status(201).json({ project: p });
});

export const getProject = asyncHandler(async (req, res) => {
  const p = await loadProject(req.params.id, req.user);
  const items = await WorkItem.find({ project: p._id }).populate('assignee', 'name code').populate('comments.author', 'name').sort({ createdAt: 1 }).lean();
  const out = withProgress(p, items);
  if (!isAdmin(req.user)) delete out.budget;
  res.json({ project: out, items, canManage: canManage(p, req.user) });
});

export const updateProject = asyncHandler(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Project not found');
  const b = req.body || {};
  if (b.name !== undefined) { if (!String(b.name).trim()) throw new HttpError(400, 'Project name is required'); p.name = b.name.trim(); }
  if (b.description !== undefined) p.description = b.description;
  if (b.status !== undefined) { if (!PROJECT_STATUS.includes(b.status)) throw new HttpError(400, 'Invalid status'); p.status = b.status; }
  if (b.startDate !== undefined) p.startDate = dateOrNull(b.startDate, 'Start date') || undefined;
  if (b.dueDate !== undefined) p.dueDate = dateOrNull(b.dueDate, 'Due date') || undefined;
  if (p.startDate && p.dueDate && p.dueDate < p.startDate) throw new HttpError(400, 'Due date cannot be before the start date');
  if (b.budget !== undefined) p.budget = Math.max(0, Number(b.budget) || 0);
  if (b.client !== undefined) {
    if (b.client && !(await Client.exists({ _id: b.client }))) throw new HttpError(400, 'Client not found');
    p.client = b.client || undefined;
  }
  if (b.lead !== undefined || b.members !== undefined) {
    const lead = b.lead !== undefined ? b.lead || undefined : p.lead;
    const members = await staffIds([...(b.members !== undefined ? b.members : p.members), lead]);
    p.lead = lead;
    p.members = members;
  }
  await p.save();
  res.json({ project: p });
});

export const deleteProject = asyncHandler(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Project not found');
  await Promise.all([WorkItem.deleteMany({ project: p._id }), p.deleteOne()]);
  res.json({ message: 'Deleted' });
});

// ===================== board cards =====================
async function itemInput(b, project, partial) {
  const out = {};
  if (!partial || b.title !== undefined) { if (!String(b.title || '').trim()) throw new HttpError(400, 'Title is required'); out.title = b.title.trim(); }
  if (b.description !== undefined) out.description = b.description;
  if (b.priority !== undefined) { if (!PRIORITY.includes(b.priority)) throw new HttpError(400, 'Invalid priority'); out.priority = b.priority; }
  if (b.dueDate !== undefined) out.dueDate = dateOrNull(b.dueDate, 'Due date') || undefined;
  if (b.assignee !== undefined) {
    if (b.assignee) {
      const ok = sid(project.lead) === String(b.assignee) || (project.members || []).some((m) => sid(m) === String(b.assignee));
      if (!ok) throw new HttpError(400, 'Assign cards only to people on the project team');
    }
    out.assignee = b.assignee || undefined;
  }
  return out;
}

export const createItem = asyncHandler(async (req, res) => {
  const p = await Project.findById(req.params.id).lean();
  if (!p) throw new HttpError(404, 'Project not found');
  if (!canManage(p, req.user)) throw new HttpError(403, 'Only the admin or project lead can add cards');
  if (p.status === 'completed') throw new HttpError(409, 'This project is completed. Reopen it to add cards.');
  const data = await itemInput(req.body || {}, p, false);
  const item = await WorkItem.create({ ...data, project: p._id, createdBy: req.user._id });
  res.status(201).json({ item });
});

export const updateItem = asyncHandler(async (req, res) => {
  const item = await WorkItem.findById(req.params.id);
  if (!item) throw new HttpError(404, 'Card not found');
  const p = await Project.findById(item.project).lean();
  if (!canManage(p, req.user)) throw new HttpError(403, 'Only the admin or project lead can edit cards');
  Object.assign(item, await itemInput(req.body || {}, p, true));
  await item.save();
  res.json({ item });
});

export const deleteItem = asyncHandler(async (req, res) => {
  const item = await WorkItem.findById(req.params.id);
  if (!item) throw new HttpError(404, 'Card not found');
  const p = await Project.findById(item.project).lean();
  if (!canManage(p, req.user)) throw new HttpError(403, 'Only the admin or project lead can delete cards');
  await item.deleteOne();
  res.json({ message: 'Deleted' });
});

// Move a card across the board. The assignee, the lead and the admin may do this.
export const setItemStatus = asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!ITEM_STATUS.includes(status)) throw new HttpError(400, 'Invalid status');
  const item = await WorkItem.findById(req.params.id);
  if (!item) throw new HttpError(404, 'Card not found');
  const p = await Project.findById(item.project).lean();
  if (!canManage(p, req.user) && !(item.assignee && sid(item.assignee) === sid(req.user._id))) throw new HttpError(403, 'Only the person assigned can move this card');
  item.status = status;
  item.completedAt = status === 'done' ? new Date() : undefined;
  await item.save();
  res.json({ item });
});

export const commentItem = asyncHandler(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) throw new HttpError(400, 'Write a comment first');
  const item = await WorkItem.findById(req.params.id);
  if (!item) throw new HttpError(404, 'Card not found');
  const p = await Project.findById(item.project).lean();
  if (!isMember(p, req.user)) throw new HttpError(403, 'You are not part of this project');
  item.comments.push({ author: req.user._id, text: text.slice(0, 1000) });
  await item.save();
  res.status(201).json({ item });
});

// ===================== views =====================
export const myWork = asyncHandler(async (req, res) => {
  const items = await WorkItem.find({ assignee: req.user._id, status: { $ne: 'done' } }).populate('project', 'name code status').sort({ dueDate: 1 }).lean();
  const today = dateKey();
  const mine = await Project.find({ $or: [{ lead: req.user._id }, { members: req.user._id }], status: { $in: ['planning', 'active'] } }).select('name code status dueDate').lean();
  res.json({ items: items.map((i) => ({ ...i, overdue: !!(i.dueDate && i.dueDate < today) })), projects: mine });
});

export const overview = asyncHandler(async (_req, res) => {
  const [projects, items, clients] = await Promise.all([Project.find().select('status dueDate name code').lean(), WorkItem.find().select('status dueDate project').lean(), Client.countDocuments()]);
  const today = dateKey();
  const open = items.filter((i) => i.status !== 'done');
  const byStatus = Object.fromEntries(PROJECT_STATUS.map((s) => [s, projects.filter((p) => p.status === s).length]));
  res.json({
    clients, byStatus, openCards: open.length, overdueCards: open.filter((i) => i.dueDate && i.dueDate < today).length,
    lateProjects: projects.filter((p) => p.status !== 'completed' && p.dueDate && p.dueDate < today).map((p) => ({ _id: p._id, name: p.name, code: p.code, dueDate: p.dueDate })),
  });
});

// Used when a person is removed from the system.
export async function detachUser(userId) {
  await Promise.all([
    Project.updateMany({ members: userId }, { $pull: { members: userId } }),
    Project.updateMany({ lead: userId }, { $unset: { lead: '' } }),
    WorkItem.updateMany({ assignee: userId }, { $unset: { assignee: '' } }),
  ]);
}
