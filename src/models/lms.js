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
    completedLessons: [Schema.Types.ObjectId],
    lastLesson: Schema.Types.ObjectId,
    completedAt: Date,
    certificate: { code: String, issuedAt: Date },
  },
  { timestamps: true }
);
enrollmentSchema.index({ course: 1, student: 1 }, { unique: true });
enrollmentSchema.index({ 'certificate.code': 1 }, { unique: true, partialFilterExpression: { 'certificate.code': { $type: 'string' } } });

// ---------- Assignments ----------
const assignmentSchema = new Schema(
  {
    course: ref('Course', { required: true, index: true }),
    title: { type: String, required: true, trim: true, maxlength: 160 },
    instructions: { type: String, maxlength: 8000 },
    dueDate: { type: String, match: DATE_RE },
    maxPoints: { type: Number, default: 100, min: 1, max: 1000 },
    allowLate: { type: Boolean, default: true },
    createdBy: ref('User'),
  },
  { timestamps: true }
);

const submissionSchema = new Schema(
  {
    assignment: ref('Assignment', { required: true, index: true }),
    course: ref('Course', { required: true, index: true }),
    student: ref('User', { required: true, index: true }),
    text: { type: String, maxlength: 10000 },
    link: { type: String, trim: true, maxlength: 600 },
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
  text: { type: String, required: true, trim: true, maxlength: 600 },
  options: { type: [String], validate: (v) => v.length >= 2 && v.length <= 6 },
  correctIndex: { type: Number, required: true, min: 0 },
  points: { type: Number, default: 1, min: 1, max: 100 },
});

const quizSchema = new Schema(
  {
    course: ref('Course', { required: true, index: true }),
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, maxlength: 2000 },
    maxAttempts: { type: Number, default: 1, min: 0, max: 20 }, // 0 = unlimited
    published: { type: Boolean, default: true },
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
    answers: [Number],
    score: { type: Number, required: true },
    maxScore: { type: Number, required: true },
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

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

export const Course = mongoose.model('Course', courseSchema);
export const Enrollment = mongoose.model('Enrollment', enrollmentSchema);
export const Assignment = mongoose.model('Assignment', assignmentSchema);
export const Submission = mongoose.model('Submission', submissionSchema);
export const Quiz = mongoose.model('Quiz', quizSchema);
export const QuizAttempt = mongoose.model('QuizAttempt', attemptSchema);
export const Announcement = mongoose.model('Announcement', announcementSchema);
