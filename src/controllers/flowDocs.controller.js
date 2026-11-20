import mongoose from 'mongoose';
import { Project, ProjectDoc, WorkItem } from '../models/flow.js';
import { StoredFile } from '../models/lms.js';
import { deleteStoredFiles, readFile, saveFile } from '../utils/fileStore.js';
import { s3Enabled } from '../utils/storage.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { DOC_CATEGORIES } from '../utils/flowKinds.js';
import { notifyUsers } from '../utils/push.js';
import { logActivity } from '../utils/activity.js';
import { audit } from '../utils/audit.js';
import { canManage, isMember } from './flow.controller.js';

// Project documents: any file type up to 10 MB each, kept in free object storage when the S3_* settings are filled in,
// otherwise in MongoDB (then a total limit protects the free database). Downloads are always sent as attachments.
export const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_DOCS_PER_PROJECT = 150;
const MAX_DB_TOTAL_MB = Number(process.env.MAX_DB_DOCS_MB) || 250;

const sid = (v) => String(v?._id || v);
const cleanName = (n) => String(n || 'file').replace(/[\\/<>:"|?*\u0000-\u001f]+/g, '_').trim().slice(0, 150) || 'file';
const cleanMime = (m) => (/^[\w.+-]+\/[\w.+-]+$/.test(String(m || '')) ? String(m).toLowerCase().slice(0, 120) : 'application/octet-stream');
const withoutExt = (n) => n.replace(/\.[A-Za-z0-9]{1,8}$/, '');

async function projectFor(req, { manage = false } = {}) {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Project not found');
  const p = await Project.findById(req.params.id).lean();
  if (!p) throw new HttpError(404, 'Project not found');
  if (!isMember(p, req.user)) throw new HttpError(403, 'You are not part of this project');
  if (manage && !canManage(p, req.user)) throw new HttpError(403, 'Only the admin or project lead can do this');
  return p;
}

const view = (d) => ({
  _id: d._id, title: d.title, category: d.category, note: d.note, name: d.name, size: d.size, mime: d.mime, createdAt: d.createdAt,
  uploadedBy: d.uploadedBy ? { _id: d.uploadedBy._id, name: d.uploadedBy.name } : null,
});

export const listDocs = asyncHandler(async (req, res) => {
  const p = await projectFor(req);
  // the Documents tab shows project documents; a card asks for its own attachments with ?item=
  const itemId = mongoose.isValidObjectId(req.query.item) ? req.query.item : null;
  const docs = await ProjectDoc.find({ project: p._id, item: itemId || { $exists: false } }).populate('uploadedBy', 'name').sort({ createdAt: -1 }).lean();
  res.json({
    items: docs.map(view),
    totalBytes: docs.reduce((s, d) => s + (d.size || 0), 0),
    storage: s3Enabled() ? 'bucket' : 'database',
    maxMb: MAX_DOC_BYTES / 1024 / 1024,
  });
});

// POST /flow/projects/:id/documents?name=...&type=...&title=...&category=...&note=...   (raw file bytes in the body)
export const uploadDoc = asyncHandler(async (req, res) => {
  const p = await projectFor(req);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, 'Choose a file to upload');
  if (buf.length > MAX_DOC_BYTES) throw new HttpError(413, 'File is too large. The limit is 10 MB.');
  if ((await ProjectDoc.countDocuments({ project: p._id })) >= MAX_DOCS_PER_PROJECT) throw new HttpError(400, `A project can hold ${MAX_DOCS_PER_PROJECT} documents. Remove old ones first.`);
  if (!s3Enabled()) {
    const used = await StoredFile.aggregate([{ $match: { kind: 'project', storage: 'mongo' } }, { $group: { _id: null, n: { $sum: '$size' } } }]);
    if (((used[0]?.n || 0) + buf.length) / 1024 / 1024 > MAX_DB_TOTAL_MB) throw new HttpError(507, `The database storage for documents is full (${MAX_DB_TOTAL_MB} MB). Connect free object storage (S3_* settings) or delete old documents.`);
  }
  let itemId;
  if (req.query.item) {
    if (!mongoose.isValidObjectId(req.query.item) || !(await WorkItem.exists({ _id: req.query.item, project: p._id }))) throw new HttpError(400, 'That card was not found in this project');
    itemId = req.query.item;
  }
  const name = cleanName(req.query.name);
  const title = String(req.query.title || '').trim().slice(0, 140) || withoutExt(name).slice(0, 140) || 'Document';
  const category = DOC_CATEGORIES.includes(req.query.category) ? req.query.category : 'other';
  const note = String(req.query.note || '').trim().slice(0, 500) || undefined;

  let stored;
  try {
    stored = await saveFile({ _id: new mongoose.Types.ObjectId(), project: p._id, owner: req.user._id, kind: 'project', name, mime: cleanMime(req.query.type), buffer: buf, attached: true });
  } catch (err) {
    if (err.name === 'ValidationError') throw err;
    throw new HttpError(502, 'The file could not be saved to storage. Please try again in a moment.');
  }
  const doc = await ProjectDoc.create({ project: p._id, item: itemId, title, category, note, file: stored._id, name: stored.name, size: stored.size, mime: stored.mime, uploadedBy: req.user._id });

  const team = [p.lead, ...(p.members || [])].filter(Boolean);
  const urls = { admin: `/admin/flow/projects/${p._id}?tab=documents`, staff: `/flow/projects/${p._id}?tab=documents` };
  logActivity(p, req.user, itemId ? `attached "${title}" to a card` : `uploaded the document "${title}"`, { item: itemId });
  if (!itemId) notifyUsers(team, { title: `New document in ${p.name}`, body: `${req.user.name} uploaded "${title}"`, tag: `doc-${doc._id}`, urls }, { exclude: req.user._id });
  res.status(201).json({ doc: view({ ...doc.toObject(), uploadedBy: { _id: req.user._id, name: req.user.name } }) });
});

async function ownDoc(req) {
  if (!mongoose.isValidObjectId(req.params.docId)) throw new HttpError(404, 'Document not found');
  const doc = await ProjectDoc.findById(req.params.docId);
  if (!doc) throw new HttpError(404, 'Document not found');
  const p = await Project.findById(doc.project).lean();
  if (!p || !isMember(p, req.user)) throw new HttpError(403, 'You are not part of this project');
  return { doc, p, owner: sid(doc.uploadedBy) === sid(req.user._id), manage: canManage(p, req.user) };
}

export const downloadDoc = asyncHandler(async (req, res) => {
  const { doc } = await ownDoc(req);
  const f = await StoredFile.findById(doc.file).select('+data');
  if (!f) throw new HttpError(404, 'The file is missing from storage');
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

export const updateDoc = asyncHandler(async (req, res) => {
  const { doc, owner, manage } = await ownDoc(req);
  if (!owner && !manage) throw new HttpError(403, 'Only the uploader, the project lead or the admin can edit this');
  const b = req.body || {};
  if (b.title !== undefined) { if (!String(b.title).trim()) throw new HttpError(400, 'Give the document a title'); doc.title = String(b.title).trim().slice(0, 140); }
  if (b.category !== undefined) { if (!DOC_CATEGORIES.includes(b.category)) throw new HttpError(400, 'Invalid category'); doc.category = b.category; }
  if (b.note !== undefined) doc.note = String(b.note || '').trim().slice(0, 500) || undefined;
  await doc.save();
  res.json({ doc: view(doc) });
});

export const deleteDoc = asyncHandler(async (req, res) => {
  const { doc, owner, manage } = await ownDoc(req);
  if (!owner && !manage) throw new HttpError(403, 'Only the uploader, the project lead or the admin can delete this');
  await deleteStoredFiles({ _id: doc.file });
  await doc.deleteOne();
  logActivity(doc.project, req.user, `deleted the document "${doc.title}"`);
  audit(req, 'flow.doc.delete', { entity: 'ProjectDoc', entityId: doc._id, summary: `Deleted document "${doc.title}"` });
  res.json({ message: 'Deleted' });
});

// Used when a card is deleted: removes its attachments.
export async function removeItemDocs(itemId) {
  const docs = await ProjectDoc.find({ item: itemId }).select('file').lean();
  if (!docs.length) return;
  await deleteStoredFiles({ _id: { $in: docs.map((d) => d.file) } });
  await ProjectDoc.deleteMany({ item: itemId });
}

// Used when a project is deleted: removes every document and its stored file.
export async function removeProjectDocs(projectId) {
  await deleteStoredFiles({ project: projectId, kind: 'project' });
  await ProjectDoc.deleteMany({ project: projectId });
}

