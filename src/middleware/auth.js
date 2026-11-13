import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { HttpError, asyncHandler } from '../utils/helpers.js';
import { internExpired } from '../utils/attendanceCalc.js';

export const signToken = (user) =>
  jwt.sign({ id: user._id, role: user.role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

export const protect = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Not authenticated');

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw new HttpError(401, 'Session expired, please log in again');
  }

  const user = await User.findById(payload.id);
  if (!user || !user.isActive) throw new HttpError(401, 'Account is inactive');
  if (internExpired(user)) throw new HttpError(403, 'Your internship period has ended');

  req.user = user;
  next();
});

export const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) {
    return next(new HttpError(403, 'You do not have permission to do this'));
  }
  next();
};

export const adminOnly = requireRole('admin');
export const staffOnly = requireRole('employee', 'intern');
// Everyone who can work in the Learn module (what they can touch is still limited to their own courses).
export const teachRoles = requireRole('admin', 'employee', 'intern', 'teacher');
