import crypto from 'crypto';
import { Client, Project, ProjectActivity, ProjectDoc, WorkItem, PROJECT_STATUS, ITEM_STATUS } from '../models/flow.js';
import { User } from '../models/User.js';
import { nextSeq } from '../models/Counter.js';
import { HttpError, asyncHandler, pick, csvEscape, escapeRegex } from '../utils/helpers.js';
import { logActivity } from '../utils/activity.js';
import { extractMentions } from '../utils/mentions.js';
import { aggregateTime, timeCsv } from '../utils/flowReports.js';
import { audit } from '../utils/audit.js';
import { notifyAdmins } from '../utils/push.js';
import { notifyUsers } from '../utils/push.js';
import { KIND_INFO, PROJECT_KINDS, STAGES, cleanMetrics, cleanRelease, starterMilestones } from '../utils/flowKinds.js';
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
export const isMember = (p, u) => isAdmin(u) || sid(p.lead) === sid(u._id) || (p.members || []).some((m) => sid(m) === sid(u._id));
// Admin or the project lead can manage cards freely.
export const canManage = (p, u) => isAdmin(u) || sid(p.lead) === sid(u._id);

// Where a tap on a Flow notification opens (admin and staff have different page prefixes).
const flowUrls = (projectId, itemId) => {
  const q = itemId ? `?item=${itemId}` : '';
  return { admin: `/admin/flow/projects/${projectId}${q}`, staff: `/flow/projects/${projectId}${q}` };
};
const teamOf = (p) => [p.lead, ...(p.members || [])].filter(Boolean).map(sid);
const kindLabel = (p) => (KIND_INFO[p.kind] || KIND_INFO.project).label.toLowerCase();

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
  const and = [];
  const kind = String(req.query.kind || '');
  if (PROJECT_KINDS.includes(kind)) and.push(kind === 'project' ? { $or: [{ kind: 'project' }, { kind: { $exists: false } }] } : { kind }); // older projects have no kind and count as projects
  if (!isAdmin(req.user)) and.push({ $or: [{ lead: req.user._id }, { members: req.user._id }] });
  if (and.length) f.$and = and;
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
      delete mine.releases;
      mine.kind = mine.kind || 'project';
      if (!isAdmin(req.user)) { delete mine.budget; if (mine.metrics) delete mine.metrics.mrr; }
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
  const kind = b.kind === undefined ? 'project' : b.kind;
  if (!PROJECT_KINDS.includes(kind)) throw new HttpError(400, 'Choose Project, Product or SaaS');
  if (b.stage && !STAGES.includes(b.stage)) throw new HttpError(400, 'Invalid stage');
  const members = await staffIds([...(b.members || []), b.lead]);
  const info = KIND_INFO[kind];
  const n = await nextSeq(info.counter);
  const extra = kind === 'project' ? {} : { stage: b.stage || 'idea', version: String(b.version || '').trim().slice(0, 20) || undefined, metrics: clean(() => cleanMetrics(b.metrics)) };
  const p = await Project.create({
    code: `${info.prefix}-${String(n).padStart(3, '0')}`, kind, ...extra,
    name: b.name.trim(), description: b.description, client: kind === 'project' ? b.client || undefined : undefined, status: b.status || 'planning',
    startDate, dueDate, budget: Math.max(0, Number(b.budget) || 0), lead: b.lead || undefined, members, createdBy: req.user._id,
    milestones: b.starterMilestones ? starterMilestones(kind) : [],
  });
  notifyUsers(teamOf(p), { title: `You were added to a ${info.label.toLowerCase()}`, body: p.name, tag: `proj-${p._id}`, urls: flowUrls(p._id) }, { exclude: req.user._id });
  logActivity(p, req.user, `created this ${info.label.toLowerCase()}`);
  audit(req, 'flow.project.create', { entity: 'Project', entityId: p._id, summary: `Created ${info.label.toLowerCase()} ${p.code} ${p.name}` });
  res.status(201).json({ project: p });
});

