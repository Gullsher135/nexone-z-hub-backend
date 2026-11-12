import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

const { Schema } = mongoose;
const ref = (name, extra = {}) => ({ type: Schema.Types.ObjectId, ref: name, ...extra });

// ---------- Student fees ----------
const feeAccountSchema = new Schema(
  {
    student: ref('User', { required: true, unique: true }),
    courseFee: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    installments: [{ label: { type: String, trim: true, maxlength: 60 }, dueDate: { type: String, match: DATE_RE, required: true }, amount: { type: Number, required: true, min: 1 } }],
    note: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

const paymentSchema = new Schema(
  {
    receiptNo: { type: String, unique: true, index: true },
    student: ref('User', { required: true, index: true }),
    amount: { type: Number, required: true, min: 1 },
    date: { type: String, required: true, match: DATE_RE },
    method: { type: String, enum: ['cash', 'bank', 'jazzcash', 'easypaisa', 'other'], default: 'cash' },
    reference: { type: String, trim: true, maxlength: 80 },
    note: { type: String, trim: true, maxlength: 300 },
    receivedBy: ref('User'),
  },
  { timestamps: true }
);

// ---------- Salaries ----------
const salaryProfileSchema = new Schema(
  {
    user: ref('User', { required: true, unique: true }),
    base: { type: Number, required: true, min: 0 },
    allowances: [{ label: { type: String, trim: true, maxlength: 60 }, amount: { type: Number, min: 0 } }],
  },
  { timestamps: true }
);

const payslipSchema = new Schema(
  {
    user: ref('User', { required: true, index: true }),
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true },
    base: Number,
    allowances: [{ label: String, amount: Number }],
    workingDays: Number,
    paidDays: Number,
    absentDays: Number,
    perDay: Number,
    absentDeduction: Number,
    items: [{ label: { type: String, trim: true, maxlength: 80 }, amount: Number }], // manual lines: bonus positive, deduction negative
    gross: Number,
    deductions: Number,
    net: Number,
    status: { type: String, enum: ['draft', 'paid'], default: 'draft' },
    paidAt: Date,
    method: { type: String, enum: ['cash', 'bank', 'jazzcash', 'easypaisa', 'other'] },
    note: { type: String, maxlength: 300 },
  },
  { timestamps: true }
);
payslipSchema.index({ user: 1, month: 1 }, { unique: true });

export const FeeAccount = mongoose.model('FeeAccount', feeAccountSchema);
export const Payment = mongoose.model('Payment', paymentSchema);
export const SalaryProfile = mongoose.model('SalaryProfile', salaryProfileSchema);
export const Payslip = mongoose.model('Payslip', payslipSchema);
