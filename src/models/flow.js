import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

const { Schema } = mongoose;
const ref = (name, extra = {}) => ({ type: Schema.Types.ObjectId, ref: name, ...extra });

export const PROJECT_STATUS = ['planning', 'active', 'on_hold', 'completed'];
export const ITEM_STATUS = ['todo', 'doing', 'review', 'done'];

// A customer or partner the software house builds for.
const clientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    company: { type: String, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 30 },
    notes: { type: String, maxlength: 2000 },
  },
  { timestamps: true }
);

const projectSchema = new Schema(
  {
    code: { type: String, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, maxlength: 4000 },
    client: ref('Client'),
    status: { type: String, enum: PROJECT_STATUS, default: 'planning', index: true },
    startDate: { type: String, match: DATE_RE },
    dueDate: { type: String, match: DATE_RE },
    budget: { type: Number, min: 0, default: 0 },
    lead: ref('User'),
    members: [ref('User')],
    createdBy: ref('User'),
  },
  { timestamps: true }
);

// A card on a project's board.
const itemSchema = new Schema(
  {
    project: ref('Project', { required: true, index: true }),
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, maxlength: 4000 },
    assignee: ref('User', { index: true }),
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    status: { type: String, enum: ITEM_STATUS, default: 'todo', index: true },
    dueDate: { type: String, match: DATE_RE },
    completedAt: Date,
    createdBy: ref('User'),
    comments: [{ author: ref('User'), text: { type: String, maxlength: 1000 }, at: { type: Date, default: Date.now } }],
  },
  { timestamps: true }
);

export const Client = mongoose.model('Client', clientSchema);
export const Project = mongoose.model('Project', projectSchema);
export const WorkItem = mongoose.model('WorkItem', itemSchema);
