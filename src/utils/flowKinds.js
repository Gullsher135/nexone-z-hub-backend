// What kinds of work Flow tracks, in plain words. Pure data and helpers (no database), so they are easy to test.

export const PROJECT_KINDS = ['project', 'product', 'saas'];
export const STAGES = ['idea', 'building', 'beta', 'live', 'maintenance'];
export const RELEASE_TYPES = ['major', 'minor', 'patch', 'hotfix'];
export const DOC_CATEGORIES = ['requirements', 'design', 'technical', 'contract', 'report', 'meeting', 'other'];

export const KIND_INFO = {
  project: {
    label: 'Project', prefix: 'PRJ', counter: 'project',
    defines: 'Client work with a fixed scope, budget and deadline. We build it once for one client, deliver it and hand it over. It ends when it is delivered.',
    example: 'A website for a client, a custom mobile app, a one-off integration.',
  },
  product: {
    label: 'Product', prefix: 'PRD', counter: 'project-product',
    defines: 'Software we build ourselves and sell or license to many customers as a package. It has versions and releases and a roadmap, and no fixed end date.',
    example: 'A school management system sold with a one-time licence, a desktop tool, a template pack.',
  },
  saas: {
    label: 'SaaS', prefix: 'SAS', counter: 'project-saas',
    defines: 'A product we host online and customers use by subscription, monthly or yearly. One running system serves many customers. We ship updates continuously and look after uptime, support and billing.',
    example: 'NexoneZ Hub offered to institutes for a monthly fee.',
  },
};

// Phases added when someone ticks "Add starter milestones" while creating.
const STARTERS = {
  project: [
    ['Kickoff and requirements', 'Agree the scope, deliverables and timeline with the client.'],
    ['Design', 'Wireframes and designs approved by the client.'],
    ['Development', 'Build the agreed features.'],
    ['Testing and client review', 'Fix bugs and collect the client\'s feedback.'],
    ['Delivery and handover', 'Go live, hand over files and documents, final payment.'],
  ],
  product: [
    ['MVP', 'The smallest version that is useful to a first customer.'],
    ['Beta', 'A few real customers try it and give feedback.'],
    ['Version 1.0 launch', 'First public release with documentation.'],
    ['Growth releases', 'Regular improvements based on customer feedback.'],
  ],
  saas: [
    ['MVP', 'Core features working for one test customer.'],
    ['Private beta', 'A handful of customers use it and give feedback.'],
    ['Billing and onboarding', 'Plans, subscriptions, sign-up and welcome flow.'],
    ['Public launch', 'Open to everyone, with support and monitoring in place.'],
    ['Scale and reliability', 'Backups, uptime monitoring, performance and security.'],
  ],
};
export const starterMilestones = (kind) => (STARTERS[kind] || STARTERS.project).map(([name, description]) => ({ name, description }));

const bad = (m) => { const e = new Error(m); e.badInput = true; return e; };

export function cleanRelease(b = {}) {
  const version = String(b.version || '').trim().slice(0, 20);
  if (!version) throw bad('Enter the version, for example 1.2.0');
  const title = String(b.title || '').trim().slice(0, 100);
  const type = RELEASE_TYPES.includes(b.type) ? b.type : 'minor';
  const date = String(b.date || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('The release date must be a date');
  const notes = String(b.notes || '').trim().slice(0, 3000);
  if (!title && !notes) throw bad('Write what changed in this release');
  return { version, title, type, date: date || undefined, notes };
}

export function cleanMetrics(m = {}) {
  const num = (v, label) => {
    if (v === '' || v === null || v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1e12) throw bad(`${label} must be a number`);
    return Math.round(n);
  };
  return { customers: num(m.customers, 'Customers'), mrr: num(m.mrr, 'Monthly revenue') };
}
