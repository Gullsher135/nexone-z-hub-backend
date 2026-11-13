import { Course } from '../models/lms.js';
import { User, STAFF_ROLES } from '../models/User.js';

// Before the Teachers module, an employee became a teacher just by being set as a course instructor.
// Give those people the teacher flag so they keep their access and show up in the Teachers list. Safe to run every start.
export async function migrateTeachers() {
  const ids = await Course.distinct('instructors');
  if (!ids.length) return;
  const r = await User.updateMany({ _id: { $in: ids }, role: { $in: STAFF_ROLES }, isTeacher: { $ne: true } }, { $set: { isTeacher: true } });
  if (r.modifiedCount) console.log(`Marked ${r.modifiedCount} existing instructor(s) as teachers`);
}
