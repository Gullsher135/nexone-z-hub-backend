import { WorkItem, Project } from '../models/flow.js';
import { Task } from '../models/crew.js';
import { Assignment, Enrollment, Submission } from '../models/lms.js';
import { FeeAccount, Payment } from '../models/pay.js';
import { User } from '../models/User.js';
import { claim } from '../models/ReminderLog.js';
import { notifyUsers, notifyAdmins } from './push.js';
import { dateKey } from './time.js';
import { addDays, daysBetween } from './flowCalc.js';
import { bucketByPerson, describeCounts, feeReminder } from './reminderCalc.js';
import { summarize } from '../controllers/pay.controller.js';
import { visibleFor } from './progress.js';

const sid = (v) => String(v?._id || v);

const weekNo = (today) => Math.floor(daysBetween('1970-01-01', today) / 7);

async function cardDigests(today, stats) {
  const items = await WorkItem.find({ status: { $ne: 'done' }, assignee: { $exists: true }, dueDate: { $lte: addDays(today, 1) } }).select('assignee dueDate status project').lean();
  const projects = new Map((await Project.find({ _id: { $in: [...new Set(items.map((i) => sid(i.project)))] }, status: { $ne: 'completed' } }).select('_id').lean()).map((p) => [sid(p._id), true]));
  for (const [user, row] of bucketByPerson(items.filter((i) => projects.has(sid(i.project))), today)) {
    if (!(await claim(`flow:${user}:${today}`))) continue;
    await notifyUsers([user], { email: true, title: 'Flow cards need you', body: describeCounts(row), tag: 'flow-digest', urls: { admin: '/admin/flow', staff: '/flow' } });
    stats.flow += 1;
  }
}

async function taskDigests(today, stats) {
  const items = await Task.find({ status: { $ne: 'done' }, dueDate: { $lte: addDays(today, 1) } }).select('assignee dueDate status').lean();
  for (const [user, row] of bucketByPerson(items, today)) {
    if (!(await claim(`task:${user}:${today}`))) continue;
    await notifyUsers([user], { email: true, title: 'Your tasks', body: describeCounts(row), tag: 'task-digest', urls: { staff: '/tasks' } });
    stats.tasks += 1;
  }
}

async function projectDeadlines(today, stats) {
  const projects = await Project.find({ status: { $in: ['planning', 'active'] }, dueDate: { $exists: true, $lte: addDays(today, 3) } }).select('name dueDate lead members kind').lean();
  for (const p of projects) {
    const days = daysBetween(today, p.dueDate);
    const when = days < 0 ? 'late' : days === 0 ? 'today' : days === 3 ? 'in3' : null;
    if (!when) continue;
    const key = when === 'late' ? `proj:${p._id}:late:${weekNo(today)}` : `proj:${p._id}:${when}`;
    if (!(await claim(key))) continue;
    const text = days < 0 ? `${p.name}: the deadline passed ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? `${p.name}: deadline is today` : `${p.name}: deadline in 3 days`;
    const urls = { admin: `/admin/flow/projects/${p._id}`, staff: `/flow/projects/${p._id}` };
    await notifyUsers([p.lead], { email: true, title: 'Project deadline', body: text, tag: `proj-${p._id}`, urls });
    await notifyAdmins({ email: true, title: 'Project deadline', body: text, tag: `proj-${p._id}`, url: urls.admin });
    stats.projects += 1;
  }
}

async function assignmentReminders(today, stats) {
  const tomorrow = addDays(today, 1);
  const list = await Assignment.find({ dueDate: { $in: [today, tomorrow] } }).select('title course dueDate batches students').lean();
  for (const a of list) {
    const when = a.dueDate === today ? 'today' : 'tomorrow';
    const [ens, subs] = await Promise.all([Enrollment.find({ course: a.course }).select('student batch').lean(), Submission.find({ assignment: a._id }).select('student').lean()]);
    const done = new Set(subs.map((s) => sid(s.student)));
    const todo = [];
    for (const e of ens) {
      if (!visibleFor(a, { batch: e.batch, student: e.student }) || done.has(sid(e.student))) continue;
      if (await claim(`asg:${a._id}:${e.student}:${when}`)) todo.push(e.student);
    }
    if (todo.length) {
      await notifyUsers(todo, { email: true, title: `Assignment due ${when}`, body: a.title, tag: `asg-${a._id}`, urls: { student: `/learn/course/${a.course}` } });
      stats.assignments += todo.length;
    }
  }
}

async function feeReminders(today, stats) {
  const accounts = await FeeAccount.find().lean();
  if (!accounts.length) return;
  const students = new Map((await User.find({ _id: { $in: accounts.map((a) => a.student) }, isActive: true }).select('_id').lean()).map((u) => [sid(u._id), true]));
  const pays = await Payment.find({ student: { $in: accounts.map((a) => a.student) } }).select('student amount').lean();
  for (const acc of accounts) {
    if (!students.has(sid(acc.student))) continue;
    const r = feeReminder(summarize(acc, pays.filter((p) => sid(p.student) === sid(acc.student)), today), today);
    if (!r) continue;
    const key = r.kind === 'overdue' ? `fee:${acc.student}:overdue:${weekNo(today)}` : `fee:${acc.student}:${r.kind}:${today}`;
    if (!(await claim(key))) continue;
    await notifyUsers([acc.student], { email: true, title: r.kind === 'overdue' ? 'Fee overdue' : 'Fee reminder', body: r.text, tag: 'fee-reminder', urls: { student: '/learn/fees' } });
    stats.fees += 1;
  }
}

// Runs every reminder once for today. Safe to call many times a day: each reminder is sent only once.
export async function runReminders(today = dateKey()) {
  const stats = { flow: 0, tasks: 0, projects: 0, assignments: 0, fees: 0, errors: 0 };
  for (const job of [cardDigests, taskDigests, projectDeadlines, assignmentReminders, feeReminders]) {
    try { await job(today, stats); } catch (e) { stats.errors += 1; console.error(`reminder job ${job.name} failed:`, e.message); }
  }
  return stats;
}

// Checks every 30 minutes; from 08:00 Pakistan time each reminder goes out once per day.
export function startReminderLoop() {
  const tick = () => {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', hour12: false }).format(new Date())) % 24;
    if (hour >= 8) runReminders().then((s) => { if (s.flow + s.tasks + s.projects + s.assignments + s.fees) console.log('Reminders sent', s); }).catch((e) => console.error('reminders failed', e.message));
  };
  setTimeout(tick, 60 * 1000);
  return setInterval(tick, 30 * 60 * 1000);
}
