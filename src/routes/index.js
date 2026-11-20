import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { protect, adminOnly, staffOnly, requireRole, teachRoles } from '../middleware/auth.js';
import * as auth from '../controllers/auth.controller.js';
import * as users from '../controllers/users.controller.js';
import * as batches from '../controllers/batches.controller.js';
import * as settings from '../controllers/settings.controller.js';
import * as attendance from '../controllers/attendance.controller.js';
import * as students from '../controllers/studentAttendance.controller.js';
import * as leaves from '../controllers/leaves.controller.js';
import * as reports from '../controllers/reports.controller.js';
import * as lms from '../controllers/lms.controller.js';
import * as files from '../controllers/files.controller.js';
import * as pres from '../controllers/presentation.controller.js';
import * as auditCtl from '../controllers/audit.controller.js';
import * as crew from '../controllers/crew.controller.js';
import * as pay from '../controllers/pay.controller.js';
import * as flow from '../controllers/flow.controller.js';
import * as docs from '../controllers/docs.controller.js';
import * as push from '../controllers/push.controller.js';
import * as flowDocs from '../controllers/flowDocs.controller.js';
import * as notif from '../controllers/notifications.controller.js';
import * as cron from '../controllers/cron.controller.js';

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

// ---- push notifications ----
router.get('/push/key', protect, push.publicKey);
router.post('/push/subscribe', protect, push.subscribe);
router.post('/push/unsubscribe', protect, push.unsubscribe);
router.post('/push/test', protect, push.test);
router.get('/push/devices', protect, notif.myDevices);
router.delete('/push/devices/:id', protect, notif.removeDevice);
router.get('/push/health', protect, requireRole('admin'), notif.health);
router.patch('/auth/contact', protect, notif.setContact);
router.get('/notifications', protect, notif.listMine);
router.get('/notifications/unread', protect, notif.unreadCount);
router.post('/notifications/read-all', protect, notif.markAllRead);
router.post('/notifications/:id/read', protect, notif.markRead);
router.delete('/notifications', protect, notif.clearAll);

// ---- settings ----
router.get('/settings', protect, settings.getSettingsHandler);
router.get('/audit', protect, adminOnly, auditCtl.listAudit);
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
router.get('/student-attendance', protect, teachRoles, students.getSheet);
router.put('/student-attendance', protect, teachRoles, students.saveSheet);
router.get('/student-attendance/summary', protect, teachRoles, students.batchSummary);
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
router.get('/lms/overview', protect, teachRoles, lms.adminOverview);
router.get('/lms/my/overview', protect, requireRole('student'), lms.myOverview);
router.get('/lms/pool', protect, teachRoles, lms.studentPool);
router.get('/lms/staff', protect, adminOnly, lms.staffPool);
router.get('/lms/teachers', protect, adminOnly, lms.listTeachers);
router.post('/lms/teachers', protect, adminOnly, lms.createTeacher);
router.put('/lms/teachers/:id/courses', protect, adminOnly, lms.setTeacherCourses);
router.delete('/lms/teachers/:id', protect, adminOnly, lms.removeTeacherAccess);
router.get('/lms/my/batches', protect, teachRoles, lms.myBatches);
router.get('/lms/courses', protect, lms.listCourses);
router.post('/lms/courses', protect, adminOnly, lms.createCourse);
router.get('/lms/courses/:id', protect, lms.getCourse);
router.patch('/lms/courses/:id', protect, teachRoles, lms.updateCourse);
router.delete('/lms/courses/:id', protect, adminOnly, lms.deleteCourse);
router.put('/lms/courses/:id/curriculum', protect, teachRoles, lms.saveCurriculum);
router.get('/lms/courses/:id/students', protect, teachRoles, lms.listStudents);
router.get('/lms/courses/:id/students/:studentId/progress', protect, teachRoles, lms.studentProgress);
router.get('/lms/courses/:id/my-progress', protect, requireRole('student'), lms.myProgress);
router.get('/lms/courses/:id/batches', protect, teachRoles, lms.listCourseBatches);
router.post('/lms/courses/:id/batches', protect, teachRoles, lms.createCourseBatch);
router.post('/lms/courses/:id/batches/link', protect, teachRoles, lms.linkCourseBatch);
router.patch('/lms/courses/:id/batches/:batchId', protect, teachRoles, lms.updateCourseBatch);
router.delete('/lms/courses/:id/batches/:batchId', protect, teachRoles, lms.deleteCourseBatch);
router.post('/lms/courses/:id/batches/:batchId/students', protect, teachRoles, lms.addStudentsToBatch);
router.post('/lms/courses/:id/enroll', protect, teachRoles, lms.enroll);
router.delete('/lms/courses/:id/enroll/:studentId', protect, teachRoles, lms.unenroll);
router.post('/lms/courses/:id/enroll/:studentId/certificate', protect, adminOnly, lms.issueManual);
router.post('/lms/courses/:id/progress', protect, requireRole('student'), lms.setProgress);
router.get('/lms/courses/:id/assignments', protect, lms.listAssignments);
router.post('/lms/courses/:id/assignments', protect, teachRoles, lms.createAssignment);
router.patch('/lms/assignments/:id', protect, teachRoles, lms.updateAssignment);
router.delete('/lms/assignments/:id', protect, teachRoles, lms.deleteAssignment);
// Raw file bytes (any format). Only parsed after the caller is logged in.
router.post('/lms/files', protect, express.raw({ type: () => true, limit: '11mb' }), files.uploadFile);
router.get('/lms/files/:id', protect, files.downloadFile);
router.post('/lms/assignments/:id/submit', protect, requireRole('student'), lms.submitAssignment);
router.get('/lms/assignments/:id/submissions', protect, teachRoles, lms.listSubmissions);
router.patch('/lms/submissions/:id/grade', protect, teachRoles, lms.gradeSubmission);
router.get('/lms/courses/:id/quizzes', protect, lms.listQuizzes);
router.post('/lms/courses/:id/quizzes', protect, teachRoles, lms.createQuiz);
router.get('/lms/quizzes/:id', protect, lms.getQuiz);
router.patch('/lms/quizzes/:id', protect, teachRoles, lms.updateQuiz);
router.delete('/lms/quizzes/:id', protect, teachRoles, lms.deleteQuiz);
router.get('/lms/courses/:id/presentations', protect, pres.listPresentations);
router.post('/lms/courses/:id/presentations', protect, teachRoles, pres.createPresentation);
router.patch('/lms/presentations/:id', protect, teachRoles, pres.updatePresentation);
router.delete('/lms/presentations/:id', protect, teachRoles, pres.deletePresentation);
router.get('/lms/presentations/:id/entries', protect, teachRoles, pres.listEntries);
router.put('/lms/presentations/:id/topics', protect, teachRoles, pres.setTopics);
router.post('/lms/presentations/:id/auto-assign', protect, teachRoles, pres.autoAssign);
router.post('/lms/presentations/:id/slides', protect, requireRole('student'), pres.submitSlides);
router.patch('/lms/presentation-entries/:id/grade', protect, teachRoles, pres.gradeEntry);
router.post('/lms/quizzes/:id/start', protect, requireRole('student'), lms.startQuiz);
router.post('/lms/quizzes/:id/attempt', protect, requireRole('student'), lms.attemptQuiz);
router.get('/lms/attempts/:id', protect, lms.getAttempt);
router.patch('/lms/attempts/:id/grade', protect, teachRoles, lms.gradeAttempt);
router.get('/lms/quizzes/:id/attempts', protect, teachRoles, lms.listAttempts);
router.get('/lms/courses/:id/announcements', protect, lms.listAnnouncements);
router.post('/lms/courses/:id/announcements', protect, teachRoles, lms.createAnnouncement);
router.delete('/lms/announcements/:id', protect, teachRoles, lms.deleteAnnouncement);

