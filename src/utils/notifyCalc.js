// Pure rules for notifications (no database), so they are easy to test.
export const STAFF = ['employee', 'intern'];
// Where a tap opens, per role, when the sender gives no page of its own.
export const ROLE_URL = { admin: '/admin/crew', employee: '/notices', intern: '/notices', student: '/learn/notices', teacher: '/teach/notices' };

// payload.urls can hold a page per role ({ admin, staff, student, teacher }); payload.url is the fallback.
export const urlFor = (role, payload = {}) => payload.urls?.[role] || (STAFF.includes(role) ? payload.urls?.staff : undefined) || payload.url || ROLE_URL[role] || '/';

export const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Email only goes out when the sender marked the message as important, the person gave an email address
// and has not turned email off, and the server has a mail service connected.
export const emailAllowed = (user, payload, mailOn) => Boolean(mailOn && payload?.email && user?.contactEmail && user.emailNotifications !== false);

export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
