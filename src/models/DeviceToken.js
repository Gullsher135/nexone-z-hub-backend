import mongoose from 'mongoose';

// One row per phone that has the NexoneZ app (Firebase Cloud Messaging token).
const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, maxlength: 20 },
    lastOkAt: Date,
    lastError: { type: String, maxlength: 240 },
  },
  { timestamps: true }
);

export const DeviceToken = mongoose.model('DeviceToken', schema);
