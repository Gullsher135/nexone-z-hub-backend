import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { DATE_RE, TIME_RE } from '../utils/time.js';
import { nextSeq } from './Counter.js';

export const ROLES = ['admin', 'employee', 'intern', 'student'];
export const STAFF_ROLES = ['employee', 'intern']; // roles tracked with entry/exit time
const PREFIX = { admin: 'ADM', employee: 'EMP', intern: 'INT', student: 'STD' };

const dateField = { type: String, match: DATE_RE };
const timeField = (def) => ({ type: String, match: TIME_RE, default: def });

const userSchema = new mongoose.Schema(
  {
    code: { type: String, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ROLES, required: true, index: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    cnic: { type: String, trim: true },
    password: { type: String, select: false },
    mustChangePassword: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true, index: true },

    // staff (employee / intern / admin)
    designation: { type: String, trim: true },
    department: { type: String, trim: true },
    joiningDate: dateField,
    shift: {
      start: timeField('09:00'),
      end: timeField('18:00'),
      graceMinutes: { type: Number, default: 15, min: 0, max: 120 },
    },

    // intern only
    internship: {
      startDate: dateField,
      endDate: dateField,
      mentor: { type: String, trim: true },
    },

    // student only
    batch: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', index: true },
    rollNo: { type: String, trim: true },
    admissionDate: dateField,
    guardianName: { type: String, trim: true },
    guardianPhone: { type: String, trim: true },
  },
  { timestamps: true }
);

// email must be unique when present (students may have none)
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
);

userSchema.pre('validate', async function assignCode(next) {
  if (!this.code) {
    const n = await nextSeq(`user-${this.role}`);
    this.code = `NZ-${PREFIX[this.role]}-${String(n).padStart(4, '0')}`;
  }
  next();
});

userSchema.pre('save', async function hashPassword(next) {
  if (this.isModified('password') && this.password) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

userSchema.methods.comparePassword = function comparePassword(plain) {
  return this.password ? bcrypt.compare(plain, this.password) : false;
};

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.__v;
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
