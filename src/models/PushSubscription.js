import mongoose from 'mongoose';

// One row per browser/device that said yes to notifications. A person can have several (phone + laptop).
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
    userAgent: { type: String, maxlength: 300 },
  },
  { timestamps: true }
);

export const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);
