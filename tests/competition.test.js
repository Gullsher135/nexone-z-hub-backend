import test from 'node:test';
import assert from 'node:assert/strict';
import { awardText, certificateTargets, isWinner, rankParticipants, resultMessage } from '../src/utils/competition.js';
import { visibleFor } from '../src/utils/visibility.js';

test('ranking: equal scores share a rank and the top three get the podium awards', () => {
  const r = rankParticipants([
    { student: 'a', score: 90 }, { student: 'b', score: 95 }, { student: 'c', score: 90 }, { student: 'd', score: 70 }, { student: 'e' },
  ]);
  const by = (s) => r.find((p) => p.student === s);
  assert.equal(by('b').rank, 1); assert.equal(by('b').award, 'first');
  assert.equal(by('a').rank, 2); assert.equal(by('c').rank, 2);
  assert.equal(by('a').award, 'second'); assert.equal(by('c').award, 'second'); // a tie shares the award
  assert.equal(by('d').rank, 4); assert.equal(by('d').award, undefined);        // rank 3 is empty after the tie
  assert.equal(by('e').rank, undefined);                                          // no score, no rank
});

test('ranking keeps special and participation awards and can limit winners', () => {
  const r = rankParticipants([{ student: 'a', score: 50, award: 'special', awardTitle: 'Best Design' }, { student: 'b', score: 80 }, { student: 'c', score: 60, award: 'first' }], { winners: 1 });
  assert.equal(r.find((p) => p.student === 'a').award, 'special');
  assert.equal(r.find((p) => p.student === 'b').award, 'first');
  assert.equal(r.find((p) => p.student === 'c').award, undefined); // an old podium award is recomputed
  assert.equal(rankParticipants([{ student: 'x', score: 1 }], { winners: 0 })[0].award, undefined);
});

test('award text, winners and certificate targets', () => {
  assert.equal(awardText({ award: 'first' }), '1st Position');
  assert.equal(awardText({ award: 'special', awardTitle: ' Best Design ' }), 'Best Design');
  assert.equal(awardText({}), '');
  assert.ok(isWinner({ award: 'third' }) && isWinner({ award: 'special' }) && !isWinner({ award: 'participation' }) && !isWinner({}));
  const parts = [{ student: 'a', award: 'first' }, { student: 'b' }, { student: 'c', award: 'first', certificate: { code: 'NZC-1' } }];
  assert.deepEqual(certificateTargets(parts, 'winners'), [{ student: 'a', award: 'first' }]);
  assert.deepEqual(certificateTargets(parts, 'all'), [{ student: 'a', award: 'first' }, { student: 'b', award: 'participation' }]);
});

test('result messages', () => {
  assert.match(resultMessage({ award: 'first', rank: 1 }, 'Quiz Cup').title, /Congratulations! 1st Position in Quiz Cup/);
  assert.match(resultMessage({ rank: 7 }, 'Quiz Cup').body, /position 7/);
  assert.match(resultMessage({}, 'Quiz Cup').title, /Results are out/);
});

test('visibility: chosen students override batches', () => {
  assert.equal(visibleFor({}, { batch: null, student: 's1' }), true);                                  // everyone
  assert.equal(visibleFor({ batches: ['b1'] }, { batch: 'b1', student: 's1' }), true);
  assert.equal(visibleFor({ batches: ['b1'] }, { batch: 'b2', student: 's1' }), false);
  assert.equal(visibleFor({ students: ['s1', 's2'] }, { batch: null, student: 's1' }), true);
  assert.equal(visibleFor({ students: ['s1', 's2'] }, { batch: 'b1', student: 's3' }), false);        // hidden from the rest
  assert.equal(visibleFor({ students: ['s1'], batches: ['b1'] }, { batch: 'b1', student: 's2' }), false); // students win over batches
  assert.equal(visibleFor({ students: ['s1'] }, {}), false);
});
