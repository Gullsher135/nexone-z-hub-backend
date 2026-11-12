import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { protect, adminOnly, staffOnly, requireRole } from '../middleware/auth.js';
import * as auth from '../controllers/auth.controller.js';
import * as users from '../controllers/users.controller.js';
import * as batches from '../controllers/batches.controller.js';
import * as settings from '../controllers/settings.controller.js';
import * as attendance from '../controllers/attendance.controller.js';
import * as students from '../controllers/studentAttendance.controller.js';
import * as leaves from '../controllers/leaves.controller.js';
import * as reports from '../controllers/reports.controller.js';
import * as lms from '../controllers/lms.controller.js';
import * as crew from '../controllers/crew.controller.js';
import * as pay from '../controllers/pay.controller.js';
import * as flow from '../controllers/flow.controller.js';
import * as docs from '../controllers/docs.controller.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again in a few minutes.' },
});

const syncLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many requests.' } });

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
router.post('/settings/office-sync-key', protect, adminOnly, settings.rotateSyncKey);
router.post('/office-sync/:key', syncLimiter, settings.officeSync);

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

// ---- NexoneZ Learn (LMS) ----
router.get('/lms/verify/:code', syncLimiter, lms.verifyCertificate);
router.get('/lms/overview', protect, requireRole('admin', 'employee', 'intern'), lms.adminOverview);
router.get('/lms/my/overview', protect, requireRole('student'), lms.myOverview);
router.get('/lms/pool', protect, requireRole('admin', 'employee', 'intern'), lms.studentPool);
router.get('/lms/staff', protect, adminOnly, lms.staffPool);
router.get('/lms/courses', protect, lms.listCourses);
router.post('/lms/courses', protect, adminOnly, lms.createCourse);
router.get('/lms/courses/:id', protect, lms.getCourse);
router.patch('/lms/courses/:id', protect, requireRole('admin', 'employee', 'intern'), lms.updateCourse);
router.delete('/lms/courses/:id', protect, adminOnly, lms.deleteCourse);
router.put('/lms/courses/:id/curriculum', protect, requireRole('admin', 'employee', 'intern'), lms.saveCurriculum);
router.get('/lms/courses/:id/students', protect, requireRole('admin', 'employee', 'intern'), lms.listStudents);
router.post('/lms/courses/:id/enroll', protect, requireRole('admin', 'employee', 'intern'), lms.enroll);
router.delete('/lms/courses/:id/enroll/:studentId', protect, requireRole('admin', 'employee', 'intern'), lms.unenroll);
router.post('/lms/courses/:id/enroll/:studentId/certificate', protect, requireRole('admin', 'employee', 'intern'), lms.issueManual);
router.post('/lms/courses/:id/progress', protect, requireRole('student'), lms.setProgress);
router.get('/lms/courses/:id/assignments', protect, lms.listAssignments);
router.post('/lms/courses/:id/assignments', protect, requireRole('admin', 'employee', 'intern'), lms.createAssignment);
router.patch('/lms/assignments/:id', protect, requireRole('admin', 'employee', 'intern'), lms.updateAssignment);
router.delete('/lms/assignments/:id', protect, requireRole('admin', 'employee', 'intern'), lms.deleteAssignment);
router.post('/lms/assignments/:id/submit', protect, requireRole('student'), lms.submitAssignment);
router.get('/lms/assignments/:id/submissions', protect, requireRole('admin', 'employee', 'intern'), lms.listSubmissions);
router.patch('/lms/submissions/:id/grade', protect, requireRole('admin', 'employee', 'intern'), lms.gradeSubmission);
router.get('/lms/courses/:id/quizzes', protect, lms.listQuizzes);
router.post('/lms/courses/:id/quizzes', protect, requireRole('admin', 'employee', 'intern'), lms.createQuiz);
router.get('/lms/quizzes/:id', protect, lms.getQuiz);
router.patch('/lms/quizzes/:id', protect, requireRole('admin', 'employee', 'intern'), lms.updateQuiz);
router.delete('/lms/quizzes/:id', protect, requireRole('admin', 'employee', 'intern'), lms.deleteQuiz);
router.post('/lms/quizzes/:id/attempt', protect, requireRole('student'), lms.attemptQuiz);
router.get('/lms/quizzes/:id/attempts', protect, requireRole('admin', 'employee', 'intern'), lms.listAttempts);
router.get('/lms/courses/:id/announcements', protect, lms.listAnnouncements);
router.post('/lms/courses/:id/announcements', protect, requireRole('admin', 'employee', 'intern'), lms.createAnnouncement);
router.delete('/lms/announcements/:id', protect, requireRole('admin', 'employee', 'intern'), lms.deleteAnnouncement);

