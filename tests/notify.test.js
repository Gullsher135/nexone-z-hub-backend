import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMentions } from '../src/utils/mentions.js';
import { aggregateTime, timeCsv } from '../src/utils/flowReports.js';
import { deviceLabel } from '../src/utils/device.js';
import { emailAllowed, isEmail, urlFor, clip } from '../src/utils/notifyCalc.js';
import { renderEmail } from '../src/utils/mailTemplate.js';

const team = [{ _id: 'a', name: 'Ali Khan' }, { _id: 'b', name: 'Sara Ahmed' }, { _id: 'c', name: 'Sara Malik' }, { _id: 'd', name: 'Alice Noor' }];

test('mentions: full names, unique first names, and no partial matches', () => {
  assert.deepEqual(extractMentions('please check @Ali Khan', team), ['a']);
  assert.deepEqual(extractMentions('thanks @ali!', team), ['a']);          // unique first name, case does not matter
  assert.deepEqual(extractMentions('@Sara can you look?', team), []);      // two Saras: ambiguous, nobody is pinged
  assert.deepEqual(extractMentions('@Sara Malik can you look?', team), ['c']);
  assert.deepEqual(extractMentions('@Alice and @Ali', team), ['a', 'd']);  // @Ali must not match inside @Alice
  assert.deepEqual(extractMentions('no mention here', team), []);
  assert.deepEqual(extractMentions('mail me at ali@example.com', team), []);
});

test('time report adds hours per person and project inside the date range', () => {
  const items = [
    { project: 'p1', timeLogs: [{ user: 'u1', hours: 2, date: '2026-11-02' }, { user: 'u1', hours: 1.5, date: '2026-11-03' }, { user: 'u2', hours: 4, date: '2026-10-30' }] },
    { project: 'p2', timeLogs: [{ user: 'u1', hours: 3, date: '2026-11-05' }, { user: 'u2', hours: 1, date: '2026-11-05' }] },
  ];
  const r = aggregateTime(items, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(r.total, 7.5);
  assert.deepEqual(r.byUser.find((u) => u.id === 'u1'), { id: 'u1', hours: 6.5 });
  assert.equal(r.rows.length, 3);
  assert.equal(r.byProject[0].id, 'p2'); // p2 has the most hours in range (4h vs 3.5h)
  const csv = timeCsv([{ userName: 'Ali, K', userCode: 'NZ-EMP-0001', projectName: 'Site', hours: 2 }]);
  assert.match(csv, /"Ali, K"/);
});

test('device labels are readable', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile Safari/604.1'), 'Safari on iPhone');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120'), 'Edge on Windows');
  assert.equal(deviceLabel(''), 'Unknown device');
});

test('notification pages follow the role, and email rules are strict', () => {
  const payload = { url: '/x', urls: { admin: '/a', staff: '/s', student: '/st' } };
  assert.equal(urlFor('admin', payload), '/a');
  assert.equal(urlFor('employee', payload), '/s');
  assert.equal(urlFor('intern', payload), '/s');
  assert.equal(urlFor('student', payload), '/st');
  assert.equal(urlFor('teacher', payload), '/x');
  assert.equal(urlFor('teacher', {}), '/teach/notices');
  const u = { contactEmail: 'a@b.co' };
  assert.equal(emailAllowed(u, { email: true }, true), true);
  assert.equal(emailAllowed(u, {}, true), false);                        // not marked important
  assert.equal(emailAllowed(u, { email: true }, false), false);          // no mail service connected
  assert.equal(emailAllowed({}, { email: true }, true), false);          // no address
  assert.equal(emailAllowed({ ...u, emailNotifications: false }, { email: true }, true), false);
  assert.ok(isEmail('x@y.pk') && !isEmail('x@y') && !isEmail('x y@z.com'));
  assert.equal(clip('  a   b  ', 10), 'a b');
});

test('the email escapes text and builds the link', () => {
  const m = renderEmail({ title: 'New <quiz>', body: 'Tom & "Jerry"', url: '/learn/course/1', appUrl: 'https://app.example.com/', name: 'Sara Khan' });
  assert.equal(m.subject, 'New <quiz>');
  assert.match(m.html, /New &lt;quiz&gt;/);
  assert.match(m.html, /Tom &amp; &quot;Jerry&quot;/);
  assert.match(m.text, /Hi Sara,/);
  assert.match(m.text, /https:\/\/app\.example\.com\/learn\/course\/1/);
});
