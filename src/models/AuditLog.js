import mongoose from 'mongoose';

// Who changed what, and when. Written by utils/audit.js, read by admins only. Entries are never edited.
const auditSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    actorName: String,
    actorRole: String,
    action: { type: String, required: true, index: true }, // e.g. payment.add, grade.submission
    entity: String, // e.g. Payment, Payslip, Attendance
    entityId: { type: String, index: true },
    summary: { type: String, maxlength: 400 }, // one readable line
    details: mongoose.Schema.Types.Mixed, // before / after values
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
auditSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditSchema);
