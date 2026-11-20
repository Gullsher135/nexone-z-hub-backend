import test from 'node:test';
import assert from 'node:assert/strict';
import { KIND_INFO, PROJECT_KINDS, cleanMetrics, cleanRelease, starterMilestones } from '../src/utils/flowKinds.js';
import { bucketByPerson, describeCounts, feeReminder } from '../src/utils/reminderCalc.js';

test('every kind has a definition, an example and its own code prefix and counter', () => {
  assert.deepEqual(PROJECT_KINDS, ['project', 'product', 'saas']);
  const prefixes = new Set(PROJECT_KINDS.map((k) => KIND_INFO[k].prefix));
  const counters = new Set(PROJECT_KINDS.map((k) => KIND_INFO[k].counter));
  assert.equal(prefixes.size, 3);
  assert.equal(counters.size, 3);
  assert.equal(KIND_INFO.project.counter, 'project'); // keeps the numbering of existing projects
  PROJECT_KINDS.forEach((k) => { assert.ok(KIND_INFO[k].defines.length > 40); assert.ok(KIND_INFO[k].example); });
});

test('starter milestones differ per kind and fall back to project', () => {
  assert.equal(starterMilestones('project')[0].name, 'Kickoff and requirements');
  assert.ok(starterMilestones('saas').some((m) => m.name === 'Billing and onboarding'));
  assert.ok(starterMilestones('product').length >= 3);
  assert.deepEqual(starterMilestones('nope'), starterMilestones('project'));
});

test('release input is cleaned and validated', () => {
  const r = cleanRelease({ version: ' 1.2.0 ', title: 'Dark mode', type: 'minor', notes: '- dark theme', date: '2026-11-20' });
  assert.equal(r.version, '1.2.0');
  assert.equal(r.type, 'minor');
  assert.equal(cleanRelease({ version: '2.0', notes: 'x', type: 'weird' }).type, 'minor');
  assert.throws(() => cleanRelease({ title: 'no version' }), /version/);
  assert.throws(() => cleanRelease({ version: '1.0' }), /what changed/);
  assert.throws(() => cleanRelease({ version: '1.0', notes: 'x', date: '20-11-2026' }), /date/);
});

test('metrics accept empty values and reject bad numbers', () => {
  assert.deepEqual(cleanMetrics({ customers: '12', mrr: '' }), { customers: 12, mrr: undefined });
  assert.throws(() => cleanMetrics({ customers: -1 }), /Customers/);
  assert.throws(() => cleanMetrics({ mrr: 'abc' }), /Monthly revenue/);
});

test('daily digest counts late, today and tomorrow per person and skips the rest', () => {
  const items = [
    { assignee: 'a', dueDate: '2026-11-18', status: 'todo' },
    { assignee: 'a', dueDate: '2026-11-20', status: 'doing' },
    { assignee: 'a', dueDate: '2026-11-21', status: 'todo' },
    { assignee: 'a', dueDate: '2026-11-25', status: 'todo' }, // later: not mentioned
    { assignee: 'a', dueDate: '2026-11-19', status: 'done' }, // finished: not mentioned
    { assignee: 'b', dueDate: '2026-11-20', status: 'todo' },
    { dueDate: '2026-11-20', status: 'todo' }, // nobody's card
  ];
  const m = bucketByPerson(items, '2026-11-20');
  assert.deepEqual(m.get('a'), { overdue: 1, today: 1, tomorrow: 1 });
  assert.deepEqual(m.get('b'), { overdue: 0, today: 1, tomorrow: 0 });
  assert.equal(m.size, 2);
  assert.equal(describeCounts(m.get('a')), '1 overdue, 1 due today, 1 due tomorrow');
});

test('fee reminders: overdue, due in 3 days, due today, otherwise nothing', () => {
  const base = { balance: 5000, overdue: 0, next: { dueDate: '2026-11-23', amount: 2500 } };
  assert.equal(feeReminder({ ...base, overdue: 1000 }, '2026-11-20').kind, 'overdue');
  assert.equal(feeReminder(base, '2026-11-20').kind, 'in3');
  assert.equal(feeReminder({ ...base, next: { dueDate: '2026-11-20', amount: 2500 } }, '2026-11-20').kind, 'today');
  assert.equal(feeReminder(base, '2026-11-21'), null);
  assert.equal(feeReminder({ ...base, balance: 0 }, '2026-11-20'), null);
  assert.equal(feeReminder(null, '2026-11-20'), null);
});
