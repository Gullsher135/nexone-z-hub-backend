import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';
import { ITEM_TYPES, PRIORITIES, LINK_KINDS } from '../utils/flowCalc.js';
import { PROJECT_KINDS, STAGES, RELEASE_TYPES, DOC_CATEGORIES } from '../utils/flowKinds.js';

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
    // project = one client, delivered once; product = built by us, sold to many; saas = hosted by us, subscription
    kind: { type: String, enum: PROJECT_KINDS, default: 'project', index: true },
    stage: { type: String, enum: STAGES }, // products and SaaS only
    version: { type: String, trim: true, maxlength: 20 }, // current version, products and SaaS only
    metrics: { customers: { type: Number, min: 0 }, mrr: { type: Number, min: 0 } }, // products and SaaS only (mrr is for the admin only)
    // what changed, version by version (products and SaaS)
    releases: [{ version: { type: String, required: true, trim: true, maxlength: 20 }, title: { type: String, maxlength: 100 }, type: { type: String, enum: RELEASE_TYPES, default: 'minor' }, date: { type: String, match: DATE_RE }, notes: { type: String, maxlength: 3000 }, by: ref('User'), at: { type: Date, default: Date.now } }],
    // what the client wrote or approved on the shared progress page
    clientFeedback: [{ kind: { type: String, enum: ['comment', 'approval'], default: 'comment' }, milestone: Schema.Types.ObjectId, milestoneName: { type: String, maxlength: 120 }, name: { type: String, maxlength: 60 }, message: { type: String, maxlength: 1000 }, at: { type: Date, default: Date.now }, seenAt: Date }],
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
    share: { token: String, enabled: { type: Boolean, default: false }, showTasks: { type: Boolean, default: false }, allowFeedback: { type: Boolean, default: true } },
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

// A document uploaded to a project (requirements, designs, contracts, reports...). The bytes live in StoredFile.
const projectDocSchema = new Schema(
  {
    project: ref('Project', { required: true, index: true }),
    item: ref('WorkItem', { index: true }), // set when the file is attached to one card instead of the whole project
    title: { type: String, required: true, trim: true, maxlength: 140 },
    category: { type: String, enum: DOC_CATEGORIES, default: 'other' },
    note: { type: String, maxlength: 500 },
    file: ref('StoredFile', { required: true }),
    name: { type: String, maxlength: 160 }, // original file name
    size: Number,
    mime: String,
    uploadedBy: ref('User'),
  },
  { timestamps: true }
);

// The project's activity feed: who did what, newest first. Kept for about a year.
const projectActivitySchema = new Schema({
  project: ref('Project', { required: true, index: true }),
  user: ref('User'),
  userName: { type: String, maxlength: 80 },
  text: { type: String, required: true, maxlength: 300 },
  item: ref('WorkItem'),
  at: { type: Date, default: Date.now, index: true, expires: 60 * 60 * 24 * 400 },
});
projectActivitySchema.index({ project: 1, at: -1 });

export const Client = mongoose.model('Client', clientSchema);
export const ProjectActivity = mongoose.model('ProjectActivity', projectActivitySchema);
export const ProjectDoc = mongoose.model('ProjectDoc', projectDocSchema);
export const Project = mongoose.model('Project', projectSchema);
export const WorkItem = mongoose.model('WorkItem', itemSchema);
