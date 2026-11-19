import mongoose from 'mongoose';
import { StoredFile } from '../models/lms.js';
import { deleteStoredFiles, readFile, saveFile } from '../utils/fileStore.js';
import { courseAccess } from './lms.controller.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';

// Files live in the database (assignment briefs and student work), so nothing is lost when the
// server restarts. Any format is accepted; downloads are always sent as attachments, never opened in the page.
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB each
const MAX_LOOSE = 20; // uploaded but not yet saved on an assignment or submission

const cleanName = (n) => String(n || 'file').replace(/[\\/<>:"|?*\u0000-\u001f]+/g, '_').trim().slice(0, 150) || 'file';
const cleanMime = (m) => (/^[\w.+-]+\/[\w.+-]+$/.test(String(m || '')) ? String(m).toLowerCase().slice(0, 120) : 'application/octet-stream');

// POST /lms/files?course=ID&kind=submission|assignment&name=...&type=...   (raw file bytes in the body)
export const uploadFile = asyncHandler(async (req, res) => {
  const course = String(req.query.course || '');
  if (!mongoose.isValidObjectId(course)) throw new HttpError(400, 'Course is required');
  const kind = req.query.kind === 'assignment' ? 'assignment' : 'submission';
  const { manage } = await courseAccess(req, course);
  if (kind === 'assignment' && !manage) throw new HttpError(403, 'Only teachers attach files to an assignment');
  if (kind === 'submission' && req.user.role !== 'student') throw new HttpError(403, 'Only students upload their work');

  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, 'Choose a file to upload');
  if (buf.length > MAX_FILE_BYTES) throw new HttpError(413, 'File is too large. The limit is 10 MB.');

  // Uploads that were never saved on anything are removed after a day.
  await deleteStoredFiles({ attached: false, createdAt: { $lt: new Date(Date.now() - 24 * 3600 * 1000) } });
  if ((await StoredFile.countDocuments({ owner: req.user._id, attached: false })) >= MAX_LOOSE) {
    throw new HttpError(400, 'Too many unsent files. Submit your work first or try again tomorrow.');
  }
  let doc;
  try {
    doc = await saveFile({ _id: new mongoose.Types.ObjectId(), course, owner: req.user._id, kind, name: cleanName(req.query.name), mime: cleanMime(req.query.type), buffer: buf });
  } catch (err) {
    if (err.name === 'ValidationError') throw err;
    throw new HttpError(502, 'The file could not be saved to storage. Please try again in a moment.');
  }
  res.status(201).json({ file: { file: doc._id, name: doc.name, size: doc.size, mime: doc.mime } });
});

// GET /lms/files/:id
export const downloadFile = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'File not found');
  const f = await StoredFile.findById(req.params.id).select('+data');
  if (!f) throw new HttpError(404, 'File not found');
  const { manage } = await courseAccess(req, f.course); // course teachers, admin and enrolled students only
  const mine = String(f.owner) === String(req.user._id);
  if (f.kind === 'submission' && !manage && !mine) throw new HttpError(403, 'Not allowed');
  const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Content-Length': String(f.size),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  let bytes;
  try { bytes = await readFile(f); } catch { throw new HttpError(502, 'The file could not be read from storage. Please try again in a moment.'); }
  if (!bytes) throw new HttpError(404, 'The file is missing from storage');
  res.send(bytes);
});
