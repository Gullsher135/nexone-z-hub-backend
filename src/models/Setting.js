import mongoose from 'mongoose';
import { DATE_RE } from '../utils/time.js';

// Single document holding organisation-wide rules.
const settingSchema = new mongoose.Schema(
  {
    organization: { type: String, default: 'NexoneZ' },
    weekendDays: { type: [Number], default: [0] }, // 0 = Sunday ... 6 = Saturday
    holidays: [
      {
        date: { type: String, match: DATE_RE, required: true },
        name: { type: String, trim: true },
      },
    ],
    office: {
      name: { type: String, default: 'NexoneZ Office' },
      lat: Number,
      lng: Number,
      radiusMeters: { type: Number, default: 150 },
      enforceGeofence: { type: Boolean, default: false },
    },
    allowedIps: { type: [String], default: [] },
    enforceIp: { type: Boolean, default: false },
    // When on, a device at the office reports the office's current public IP and it is allowed too.
    autoIpEnabled: { type: Boolean, default: false },
    autoIp: { ip: String, seenAt: Date },
    officeSyncKey: { type: String, default: '' }, // secret in the link opened on a device that stays at the office
    leaveQuota: { casual: { type: Number, default: 10, min: 0 }, sick: { type: Number, default: 8, min: 0 } }, // days per year
    requireQr: { type: Boolean, default: false }, // if true, button check-in is disabled
  },
  { timestamps: true }
);

export const Setting = mongoose.model('Setting', settingSchema);

export async function getSettings() {
  let s = await Setting.findOne();
  if (!s) s = await Setting.create({});
  return s;
}
