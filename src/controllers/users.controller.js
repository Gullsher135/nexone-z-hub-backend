import { User, ROLES } from '../models/User.js';
import { Batch } from '../models/Batch.js';
import { Attendance } from '../models/Attendance.js';
import { StudentAttendance } from '../models/StudentAttendance.js';
import { Leave } from '../models/Leave.js';
import { Enrollment, Submission, QuizAttempt } from '../models/lms.js';
import { FeeAccount, Payment, SalaryProfile, Payslip } from '../models/pay.js';
import { Task } from '../models/crew.js';
import { detachUser } from './flow.controller.js';
import { HttpError, asyncHandler, escapeRegex, pick, randomPassword } from '../utils/helpers.js';

const EDITABLE = [
  'name', 'email', 'phone', 'cnic', 'designation', 'department', 'joiningDate', 'shift',
  'internship', 'batch', 'rollNo', 'admissionDate', 'guardianName', 'guardianPhone',
];

const isStaffLogin = (role) => role !== 'student';
const MIN_PASSWORD = 8;

// App-level guard in addition to the unique index, so the message is clear everywhere.
async function assertEmailFree(email, excludeId) {
  if (!email) return;
  const clash = await User.findOne({ email: String(email).toLowerCase().trim() }).select('_id');
  if (clash && String(clash._id) !== String(excludeId)) {
    throw new HttpError(409, 'A record with this email already exists');
  }
}

export const listUsers = asyncHandler(async (req, res) => {
  const { role, isActive, batch, q } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));

  const filter = {};
  if (role) filter.role = { $in: String(role).split(',') };
  if (isActive === 'true' || isActive === 'false') filter.isActive = isActive === 'true';
  if (batch) filter.batch = batch;
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { code: rx }, { rollNo: rx }];
  }

  const [items, total] = await Promise.all([
    User.find(filter)
      .populate('batch', 'name course')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter),
  ]);
  res.json({ items, total, page, pages: Math.ceil(total / limit) || 1 });
});

export const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).populate('batch', 'name course');
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user });
});

export const createUser = asyncHandler(async (req, res) => {
  const { role } = req.body || {};
  if (!ROLES.includes(role)) throw new HttpError(400, 'Role must be admin, employee, intern or student');
  if (!req.body.name) throw new HttpError(400, 'Name is required');

  const data = pick(req.body, EDITABLE);
  data.role = role;
  await assertEmailFree(data.email);

  let tempPassword;
  if (isStaffLogin(role)) {
    if (!data.email) throw new HttpError(400, 'Email is required for employees, interns and admins');
    tempPassword = req.body.password || randomPassword();
    if (tempPassword.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    data.password = tempPassword;
    data.mustChangePassword = !req.body.password;
    if (!data.joiningDate) data.joiningDate = new Date().toISOString().slice(0, 10);
  } else {
    if (data.batch) {
      const b = await Batch.findById(data.batch);
      if (!b) throw new HttpError(400, 'Batch not found');
    }
    // A student gets a login for the learning portal when an email is given and a login is asked for.
    if (req.body.createLogin || req.body.password) {
      if (!data.email) throw new HttpError(400, 'Add the student\'s email to give them a login');
      tempPassword = req.body.password || randomPassword();
      if (tempPassword.length < MIN_PASSWORD) throw new HttpError(400, 'Password must be at least 8 characters');
      data.password = tempPassword;
      data.mustChangePassword = !req.body.password;
    }
  }
  if (role !== 'intern') delete data.internship;

  const user = await User.create(data);
  res.status(201).json({ user, tempPassword });
});

export const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');

  const isSelf = String(user._id) === String(req.user._id);
  if (isSelf && (req.body.isActive === false || (req.body.role && req.body.role !== user.role))) {
    throw new HttpError(400, 'You cannot deactivate or change the role of your own account');
  }

  await assertEmailFree(req.body.email, user._id);
  Object.assign(user, pick(req.body, EDITABLE));
  if (typeof req.body.isActive === 'boolean') user.isActive = req.body.isActive;
  if (req.body.role && ROLES.includes(req.body.role) && !isSelf) user.role = req.body.role;
  if (user.role !== 'intern') user.internship = undefined;
  if (user.role !== 'student') user.batch = undefined;

  await user.save();
  await user.populate('batch', 'name course');
  res.json({ user });
});

