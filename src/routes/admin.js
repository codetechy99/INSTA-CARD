const express = require('express');
const bcrypt = require('bcryptjs');
const { protect, authorize } = require('../middleware/auth');
const { User, Wallet, Transaction, LedgerEntry, WebhookEvent, FeeConfig, ProviderConfig, sequelize } = require('../models');
const WalletEngine = require('../services/walletEngine');
const { getProvider } = require('../providers/registry');

const router = express.Router();

// All admin routes require auth + admin role
router.use(protect, authorize('admin', 'super_admin'));

// GET /api/admin/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const [userCount, walletCount, txStats, pendingTx] = await Promise.all([
      User.count(),
      Wallet.count(),
      Transaction.findAll({
        attributes: [
          'type',
          'status',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          [sequelize.fn('SUM', sequelize.col('amount')), 'total'],
        ],
        group: ['type', 'status'],
        raw: true,
      }),
      Transaction.count({ where: { status: 'pending' } }),
    ]);

    const totalBalance = await Wallet.sum('balance');

    res.json({
      status: 'success',
      dashboard: {
        users: userCount,
        wallets: walletCount,
        totalBalance: parseFloat(totalBalance || 0),
        pendingTransactions: pendingTx,
        transactionStats: txStats.map((s) => ({
          type: s.type,
          status: s.status,
          count: parseInt(s.count),
          total: parseFloat(s.total),
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get dashboard' });
  }
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const { limit, offset, search } = req.query;
    const where = {};
    if (search) {
      const { Op } = require('sequelize');
      where[Op.or] = [
        { email: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
        { name: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const users = await User.findAndCountAll({
      where,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
      order: [['createdAt', 'DESC']],
    });

    res.json({
      status: 'success',
      count: users.count,
      users: users.rows.map((u) => u.toSafeJSON()),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// PUT /api/admin/users/:id/status
router.put('/users/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.status = status;
    await user.save();

    res.json({ status: 'success', user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// POST /api/admin/adjust/:userId
router.post('/adjust/:userId', async (req, res) => {
  try {
    const { amount, currency, description } = req.body;

    if (!amount || !description) {
      return res.status(400).json({ error: 'amount and description required' });
    }

    const result = await WalletEngine.credit(req.params.userId, parseFloat(amount), {
      currency: currency || 'UGX',
      type: 'adjustment',
      description: `Admin adjustment: ${description}`,
      userId: req.userId,
    });

    res.json({
      status: 'success',
      newBalance: result.newBalance,
      transaction: result.transaction,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/transactions
router.get('/transactions', async (req, res) => {
  try {
    const { limit, offset, status, type, userId, provider } = req.query;
    const where = {};
    if (status) where.status = status;
    if (type) where.type = type;
    if (userId) where.userId = userId;
    if (provider) where.provider = provider;

    const txs = await Transaction.findAndCountAll({
      where,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
      order: [['createdAt', 'DESC']],
      include: [{ model: User, attributes: ['id', 'email', 'phone', 'name'] }],
    });

    res.json({
      status: 'success',
      count: txs.count,
      transactions: txs.rows.map((tx) => ({
        id: tx.id,
        userId: tx.userId,
        user: tx.User ? { email: tx.User.email, phone: tx.User.phone, name: tx.User.name } : null,
        type: tx.type,
        status: tx.status,
        amount: parseFloat(tx.amount),
        currency: tx.currency,
        fee: parseFloat(tx.fee),
        provider: tx.provider,
        reference: tx.reference,
        createdAt: tx.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

// GET /api/admin/webhooks
router.get('/webhooks', async (req, res) => {
  try {
    const events = await WebhookEvent.findAll({
      limit: 50,
      order: [['createdAt', 'DESC']],
    });

    res.json({
      status: 'success',
      events: events.map((e) => ({
        id: e.id,
        provider: e.provider,
        eventId: e.eventId,
        eventType: e.eventType,
        status: e.status,
        processedAt: e.processedAt,
        error: e.error,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get webhooks' });
  }
});

// GET /api/admin/providers
router.get('/providers', async (req, res) => {
  try {
    const providerStatus = {};
    for (const name of ['mtn', 'airtel']) {
      try {
        const p = getProvider(name);
        const healthy = await p.healthCheck();
        providerStatus[name] = { healthy, name };
      } catch {
        providerStatus[name] = { healthy: false, name };
      }
    }

    res.json({ status: 'success', providers: providerStatus });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check providers' });
  }
});

// GET /api/admin/fees
router.get('/fees', async (req, res) => {
  try {
    const fees = await FeeConfig.findAll({ order: [['currency', 'ASC'], ['name', 'ASC']] });
    res.json({
      status: 'success',
      fees: fees.map((f) => ({
        id: f.id, name: f.name, type: f.type,
        value: parseFloat(f.value), minFee: parseFloat(f.minFee),
        maxFee: parseFloat(f.maxFee), currency: f.currency,
        country: f.country, isActive: f.isActive,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get fees' });
  }
});

// PUT /api/admin/fees/:id
router.put('/fees/:id', async (req, res) => {
  try {
    const fee = await FeeConfig.findByPk(req.params.id);
    if (!fee) return res.status(404).json({ error: 'Fee config not found' });

    await fee.update(req.body);
    res.json({ status: 'success', fee: fee.toJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update fee' });
  }
});

module.exports = router;
