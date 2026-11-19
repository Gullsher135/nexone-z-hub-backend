import { AuditLog } from '../models/AuditLog.js';
import { DATE_RE } from '../utils/time.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';

const PAGE = 50;

// GET /audit?action=payment&entity=Payslip&from=YYYY-MM-DD&to=YYYY-MM-DD&page=1   (admin only)
export const listAudit = asyncHandler(async (req, res) => {
  const { action, entity, from, to } = req.query;
  const q = {};
  if (action) q.action = new RegExp(`^${String(action).replace(/[^\w.]/g, '')}`); // "payment" matches payment.add, payment.void
  if (entity) q.entity = String(entity);
  if (from || to) {
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(`${from}T00:00:00+05:00`);
    if (to) q.createdAt.$lte = new Date(`${to}T23:59:59.999+05:00`);
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const [items, total] = await Promise.all([
    AuditLog.find(q).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean(),
    AuditLog.countDocuments(q),
  ]);
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / PAGE)) });
});
