import mongoose from 'mongoose';

// The in-app inbox (the bell). Every notification is saved here first, so a person who missed the phone alert,
// had notifications blocked or was offline still finds it when they open the site.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, maxlength: 200 },
  body: { type: String, maxlength: 500 },
  url: { type: String, maxlength: 300 },
  tag: { type: String, maxlength: 80 }, // the same unread tag is updated instead of repeated
  readAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 }, // kept for 90 days
});
schema.index({ user: 1, createdAt: -1 });
schema.index({ user: 1, tag: 1, readAt: 1 });

export const Notification = mongoose.model('Notification', schema);
