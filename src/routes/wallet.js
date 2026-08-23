const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { protect, requirePin } = require('../middleware/auth');
const { Wallet } = require('../models');
const WalletEngine = require('../services/walletEngine');
const FeeEngine = require('../services/feeEngine');
const FXService = require('../services/fxService');
const { getProvider } = require('../providers/registry');

const router = express.Router();

// GET /api/wallet/balance
router.get('/balance', protect, async (req, res) => {
  try {
    const wallets = await Wallet.findAll({ where: { userId: req.userId } });
    res.json({
      status: 'success',
      wallets: wallets.map((w) => ({
        currency: w.currency,
        balance: parseFloat(w.balance),
        pendingBalance: parseFloat(w.pendingBalance),
        status: w.status,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

// POST /api/wallet/deposit
router.post('/deposit', protect, async (req, res) => {
  try {
    const { amount, currency, phone, provider: providerName } = req.body;

    if (!amount || !providerName || !phone) {
      return res.status(400).json({ error: 'amount, provider, and phone are required' });
    }

    const amt = parseFloat(amount);
    if (amt <= 0) return res.status(400).json({ error: 'Amount must be positive' });

    // Calculate fees
    const feeResult = await FeeEngine.calculate('deposit', amt, currency);

    // Create pending transaction
    const reference = uuidv4();
    const t = await require('../config/database').transaction();

    try {
      // Initiate provider collection
      const provider = getProvider(providerName);
      const result = await provider.collect({
        amount: amt,
        currency: currency || 'UGX',
        phone,
        reference,
        callbackUrl: `${process.env.MTN_CALLBACK_URL || ''}?ref=${reference}`,
      });

      // Create pending transaction record
      const { Transaction } = require('../models');
      await Transaction.create({
        userId: req.userId,
        walletId: (await Wallet.findOne({ where: { userId: req.userId, currency: currency || 'UGX' } })).id,
        type: 'deposit',
        status: 'pending',
        amount: amt,
        currency: currency || 'UGX',
        fee: feeResult.fee,
        tax: feeResult.tax,
        netAmount: amt,
        description: `Deposit via ${providerName.toUpperCase()}`,
        provider: providerName,
        providerTransactionId: result.providerTxId,
        providerStatus: result.status,
        reference,
        metadata: { phone, providerResult: result.raw },
        ipAddress: req.ip,
        initiatedBy: req.userId,
      }, { transaction: t });

      await t.commit();

      // Check status immediately (for sandbox/testing)
      if (providerName === 'airtel') {
        setTimeout(async () => {
          try {
            const status = await provider.checkStatus(result.providerTxId);
            if (status.status === 'completed') {
              const { WebhookService } = require('../services/webhookService');
              await WebhookService.handleEvent(providerName, {
                eventId: result.providerTxId,
                providerTxId: reference,
                status: 'completed',
                providerRef: result.providerTxId,
                amount: amt,
                currency: currency || 'UGX',
                raw: status.raw,
              });
            }
          } catch (e) { /* ignore */ }
        }, 5000);
      }

      res.status(202).json({
        status: 'success',
        message: 'Deposit initiated',
        reference,
        providerTxId: result.providerTxId,
        amount: amt,
        currency: currency || 'UGX',
        fee: feeResult.fee,
        total: amt + feeResult.total,
      });
    } catch (err) {
      await t.rollback();
      throw err;
    }
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Deposit failed: ' + err.message });
  }
});

// POST /api/wallet/withdraw
router.post('/withdraw', protect, requirePin, async (req, res) => {
  try {
    const { amount, currency, phone, provider: providerName } = req.body;

    if (!amount || !providerName || !phone) {
      return res.status(400).json({ error: 'amount, provider, and phone are required' });
    }

    const amt = parseFloat(amount);
    if (amt <= 0) return res.status(400).json({ error: 'Amount must be positive' });

    // Calculate fees
    const feeResult = await FeeEngine.calculate('withdrawal', amt, currency);
    const totalDeduction = amt + feeResult.total;

    // Debit wallet first (pending state)
    const reference = uuidv4();
    const wallet = await Wallet.findOne({ where: { userId: req.userId, currency: currency || 'UGX' } });
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    if (parseFloat(wallet.balance) < totalDeduction) {
      return res.status(400).json({
        error: 'Insufficient balance',
        required: totalDeduction,
        available: parseFloat(wallet.balance),
      });
    }

    // Create pending + debit
    const { Transaction } = require('../models');
    const db = require('../config/database');
    const t = await db.transaction();

    try {
      const balanceBefore = parseFloat(wallet.balance);
      await wallet.update({ balance: balanceBefore - totalDeduction }, { transaction: t });

      const tx = await Transaction.create({
        userId: req.userId,
        walletId: wallet.id,
        type: 'withdrawal',
        status: 'processing',
        amount: amt,
        currency: currency || 'UGX',
        fee: feeResult.fee,
        tax: feeResult.tax,
        netAmount: amt,
        description: `Withdrawal via ${providerName.toUpperCase()}`,
        provider: providerName,
        reference,
        metadata: { phone, feeDetails: feeResult },
        ipAddress: req.ip,
        initiatedBy: req.userId,
      }, { transaction: t });

      await t.commit();

      // Initiate provider disbursement
      const provider = getProvider(providerName);
      const result = await provider.disburse({
        amount: amt,
        currency: currency || 'UGX',
        phone,
        reference,
        callbackUrl: `${process.env.MTN_CALLBACK_URL || ''}?ref=${reference}`,
      });

      await tx.update({
        providerTransactionId: result.providerTxId,
        providerStatus: result.status,
      });

      res.status(202).json({
        status: 'success',
        message: 'Withdrawal initiated',
        reference,
        providerTxId: result.providerTxId,
        amount: amt,
        currency: currency || 'UGX',
        fee: feeResult.fee,
        tax: feeResult.tax,
        totalDeduction,
        newBalance: balanceBefore - totalDeduction,
      });
    } catch (err) {
      await t.rollback();
      throw err;
    }
  } catch (err) {
    console.error('Withdrawal error:', err);
    res.status(500).json({ error: 'Withdrawal failed: ' + err.message });
  }
});

// POST /api/wallet/transfer
router.post('/transfer', protect, requirePin, async (req, res) => {
  try {
    const { recipientEmail, recipientPhone, amount, currency, description } = req.body;

    if (!amount || (!recipientEmail && !recipientPhone)) {
      return res.status(400).json({ error: 'Amount and recipient (email or phone) required' });
    }

    const amt = parseFloat(amount);
    if (amt <= 0) return res.status(400).json({ error: 'Amount must be positive' });

    // Find recipient
    const { User: UserModel } = require('../models');
    const recipient = recipientEmail
      ? await UserModel.findOne({ where: { email: recipientEmail } })
      : await UserModel.findOne({ where: { phone: recipientPhone } });

    if (!recipient) return res.status(404).json({ error: 'Recipient not found' });
    if (recipient.id === req.userId) return res.status(400).json({ error: 'Cannot transfer to yourself' });

    // Calculate fee
    const feeResult = await FeeEngine.calculate('transfer', amt, currency);

    // Execute transfer
    const result = await WalletEngine.transfer(req.userId, recipient.id, amt, {
      currency: currency || 'UGX',
      fee: feeResult.fee,
      description: description || `Transfer to ${recipient.name}`,
      ipAddress: req.ip,
    });

    res.json({
      status: 'success',
      message: 'Transfer completed',
      senderNewBalance: result.senderNewBalance,
      recipientName: recipient.name,
      amount: amt,
      currency: currency || 'UGX',
      fee: feeResult.fee,
    });
  } catch (err) {
    console.error('Transfer error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wallet/transactions
router.get('/transactions', protect, async (req, res) => {
  try {
    const { type, status, limit, offset } = req.query;
    const result = await WalletEngine.getTransactions(req.userId, { type, status, limit, offset });

    res.json({
      status: 'success',
      count: result.count,
      transactions: result.rows.map((tx) => ({
        id: tx.id,
        type: tx.type,
        status: tx.status,
        amount: parseFloat(tx.amount),
        currency: tx.currency,
        fee: parseFloat(tx.fee),
        tax: parseFloat(tx.tax),
        description: tx.description,
        provider: tx.provider,
        createdAt: tx.createdAt,
        completedAt: tx.completedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

// POST /api/wallet/fx/quote
router.post('/fx/quote', protect, async (req, res) => {
  try {
    const { fromCurrency, toCurrency, amount } = req.body;
    if (!fromCurrency || !toCurrency || !amount) {
      return res.status(400).json({ error: 'fromCurrency, toCurrency, and amount required' });
    }

    const quote = await FXService.convert(amount, fromCurrency, toCurrency);
    const feeResult = await FeeEngine.calculate('fx', amount, fromCurrency);

    res.json({
      status: 'success',
      from: { currency: fromCurrency, amount: parseFloat(amount) },
      to: { currency: toCurrency, amount: quote.amount },
      rate: quote.rate,
      fee: feeResult.fee,
      netAmount: quote.amount - feeResult.fee,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get FX quote' });
  }
});

// POST /api/wallet/fx/convert — execute a currency conversion
router.post('/fx/convert', protect, requirePin, async (req, res) => {
  try {
    const { amount, fromCurrency, toCurrency } = req.body;
    if (!amount || !fromCurrency || !toCurrency) {
      return res.status(400).json({ error: 'amount, fromCurrency, and toCurrency required' });
    }
    if (fromCurrency === toCurrency) {
      return res.status(400).json({ error: 'Cannot convert to the same currency' });
    }

    const amt = parseFloat(amount);
    if (amt <= 0) return res.status(400).json({ error: 'Amount must be positive' });

    // Quote + fee up front so the user is charged exactly what a quote promised
    const feeResult = await FeeEngine.calculate('fx', amt, fromCurrency);

    const result = await WalletEngine.convert(req.userId, amt, {
      from: fromCurrency,
      to: toCurrency,
      fee: feeResult.fee,
      tax: feeResult.tax,
      ipAddress: req.ip,
    });

    res.json({ status: 'success', message: 'Conversion completed', ...result });
  } catch (err) {
    console.error('FX convert error:', err);
    const msg = /Insufficient balance|not active|wallet/i.test(err.message)
      ? err.message
      : 'Conversion failed';
    res.status(err.message.includes('Insufficient') ? 400 : 500).json({ error: msg });
  }
});

module.exports = router;
