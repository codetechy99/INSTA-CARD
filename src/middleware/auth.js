const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { User } = require('../models');

const signToken = (user) =>
  jwt.sign({ id: user.id, role: user.role }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

const protect = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const decoded = jwt.verify(header.split(' ')[1], config.jwt.secret);
    const user = await User.findByPk(decoded.id);
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'Account not found or suspended' });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(423).json({ error: 'Account temporarily locked' });
    }
    req.user = user;
    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

const requirePin = async (req, res, next) => {
  const { pin } = req.headers;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  const bcrypt = require('bcryptjs');
  const valid = await bcrypt.compare(pin, req.user.pinHash || '');
  if (!valid) {
    req.user.loginAttempts = (req.user.loginAttempts || 0) + 1;
    if (req.user.loginAttempts >= 5) {
      req.user.lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
    }
    await req.user.save();
    return res.status(401).json({ error: 'Invalid PIN' });
  }
  req.user.loginAttempts = 0;
  await req.user.save();
  next();
};

module.exports = { signToken, protect, authorize, requirePin };