// ---- NexoneZ Crew (employee portal) ----
const crewUser = requireRole('admin', 'employee', 'intern');
router.get('/crew/home', protect, staffOnly, crew.home);
router.get('/crew/leave-balance', protect, staffOnly, crew.myBalance);
router.get('/crew/team', protect, crewUser, crew.team);
router.patch('/crew/profile', protect, crewUser, crew.updateProfile);
router.get('/crew/notices', protect, crewUser, crew.listNotices);
router.post('/crew/notices', protect, adminOnly, crew.createNotice);
router.post('/crew/notices/read-all', protect, staffOnly, crew.markAllRead);
router.post('/crew/notices/:id/read', protect, crewUser, crew.markNoticeRead);
router.patch('/crew/notices/:id', protect, adminOnly, crew.updateNotice);
router.delete('/crew/notices/:id', protect, adminOnly, crew.deleteNotice);
router.get('/crew/tasks/mine', protect, staffOnly, crew.myTasks);
router.get('/crew/tasks', protect, adminOnly, crew.listTasks);
router.post('/crew/tasks', protect, adminOnly, crew.createTask);
router.patch('/crew/tasks/:id', protect, adminOnly, crew.updateTask);
router.delete('/crew/tasks/:id', protect, adminOnly, crew.deleteTask);
router.post('/crew/tasks/:id/status', protect, crewUser, crew.setTaskStatus);
router.post('/crew/tasks/:id/comments', protect, crewUser, crew.commentTask);

// ---- NexoneZ Pay (fees and payroll) ----
router.get('/pay/overview', protect, adminOnly, pay.overview);
router.get('/pay/fees', protect, adminOnly, pay.feeList);
router.get('/pay/my-fees', protect, requireRole('student'), pay.myFees);
router.get('/pay/fees/:studentId', protect, adminOnly, pay.feeDetail);
router.put('/pay/fees/:studentId', protect, adminOnly, pay.setPlan);
router.post('/pay/fees/:studentId/payments', protect, adminOnly, pay.addPayment);
router.delete('/pay/payments/:id', protect, adminOnly, pay.voidPayment);
router.get('/pay/payments/:id', protect, pay.receipt);
router.get('/pay/salaries', protect, adminOnly, pay.salaryList);
router.put('/pay/salaries/:userId', protect, adminOnly, pay.setSalary);
router.get('/pay/payroll', protect, adminOnly, pay.payrollList);
router.post('/pay/payroll/generate', protect, adminOnly, pay.generatePayroll);
router.patch('/pay/payslips/:id', protect, adminOnly, pay.updatePayslip);
router.post('/pay/payslips/:id/pay', protect, adminOnly, pay.payPayslip);
router.delete('/pay/payslips/:id', protect, adminOnly, pay.deletePayslip);
router.get('/pay/my-payslips', protect, staffOnly, pay.myPayslips);
router.get('/pay/payslips/:id', protect, pay.payslip);

// ---- Letters and certificates (HR) ----
router.get('/docs/verify/:code', syncLimiter, docs.verify);
router.get('/docs/suggest/:userId', protect, adminOnly, docs.suggest);
router.get('/docs/eligible', protect, adminOnly, docs.eligible);
router.get('/docs/letters', protect, adminOnly, docs.listLetters);
router.post('/docs/letters', protect, adminOnly, docs.createLetter);
router.get('/docs/my', protect, staffOnly, docs.myLetters);
router.get('/docs/letters/:id', protect, docs.getLetter);
router.post('/docs/letters/:id/revoke', protect, adminOnly, docs.revokeLetter);
router.post('/docs/letters/:id/acknowledge', protect, staffOnly, docs.acknowledge);

// ---- NexoneZ Flow (projects) ----
router.get('/flow/overview', protect, adminOnly, flow.overview);
router.get('/flow/my-work', protect, staffOnly, flow.myWork);
router.get('/flow/clients', protect, adminOnly, flow.listClients);
router.post('/flow/clients', protect, adminOnly, flow.createClient);
router.patch('/flow/clients/:id', protect, adminOnly, flow.updateClient);
router.delete('/flow/clients/:id', protect, adminOnly, flow.deleteClient);
router.get('/flow/projects', protect, crewUser, flow.listProjects);
router.post('/flow/projects', protect, adminOnly, flow.createProject);
router.get('/flow/projects/:id', protect, crewUser, flow.getProject);
router.patch('/flow/projects/:id', protect, adminOnly, flow.updateProject);
router.delete('/flow/projects/:id', protect, adminOnly, flow.deleteProject);
router.post('/flow/projects/:id/items', protect, crewUser, flow.createItem);
router.patch('/flow/items/:id', protect, crewUser, flow.updateItem);
router.delete('/flow/items/:id', protect, crewUser, flow.deleteItem);
router.post('/flow/items/:id/status', protect, crewUser, flow.setItemStatus);
router.post('/flow/items/:id/comments', protect, crewUser, flow.commentItem);

export default router;