export const getProject = asyncHandler(async (req, res) => {
  const p = await loadProject(req.params.id, req.user);
  const items = await WorkItem.find({ project: p._id })
    .populate('assignee', 'name code').populate('comments.author', 'name').populate('activity.user', 'name').populate('timeLogs.user', 'name').populate('blockedBy', 'title status')
    .sort({ createdAt: 1 }).lean();
  const out = withProgress(p, items);
  out.kind = out.kind || 'project';
  if (!canManage(p, req.user)) delete out.clientFeedback;
  if (!isAdmin(req.user)) { delete out.budget; delete out.share; if (out.metrics) delete out.metrics.mrr; }
  res.json({ project: out, items, canManage: canManage(p, req.user), health: projectHealth({ project: p, items, today: dateKey() }) });
});

export const updateProject = asyncHandler(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Project not found');
  const b = req.body || {};
  const wasStatus = p.status;
  const wasTeam = new Set(teamOf(p));
  if (b.name !== undefined) { if (!String(b.name).trim()) throw new HttpError(400, 'Project name is required'); p.name = b.name.trim(); }
  if (b.description !== undefined) p.description = b.description;
  if (b.kind !== undefined) { if (!PROJECT_KINDS.includes(b.kind)) throw new HttpError(400, 'Choose Project, Product or SaaS'); p.kind = b.kind; }
  if (b.stage !== undefined) { if (b.stage && !STAGES.includes(b.stage)) throw new HttpError(400, 'Invalid stage'); p.stage = b.stage || undefined; }
  if (b.version !== undefined) p.version = String(b.version || '').trim().slice(0, 20) || undefined;
  if (b.metrics !== undefined) p.metrics = clean(() => cleanMetrics(b.metrics));
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
  const urls = flowUrls(p._id);
  const added = teamOf(p).filter((id) => !wasTeam.has(id));
  notifyUsers(added, { title: `You were added to a ${kindLabel(p)}`, body: p.name, tag: `proj-${p._id}`, urls }, { exclude: req.user._id });
  if (p.status !== wasStatus) {
    logActivity(p, req.user, `changed the status from ${wasStatus.replace('_', ' ')} to ${p.status.replace('_', ' ')}`);
    audit(req, 'flow.project.status', { entity: 'Project', entityId: p._id, summary: `${p.code} ${p.name}: ${wasStatus} to ${p.status}` });
    const word = { completed: 'completed', on_hold: 'put on hold', active: 'now active', planning: 'moved back to planning' }[p.status];
    notifyUsers(teamOf(p).filter((id) => wasTeam.has(id)), { title: `${p.name} is ${word}`, body: `Status changed by ${req.user.name}`, tag: `projstatus-${p._id}`, urls }, { exclude: req.user._id });
  }
  res.json({ project: p });
});

export const deleteProject = asyncHandler(async (req, res) => {
  const p = await Project.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Project not found');
  const { removeProjectDocs } = await import('./flowDocs.controller.js');
  await Promise.all([WorkItem.deleteMany({ project: p._id }), removeProjectDocs(p._id), ProjectActivity.deleteMany({ project: p._id }), p.deleteOne()]);
  audit(req, 'flow.project.delete', { entity: 'Project', entityId: p._id, summary: `Deleted ${p.code} ${p.name}` });
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
  logActivity(p, req.user, `created the card "${item.title}"`, { item: item._id });
  if (item.assignee) notifyUsers([item.assignee], { email: true, title: `New card for you: ${item.title}`, body: `${p.name} · assigned by ${req.user.name}${item.dueDate ? ` · due ${shortDate(item.dueDate)}` : ''}`, tag: `card-${item._id}`, urls: flowUrls(p._id, item._id) }, { exclude: req.user._id });
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
  if (item.assignee) {
    const urls = flowUrls(p._id, item._id);
    if (sid(item.assignee) !== before.assignee) logActivity(p, req.user, `assigned "${item.title}" to someone new`, { item: item._id });
    if (sid(item.assignee) !== before.assignee) notifyUsers([item.assignee], { email: true, title: `Card assigned to you: ${item.title}`, body: `${p.name} · by ${req.user.name}${item.dueDate ? ` · due ${shortDate(item.dueDate)}` : ''}`, tag: `card-${item._id}`, urls }, { exclude: req.user._id });
    else if ((item.dueDate || '') !== before.dueDate && item.dueDate) notifyUsers([item.assignee], { title: `Due date changed: ${item.title}`, body: `${p.name} · now due ${shortDate(item.dueDate)}`, tag: `card-${item._id}`, urls }, { exclude: req.user._id });
  }
  res.json({ item });
});

