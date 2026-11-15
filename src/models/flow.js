import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';
import { ITEM_TYPES, PRIORITIES, LINK_KINDS } from '../utils/flowCalc.js';

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
    // phases of the project; cards can be attached to one
    milestones: [{ name: { type: String, required: true, trim: true, maxlength: 100 }, description: { type: String, maxlength: 500 }, dueDate: { type: String, match: DATE_RE }, doneAt: Date }],
    // repo, design files, documents, staging and live links
    links: [{ title: { type: String, trim: true, maxlength: 80 }, url: { type: String, required: true, maxlength: 500 }, kind: { type: String, enum: LINK_KINDS, default: 'other' } }],
    // read-only progress page for the client
    share: { token: String, enabled: { type: Boolean, default: false }, showTasks: { type: Boolean, default: false } },
  },
  { timestamps: true }
);
projectSchema.index({ 'share.token': 1 }, { unique: true, sparse: true });

// A card on a project's board.
const itemSchema = new Schema(
  {
    project: ref('Project', { required: true, index: true }),
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, maxlength: 4000 },
    assignee: ref('User', { index: true }),
    priority: { type: String, enum: PRIORITIES, default: 'medium' },
    type: { type: String, enum: ITEM_TYPES, default: 'task' },
    labels: [{ type: String, trim: true, maxlength: 24 }],
    startDate: { type: String, match: DATE_RE },
    estimateHours: { type: Number, min: 0, max: 1000 },
    loggedHours: { type: Number, min: 0, default: 0 },
    timeLogs: [{ user: ref('User'), hours: { type: Number, min: 0, max: 24 }, note: { type: String, maxlength: 200 }, date: { type: String, match: DATE_RE }, at: { type: Date, default: Date.now } }],
    checklist: [{ text: { type: String, maxlength: 140 }, done: { type: Boolean, default: false } }],
    links: [{ title: { type: String, maxlength: 80 }, url: { type: String, required: true, maxlength: 500 } }],
    milestone: Schema.Types.ObjectId, // _id of one of the project's milestones
    blockedBy: [ref('WorkItem')], // cards that must be finished first
    activity: [{ user: ref('User'), text: { type: String, maxlength: 200 }, at: { type: Date, default: Date.now } }],
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
