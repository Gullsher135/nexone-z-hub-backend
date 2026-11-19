import test from 'node:test';
import assert from 'node:assert/strict';
import { isClassDay, lastClassDay, weekdayOfKey, datesBetween, monthRange } from '../src/utils/time.js';

test('classes run on Saturday and Sunday only', () => {
  assert.deepEqual(['2026-11-14', '2026-11-15'].map(isClassDay), [true, true]);
  assert.deepEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'].map(isClassDay), [false, false, false, false, false]);
});

test('lastClassDay walks back to the latest Saturday or Sunday', () => {
  assert.equal(lastClassDay('2026-11-17'), '2026-11-15'); // Tuesday
  assert.equal(lastClassDay('2026-11-14'), '2026-11-14'); // Saturday itself
  assert.equal(lastClassDay('2026-11-20'), '2026-11-15'); // Friday
});

test('weekday of a date is not shifted by the time zone', () => {
  assert.equal(weekdayOfKey('2026-11-15'), 0); // Sunday
  assert.equal(weekdayOfKey('2026-11-14'), 6); // Saturday
});

test('datesBetween is inclusive and monthRange covers the whole month', () => {
  assert.deepEqual(datesBetween('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  assert.deepEqual(monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
});
