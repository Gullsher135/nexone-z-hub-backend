// Who can see an assignment or quiz. Pure (no database), so it is easy to test.
const sid = (v) => String(v?._id || v);

// An assignment or quiz with no batches is for the whole course; otherwise only for the listed batches.
export const visibleForBatch = (item, batchId) =>
  !item.batches?.length || (!!batchId && item.batches.some((b) => sid(b) === sid(batchId)));

// Chosen students beat batches: an item with a student list is for exactly those students; otherwise the batch rule applies.
export const visibleFor = (item, { batch, student } = {}) =>
  item.students?.length ? !!student && item.students.some((s) => sid(s) === sid(student)) : visibleForBatch(item, batch);
