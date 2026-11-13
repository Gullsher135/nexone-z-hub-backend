import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

const batchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    course: { type: String, trim: true }, // course title, kept for display
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', index: true }, // the course this batch belongs to
    instructor: { type: String, trim: true },
    schedule: { type: String, trim: true }, // e.g. "Mon-Fri 4pm-6pm"
    startDate: { type: String, match: DATE_RE },
    endDate: { type: String, match: DATE_RE },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// A batch name only has to be unique inside its course (legacy batches without a course stay unique among themselves).
batchSchema.index({ courseId: 1, name: 1 }, { unique: true });

export const Batch = mongoose.model('Batch', batchSchema);
