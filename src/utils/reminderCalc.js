import { addDays, daysBetween } from './flowCalc.js';

const sid = (v) => String(v?._id || v);

// Groups open cards or tasks by the person they belong to: how many are late, due today, due tomorrow.
export function bucketByPerson(items, today) {
  const tomorrow = addDays(today, 1);
  const out = new Map();
  for (const i of items) {
    if (!i.assignee || !i.dueDate || i.status === 'done' || i.dueDate > tomorrow) continue;
    const key = sid(i.assignee);
    const row = out.get(key) || { overdue: 0, today: 0, tomorrow: 0 };
    if (i.dueDate < today) row.overdue += 1;
    else if (i.dueDate === today) row.today += 1;
    else row.tomorrow += 1;
    out.set(key, row);
  }
  return out;
}

export function describeCounts({ overdue, today, tomorrow }) {
  const parts = [];
  if (overdue) parts.push(`${overdue} overdue`);
  if (today) parts.push(`${today} due today`);
  if (tomorrow) parts.push(`${tomorrow} due tomorrow`);
  return parts.join(', ');
}

// 3 days before, on the day, and (weekly) while it stays unpaid
export function feeReminder(summary, today) {
  if (!summary || !summary.balance) return null;
  if (summary.overdue > 0) return { kind: 'overdue', text: `Rs ${summary.overdue} of your fee is overdue. Please pay as soon as you can.` };
  if (!summary.next) return null;
  const days = daysBetween(today, summary.next.dueDate);
  if (days === 3) return { kind: 'in3', text: `Rs ${summary.next.amount} is due in 3 days (${summary.next.dueDate}).` };
  if (days === 0) return { kind: 'today', text: `Rs ${summary.next.amount} is due today.` };
  return null;
}

