// "@Sara" or "@Sara Khan" in a comment notifies that teammate. Pure, so it is easy to test.
const isWordChar = (c) => !!c && /[\p{L}\p{N}_]/u.test(c);

function hasMention(text, handle) {
  const needle = `@${handle}`;
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i === -1) return false;
    if (!isWordChar(text[i + needle.length])) return true; // "@Ali" must not match "@Alice"
    from = i + 1;
  }
}

// people: [{ _id, name }]. A full name always matches; a first name only when it is unique in the team.
export function extractMentions(text, people) {
  const t = String(text || '').toLowerCase();
  if (!t.includes('@')) return [];
  const firstCount = new Map();
  for (const p of people) {
    const first = String(p.name || '').trim().toLowerCase().split(/\s+/)[0];
    if (first) firstCount.set(first, (firstCount.get(first) || 0) + 1);
  }
  const out = [];
  for (const p of people) {
    const full = String(p.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const first = full.split(' ')[0];
    if ((full && hasMention(t.replace(/\s+/g, ' '), full)) || (first && firstCount.get(first) === 1 && hasMention(t, first))) out.push(String(p._id));
  }
  return out;
}
