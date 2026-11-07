import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

// Student attendance: present / absent per class day, marked by admin/instructor.
const studentAttendanceSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    batch: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
    date: { type: String, required: true, match: DATE_RE },
    status: {
      type: String,
      enum: ['present', 'absent', 'late', 'leave'],
      required: true,
    },
    note: { type: String, trim: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

studentAttendanceSchema.index({ student: 1, date: 1 }, { unique: true });
studentAttendanceSchema.index({ batch: 1, date: 1 });

export const StudentAttendance = mongoose.model('StudentAttendance', studentAttendanceSchema);
