import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

const { Schema } = mongoose;
const ref = (name, extra = {}) => ({ type: Schema.Types.ObjectId, ref: name, ...extra });

// ---------- Course (NexoneZ Learn) ----------
const lessonSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  type: { type: String, enum: ['video', 'reading', 'link', 'file'], default: 'reading' },
  content: { type: String, maxlength: 20000 }, // reading text
  url: { type: String, trim: true, maxlength: 600 }, // video, link or file
  durationMin: { type: Number, min: 0, max: 1000 },
});

const sectionSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  lessons: [lessonSchema],
});

const courseSchema = new Schema(
  {
    code: { type: String, unique: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    category: { type: String, trim: true, maxlength: 60 },
    level: { type: String, enum: ['beginner', 'intermediate', 'advanced'], default: 'beginner' },
    summary: { type: String, trim: true, maxlength: 240 },
    description: { type: String, maxlength: 8000 },
    color: { type: Number, min: 0, max: 5, default: 0 }, // accent used on cards
    durationWeeks: { type: Number, min: 0, max: 200 },
    status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
    autoCertificate: { type: Boolean, default: true },
    instructors: [ref('User')],
    sections: [sectionSchema],
  },
  { timestamps: true }
);

// ---------- Enrolment, progress and certificate ----------
const enrollmentSchema = new Schema(
  {
    course: ref('Course', { required: true, index: true }),
    student: ref('User', { required: true, index: true }),
    batch: ref('Batch'), // the batch (of this course) the student attends
    completedLessons: [Schema.Types.ObjectId],
    lastLesson: Schema.Types.ObjectId,
    completedAt: Date,
    certificate: { code: String, issuedAt: Date },
  },
  { timestamps: true }
);
enrollmentSchema.index({ course: 1, student: 1 }, { unique: true });
enrollmentSchema.index({ 'certificate.code': 1 }, { unique: true, partialFilterExpression: { 'certificate.code': { $type: 'string' } } });

// ---------- Files (assignment briefs and student work, stored in the database) ----------
const storedFileSchema = new Schema(
  {
    course: ref('Course', { required: true, index: true }),
    owner: ref('User', { required: true, index: true }),
    kind: { type: String, enum: ['submission', 'assignment'], required: true },
    name: { type: String, required: true, maxlength: 160 },
    mime: { type: String, default: 'application/octet-stream', maxlength: 120 },
    size: { type: Number, required: true, min: 1 },
    storage: { type: String, enum: ['mongo', 's3'], default: 'mongo' }, // where the bytes live
    key: { type: String }, // object key when storage is s3
    data: { type: Buffer, required() { return this.storage !== 's3'; } }, // only for storage = mongo
    attached: { type: Boolean, default: false, index: true }, // false until it is saved on an assignment or submission
  },
  { timestamps: true }
);
const fileRefSchema = new Schema(
  { file: ref('StoredFile', { required: true }), name: String, size: Number, mime: String },
  { _id: false }
);

// ---------- Assignments ----------
const assignmentSchema = new Schema(
  {
    course: ref('Course', { required: true, index: true }),
    title: { type: String, required: true, trim: true, maxlength: 160 },
    instructions: { type: String, maxlength: 8000 },
    dueDate: { type: String, match: DATE_RE },
    maxPoints: { type: Number, default: 100, min: 1, max: 1000 },
    allowLate: { type: Boolean, default: true },
    requireAttachment: { type: Boolean, default: false }, // students must hand in a file or a link
    attachments: [fileRefSchema], // brief or starter files from the teacher
    batches: [ref('Batch')], // empty = every batch of the course; otherwise only these batches
    createdBy: ref('User'),
  },
  { timestamps: true }
);

const submissionSchema = new Schema(
  {
    assignment: ref('Assignment', { required: true, index: true }),
    course: ref('Course', { required: true, index: true }),
    student: ref('User', { required: true, index: true }),
    text: { type: String, maxlength: 10000 }, // optional note to the teacher
    link: { type: String, trim: true, maxlength: 600 }, // first link (older submissions only have this)
    links: [{ type: String, trim: true, maxlength: 600 }],
    files: [fileRefSchema],
    submittedAt: { type: Date, default: Date.now },
    late: { type: Boolean, default: false },
    grade: { type: Number, min: 0 },
    feedback: { type: String, maxlength: 4000 },
    gradedAt: Date,
    gradedBy: ref('User'),
  },
  { timestamps: true }
);
submissionSchema.index({ assignment: 1, student: 1 }, { unique: true });

// ---------- Quizzes (multiple choice, marked automatically) ----------
const questionSchema = new Schema({
  type: { type: String, enum: ['mcq', 'tf', 'short', 'code'], default: 'mcq' }, // mcq and tf are marked automatically
  section: { type: String, trim: true, maxlength: 160 }, // e.g. "Section A: Multiple Choice Questions"
  text: { type: String, required: true, trim: true, maxlength: 1500 },
  code: { type: String, maxlength: 4000 }, // optional code shown with the question
  options: {
    type: [String],
    validate: {
      validator(v) { return !['mcq', 'tf', undefined].includes(this.type) || (v.length >= 2 && v.length <= 6); },
      message: 'A choice question needs 2 to 6 options',
    },
  },
  correctIndex: { type: Number, default: 0, min: 0 },
  modelAnswer: { type: String, maxlength: 3000 }, // for the teacher while marking; students never get it before the result
  points: { type: Number, default: 1, min: 1, max: 100 },
});

const quizSchema = new Schema(
  {
    course: ref('Course', { required: true, index: true }),
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, maxlength: 2000 },
    maxAttempts: { type: Number, default: 1, min: 0, max: 20 }, // 0 = unlimited
    instructions: { type: String, maxlength: 3000 },
    kind: { type: String, enum: ['daily', 'weekly'], default: 'daily' }, // daily = multiple choice only; weekly = full paper with sections
    timeLimit: { type: Number, default: 0, min: 0, max: 300 }, // minutes, 0 = no timer
    revealAnswers: { type: Boolean, default: true }, // show the correct answers after the student finishes
    published: { type: Boolean, default: true },
    batches: [ref('Batch')], // empty = every batch of the course; otherwise only these batches
    questions: [questionSchema],
    createdBy: ref('User'),
  },
  { timestamps: true }
);

