import mongoose from 'mongoose';

// One row per reminder already sent, so a restart or a second server never sends the same reminder twice.
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  at: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 14 }, // forgotten after two weeks
});
export const ReminderLog = mongoose.model('ReminderLog', schema);

// true the first time a key is seen, false if it was already sent
export async function claim(key) {
  try {
    await ReminderLog.create({ key });
    return true;
  } catch (e) {
    if (e.code === 11000) return false;
    throw e;
  }
}
