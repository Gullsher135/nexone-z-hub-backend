import { User } from '../models/User.js';
import { signToken } from '../middleware/auth.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { internExpired } from '../utils/attendanceCalc.js';

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new HttpError(400, 'Email and password are required');

  const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    throw new HttpError(401, 'Invalid email or password');
  }
  if (user.role === 'student') throw new HttpError(403, 'Students do not have login access');
  if (!user.isActive) throw new HttpError(403, 'Your account has been deactivated');
  if (internExpired(user)) throw new HttpError(403, 'Your internship period has ended');

  res.json({ token: signToken(user), user });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user });
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    throw new HttpError(400, 'Current and new password are required');
  }
  if (String(newPassword).length < 8) {
    throw new HttpError(400, 'New password must be at least 8 characters');
  }
  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(currentPassword))) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  user.password = newPassword;
  user.mustChangePassword = false;
  await user.save();
  res.json({ message: 'Password updated' });
});