// ---- NexoneZ Crew (employee portal) ----
const crewUser = requireRole('admin', 'employee', 'intern');
const noticeUser = requireRole('admin', 'employee', 'intern', 'student', 'teacher');
router.get('/crew/home', protect, staffOnly, crew.home);
router.get('/crew/leave-balance', protect, staffOnly, crew.myBalance);
router.get('/crew/team', protect, crewUser, crew.team);
router.patch('/crew/profile', protect, crewUser, crew.updateProfile);
router.get('/crew/notices', protect, noticeUser, crew.listNotices);
router.post('/crew/notices', protect, adminOnly, crew.createNotice);
router.post('/crew/notices/read-all', protect, noticeUser, crew.markAllRead);
router.post('/crew/notices/:id/read', protect, noticeUser, crew.markNoticeRead);
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
router.post('/flow/items/:id/time', protect, crewUser, flow.logTime);
router.delete('/flow/items/:id/time/:logId', protect, crewUser, flow.deleteTime);
router.get('/flow/reminders', protect, crewUser, flow.reminders);
router.post('/flow/projects/:id/milestones', protect, crewUser, flow.createMilestone);
router.patch('/flow/projects/:id/milestones/:mid', protect, crewUser, flow.updateMilestone);
router.delete('/flow/projects/:id/milestones/:mid', protect, crewUser, flow.deleteMilestone);
router.put('/flow/projects/:id/links', protect, crewUser, flow.setProjectLinks);
router.post('/flow/projects/:id/share', protect, adminOnly, flow.setShare);
router.post('/flow/projects/:id/releases', protect, crewUser, flow.createRelease);
router.delete('/flow/projects/:id/releases/:rid', protect, crewUser, flow.deleteRelease);
router.get('/flow/projects/:id/export', protect, crewUser, flow.exportCards);
router.get('/flow/projects/:id/activity', protect, crewUser, flow.activityFeed);
router.post('/flow/projects/:id/feedback/seen', protect, crewUser, flow.feedbackSeen);
router.get('/flow/reports/time', protect, adminOnly, flow.timeReport);
router.get('/flow/search', protect, crewUser, flow.search);
router.get('/flow/projects/:id/documents', protect, crewUser, flowDocs.listDocs);
router.post('/flow/projects/:id/documents', protect, crewUser, express.raw({ type: () => true, limit: '11mb' }), flowDocs.uploadDoc);
router.get('/flow/documents/:docId/download', protect, crewUser, flowDocs.downloadDoc);
router.patch('/flow/documents/:docId', protect, crewUser, flowDocs.updateDoc);
router.delete('/flow/documents/:docId', protect, crewUser, flowDocs.deleteDoc);
router.get('/cron/reminders', syncLimiter, cron.reminders);
router.get('/flow/share/:token', syncLimiter, flow.publicShare);
router.post('/flow/share/:token/feedback', syncLimiter, flow.publicFeedback); // public: progress page for the client

export default router;
