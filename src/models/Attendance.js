import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

// Staff attendance (employees + interns): one record per person per day.
const attendanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true, match: DATE_RE }, // YYYY-MM-DD (Pakistan time)
    checkIn: Date,
    checkOut: Date,
    status: {
      type: String,
      enum: ['present', 'late', 'absent', 'leave'],
      default: 'present',
    },
    lateMinutes: { type: Number, default: 0 },
    earlyLeaveMinutes: { type: Number, default: 0 },
    workMinutes: { type: Number, default: 0 },
    checkInMethod: { type: String, enum: ['button', 'qr', 'manual'] },
    checkOutMethod: { type: String, enum: ['button', 'qr', 'manual'] },
    checkInLocation: { lat: Number, lng: Number, distance: Number },
    checkOutLocation: { lat: Number, lng: Number, distance: Number },
    note: { type: String, trim: true },
    editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: 1 });

export const Attendance = mongoose.model('Attendance', attendanceSchema);
