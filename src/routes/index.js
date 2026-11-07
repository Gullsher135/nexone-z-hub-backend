import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { protect, adminOnly, staffOnly } from '../middleware/auth.js';
import * as auth from '../controllers/auth.controller.js';
import * as users from '../controllers/users.controller.js';
import * as batches from '../controllers/batches.controller.js';
import * as settings from '../controllers/settings.controller.js';
import * as attendance from '../controllers/attendance.controller.js';
import * as students from '../controllers/studentAttendance.controller.js';
import * as leaves from '../controllers/leaves.controller.js';
import * as reports from '../controllers/reports.controller.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again in a few minutes.' },
});

router.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- auth ----
router.post('/auth/login', loginLimiter, auth.login);
router.get('/auth/me', protect, auth.me);
router.post('/auth/change-password', protect, auth.changePassword);

// ---- settings ----
router.get('/settings', protect, settings.getSettingsHandler);
router.put('/settings', protect, adminOnly, settings.updateSettings);
router.get('/settings/my-ip', protect, adminOnly, settings.myIp);
router.post('/settings/resolve-map', protect, adminOnly, settings.resolveMap);

// ---- users (employees / interns / students / admins) ----
router.get('/users', protect, adminOnly, users.listUsers);
router.post('/users', protect, adminOnly, users.createUser);
router.post('/users/import-students', protect, adminOnly, users.importStudents);
router.get('/users/:id', protect, adminOnly, users.getUser);
router.patch('/users/:id', protect, adminOnly, users.updateUser);
router.delete('/users/:id', protect, adminOnly, users.deleteUser);
router.post('/users/:id/activate', protect, adminOnly, users.setActive(true));
router.post('/users/:id/deactivate', protect, adminOnly, users.setActive(false));
router.post('/users/:id/reset-password', protect, adminOnly, users.resetPassword);

// ---- batches ----
router.get('/batches', protect, adminOnly, batches.listBatches);
router.post('/batches', protect, adminOnly, batches.createBatch);
router.patch('/batches/:id', protect, adminOnly, batches.updateBatch);
router.delete('/batches/:id', protect, adminOnly, batches.deleteBatch);

// ---- staff attendance ----
router.get('/attendance/today', protect, staffOnly, attendance.myToday);
router.get('/attendance/me', protect, staffOnly, attendance.myMonth);
router.post('/attendance/check-in', protect, staffOnly, attendance.checkIn);
router.post('/attendance/check-out', protect, staffOnly, attendance.checkOut);
router.post('/attendance/punch', protect, staffOnly, attendance.punch);
router.get('/attendance/qr', protect, adminOnly, attendance.qrToken);
router.get('/attendance/board', protect, adminOnly, attendance.board);
router.post('/attendance/manual', protect, adminOnly, attendance.manualEntry);
router.delete('/attendance/:id', protect, adminOnly, attendance.deleteRecord);

// ---- student attendance ----
router.get('/student-attendance', protect, adminOnly, students.getSheet);
router.put('/student-attendance', protect, adminOnly, students.saveSheet);
router.get('/student-attendance/summary', protect, adminOnly, students.batchSummary);
router.get('/student-attendance/student/:id', protect, adminOnly, students.studentHistory);

// ---- leaves ----
router.post('/leaves', protect, staffOnly, leaves.createLeave);
router.get('/leaves/me', protect, staffOnly, leaves.myLeaves);
router.delete('/leaves/:id', protect, staffOnly, leaves.cancelLeave);
router.get('/leaves', protect, adminOnly, leaves.listLeaves);
router.patch('/leaves/:id/review', protect, adminOnly, leaves.reviewLeave);

// ---- reports ----
router.get('/reports/dashboard', protect, adminOnly, reports.dashboard);
router.get('/reports/summary', protect, adminOnly, reports.summary);
router.get('/reports/user/:id', protect, adminOnly, reports.userReport);
router.get('/reports/export', protect, adminOnly, reports.exportCsv);

export default router;
