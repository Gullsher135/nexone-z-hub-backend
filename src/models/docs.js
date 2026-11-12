import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

const { Schema } = mongoose;
const ref = (name, extra = {}) => ({ type: Schema.Types.ObjectId, ref: name, ...extra });

export const LETTER_TYPES = ['internship', 'experience', 'warning'];
export const SEVERITY = ['notice', 'warning', 'final'];

// Official letters and certificates issued to staff and interns.
const letterSchema = new Schema(
  {
    refNo: { type: String, unique: true, index: true },
    code: { type: String, unique: true, index: true }, // printed and QR-verifiable (not used for warnings)
    type: { type: String, enum: LETTER_TYPES, required: true, index: true },
    user: ref('User', { required: true, index: true }),
    // Name and role as they were on the day of issue, so the letter never changes later.
    person: { name: String, code: String, designation: String, role: String },
    data: {
      designation: String,
      from: { type: String, match: DATE_RE },
      to: { type: String, match: DATE_RE },
      grade: String,
      remark: { type: String, maxlength: 1500 },
      projects: [{ name: String, client: String, role: String, cardsDone: Number }],
      severity: { type: String, enum: SEVERITY },
      subject: { type: String, maxlength: 140 },
      reason: { type: String, maxlength: 3000 },
    },
    issuedBy: ref('User'),
    issuedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['issued', 'revoked'], default: 'issued' },
    revokedReason: String,
    revokedAt: Date,
    // warnings: the person confirms they have read it and may reply
    acknowledgedAt: Date,
    reply: { type: String, maxlength: 1500 },
  },
  { timestamps: true }
);

export const Letter = mongoose.model('Letter', letterSchema);