export const setActive = (isActive) =>
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw new HttpError(404, 'User not found');
    if (!isActive && String(user._id) === String(req.user._id)) {
      throw new HttpError(400, 'You cannot deactivate your own account');
    }
    user.isActive = isActive;
    await user.save();
    res.json({ user });
  });

export const resetPassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');
  if (!isStaffLogin(user.role) && !user.email) {
    throw new HttpError(400, 'Add the student\'s email first, then you can give them a login');
  }

  const tempPassword = req.body?.password || randomPassword();
  if (tempPassword.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  user.password = tempPassword;
  user.mustChangePassword = true;
  await user.save();
  res.json({ tempPassword });
});

export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError(404, 'User not found');
  if (String(user._id) === String(req.user._id)) {
    throw new HttpError(400, 'You cannot delete your own account');
  }
  const [a, s, l, pm, ps] = await Promise.all([
    Attendance.exists({ user: user._id }),
    StudentAttendance.exists({ student: user._id }),
    Leave.exists({ user: user._id }),
    Payment.exists({ student: user._id }),
    Payslip.exists({ user: user._id, status: 'paid' }),
  ]);
  const hasHistory = a || s || l || pm || ps;
  if (hasHistory && req.query.force !== 'true') {
    throw new HttpError(409, 'This person has attendance or payment history. Deactivate instead of deleting, or delete permanently together with all their records.');
  }
  if (hasHistory) {
    // Permanent delete: remove their records first so nothing is left pointing at a missing person.
    await Promise.all([
      Attendance.deleteMany({ user: user._id }),
      StudentAttendance.deleteMany({ student: user._id }),
      Leave.deleteMany({ user: user._id }),
    ]);
  }
  await Promise.all([
    Enrollment.deleteMany({ student: user._id }),
    Submission.deleteMany({ student: user._id }),
    QuizAttempt.deleteMany({ student: user._id }),
    FeeAccount.deleteMany({ student: user._id }),
    Payment.deleteMany({ student: user._id }),
    SalaryProfile.deleteMany({ user: user._id }),
    Payslip.deleteMany({ user: user._id }),
    Task.deleteMany({ assignee: user._id }),
    detachUser(user._id),
  ]);
  await user.deleteOne();
  res.json({ message: 'Deleted' });
});

// Bulk import of students: { batch, students: [{ name, phone, rollNo, email }] }
export const importStudents = asyncHandler(async (req, res) => {
  const { batch, students } = req.body || {};
  if (!Array.isArray(students) || !students.length) throw new HttpError(400, 'No students provided');
  if (students.length > 500) throw new HttpError(400, 'Maximum 500 students per import');
  const b = await Batch.findById(batch);
  if (!b) throw new HttpError(400, 'Batch not found');

  const created = [];
  const errors = [];
  for (let i = 0; i < students.length; i++) {
    const row = students[i];
    if (!row?.name?.trim()) {
      errors.push({ row: i + 1, message: 'Name is missing' });
      continue;
    }
    try {
      await assertEmailFree(row.email || undefined);
      const u = await User.create({
        role: 'student',
        batch: b._id,
        name: row.name,
        phone: row.phone || undefined,
        rollNo: row.rollNo ? String(row.rollNo) : undefined,
        email: row.email || undefined,
        admissionDate: new Date().toISOString().slice(0, 10),
      });
      created.push(u._id);
    } catch (e) {
      errors.push({ row: i + 1, name: row.name, message: e.message });
    }
  }
  res.status(201).json({ created: created.length, errors });
});
