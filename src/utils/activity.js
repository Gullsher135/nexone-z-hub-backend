import { ProjectActivity } from '../models/flow.js';

// One line in a project's activity feed ("Sara moved Login page to Review"). Never blocks the real action.
export function logActivity(project, user, text, extra = {}) {
  const id = project?._id || project;
  if (!id) return;
  ProjectActivity.create({ project: id, user: user?._id, userName: user?.name || 'Someone', text: String(text).replace(/\s+/g, ' ').slice(0, 300), item: extra.item })
    .catch((e) => console.warn('activity log failed', e.message));
}
