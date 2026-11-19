import { Leave } from '../models/Leave.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { DATE_RE, addDays, dateKey } from '../utils/time.js';

export const createLeave = asyncHandler(async (req, res) => {
  const { type, fromDate, toDate, reason } = req.body || {};
  if (!DATE_RE.test(fromDate || '') || !DATE_RE.test(toDate || '')) {
    throw new HttpError(400, 'Valid from and to dates are required');
  }
  if (toDate < fromDate) throw new HttpError(400, 'End date cannot be before start date');
  if (toDate > addDays(fromDate, 60)) throw new HttpError(400, 'A leave request can cover at most 60 days');
  if (!reason?.trim()) throw new HttpError(400, 'Please give a reason');

  const overlap = await Leave.exists({
    user: req.user._id,
    status: { $in: ['pending', 'approved'] },
    fromDate: { $lte: toDate },
    toDate: { $gte: fromDate },
  });
  if (overlap) throw new HttpError(409, 'You already have a leave request covering these dates');

  const leave = await Leave.create({ user: req.user._id, type, fromDate, toDate, reason: reason.trim() });
  res.status(201).json({ leave });
});

export const myLeaves = asyncHandler(async (req, res) => {
  const items = await Leave.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100);
  res.json({ items });
});

export const cancelLeave = asyncHandler(async (req, res) => {
  const leave = await Leave.findOne({ _id: req.params.id, user: req.user._id });
  if (!leave) throw new HttpError(404, 'Leave request not found');
  if (leave.status !== 'pending') throw new HttpError(400, 'Only pending requests can be cancelled');
  await leave.deleteOne();
  res.json({ message: 'Cancelled' });
});

export const listLeaves = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.user) filter.user = req.query.user;
  const items = await Leave.find(filter)
    .sort({ status: 1, createdAt: -1 })
    .limit(300)
    .populate('user', 'name code role')
    .populate('reviewedBy', 'name');
  res.json({ items });
});

export const reviewLeave = asyncHandler(async (req, res) => {
  const { status, reviewNote } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) throw new HttpError(400, 'Status must be approved or rejected');
  const leave = await Leave.findById(req.params.id);
  if (!leave) throw new HttpError(404, 'Leave request not found');
  leave.status = status;
  leave.reviewNote = reviewNote || '';
  leave.reviewedBy = req.user._id;
  leave.reviewedAt = new Date();
  await leave.save();
  res.json({ leave, today: dateKey() });
});
