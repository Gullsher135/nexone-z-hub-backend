import { csvEscape } from './helpers.js';

// Hours per person and project between two dates (inclusive). Pure.
// items: [{ project, timeLogs: [{ user, hours, date }] }]
export function aggregateTime(items, { from, to }) {
  const cell = new Map();
  for (const it of items) {
    for (const l of it.timeLogs || []) {
      if (!l.user || !l.date || (from && l.date < from) || (to && l.date > to)) continue;
      const key = `${l.user}|${it.project}`;
      cell.set(key, Math.round(((cell.get(key) || 0) + (l.hours || 0)) * 100) / 100);
    }
  }
  const rows = [...cell].map(([k, hours]) => { const [user, project] = k.split('|'); return { user, project, hours }; });
  const sum = (key) => {
    const m = new Map();
    for (const r of rows) m.set(r[key], Math.round(((m.get(r[key]) || 0) + r.hours) * 100) / 100);
    return [...m].map(([id, hours]) => ({ id, hours })).sort((a, b) => b.hours - a.hours);
  };
  return { rows, byUser: sum('user'), byProject: sum('project'), total: Math.round(rows.reduce((s, r) => s + r.hours, 0) * 100) / 100 };
}

export const timeCsv = (rows) => ['Person,Code,Project,Hours', ...rows.map((r) => [r.userName, r.userCode || '', r.projectName, r.hours].map(csvEscape).join(','))].join('\r\n');
