import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

const { Schema } = mongoose;
const ref = (name, extra = {}) => ({ type: Schema.Types.ObjectId, ref: name, ...extra });

// Company notices shown on every employee's home page.
const noticeSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, maxlength: 5000 },
    audience: { type: String, enum: ['all', 'employee', 'intern'], default: 'all' },
    pinned: { type: Boolean, default: false },
    author: ref('User'),
    readBy: [Schema.Types.ObjectId],
  },
  { timestamps: true }
);
noticeSchema.index({ pinned: -1, createdAt: -1 });

// Work assigned to one person, tracked from "to do" to "done".
const taskSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, maxlength: 4000 },
    assignee: ref('User', { required: true, index: true }),
    createdBy: ref('User'),
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    status: { type: String, enum: ['todo', 'doing', 'done'], default: 'todo', index: true },
    dueDate: { type: String, match: DATE_RE },
    completedAt: Date,
    comments: [{ author: ref('User'), text: { type: String, maxlength: 1000 }, at: { type: Date, default: Date.now } }],
  },
  { timestamps: true }
);

export const Notice = mongoose.model('Notice', noticeSchema);
export const Task = mongoose.model('Task', taskSchema);
