import crypto from 'crypto';
import { Client, Project, WorkItem, PROJECT_STATUS, ITEM_STATUS } from '../models/flow.js';
import { User } from '../models/User.js';
import { pushTo } from '../utils/push.js';
import { nextSeq } from '../models/Counter.js';
import { HttpError, asyncHandler, pick } from '../utils/helpers.js';
import { DATE_RE, dateKey } from '../utils/time.js';
import { ITEM_TYPES, PRIORITIES, addDays, cleanChecklist, cleanLabels, cleanLinks, projectHealth, publicShareView } from '../utils/flowCalc.js';

const sid = (v) => String(v?._id || v);
const isAdmin = (u) => u.role === 'admin';
const PRIORITY = PRIORITIES;
// The clean* helpers throw plain errors for bad input; turn those into 400 responses.
const clean = (fn) => { try { return fn(); } catch (e) { if (e.badInput) throw new HttpError(400, e.message); throw e; } };
const COLUMN_LABEL = { todo: 'To do', doing: 'In progress', review: 'Review', done: 'Done' };
const shortDate = (k) => { const [, m, d] = k.split('-').map(Number); return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`; };
// Fields on a card the assigned person (who is not the lead) may change themselves.
const ASSIGNEE_FIELDS = ['checklist', 'links'];

// Adds a line to the card's history (kept to the latest 60).
function note(item, user, text) {
  item.activity.push({ user: user._id, text: text.slice(0, 200) });
  if (item.activity.length > 60) item.activity.splice(0, item.activity.length - 60);
}
const ITEM_FIELDS_FOR_HEALTH = 'project title status dueDate startDate assignee estimateHours loggedHours milestone blockedBy updatedAt type';
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
  const items = await WorkItem.find({ project: { $in: projects.map((p) => p._id) } }).select(ITEM_FIELDS_FOR_HEALTH).lean();
  const today = dateKey();
  res.json({
    items: projects.map((p) => {
      const list = items.filter((i) => sid(i.project) === sid(p._id));
      const mine = withProgress(p, list);
      const h = projectHealth({ project: p, items: list, today });
      mine.health = { rag: h.rag, reasons: h.reasons };
      delete mine.share; // the share token is only for the project page itself
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
  pushTo([...(p.members || []), p.lead], { title: 'You were added to a project', body: p.name, url: `/flow/projects/${p._id}`, adminUrl: `/admin/flow/projects/${p._id}`, tag: `prj-${p._id}` }, { exceptId: req.user._id });
  res.status(201).json({ project: p });
});

export const getProject = asyncHandler(async (req, res) => {
  const p = await loadProject(req.params.id, req.user);
  const items = await WorkItem.find({ project: p._id })
    .populate('assignee', 'name code').populate('comments.author', 'name').populate('activity.user', 'name').populate('timeLogs.user', 'name').populate('blockedBy', 'title status')
    .sort({ createdAt: 1 }).lean();
  const out = withProgress(p, items);
  if (!isAdmin(req.user)) { delete out.budget; delete out.share; }
  res.json({ project: out, items, canManage: canManage(p, req.user), health: projectHealth({ project: p, items, today: dateKey() }) });
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
// Would making `blockers` the prerequisites of `selfId` create a loop (A waits for B, B waits for A)?
async function assertNoLoop(projectId, selfId, blockers) {
  const all = await WorkItem.find({ project: projectId }).select('blockedBy').lean();
  const graph = new Map(all.map((i) => [sid(i._id), (i.blockedBy || []).map(sid)]));
  const seen = new Set();
  const reaches = (from) => {
    if (from === selfId) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (graph.get(from) || []).some(reaches);
  };
  if (blockers.some(reaches)) throw new HttpError(400, 'That would make two cards wait for each other');
}

// `current` is the card as it is now (for partial updates), so dates can be compared against each other.
async function itemInput(b, project, partial, current = null) {
  const out = {};
  if (!partial || b.title !== undefined) { if (!String(b.title || '').trim()) throw new HttpError(400, 'Title is required'); out.title = b.title.trim(); }
  if (b.description !== undefined) out.description = b.description;
  if (b.priority !== undefined) { if (!PRIORITY.includes(b.priority)) throw new HttpError(400, 'Invalid priority'); out.priority = b.priority; }
  if (b.type !== undefined) { if (!ITEM_TYPES.includes(b.type)) throw new HttpError(400, 'Invalid card type'); out.type = b.type; }
  if (b.labels !== undefined) out.labels = clean(() => cleanLabels(b.labels));
  if (b.dueDate !== undefined) out.dueDate = dateOrNull(b.dueDate, 'Due date') || undefined;
  if (b.startDate !== undefined) out.startDate = dateOrNull(b.startDate, 'Start date') || undefined;
  const start = 'startDate' in out ? out.startDate : current?.startDate;
  const due = 'dueDate' in out ? out.dueDate : current?.dueDate;
  if (start && due && due < start) throw new HttpError(400, 'The due date cannot be before the start date');
  if (b.estimateHours !== undefined) {
    if (b.estimateHours === '' || b.estimateHours === null) out.estimateHours = undefined;
    else {
      const h = Number(b.estimateHours);
      if (!Number.isFinite(h) || h < 0 || h > 1000) throw new HttpError(400, 'Estimate must be between 0 and 1000 hours');
      out.estimateHours = Math.round(h * 100) / 100;
    }
  }
  if (b.milestone !== undefined) {
    if (b.milestone) {
      if (!(project.milestones || []).some((m) => sid(m._id) === String(b.milestone))) throw new HttpError(400, 'That milestone is not in this project');
      out.milestone = b.milestone;
    } else out.milestone = undefined;
  }
  if (b.checklist !== undefined) out.checklist = clean(() => cleanChecklist(b.checklist));
  if (b.links !== undefined) out.links = clean(() => cleanLinks(b.links, { max: 10 }));
  if (b.blockedBy !== undefined) {
    const ids = [...new Set((Array.isArray(b.blockedBy) ? b.blockedBy : []).map(String))];
    if (ids.length > 5) throw new HttpError(400, 'A card can wait on at most 5 other cards');
    if (current && ids.includes(sid(current._id))) throw new HttpError(400, 'A card cannot wait on itself');
    if (ids.length) {
      const found = await WorkItem.countDocuments({ _id: { $in: ids }, project: project._id });
      if (found !== ids.length) throw new HttpError(400, 'Cards can only wait on other cards of the same project');
      if (current) await assertNoLoop(project._id, sid(current._id), ids);
    }
    out.blockedBy = ids;
  }
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
  const item = new WorkItem({ ...data, project: p._id, createdBy: req.user._id });
  note(item, req.user, 'created this card');
  await item.save();
  pushTo([item.assignee], { title: 'New card assigned to you', body: `${item.title} (${p.name})`.slice(0, 140), url: `/flow/projects/${p._id}`, adminUrl: `/admin/flow/projects/${p._id}`, tag: `card-${item._id}` }, { exceptId: req.user._id });
  res.status(201).json({ item });
});

// Writes the changes of an edit into the card's history.
async function describeChanges(item, before, user, project) {
  const lines = [];
  if (before.title !== item.title) lines.push('renamed the card');
  if (before.type !== item.type) lines.push(`changed the type to ${item.type}`);
  if (before.priority !== item.priority) lines.push(`changed the priority to ${item.priority}`);
  if (before.assignee !== (item.assignee ? sid(item.assignee) : '')) {
    const who = item.assignee ? await User.findById(item.assignee).select('name').lean() : null;
    lines.push(who ? `assigned the card to ${who.name}` : 'removed the assignee');
  }
  if (before.startDate !== (item.startDate || '')) lines.push(item.startDate ? `set the start date to ${shortDate(item.startDate)}` : 'removed the start date');
  if (before.dueDate !== (item.dueDate || '')) lines.push(item.dueDate ? `set the due date to ${shortDate(item.dueDate)}` : 'removed the due date');
  if (before.milestone !== (item.milestone ? sid(item.milestone) : '')) {
    const m = (project.milestones || []).find((x) => sid(x._id) === sid(item.milestone));
    lines.push(m ? `moved the card to milestone "${m.name}"` : 'removed the card from its milestone');
  }
  if (before.estimate !== (item.estimateHours ?? '')) lines.push(item.estimateHours ? `set the estimate to ${item.estimateHours} h` : 'removed the estimate');
  if (before.blockedBy !== (item.blockedBy || []).map(sid).sort().join(',')) lines.push('changed what this card waits for');
  const wasDone = new Set(before.doneChecks);
  (item.checklist || []).filter((c) => c.done && !wasDone.has(sid(c._id))).forEach((c) => lines.push(`ticked "${c.text.slice(0, 60)}"`));
  lines.forEach((l) => note(item, user, l));
}

export const updateItem = asyncHandler(async (req, res) => {
  const item = await WorkItem.findById(req.params.id);
  if (!item) throw new HttpError(404, 'Card not found');
  const p = await Project.findById(item.project).lean();
  const manage = canManage(p, req.user);
  const mine = !!item.assignee && sid(item.assignee) === sid(req.user._id);
  if (!manage && !mine) throw new HttpError(403, 'Only the admin, the project lead or the person assigned can edit this card');
  // the assignee may tick the checklist and add links; everything else is for the admin and lead
  const body = manage ? req.body || {} : pick(req.body || {}, ASSIGNEE_FIELDS);
  if (!manage && !Object.keys(body).length) throw new HttpError(403, 'You can update the checklist and links on your cards. Ask the project lead for other changes.');

  const before = {
    title: item.title, type: item.type, priority: item.priority, assignee: item.assignee ? sid(item.assignee) : '', startDate: item.startDate || '', dueDate: item.dueDate || '',
    milestone: item.milestone ? sid(item.milestone) : '', estimate: item.estimateHours ?? '', blockedBy: (item.blockedBy || []).map(sid).sort().join(','),
    doneChecks: (item.checklist || []).filter((c) => c.done).map((c) => sid(c._id)),
  };
  Object.assign(item, await itemInput(body, p, true, item));
  await describeChanges(item, before, req.user, p);
  await item.save();
  if (item.assignee && before.assignee !== sid(item.assignee)) pushTo([item.assignee], { title: 'Card assigned to you', body: `${item.title} (${p.name})`.slice(0, 140), url: `/flow/projects/${p._id}`, adminUrl: `/admin/flow/projects/${p._id}`, tag: `card-${item._id}` }, { exceptId: req.user._id });
  res.json({ item });
});

export const deleteItem = asyncHandler(async (req, res) => {
  const item = await WorkItem.findById(req.params.id);
  if (!item) throw new HttpError(404, 'Card not found');
  const p = await Project.findById(item.project).lean();
  if (!canManage(p, req.user)) throw new HttpError(403, 'Only the admin or project lead can delete cards');
  await Promise.all([item.deleteOne(), WorkItem.updateMany({ blockedBy: item._id }, { $pull: { blockedBy: item._id } })]);
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
  if (item.status !== status) note(item, req.user, `moved the card from ${COLUMN_LABEL[item.status]} to ${COLUMN_LABEL[status]}`);
  item.status = status;
  item.completedAt = status === 'done' ? new Date() : undefined;
  await item.save();
  pushTo([item.assignee, p.lead, item.createdBy], { title: `Card moved to ${COLUMN_LABEL[status]}`, body: `${req.user.name}: ${item.title}`.slice(0, 140), url: `/flow/projects/${p._id}`, adminUrl: `/admin/flow/projects/${p._id}`, tag: `card-${item._id}` }, { exceptId: req.user._id });
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
  pushTo([item.assignee, p.lead, item.createdBy, ...item.comments.map((c) => c.author)], { title: `Comment on "${item.title}"`.slice(0, 60), body: `${req.user.name}: ${text}`.slice(0, 140), url: `/flow/projects/${p._id}`, adminUrl: `/admin/flow/projects/${p._id}`, tag: `cmt-${item._id}` }, { exceptId: req.user._id });
  res.status(201).json({ item });
});

// ===================== views =====================
export const myWork = asyncHandler(async (req, res) => {
  const items = await WorkItem.find({ assignee: req.user._id, status: { $ne: 'done' } }).populate('project', 'name code status').populate('blockedBy', 'status').sort({ dueDate: 1 }).lean();
  const today = dateKey();
  const soon = addDays(today, 7);
  const mine = await Project.find({ $or: [{ lead: req.user._id }, { members: req.user._id }], status: { $in: ['planning', 'active'] } }).select('name code status dueDate').lean();
  const out = items.map((i) => ({
    ...i,
    overdue: !!(i.dueDate && i.dueDate < today),
    blocked: (i.blockedBy || []).some((b) => b.status !== 'done'),
    blockedBy: undefined,
  }));
  res.json({
    items: out, projects: mine,
    summary: {
      overdue: out.filter((i) => i.overdue).length,
      dueToday: out.filter((i) => i.dueDate === today).length,
      dueSoon: out.filter((i) => i.dueDate && i.dueDate > today && i.dueDate <= soon).length,
      blocked: out.filter((i) => i.blocked).length,
    },
  });
});

// Light summary for the badge in the sidebar and the notice on the home page.
export const reminders = asyncHandler(async (req, res) => {
  const today = dateKey();
  const soon = addDays(today, 7);
  const items = await WorkItem.find({ assignee: req.user._id, status: { $ne: 'done' }, dueDate: { $lte: soon, $exists: true } })
    .populate('project', 'name').select('title dueDate project priority').sort({ dueDate: 1 }).lean();
  const live = items.filter((i) => i.project);
  res.json({
    overdue: live.filter((i) => i.dueDate < today).length,
    dueToday: live.filter((i) => i.dueDate === today).length,
    dueSoon: live.filter((i) => i.dueDate > today).length,
    items: live.slice(0, 5).map((i) => ({ _id: i._id, title: i.title, dueDate: i.dueDate, project: { _id: i.project._id, name: i.project.name }, overdue: i.dueDate < today })),
  });
});

export const overview = asyncHandler(async (_req, res) => {
  const [projects, items, clients] = await Promise.all([
    Project.find().select('status dueDate startDate name code createdAt milestones').lean(),
    WorkItem.find().select(ITEM_FIELDS_FOR_HEALTH).lean(),
    Client.countDocuments(),
  ]);
  const today = dateKey();
  const open = items.filter((i) => i.status !== 'done');
  const byStatus = Object.fromEntries(PROJECT_STATUS.map((s) => [s, projects.filter((p) => p.status === s).length]));
  const health = { green: 0, amber: 0, red: 0 };
  const attention = [];
  projects.filter((p) => p.status !== 'completed').forEach((p) => {
    const h = projectHealth({ project: p, items: items.filter((i) => sid(i.project) === sid(p._id)), today });
    if (health[h.rag] !== undefined) health[h.rag]++;
    if (h.rag === 'amber' || h.rag === 'red') attention.push({ _id: p._id, name: p.name, code: p.code, rag: h.rag, reasons: h.reasons, percent: h.percent });
  });
  attention.sort((a, b) => (a.rag === b.rag ? 0 : a.rag === 'red' ? -1 : 1));
  res.json({
    clients, byStatus, openCards: open.length, overdueCards: open.filter((i) => i.dueDate && i.dueDate < today).length, health, attention: attention.slice(0, 8),
    lateProjects: projects.filter((p) => p.status !== 'completed' && p.dueDate && p.dueDate < today).map((p) => ({ _id: p._id, name: p.name, code: p.code, dueDate: p.dueDate })),
  });
});

// ===================== time log =====================
async function loadItemFor(req, { manageOrAssignee }) {
  const item = await WorkItem.findById(req.params.id);
  if (!item) throw new HttpError(404, 'Card not found');
  const p = await Project.findById(item.project).lean();
  const mine = !!item.assignee && sid(item.assignee) === sid(req.user._id);
  if (manageOrAssignee && !canManage(p, req.user) && !mine) throw new HttpError(403, 'Only the person assigned, the project lead or the admin can do this');
  return { item, p };
}
const sumHours = (item) => Math.round(item.timeLogs.reduce((t, l) => t + (l.hours || 0), 0) * 100) / 100;

export const logTime = asyncHandler(async (req, res) => {
  const { item } = await loadItemFor(req, { manageOrAssignee: true });
  const hours = Math.round(Number(req.body?.hours) * 100) / 100;
  if (!Number.isFinite(hours) || hours < 0.1 || hours > 24) throw new HttpError(400, 'Enter between 0.1 and 24 hours');
  const today = dateKey();
  const date = req.body?.date ? dateOrNull(req.body.date, 'Date') : today;
  if (date > today) throw new HttpError(400, 'You cannot log time in the future');
  item.timeLogs.push({ user: req.user._id, hours, note: String(req.body?.note || '').trim().slice(0, 200), date });
  item.loggedHours = sumHours(item);
  note(item, req.user, `logged ${hours} h`);
  await item.save();
  res.status(201).json({ item });
});

export const deleteTime = asyncHandler(async (req, res) => {
  const { item, p } = await loadItemFor(req, { manageOrAssignee: false });
  const log = item.timeLogs.id(req.params.logId);
  if (!log) throw new HttpError(404, 'Time entry not found');
  if (sid(log.user) !== sid(req.user._id) && !canManage(p, req.user)) throw new HttpError(403, 'You can only remove your own time entries');
  log.deleteOne();
  item.loggedHours = sumHours(item);
  await item.save();
  res.json({ item });
});

// ===================== milestones, links, client sharing =====================
async function projectToManage(req) {
  const p = await Project.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Project not found');
  if (!canManage(p, req.user)) throw new HttpError(403, 'Only the admin or project lead can do this');
  return p;
}

function milestoneInput(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) { if (!String(b.name || '').trim()) throw new HttpError(400, 'Milestone name is required'); out.name = b.name.trim().slice(0, 100); }
  if (b.description !== undefined) out.description = String(b.description || '').slice(0, 500);
  if (b.dueDate !== undefined) out.dueDate = dateOrNull(b.dueDate, 'Due date') || undefined;
  return out;
}

export const createMilestone = asyncHandler(async (req, res) => {
  const p = await projectToManage(req);
  if (p.milestones.length >= 30) throw new HttpError(400, 'A project can have at most 30 milestones');
  p.milestones.push(milestoneInput(req.body || {}, false));
  await p.save();
  res.status(201).json({ milestone: p.milestones[p.milestones.length - 1] });
});

export const updateMilestone = asyncHandler(async (req, res) => {
  const p = await projectToManage(req);
  const m = p.milestones.id(req.params.mid);
  if (!m) throw new HttpError(404, 'Milestone not found');
  Object.assign(m, milestoneInput(req.body || {}, true));
  if (typeof req.body?.done === 'boolean') m.doneAt = req.body.done ? new Date() : undefined;
  await p.save();
  res.json({ milestone: m });
});

export const deleteMilestone = asyncHandler(async (req, res) => {
  const p = await projectToManage(req);
  const m = p.milestones.id(req.params.mid);
  if (!m) throw new HttpError(404, 'Milestone not found');
  m.deleteOne();
  await Promise.all([p.save(), WorkItem.updateMany({ project: p._id, milestone: req.params.mid }, { $unset: { milestone: '' } })]);
  res.json({ message: 'Deleted' });
});

export const setProjectLinks = asyncHandler(async (req, res) => {
  const p = await projectToManage(req);
  p.links = clean(() => cleanLinks(req.body?.links, { kinds: true, max: 20 }));
  await p.save();
  res.json({ links: p.links });
});

// Admin only: the read-only page a client can open without logging in.
export const setShare = asyncHandler(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Project not found');
  const b = req.body || {};
  const cur = p.share?.toObject ? p.share.toObject() : { ...(p.share || {}) };
  const next = { token: cur.token, enabled: !!cur.enabled, showTasks: !!cur.showTasks };
  if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
  if (typeof b.showTasks === 'boolean') next.showTasks = b.showTasks;
  if (!next.token || b.regenerate) next.token = crypto.randomBytes(18).toString('base64url'); // a new token kills the old link
  p.set('share', next);
  await p.save();
  res.json({ share: next });
});

// Public: no login. Returns progress only (see publicShareView).
export const publicShare = asyncHandler(async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw new HttpError(404, 'This link is not active');
  const p = await Project.findOne({ 'share.token': token, 'share.enabled': true }).populate('client', 'name').lean();
  if (!p) throw new HttpError(404, 'This link is not active');
  const items = await WorkItem.find({ project: p._id }).select('title status type dueDate milestone updatedAt').lean();
  res.set('Cache-Control', 'no-store');
  res.json(publicShareView({ project: p, items, today: dateKey(), client: p.client }));
});

// Used when a person is removed from the system.
export async function detachUser(userId) {
  await Promise.all([
    Project.updateMany({ members: userId }, { $pull: { members: userId } }),
    Project.updateMany({ lead: userId }, { $unset: { lead: '' } }),
    WorkItem.updateMany({ assignee: userId }, { $unset: { assignee: '' } }),
  ]);
}