const attemptSchema = new Schema(
  {
    quiz: ref('Quiz', { required: true, index: true }),
    course: ref('Course', { required: true, index: true }),
    student: ref('User', { required: true, index: true }),
    answers: [Number], // older attempts only
    responses: [new Schema({
      question: { type: Schema.Types.ObjectId, required: true },
      choice: Number, // mcq / true-false: index of the chosen option
      text: { type: String, maxlength: 8000 }, // written or code answer
      marks: Number, // automatic for choice questions, set by the teacher for written ones
      feedback: { type: String, maxlength: 1000 },
    }, { _id: false })],
    status: { type: String, enum: ['in_progress', 'pending', 'graded'], default: 'graded' }, // pending = written answers still to be marked
    startedAt: Date,
    expiresAt: Date, // timed quizzes
    autoScore: Number,
    manualScore: Number,
    score: { type: Number, required: true },
    maxScore: { type: Number, required: true },
    comment: { type: String, maxlength: 2000 },
    gradedAt: Date,
    gradedBy: ref('User'),
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
// One unfinished attempt per student per quiz, so a double click cannot start two.
attemptSchema.index({ quiz: 1, student: 1 }, { unique: true, partialFilterExpression: { status: 'in_progress' } });

// ---------- Announcements ----------
const announcementSchema = new Schema(
  {
    course: ref('Course', { required: true, index: true }),
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, maxlength: 4000 },
    author: ref('User'),
  },
  { timestamps: true }
);

// ---------- Presentations (one topic per student, marked on a rubric) ----------
const rubricSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  maxMarks: { type: Number, required: true, min: 1, max: 100 },
});
const presentationSchema = new Schema(
  {
    course: ref('Course', { required: true, index: true }),
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, maxlength: 3000 },
    date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ }, // YYYY-MM-DD
    time: { type: String, match: /^\d{2}:\d{2}$/ }, // HH:MM
    durationMin: { type: Number, default: 5, min: 1, max: 180 }, // per student
    rubric: [rubricSchema], // what is marked, and out of how much
    askSlides: { type: Boolean, default: true }, // students may upload their slides
    published: { type: Boolean, default: true },
    batches: [ref('Batch')], // empty = every batch of the course
    createdBy: ref('User'),
  },
  { timestamps: true }
);
const presentationEntrySchema = new Schema(
  {
    presentation: ref('Presentation', { required: true, index: true }),
    course: ref('Course', { required: true, index: true }),
    student: ref('User', { required: true, index: true }),
    topic: { type: String, trim: true, maxlength: 300 },
    status: { type: String, enum: ['assigned', 'presented', 'absent'], default: 'assigned' },
    scores: [new Schema({ criterion: { type: Schema.Types.ObjectId, required: true }, marks: { type: Number, min: 0 } }, { _id: false })],
    total: { type: Number, default: 0 },
    comment: { type: String, maxlength: 2000 },
    slideFiles: [fileRefSchema],
    slideLinks: [{ type: String, trim: true, maxlength: 600 }],
    gradedAt: Date, // set once every criterion is marked, or the student is marked absent
    gradedBy: ref('User'),
  },
  { timestamps: true }
);
presentationEntrySchema.index({ presentation: 1, student: 1 }, { unique: true });

export const Presentation = mongoose.model('Presentation', presentationSchema);
export const PresentationEntry = mongoose.model('PresentationEntry', presentationEntrySchema);
export const StoredFile = mongoose.model('StoredFile', storedFileSchema);
export const Course = mongoose.model('Course', courseSchema);
export const Enrollment = mongoose.model('Enrollment', enrollmentSchema);
export const Assignment = mongoose.model('Assignment', assignmentSchema);
export const Submission = mongoose.model('Submission', submissionSchema);
export const Quiz = mongoose.model('Quiz', quizSchema);
export const QuizAttempt = mongoose.model('QuizAttempt', attemptSchema);
export const Announcement = mongoose.model('Announcement', announcementSchema);
