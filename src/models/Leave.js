import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

const leaveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['casual', 'sick', 'other'], default: 'casual' },
    fromDate: { type: String, required: true, match: DATE_RE },
    toDate: { type: String, required: true, match: DATE_RE },
    reason: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewNote: { type: String, trim: true },
    reviewedAt: Date,
  },
  { timestamps: true }
);

export const Leave = mongoose.model('Leave', leaveSchema);
