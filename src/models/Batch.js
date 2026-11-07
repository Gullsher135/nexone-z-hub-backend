import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

const batchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    course: { type: String, trim: true },
    instructor: { type: String, trim: true },
    schedule: { type: String, trim: true }, // e.g. "Mon-Fri 4pm-6pm"
    startDate: { type: String, match: DATE_RE },
    endDate: { type: String, match: DATE_RE },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Batch = mongoose.model('Batch', batchSchema);
