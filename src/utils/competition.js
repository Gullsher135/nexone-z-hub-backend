// Rules for competitions: ranking, awards and certificates. Pure (no database), so they are easy to test.
export const AWARDS = ['first', 'second', 'third', 'special', 'participation'];
export const AWARD_LABEL = { first: '1st Position', second: '2nd Position', third: '3rd Position', special: 'Special Award', participation: 'Participation' };
const PODIUM = ['first', 'second', 'third'];

// What the certificate and the leaderboard say: a custom title (for example "Best Design") or the standard label.
export const awardText = (p) => String(p?.awardTitle || '').trim() || AWARD_LABEL[p?.award] || '';

// A winner has a podium or special award; participation is not a win.
export const isWinner = (p) => ['first', 'second', 'third', 'special'].includes(p?.award);

// Ranks by score, highest first. Equal scores share a rank (1, 1, 3). People without a score get no rank.
// The top `winners` ranks (at most 3) receive 1st, 2nd and 3rd; special and participation awards are left alone.
export function rankParticipants(participants, { winners = 3 } = {}) {
  const top = Math.min(3, Math.max(0, Math.floor(Number(winners) || 0)));
  const scored = participants.filter((p) => Number.isFinite(p.score)).map((p) => p.score);
  return participants.map((p) => {
    const out = { ...p };
    if (!Number.isFinite(p.score)) { delete out.rank; return out; }
    out.rank = 1 + scored.filter((s) => s > p.score).length;
    const auto = !p.award || PODIUM.includes(p.award);
    if (auto) out.award = out.rank <= top ? PODIUM[out.rank - 1] : undefined;
    return out;
  });
}

// Who gets a certificate: winners only, or everyone (people without an award get a participation certificate).
export function certificateTargets(participants, include) {
  return participants.filter((p) => !p.certificate?.code && (include === 'all' || isWinner(p)))
    .map((p) => ({ student: p.student, award: p.award || 'participation' }));
}

// The message a student gets when results are published.
export function resultMessage(p, title) {
  if (isWinner(p)) return { title: `Congratulations! ${awardText(p)} in ${title}`, body: p.rank ? `You finished at position ${p.rank}. Well done!` : 'Well done!' };
  if (p.rank) return { title: `Results are out: ${title}`, body: `You finished at position ${p.rank}.` };
  return { title: `Results are out: ${title}`, body: 'Open Competitions to see the results.' };
}
