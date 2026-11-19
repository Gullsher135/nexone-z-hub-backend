import { StoredFile } from '../models/lms.js';
import { deleteObject, getObject, putObject, s3Enabled } from './storage.js';

// One place that knows whether a file lives in the bucket or in MongoDB.

export async function saveFile({ _id, course, owner, kind, name, mime, buffer }) {
  if (!s3Enabled()) return StoredFile.create({ _id, course, owner, kind, name, mime, size: buffer.length, data: buffer, storage: 'mongo' });
  const key = `${kind}/${course}/${_id}`;
  await putObject(key, buffer, { contentType: mime, filename: name });
  try {
    return await StoredFile.create({ _id, course, owner, kind, name, mime, size: buffer.length, storage: 's3', key });
  } catch (err) {
    await deleteObject(key).catch(() => {}); // do not leave an orphan in the bucket
    throw err;
  }
}

export async function readFile(doc) {
  if (doc.storage === 's3') {
    const buf = await getObject(doc.key);
    if (!buf) return null;
    return buf;
  }
  return doc.data ? Buffer.from(doc.data) : null;
}

// Deletes the database rows and, for bucket files, the stored objects too.
export async function deleteStoredFiles(filter) {
  const rows = await StoredFile.find(filter).select('storage key').lean();
  await Promise.allSettled(rows.filter((r) => r.storage === 's3').map((r) => deleteObject(r.key)));
  await StoredFile.deleteMany(filter);
}
