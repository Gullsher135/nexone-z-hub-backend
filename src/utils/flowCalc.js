import { DATE_RE } from './time.js';

// Pure helpers for NexoneZ Flow (no database inside), so they are easy to test.

export const ITEM_TYPES = ['task', 'bug', 'feature', 'improvement'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const LINK_KINDS = ['repo', 'design', 'doc', 'staging', 'production', 'other'];

const sid = (v) => String(v?._id || v);

// ---- dates ('YYYY-MM-DD' strings) ----
const toUtc = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
export const addDays = (key, n) => new Date(toUtc(key) + n * 86400000).toISOString().slice(0, 10);

// ---- input cleaning (throws plain Errors with a message; the controller turns them into 400s) ----
const bad = (m) => { const e = new Error(m); e.badInput = true; return e; };

export function cleanLabels(list) {
  if (!Array.isArray(list)) throw bad('Labels must be a list');
  const out = [];
  for (const raw of list) {
    const t = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  if (out.length > 8) throw bad('Use at most 8 labels on a card');
  return out;
}

export function cleanChecklist(list) {
  if (!Array.isArray(list)) throw bad('Checklist must be a list');
  if (list.length > 40) throw bad('A checklist can have at most 40 items');
  return list
    .map((x) => ({ ...(x?._id ? { _id: x._id } : {}), text: String(x?.text || '').trim().slice(0, 140), done: !!x?.done }))
    .filter((x) => x.text);
}

export function cleanUrl(raw) {
  const url = String(raw || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 500) throw bad('Links must start with http:// or https://');
  return url;
}

export function cleanLinks(list, { kinds = false, max = 12 } = {}) {
  if (!Array.isArray(list)) throw bad('Links must be a list');
  if (list.length > max) throw bad(`At most ${max} links are allowed here`);
  return list.map((l) => {
    const url = cleanUrl(l?.url);
    const out = { ...(l?._id ? { _id: l._id } : {}), url, title: String(l?.title || '').trim().slice(0, 80) || url.replace(/^https?:\/\//i, '').slice(0, 60) };
    if (kinds) out.kind = LINK_KINDS.includes(l?.kind) ? l.kind : 'other';
    return out;
  });
}

// ---- project health ----
const DONE = 'done';

export function projectHealth({ project, items, today }) {
  const open = items.filter((i) => i.status !== DONE);
  const total = items.length;
  const done = total - open.length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const byId = new Map(items.map((i) => [sid(i._id), i]));

  const overdue = open.filter((i) => i.dueDate && i.dueDate < today);
  const weekEnd = addDays(today, 7);
  const dueSoon = open.filter((i) => i.dueDate && i.dueDate >= today && i.dueDate <= weekEnd);
  const blocked = open.filter((i) => (i.blockedBy || []).some((b) => { const x = byId.get(sid(b)); return x && x.status !== DONE; }));
  const unassigned = open.filter((i) => !i.assignee);

  const byStatus = { todo: 0, doing: 0, review: 0, done: 0 };
  items.forEach((i) => { if (byStatus[i.status] !== undefined) byStatus[i.status]++; });

  const hours = {
    estimate: round1(items.reduce((s, i) => s + (i.estimateHours || 0), 0)),
    logged: round1(items.reduce((s, i) => s + (i.loggedHours || 0), 0)),
    remaining: round1(open.reduce((s, i) => s + Math.max((i.estimateHours || 0) - (i.loggedHours || 0), 0), 0)),
  };

  // workload: who carries how much of the open work
  const load = new Map();
  const row = (key) => { if (!load.has(key)) load.set(key, { user: key === 'none' ? null : key, open: 0, doing: 0, overdue: 0, remainingHours: 0, loggedHours: 0, done: 0 }); return load.get(key); };
  items.forEach((i) => {
    const r = row(i.assignee ? sid(i.assignee) : 'none');
    r.loggedHours += i.loggedHours || 0;
    if (i.status === DONE) { r.done++; return; }
    r.open++;
    if (i.status === 'doing') r.doing++;
    if (i.dueDate && i.dueDate < today) r.overdue++;
    r.remainingHours += Math.max((i.estimateHours || 0) - (i.loggedHours || 0), 0);
  });
  const workload = [...load.values()].map((r) => ({ ...r, remainingHours: round1(r.remainingHours), loggedHours: round1(r.loggedHours) })).sort((a, b) => b.open - a.open);

  const milestones = (project.milestones || []).map((m) => {
    const mine = items.filter((i) => i.milestone && sid(i.milestone) === sid(m._id));
    const d = mine.filter((i) => i.status === DONE).length;
    const complete = !!m.doneAt || (mine.length > 0 && d === mine.length);
    return {
      _id: m._id, name: m.name, description: m.description, dueDate: m.dueDate || null, doneAt: m.doneAt || null,
      total: mine.length, done: d, percent: mine.length ? Math.round((d / mine.length) * 100) : (m.doneAt ? 100 : 0),
      complete, overdue: !complete && !!m.dueDate && m.dueDate < today,
    };
  }).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));

  // traffic light
  const reasons = [];
  let rag = 'green';
  const raise = (to) => { const order = ['green', 'amber', 'red']; if (order.indexOf(to) > order.indexOf(rag)) rag = to; };
  if (project.status === 'completed') {
    rag = 'done';
  } else if (total === 0) {
    rag = 'none';
    reasons.push('No cards on the board yet');
  } else {
    if (project.dueDate && project.dueDate < today) { raise('red'); reasons.push('The project deadline has passed'); }
    if (overdue.length) {
      raise(overdue.length >= 3 || (overdue.length >= 2 && overdue.length / open.length >= 0.3) ? 'red' : 'amber'); // one late card is a warning, not an alarm
      reasons.push(`${overdue.length} overdue card${overdue.length > 1 ? 's' : ''}`);
    }
    if (blocked.length) { raise('amber'); reasons.push(`${blocked.length} card${blocked.length > 1 ? 's are' : ' is'} waiting on another card`); }
    const start = project.startDate || (project.createdAt ? new Date(project.createdAt).toISOString().slice(0, 10) : null);
    if (project.dueDate && start && start < project.dueDate) {
      const span = daysBetween(start, project.dueDate);
      const elapsed = Math.min(Math.max(daysBetween(start, today), 0), span);
      const expected = Math.round((elapsed / span) * 100);
      if (percent + 25 < expected) { raise(percent + 45 < expected ? 'red' : 'amber'); reasons.push(`${percent}% done, but ${expected}% of the time has passed`); }
    }
    if (milestones.some((m) => m.overdue)) { raise('amber'); reasons.push('A milestone is past its date'); }
    if (project.status === 'on_hold') reasons.push('The project is on hold');
  }

  return {
    rag, reasons, percent, total, done, overdue: overdue.length, dueSoon: dueSoon.length, blocked: blocked.length,
    unassigned: unassigned.length, byStatus, hours, workload, milestones,
    upcoming: open.filter((i) => i.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5).map((i) => ({ _id: i._id, title: i.title, dueDate: i.dueDate, status: i.status, overdue: i.dueDate < today })),
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

// What a client may see on the shared page: progress only. No budget, people, comments, hours or internal links.
export function publicShareView({ project, items, today, client }) {
  const h = projectHealth({ project, items, today });
  const out = {
    project: { name: project.name, client: client?.name || null, status: project.status, startDate: project.startDate || null, dueDate: project.dueDate || null },
    progress: { percent: h.percent, total: h.total, done: h.done, byStatus: h.byStatus },
    milestones: h.milestones.map((m) => ({ name: m.name, dueDate: m.dueDate, percent: m.percent, total: m.total, done: m.done, complete: m.complete, overdue: m.overdue })),
    updatedAt: items.reduce((latest, i) => (i.updatedAt && (!latest || new Date(i.updatedAt) > new Date(latest)) ? i.updatedAt : latest), project.updatedAt || null),
  };
  if (project.share?.showTasks) {
    out.tasks = items.map((i) => ({ title: i.title, status: i.status, type: i.type || 'task', dueDate: i.dueDate || null, milestone: i.milestone ? (project.milestones || []).find((m) => sid(m._id) === sid(i.milestone))?.name || null : null }));
  }
  return out;
}

export const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);
