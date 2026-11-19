import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, compute, totals } from '../src/controllers/pay.controller.js';
import { Attendance } from '../src/models/Attendance.js';
import { Leave } from '../src/models/Leave.js';

// ---------------- fees ----------------
const plan = (extra = {}) => ({
  admissionFee: 1000, courseFee: 20000, discount: 0,
  installments: [
    { label: 'Advance', dueDate: '2026-11-17', amount: 5000 },
    { label: 'Installment 1', dueDate: '2026-12-17', amount: 4000 },
    { label: 'Installment 2', dueDate: '2027-01-17', amount: 4000 },
    { label: 'Installment 3', dueDate: '2027-02-17', amount: 4000 },
    { label: 'Installment 4', dueDate: '2027-03-17', amount: 4000 },
  ],
  ...extra,
});
const pays = (...a) => a.map((amount) => ({ amount }));

test('total = admission fee + course fee - discount', () => {
  assert.equal(summarize(plan(), [], '2026-11-01').total, 21000);
  assert.equal(summarize(plan({ discount: 1000 }), [], '2026-11-01').total, 20000);
});

test('plans made before the admission fee existed keep their old total', () => {
  const old = { courseFee: 15000, discount: 500, installments: [] };
  assert.equal(summarize(old, [], '2026-11-01').total, 14500);
});

test('advance not yet received on the admission day is overdue', () => {
  const s = summarize(plan(), [], '2026-11-17');
  assert.equal(s.overdue, 5000);
  assert.equal(s.status, 'overdue');
});

test('advance received: nothing overdue, next is the first installment', () => {
  const s = summarize(plan(), pays(5000), '2026-11-17');
  assert.equal(s.paid, 5000);
  assert.equal(s.balance, 16000);
  assert.equal(s.overdue, 0);
  assert.equal(s.status, 'due');
  assert.deepEqual(s.next, { dueDate: '2026-12-17', amount: 4000, label: 'Installment 1' });
});

test('a part payment reduces the next installment instead of skipping it', () => {
  const s = summarize(plan(), pays(5000, 2000), '2026-11-20');
  assert.equal(s.next.amount, 2000);
  assert.equal(s.next.label, 'Installment 1');
});

test('overdue grows with each missed installment', () => {
  assert.equal(summarize(plan(), pays(5000), '2026-12-18').overdue, 4000);
  assert.equal(summarize(plan(), pays(5000), '2027-01-18').overdue, 8000);
  assert.equal(summarize(plan(), pays(5000, 4000), '2027-01-18').overdue, 4000);
});

test('overdue can never be more than the balance', () => {
  const s = summarize(plan(), pays(20000), '2027-06-01');
  assert.equal(s.balance, 1000);
  assert.equal(s.overdue, 1000);
});

test('fully paid, and overpaid, both end at balance 0 with status paid', () => {
  for (const total of [21000, 22000]) {
    const s = summarize(plan(), pays(total), '2027-06-01');
    assert.equal(s.balance, 0);
    assert.equal(s.status, 'paid');
    assert.equal(s.next, null);
  }
});

test('a plan with no installments is due, never overdue', () => {
  const s = summarize({ courseFee: 10000, discount: 0, installments: [] }, pays(2000), '2027-01-01');
  assert.equal(s.balance, 8000);
  assert.equal(s.overdue, 0);
  assert.equal(s.status, 'due');
});

// ---------------- payslip totals ----------------
test('payslip: gross, deductions and net', () => {
  const s = { base: 30000, allowances: [{ amount: 2000 }], items: [{ amount: 1500 }, { amount: -500 }], absentDeduction: 1000 };
  totals(s);
  assert.equal(s.gross, 33500);
  assert.equal(s.deductions, 1500);
  assert.equal(s.net, 32000);
});

test('payslip net never goes below zero', () => {
  const s = { base: 1000, allowances: [], items: [{ amount: -5000 }], absentDeduction: 0 };
  totals(s);
  assert.equal(s.net, 0);
});

// ---------------- payroll attendance maths ----------------
// October 2026: 31 days, Sundays off (4 11 18 25), one holiday (14 Oct) -> 26 working days.
const settings = { holidays: [{ date: '2026-10-14' }], weekendDays: [0] };
const chain = (rows) => ({ select: () => ({ lean: async () => rows }), lean: async () => rows });
function stub({ present = [], leaves = [] }) {
  Attendance.find = () => chain(present.map((date) => ({ date })));
  Leave.find = () => chain(leaves);
}
const staff = (extra = {}) => ({ _id: 'u1', ...extra });
const profile = (base) => ({ base, allowances: [{ label: 'Transport', amount: 1000 }] });

// every working day of October 2026 (the 26 that count)
const WORKING = [];
for (let d = 1; d <= 31; d += 1) {
  const key = `2026-10-${String(d).padStart(2, '0')}`;
  const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
  if (dow !== 0 && key !== '2026-10-14') WORKING.push(key);
}

test('working days exclude Sundays and holidays', () => {
  assert.equal(WORKING.length, 26);
});

test('payroll: full attendance means no deduction', async () => {
  stub({ present: WORKING });
  const r = await compute(staff(), profile(26000), '2026-10', settings);
  assert.equal(r.workingDays, 26);
  assert.equal(r.absentDays, 0);
  assert.equal(r.absentDeduction, 0);
  assert.equal(r.perDay, 1000);
});

test('payroll: each absent day costs base / working days', async () => {
  stub({ present: WORKING.slice(0, 23) }); // 3 days missing
  const r = await compute(staff(), profile(26000), '2026-10', settings);
  assert.equal(r.absentDays, 3);
  assert.equal(r.absentDeduction, 3000);
  assert.equal(r.paidDays, 23);
});

test('payroll: an approved leave day is not an absence', async () => {
  stub({ present: WORKING.slice(0, 23), leaves: [{ fromDate: WORKING[25], toDate: WORKING[25] }] }); // leave on one of the 3 missing days
  const r = await compute(staff(), profile(26000), '2026-10', settings);
  assert.equal(r.absentDays, 2); // 3 missing, 1 covered by leave
  assert.equal(r.absentDeduction, 2000);
});

test('payroll: a leave that crosses into the month only covers days inside it', async () => {
  stub({ present: WORKING.filter((d) => d > '2026-10-02'), leaves: [{ fromDate: '2026-09-28', toDate: '2026-10-02' }] });
  const r = await compute(staff(), profile(26000), '2026-10', settings);
  assert.equal(r.absentDays, 0);
});

test('payroll: someone who joined mid-month is only marked absent from the joining date', async () => {
  stub({ present: [] });
  const r = await compute(staff({ joiningDate: '2026-10-16' }), profile(26000), '2026-10', settings);
  const after = WORKING.filter((d) => d >= '2026-10-16').length;
  assert.equal(r.absentDays, after);
  assert.equal(r.absentDeduction, after * 1000);
});

test('payroll: the deduction uses the exact day rate, rounded once at the end', async () => {
  stub({ present: WORKING.slice(0, 25) }); // 1 absent
  const r = await compute(staff(), profile(30000), '2026-10', settings); // 30000 / 26 = 1153.846...
  assert.equal(r.absentDeduction, Math.round(30000 / 26));
  assert.equal(r.perDay, Math.round(30000 / 26));
});

test('payroll feeds payslip totals: base + allowance - absence', async () => {
  stub({ present: WORKING.slice(0, 24) }); // 2 absent
  const slip = { ...(await compute(staff(), profile(26000), '2026-10', settings)), items: [] };
  totals(slip);
  assert.equal(slip.gross, 27000);
  assert.equal(slip.net, 25000);
});
