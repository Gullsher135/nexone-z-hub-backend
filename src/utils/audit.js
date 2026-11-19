import { AuditLog } from '../models/AuditLog.js';

// Records a sensitive action. A problem here must never stop the real action, so errors are only logged.
export async function audit(req, action, { entity, entityId, summary, details } = {}) {
  try {
    await AuditLog.create({
      actor: req.user?._id, actorName: req.user?.name, actorRole: req.user?.role,
      action, entity, entityId: entityId ? String(entityId) : undefined,
      summary: String(summary || action).slice(0, 400), details,
      ip: req.ip,
    });
  } catch (err) {
    console.warn(`Audit log failed for ${action}: ${err.message}`);
  }
}
