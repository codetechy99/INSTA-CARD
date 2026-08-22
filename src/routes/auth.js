const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { User, Wallet } = require('../models');
const { signToken, protect } = require('../middleware/auth');
const WalletEngine = require('../services/walletEngine');

const router = express.Router();

// Rate limit auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts, try again later' },
});

// POST /api/auth/signup
router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { email, phone, name, password, pin, country } = req.body;

    if (!email || !phone || !name || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const existingPhone = await User.findOne({ where: { phone } });
    if (existingPhone) return res.status(409).json({ error: 'Phone already registered' });

    const user = await User.create({
      email, phone, name,
      passwordHash: password,
      pinHash: pin ? await bcrypt.hash(pin, 12) : null,
      country: country || 'UG',
      status: 'active',
    });

    // Create default wallets
    const currencies = user.country === 'UG' ? ['UGX', 'USD'] :
                       user.country === 'KE' ? ['KES', 'USD'] :
                       user.country === 'TZ' ? ['TZS', 'USD'] : ['UGX', 'USD'];

    for (const currency of currencies) {
      await WalletEngine.createWallet(user.id, currency);
    }

    const token = signToken(user);

    res.status(201).json({
      status: 'success',
      token,
      user: user.toSafeJSON(),
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await User.findOne({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(423).json({ error: 'Account temporarily locked' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account not active' });
    }

    const valid = await user.comparePassword(password);
    if (!valid) {
      user.loginAttempts = (user.loginAttempts || 0) + 1;
      if (user.loginAttempts >= 5) {
        user.lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      }
      await user.save();
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    user.loginAttempts = 0;
    user.lockedUntil = null;
    user.lastLogin = new Date();
    await user.save();

    const token = signToken(user);

    res.json({
      status: 'success',
      token,
      user: user.toSafeJSON(),
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  try {
    const wallets = await Wallet.findAll({ where: { userId: req.userId } });
    res.json({
      status: 'success',
      user: req.user.toSafeJSON(),
      wallets: wallets.map((w) => ({
        currency: w.currency,
        balance: parseFloat(w.balance),
        pendingBalance: parseFloat(w.pendingBalance),
        status: w.status,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// PUT /api/auth/pin
router.put('/pin', protect, async (req, res) => {
  try {
    const { currentPin, newPin } = req.body;

    if (req.user.pinHash) {
      const valid = await bcrypt.compare(currentPin, req.user.pinHash);
      if (!valid) return res.status(401).json({ error: 'Current PIN is incorrect' });
    }

    if (!newPin || newPin.length < 4 || newPin.length > 6) {
      return res.status(400).json({ error: 'PIN must be 4-6 digits' });
    }

    req.user.pinHash = await bcrypt.hash(newPin, 12);
    await req.user.save();

    res.json({ status: 'success', message: 'PIN updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update PIN' });
  }
});

module.exports = router;
