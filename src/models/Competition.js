import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';
import { AWARDS } from '../utils/competition.js';

const { Schema } = mongoose;
const ref = (name, extra = {}) => ({ type: Schema.Types.ObjectId, ref: name, ...extra });

// One person taking part: only chosen students are added, so only they can see the competition.
const participantSchema = new Schema(
  {
    student: ref('User', { required: true }),
    score: { type: Number, min: 0 },
    rank: Number,
    award: { type: String, enum: AWARDS },
    awardTitle: { type: String, maxlength: 80 }, // for example "Best Design"; replaces the standard label
    note: { type: String, maxlength: 300 },
    certificate: { code: String, issuedAt: Date },
  },
  { _id: false }
);

const competitionSchema = new Schema(
  {
    code: { type: String, unique: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, maxlength: 4000 },
    date: { type: String, match: DATE_RE },
    status: { type: String, enum: ['upcoming', 'running', 'finished'], default: 'upcoming' },
    quiz: ref('Quiz'), // when the scores come from a quiz
    maxScore: { type: Number, min: 1 },
    issuer: { type: String, maxlength: 80, default: 'NexoneZ Software House' }, // shown on the certificate
    published: { type: Boolean, default: false }, // students see the results only when true
    participants: [participantSchema],
    createdBy: ref('User'),
  },
  { timestamps: true }
);
competitionSchema.index({ 'participants.student': 1 });
competitionSchema.index({ 'participants.certificate.code': 1 });

export const Competition = mongoose.model('Competition', competitionSchema);
