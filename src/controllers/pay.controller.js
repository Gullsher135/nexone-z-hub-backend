import { FeeAccount, Payment, SalaryProfile, Payslip } from '../models/pay.js';
import { User, STAFF_ROLES } from '../models/User.js';
import { Attendance } from '../models/Attendance.js';
import { Leave } from '../models/Leave.js';
import { getSettings } from '../models/Setting.js';
import { nextSeq } from '../models/Counter.js';
import { HttpError, asyncHandler, escapeRegex } from '../utils/helpers.js';
import { DATE_RE, dateKey, datesBetween, monthRange, weekdayOfKey } from '../utils/time.js';

const sid = (v) => String(v?._id || v);
const money = (n) => Math.round(Number(n) || 0);
const METHODS = ['cash', 'bank', 'jazzcash', 'easypaisa', 'other'];

// ===================== fees =====================
function summarize(acc, payments, today = dateKey()) {
  const total = Math.max(0, acc.courseFee - (acc.discount || 0));
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const balance = Math.max(0, total - paid);
  const dueSoFar = acc.installments.filter((i) => i.dueDate <= today).reduce((s, i) => s + i.amount, 0);
  const overdue = Math.max(0, Math.min(balance, dueSoFar - paid));
  // the first installment not yet covered by what has been paid
  let run = 0;
  let next = null;
  for (const i of [...acc.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
    run += i.amount;
    if (run > paid) { next = { dueDate: i.dueDate, amount: Math.min(i.amount, run - paid), label: i.label }; break; }
  }
  const status = balance === 0 ? 'paid' : overdue > 0 ? 'overdue' : 'due';
  return { total, paid, balance, overdue, next: balance ? next : null, status };
}

export const feeList = asyncHandler(async (req, res) => {
  const f = { role: 'student', isActive: true };
  if (req.query.batch) f.batch = req.query.batch;
  if (req.query.q) f.$or = [{ name: new RegExp(escapeRegex(req.query.q), 'i') }, { code: new RegExp(escapeRegex(req.query.q), 'i') }];
  const students = await User.find(f).select('name code rollNo batch').populate('batch', 'name').sort({ name: 1 }).limit(500).lean();
  const ids = students.map((s) => s._id);
  const [accs, pays] = await Promise.all([FeeAccount.find({ student: { $in: ids } }).lean(), Payment.find({ student: { $in: ids } }).select('student amount').lean()]);
  const am = new Map(accs.map((a) => [sid(a.student), a]));
  const pm = new Map();
  pays.forEach((p) => pm.set(sid(p.student), [...(pm.get(sid(p.student)) || []), p]));
  let items = students.map((s) => {
    const a = am.get(sid(s._id));
    return { ...s, plan: a ? summarize(a, pm.get(sid(s._id)) || []) : null };
  });
  if (req.query.status === 'noplan') items = items.filter((i) => !i.plan);
  else if (req.query.status) items = items.filter((i) => i.plan?.status === req.query.status);
  res.json({ items });
});

async function ledger(studentId) {
  const [student, acc, payments] = await Promise.all([
    User.findById(studentId).select('name code rollNo batch email phone').populate('batch', 'name').lean(),
    FeeAccount.findOne({ student: studentId }).lean(),
    Payment.find({ student: studentId }).populate('receivedBy', 'name').sort({ date: -1, createdAt: -1 }).lean(),
  ]);
  if (!student) throw new HttpError(404, 'Student not found');
  return { student, account: acc || null, summary: acc ? summarize(acc, payments) : null, payments };
}

export const feeDetail = asyncHandler(async (req, res) => res.json(await ledger(req.params.studentId)));
export const myFees = asyncHandler(async (req, res) => res.json(await ledger(req.user._id)));

export const setPlan = asyncHandler(async (req, res) => {
  const student = await User.findOne({ _id: req.params.studentId, role: 'student' });
  if (!student) throw new HttpError(404, 'Student not found');
  const courseFee = money(req.body.courseFee);
  const discount = money(req.body.discount);
  if (courseFee <= 0) throw new HttpError(400, 'Enter the course fee');
  if (discount < 0 || discount > courseFee) throw new HttpError(400, 'Discount cannot be more than the fee');
  const installments = (req.body.installments || []).map((i) => ({ label: i.label, dueDate: i.dueDate, amount: money(i.amount) }));
  if (installments.some((i) => !DATE_RE.test(i.dueDate || '') || i.amount <= 0)) throw new HttpError(400, 'Every installment needs a due date and amount');
  const total = courseFee - discount;
  if (installments.length && installments.reduce((s, i) => s + i.amount, 0) !== total) throw new HttpError(400, `Installments must add up to the total fee (Rs ${total})`);
  const acc = await FeeAccount.findOneAndUpdate({ student: student._id }, { courseFee, discount, installments, note: req.body.note }, { upsert: true, new: true, setDefaultsOnInsert: true });
  res.json({ account: acc });
});

export const addPayment = asyncHandler(async (req, res) => {
  const student = await User.findOne({ _id: req.params.studentId, role: 'student' });
  if (!student) throw new HttpError(404, 'Student not found');
  const acc = await FeeAccount.findOne({ student: student._id });
  if (!acc) throw new HttpError(400, 'Set the fee plan for this student first');
  const amount = money(req.body.amount);
  const date = req.body.date || dateKey();
  if (amount <= 0) throw new HttpError(400, 'Enter the amount received');
  if (!DATE_RE.test(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
  const method = METHODS.includes(req.body.method) ? req.body.method : 'cash';
  const paid = (await Payment.find({ student: student._id }).select('amount').lean()).reduce((s, p) => s + p.amount, 0);
  const balance = acc.courseFee - (acc.discount || 0) - paid;
  if (amount > balance) throw new HttpError(400, `Only Rs ${balance} is outstanding for this student`);
  const n = await nextSeq('receipt');
  const p = await Payment.create({ receiptNo: `RCPT-${String(n).padStart(5, '0')}`, student: student._id, amount, date, method, reference: req.body.reference, note: req.body.note, receivedBy: req.user._id });
  res.status(201).json({ payment: p });
});

export const voidPayment = asyncHandler(async (req, res) => {
  const p = await Payment.findById(req.params.id);
  if (!p) throw new HttpError(404, 'Payment not found');
  await p.deleteOne();
  res.json({ message: 'Payment removed' });
});

export const receipt = asyncHandler(async (req, res) => {
  const p = await Payment.findById(req.params.id).populate('student', 'name code rollNo batch').populate('receivedBy', 'name').lean();
  if (!p) throw new HttpError(404, 'Receipt not found');
  if (req.user.role !== 'admin' && sid(p.student) !== sid(req.user._id)) throw new HttpError(403, 'Not allowed');
  await User.populate(p.student, { path: 'batch', select: 'name' });
  const acc = await FeeAccount.findOne({ student: p.student._id }).lean();
  const all = await Payment.find({ student: p.student._id }).select('amount').lean();
  res.json({ receipt: p, summary: acc ? summarize(acc, all) : null });
});

// ===================== salaries and payroll =====================
export const salaryList = asyncHandler(async (_req, res) => {
  const staff = await User.find({ role: { $in: STAFF_ROLES }, isActive: true }).select('name code role designation').sort({ name: 1 }).lean();
  const profiles = await SalaryProfile.find({ user: { $in: staff.map((s) => s._id) } }).lean();
  const m = new Map(profiles.map((p) => [sid(p.user), p]));
  res.json({ items: staff.map((s) => ({ ...s, profile: m.get(sid(s._id)) || null })) });
});

export const setSalary = asyncHandler(async (req, res) => {
  const u = await User.findOne({ _id: req.params.userId, role: { $in: STAFF_ROLES } });
  if (!u) throw new HttpError(404, 'Employee not found');
  const base = money(req.body.base);
  if (base <= 0) throw new HttpError(400, 'Enter the monthly salary');
  const allowances = (req.body.allowances || []).filter((a) => a.label?.trim() && money(a.amount) > 0).map((a) => ({ label: a.label.trim(), amount: money(a.amount) }));
  const p = await SalaryProfile.findOneAndUpdate({ user: u._id }, { base, allowances }, { upsert: true, new: true, setDefaultsOnInsert: true });
  res.json({ profile: p });
});

const totals = (s) => {
  const allow = (s.allowances || []).reduce((a, x) => a + x.amount, 0);
  const plus = (s.items || []).filter((i) => i.amount > 0).reduce((a, x) => a + x.amount, 0);
  const minus = (s.items || []).filter((i) => i.amount < 0).reduce((a, x) => a - x.amount, 0);
  s.gross = s.base + allow + plus;
  s.deductions = (s.absentDeduction || 0) + minus;
  s.net = Math.max(0, s.gross - s.deductions);
};

async function compute(user, profile, month, settings) {
  const { from, to } = monthRange(month);
  const today = dateKey();
  const hol = new Set(settings.holidays.map((h) => h.date));
  const off = new Set(settings.weekendDays);
  const working = datesBetween(from, to).filter((d) => !hol.has(d) && !off.has(weekdayOfKey(d)));
  const start = user.joiningDate && user.joiningDate > from ? user.joiningDate : from;
  const counted = working.filter((d) => d >= start && d <= today);
  const [att, leaves] = await Promise.all([
    Attendance.find({ user: user._id, date: { $gte: from, $lte: to }, status: { $in: ['present', 'late', 'leave'] } }).select('date').lean(),
    Leave.find({ user: user._id, status: 'approved', fromDate: { $lte: to }, toDate: { $gte: from } }).lean(),
  ]);
  const covered = new Set(att.map((a) => a.date));
  leaves.forEach((l) => datesBetween(l.fromDate < from ? from : l.fromDate, l.toDate > to ? to : l.toDate).forEach((d) => covered.add(d)));
  const absent = counted.filter((d) => !covered.has(d)).length;
  const perDay = working.length ? profile.base / working.length : 0;
  return { base: profile.base, allowances: profile.allowances.map((a) => ({ label: a.label, amount: a.amount })), workingDays: working.length, paidDays: counted.length - absent, absentDays: absent, perDay: Math.round(perDay), absentDeduction: Math.round(perDay * absent) };
}

export const generatePayroll = asyncHandler(async (req, res) => {
  const month = String(req.body?.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'Choose a month');
  if (month > dateKey().slice(0, 7)) throw new HttpError(400, 'You cannot run payroll for a future month');
  const settings = await getSettings();
  const profiles = await SalaryProfile.find().populate('user').lean();
  let created = 0;
  let updated = 0;
  for (const p of profiles) {
    if (!p.user || !p.user.isActive || !STAFF_ROLES.includes(p.user.role)) continue;
    const base = await compute(p.user, p, month, settings);
    const existing = await Payslip.findOne({ user: p.user._id, month });
    if (existing?.status === 'paid') continue;
    const slip = existing || new Payslip({ user: p.user._id, month, items: [] });
    Object.assign(slip, base);
    totals(slip);
    await slip.save();
    existing ? updated++ : created++;
  }
  if (!profiles.length) throw new HttpError(400, 'Set salaries for employees first');
  res.json({ created, updated });
});

export const payrollList = asyncHandler(async (req, res) => {
  const month = req.query.month || dateKey().slice(0, 7);
  const items = await Payslip.find({ month }).populate('user', 'name code role designation').sort({ createdAt: 1 }).lean();
  res.json({ month, items, totalNet: items.reduce((s, i) => s + i.net, 0), paidNet: items.filter((i) => i.status === 'paid').reduce((s, i) => s + i.net, 0) });
});

export const updatePayslip = asyncHandler(async (req, res) => {
  const slip = await Payslip.findById(req.params.id);
  if (!slip) throw new HttpError(404, 'Payslip not found');
  if (slip.status === 'paid') throw new HttpError(409, 'This payslip is already paid and cannot be changed');
  const items = (req.body.items || []).filter((i) => i.label?.trim() && money(i.amount) !== 0).map((i) => ({ label: i.label.trim(), amount: money(i.amount) }));
  slip.items = items;
  if (req.body.note !== undefined) slip.note = req.body.note;
  totals(slip);
  await slip.save();
  res.json({ payslip: slip });
});

export const payPayslip = asyncHandler(async (req, res) => {
  const slip = await Payslip.findById(req.params.id);
  if (!slip) throw new HttpError(404, 'Payslip not found');
  if (slip.status === 'paid') throw new HttpError(409, 'Already paid');
  slip.status = 'paid';
  slip.paidAt = new Date();
  slip.method = METHODS.includes(req.body?.method) ? req.body.method : 'bank';
  await slip.save();
  res.json({ payslip: slip });
});

export const deletePayslip = asyncHandler(async (req, res) => {
  const slip = await Payslip.findById(req.params.id);
  if (!slip) throw new HttpError(404, 'Payslip not found');
  if (slip.status === 'paid') throw new HttpError(409, 'A paid payslip cannot be deleted');
  await slip.deleteOne();
  res.json({ message: 'Deleted' });
});

export const myPayslips = asyncHandler(async (req, res) => {
  const items = await Payslip.find({ user: req.user._id, status: 'paid' }).sort({ month: -1 }).lean();
  res.json({ items });
});

export const payslip = asyncHandler(async (req, res) => {
  const slip = await Payslip.findById(req.params.id).populate('user', 'name code role designation department joiningDate').lean();
  if (!slip) throw new HttpError(404, 'Payslip not found');
  if (req.user.role !== 'admin' && (sid(slip.user) !== sid(req.user._id) || slip.status !== 'paid')) throw new HttpError(403, 'Not allowed');
  res.json({ payslip: slip });
});

// ===================== overview =====================
export const overview = asyncHandler(async (_req, res) => {
  const month = dateKey().slice(0, 7);
  const students = await User.find({ role: 'student', isActive: true }).select('_id').lean();
  const ids = students.map((s) => s._id);
  const [accs, pays, slips] = await Promise.all([FeeAccount.find({ student: { $in: ids } }).lean(), Payment.find({ student: { $in: ids } }).lean(), Payslip.find({ month }).lean()]);
  const pm = new Map();
  pays.forEach((p) => pm.set(sid(p.student), [...(pm.get(sid(p.student)) || []), p]));
  let outstanding = 0;
  let overdueCount = 0;
  let overdueAmount = 0;
  for (const a of accs) {
    const s = summarize(a, pm.get(sid(a.student)) || []);
    outstanding += s.balance;
    if (s.overdue > 0) { overdueCount++; overdueAmount += s.overdue; }
  }
  res.json({
    collectedThisMonth: pays.filter((p) => p.date.startsWith(month)).reduce((s, p) => s + p.amount, 0),
    outstanding, overdueCount, overdueAmount,
    withoutPlan: students.length - accs.length,
    payrollMonth: month, payrollNet: slips.reduce((s, p) => s + p.net, 0), payrollPaid: slips.filter((p) => p.status === 'paid').length, payrollTotal: slips.length,
  });
});