export const deleteItem = asyncHandler(async (req, res) => {
  const item = await WorkItem.findById(req.params.id);
  if (!item) throw new HttpError(404, 'Card not found');
  const p = await Project.findById(item.project).lean();
  if (!canManage(p, req.user)) throw new HttpError(403, 'Only the admin or project lead can delete cards');
  const { removeItemDocs } = await import('./flowDocs.controller.js');
  await Promise.all([item.deleteOne(), WorkItem.updateMany({ blockedBy: item._id }, { $pull: { blockedBy: item._id } }), removeItemDocs(item._id)]);
  logActivity(p, req.user, `deleted the card "${item.title}"`);
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
  const changed = item.status !== status;
  if (changed) note(item, req.user, `moved the card from ${COLUMN_LABEL[item.status]} to ${COLUMN_LABEL[status]}`);
  item.status = status;
  item.completedAt = status === 'done' ? new Date() : undefined;
  await item.save();
  if (changed) {
    logActivity(p, req.user, `moved "${item.title}" to ${COLUMN_LABEL[status]}`, { item: item._id });
    // the lead hears when work reaches review or is done; the assignee hears when somebody else moves their card
    const to = [];
    if (['review', 'done'].includes(status) && p.lead) to.push(p.lead);
    if (item.assignee) to.push(item.assignee);
    notifyUsers(to, { title: `${item.title}: ${COLUMN_LABEL[status]}`, body: `${p.name} · moved by ${req.user.name}`, tag: `card-${item._id}`, urls: flowUrls(p._id, item._id) }, { exclude: req.user._id });
  }
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
  logActivity(p, req.user, `commented on "${item.title}"`, { item: item._id });
  // @name in the comment notifies that teammate (by email too), even if they are not otherwise part of the card
  const team = await User.find({ _id: { $in: teamOf(p) } }).select('name').lean();
  const mentioned = extractMentions(text, team);
  notifyUsers(mentioned, { email: true, title: `${req.user.name} mentioned you on ${item.title}`, body: text.slice(0, 160), tag: `mention-${item._id}`, urls: flowUrls(p._id, item._id) }, { exclude: req.user._id });
  // the assignee, the lead and everybody else in the conversation (not the author, not those already mentioned)
  notifyUsers([item.assignee, p.lead, ...item.comments.map((c) => c.author)].filter((id) => id && !mentioned.includes(sid(id))), { title: `${req.user.name} commented on ${item.title}`, body: text.slice(0, 120), tag: `cmt-${item._id}`, urls: flowUrls(p._id, item._id) }, { exclude: req.user._id });
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
    Project.find().select('status dueDate startDate name code createdAt milestones kind').lean(),
    WorkItem.find().select(ITEM_FIELDS_FOR_HEALTH).lean(),
    Client.countDocuments(),
  ]);
  const today = dateKey();
  const open = items.filter((i) => i.status !== 'done');
  const byStatus = Object.fromEntries(PROJECT_STATUS.map((s) => [s, projects.filter((p) => p.status === s).length]));
  const byKind = Object.fromEntries(PROJECT_KINDS.map((k) => [k, projects.filter((p) => (p.kind || 'project') === k).length]));
  const health = { green: 0, amber: 0, red: 0 };
  const attention = [];
  projects.filter((p) => p.status !== 'completed').forEach((p) => {
    const h = projectHealth({ project: p, items: items.filter((i) => sid(i.project) === sid(p._id)), today });
    if (health[h.rag] !== undefined) health[h.rag]++;
    if (h.rag === 'amber' || h.rag === 'red') attention.push({ _id: p._id, name: p.name, code: p.code, kind: p.kind || 'project', rag: h.rag, reasons: h.reasons, percent: h.percent });
  });
  attention.sort((a, b) => (a.rag === b.rag ? 0 : a.rag === 'red' ? -1 : 1));
  res.json({
    clients, byStatus, byKind, openCards: open.length, overdueCards: open.filter((i) => i.dueDate && i.dueDate < today).length, health, attention: attention.slice(0, 8),
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
  logActivity(item.project, req.user, `logged ${hours} h on "${item.title}"`, { item: item._id });
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
  logActivity(p, req.user, `added the milestone "${p.milestones[p.milestones.length - 1].name}"`);
  res.status(201).json({ milestone: p.milestones[p.milestones.length - 1] });
});

export const updateMilestone = asyncHandler(async (req, res) => {
  const p = await projectToManage(req);
  const m = p.milestones.id(req.params.mid);
  if (!m) throw new HttpError(404, 'Milestone not found');
  Object.assign(m, milestoneInput(req.body || {}, true));
  if (typeof req.body?.done === 'boolean') m.doneAt = req.body.done ? new Date() : undefined;
  await p.save();
  if (typeof req.body?.done === 'boolean') logActivity(p, req.user, `${req.body.done ? 'marked' : 'reopened'} the milestone "${m.name}"${req.body.done ? ' as done' : ''}`);
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
  const next = { token: cur.token, enabled: !!cur.enabled, showTasks: !!cur.showTasks, allowFeedback: cur.allowFeedback !== false };
  if (typeof b.allowFeedback === 'boolean') next.allowFeedback = b.allowFeedback;
  if (typeof b.enabled === 'boolean') next.enabled = b.enabled;
  if (typeof b.showTasks === 'boolean') next.showTasks = b.showTasks;
  if (!next.token || b.regenerate) next.token = crypto.randomBytes(18).toString('base64url'); // a new token kills the old link
  p.set('share', next);
  await p.save();
  audit(req, 'flow.share', { entity: 'Project', entityId: p._id, summary: `${p.code}: client link ${next.enabled ? 'on' : 'off'}${b.regenerate ? ' (new link)' : ''}` });
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

// ===================== releases (products and SaaS) =====================
export const createRelease = asyncHandler(async (req, res) => {
  const p = await projectToManage(req);
  if ((p.kind || 'project') === 'project') throw new HttpError(400, 'Releases are for products and SaaS. A project is delivered once.');
  const r = clean(() => cleanRelease(req.body));
  if (p.releases.length >= 200) throw new HttpError(400, 'This project already has 200 releases');
  p.releases.push({ ...r, date: r.date || dateKey(), by: req.user._id });
  p.version = r.version; // the newest release is the current version
  await p.save();
  logActivity(p, req.user, `published release ${r.version}${r.title ? `: ${r.title}` : ''}`);
  notifyUsers(teamOf(p), { title: `${p.name} ${r.version} released`, body: r.title || r.notes.slice(0, 100), tag: `rel-${p._id}-${r.version}`, urls: { ...flowUrls(p._id), admin: `/admin/flow/projects/${p._id}?tab=releases`, staff: `/flow/projects/${p._id}?tab=releases` } }, { exclude: req.user._id });
  res.status(201).json({ project: p });
});

export const deleteRelease = asyncHandler(async (req, res) => {
  const p = await projectToManage(req);
  const rel = p.releases.id(req.params.rid);
  if (!rel) throw new HttpError(404, 'Release not found');
  rel.deleteOne();
  await p.save();
  res.json({ project: p });
});

// ===================== export =====================
// All cards of a project as a spreadsheet (CSV), for reports and clients.
export const exportCards = asyncHandler(async (req, res) => {
  const p = await loadProject(req.params.id, req.user);
  const items = await WorkItem.find({ project: p._id }).populate('assignee', 'name').sort({ createdAt: 1 }).lean();
  const ms = new Map((p.milestones || []).map((m) => [sid(m._id), m.name]));
  const head = ['Card', 'Type', 'Status', 'Priority', 'Assigned to', 'Milestone', 'Start', 'Due', 'Estimate (h)', 'Logged (h)', 'Completed'];
  const rows = items.map((i) => [i.title, i.type, COLUMN_LABEL[i.status], i.priority, i.assignee?.name || '', i.milestone ? ms.get(sid(i.milestone)) || '' : '', i.startDate || '', i.dueDate || '', i.estimateHours ?? '', i.loggedHours || 0, i.completedAt ? dateKey(new Date(i.completedAt)) : '']);
  const csv = [head, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${p.code}-cards.csv"`, 'Cache-Control': 'private, no-store' });
  res.send('\ufeff' + csv);
});

// ===================== activity feed =====================
export const activityFeed = asyncHandler(async (req, res) => {
  const p = await loadProject(req.params.id, req.user);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
  const items = await ProjectActivity.find({ project: p._id }).sort({ at: -1 }).limit(limit).select('userName text at item').lean();
  res.json({ items });
});

// ===================== time report (admin) =====================
const monthStart = (k) => `${k.slice(0, 7)}-01`;
export const timeReport = asyncHandler(async (req, res) => {
  const today = dateKey();
  const from = req.query.from ? String(req.query.from) : monthStart(today);
  const to = req.query.to ? String(req.query.to) : today;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new HttpError(400, 'Choose a valid date range');
  const items = await WorkItem.find({ 'timeLogs.date': { $gte: from, $lte: to } }).select('project timeLogs').lean();
  const agg = aggregateTime(items, { from, to });
  const [users, projects] = await Promise.all([
    User.find({ _id: { $in: agg.byUser.map((u) => u.id) } }).select('name code').lean(),
    Project.find({ _id: { $in: agg.byProject.map((x) => x.id) } }).select('name code kind').lean(),
  ]);
  const U = new Map(users.map((u) => [sid(u._id), u]));
  const P = new Map(projects.map((x) => [sid(x._id), x]));
  const rows = agg.rows.map((r) => ({ ...r, userName: U.get(r.user)?.name || 'Removed person', userCode: U.get(r.user)?.code, projectName: P.get(r.project)?.name || 'Deleted project', projectCode: P.get(r.project)?.code }))
    .sort((a, b) => a.userName.localeCompare(b.userName) || b.hours - a.hours);
  if (req.query.format === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="time-report-${from}-to-${to}.csv"`, 'Cache-Control': 'private, no-store' });
    return res.send('\ufeff' + timeCsv(rows));
  }
  res.json({
    from, to, total: agg.total, rows,
    byUser: agg.byUser.map((u) => ({ ...u, name: U.get(u.id)?.name || 'Removed person', code: U.get(u.id)?.code })),
    byProject: agg.byProject.map((x) => ({ ...x, name: P.get(x.id)?.name || 'Deleted project', code: P.get(x.id)?.code, kind: P.get(x.id)?.kind || 'project' })),
  });
});

// ===================== search =====================
export const search = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json({ projects: [], cards: [], docs: [] });
  const rx = new RegExp(escapeRegex(q), 'i');
  const mine = isAdmin(req.user) ? {} : { $or: [{ lead: req.user._id }, { members: req.user._id }] };
  const projects = await Project.find(mine).select('name code kind status').lean();
  const ids = projects.map((x) => x._id);
  const [cards, docs] = await Promise.all([
    WorkItem.find({ project: { $in: ids }, title: rx }).select('title status project').sort({ updatedAt: -1 }).limit(8).lean(),
    ProjectDoc.find({ project: { $in: ids }, item: { $exists: false }, $or: [{ title: rx }, { name: rx }] }).select('title name project').limit(8).lean(),
  ]);
  const by = new Map(projects.map((x) => [sid(x._id), x]));
  const ref = (id) => { const x = by.get(sid(id)); return x ? { _id: x._id, name: x.name, kind: x.kind || 'project' } : null; };
  res.json({
    projects: projects.filter((x) => rx.test(x.name) || rx.test(x.code)).slice(0, 8).map((x) => ({ _id: x._id, name: x.name, code: x.code, kind: x.kind || 'project' })),
    cards: cards.map((c) => ({ _id: c._id, title: c.title, status: c.status, project: ref(c.project) })).filter((c) => c.project),
    docs: docs.map((d) => ({ _id: d._id, title: d.title, name: d.name, project: ref(d.project) })).filter((d) => d.project),
  });
});

// ===================== client feedback (from the shared progress page) =====================
const cleanLine = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);

// Public: no account. Rate limited by the router; also capped per project.
export const publicFeedback = asyncHandler(async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw new HttpError(404, 'This link is not active');
  const p = await Project.findOne({ 'share.token': token, 'share.enabled': true });
  if (!p) throw new HttpError(404, 'This link is not active');
  if (p.share.allowFeedback === false) throw new HttpError(403, 'Messages are switched off for this link');
  const b = req.body || {};
  const name = cleanLine(b.name, 60);
  if (name.length < 2) throw new HttpError(400, 'Please write your name');
  const message = cleanLine(b.message, 1000);
  let m;
  if (b.milestoneId) { m = p.milestones.id(String(b.milestoneId)); if (!m) throw new HttpError(400, 'That milestone was not found'); }
  const approve = b.approve === true;
  if (approve) {
    if (!m) throw new HttpError(400, 'Choose the milestone to approve');
    const cards = await WorkItem.find({ project: p._id, milestone: m._id }).select('status').lean();
    if (!cards.length || cards.some((c) => c.status !== 'done')) throw new HttpError(400, 'Only a finished milestone can be approved');
    if (p.clientFeedback.some((f) => f.kind === 'approval' && sid(f.milestone) === sid(m._id))) throw new HttpError(409, 'This milestone is already approved');
  } else if (!message) throw new HttpError(400, 'Please write your message');
  if (p.clientFeedback.filter((f) => Date.now() - new Date(f.at).getTime() < 3600e3).length >= 20) throw new HttpError(429, 'Too many messages. Please try again later.');
  while (p.clientFeedback.length >= 300) p.clientFeedback.shift();
  p.clientFeedback.push({ kind: approve ? 'approval' : 'comment', milestone: m?._id, milestoneName: m?.name, name, message: message || undefined });
  await p.save();
  const text = approve ? `${name} approved the milestone "${m.name}"` : `${name} wrote: ${message.slice(0, 120)}`;
  logActivity(p, { name: 'Client' }, text);
  notifyUsers([p.lead], { email: true, title: approve ? `Client approved a milestone in ${p.name}` : `Client message on ${p.name}`, body: text, tag: `client-${p._id}`, urls: { ...flowUrls(p._id), admin: `/admin/flow/projects/${p._id}?tab=links`, staff: `/flow/projects/${p._id}?tab=links` } });
  notifyAdmins({ email: true, title: approve ? `Client approved a milestone in ${p.name}` : `Client message on ${p.name}`, body: text, tag: `client-${p._id}`, url: `/admin/flow/projects/${p._id}?tab=links` });
  res.status(201).json({ ok: true });
});

export const feedbackSeen = asyncHandler(async (req, res) => {
  const p = await projectToManage(req);
  const now = new Date();
  p.clientFeedback.forEach((f) => { if (!f.seenAt) f.seenAt = now; });
  await p.save();
  res.json({ ok: true });
});

// Used when a person is removed from the system.
export async function detachUser(userId) {
  await Promise.all([
    Project.updateMany({ members: userId }, { $pull: { members: userId } }),
    Project.updateMany({ lead: userId }, { $unset: { lead: '' } }),
    WorkItem.updateMany({ assignee: userId }, { $unset: { assignee: '' } }),
  ]);
}
