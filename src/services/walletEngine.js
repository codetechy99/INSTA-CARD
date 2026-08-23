const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const { sequelize, Wallet, Transaction, LedgerEntry } = require('../models');

class WalletEngine {
  /**
   * Create a wallet for a user in a given currency
   */
  static async createWallet(userId, currency = 'UGX') {
    const [wallet] = await Wallet.findOrCreate({
      where: { userId, currency },
      defaults: { userId, currency, balance: 0, pendingBalance: 0 },
    });
    return wallet;
  }

  /**
   * Get wallet balance (server-controlled, never trust frontend)
   */
  static async getBalance(userId, currency = 'UGX') {
    const wallet = await Wallet.findOne({ where: { userId, currency } });
    if (!wallet) return { balance: 0, pendingBalance: 0, currency };
    return {
      balance: parseFloat(wallet.balance),
      pendingBalance: parseFloat(wallet.pendingBalance),
      currency: wallet.currency,
    };
  }

  /**
   * Credit wallet (deposit) — with ledger entry
   * Only call this AFTER provider confirms payment
   */
  static async credit(userId, amount, { currency = 'UGX', type, description, provider, providerTxId, providerRaw, reference, metadata, ipAddress, userId: initiatingUser }) {
    const t = await sequelize.transaction();
    try {
      // Lock wallet row
      const wallet = await Wallet.findOne({
        where: { userId, currency },
        transaction: t,
        lock: true,
      });

      if (!wallet) throw new Error('Wallet not found');
      if (wallet.status !== 'active') throw new Error('Wallet is not active');

      const balanceBefore = parseFloat(wallet.balance);
      const balanceAfter = balanceBefore + parseFloat(amount);

      // Update balance
      await wallet.update({ balance: balanceAfter }, { transaction: t });

      // Create transaction record
      const tx = await Transaction.create({
        userId,
        walletId: wallet.id,
        type,
        status: 'completed',
        amount: parseFloat(amount),
        currency,
        fee: 0,
        tax: 0,
        netAmount: parseFloat(amount),
        description,
        provider,
        providerTransactionId: providerTxId,
        providerRaw,
        reference: reference || uuidv4(),
        metadata,
        ipAddress,
        initiatedBy: initiatingUser || userId,
        processedAt: new Date(),
        completedAt: new Date(),
      }, { transaction: t });

      // Create ledger entry
      await LedgerEntry.create({
        transactionId: tx.id,
        walletId: wallet.id,
        userId,
        type: 'credit',
        amount: parseFloat(amount),
        currency,
        balanceBefore,
        balanceAfter,
        description,
      }, { transaction: t });

      await t.commit();

      return { wallet, transaction: tx, newBalance: balanceAfter };
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  /**
   * Debit wallet (withdrawal/transfer) — with concurrency lock
   */
  static async debit(userId, amount, { currency = 'UGX', type, description, fee = 0, tax = 0, provider, providerTxId, counterpartyUserId, reference, metadata, ipAddress, userId: initiatingUser }) {
    const t = await sequelize.transaction();
    try {
      const wallet = await Wallet.findOne({
        where: { userId, currency },
        transaction: t,
        lock: true,
      });

      if (!wallet) throw new Error('Wallet not found');
      if (wallet.status !== 'active') throw new Error('Wallet is not active');

      const balanceBefore = parseFloat(wallet.balance);
      const totalDeduction = parseFloat(amount) + parseFloat(fee) + parseFloat(tax);

      if (balanceBefore < totalDeduction) {
        throw new Error(`Insufficient balance. Need ${totalDeduction}, have ${balanceBefore}`);
      }

      const balanceAfter = balanceBefore - totalDeduction;
      await wallet.update({ balance: balanceAfter }, { transaction: t });

      const tx = await Transaction.create({
        userId,
        walletId: wallet.id,
        type,
        status: 'completed',
        amount: parseFloat(amount),
        currency,
        fee: parseFloat(fee),
        tax: parseFloat(tax),
        netAmount: parseFloat(amount),
        description,
        provider,
        providerTransactionId: providerTxId,
        counterpartyUserId,
        reference: reference || uuidv4(),
        metadata,
        ipAddress,
        initiatedBy: initiatingUser || userId,
        processedAt: new Date(),
        completedAt: new Date(),
      }, { transaction: t });

      await LedgerEntry.create({
        transactionId: tx.id,
        walletId: wallet.id,
        userId,
        type: 'debit',
        amount: totalDeduction,
        currency,
        balanceBefore,
        balanceAfter,
        description,
      }, { transaction: t });

      await t.commit();
      return { wallet, transaction: tx, newBalance: balanceAfter };
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  /**
   * Internal transfer (InstaCard-to-InstaCard) — atomic two-sided
   */
  static async transfer(senderId, recipientId, amount, { currency = 'UGX', fee = 0, description, reference, ipAddress }) {
    const t = await sequelize.transaction();
    try {
      // Lock both wallets in consistent order to prevent deadlocks
      const [senderWallet, recipientWallet] = await Promise.all([
        Wallet.findOne({ where: { userId: senderId, currency }, transaction: t, lock: true }),
        Wallet.findOne({ where: { userId: recipientId, currency }, transaction: t, lock: true }),
      ]);

      if (!senderWallet) throw new Error('Sender wallet not found');
      if (!recipientWallet) throw new Error('Recipient wallet not found');
      if (senderWallet.status !== 'active') throw new Error('Sender wallet is not active');
      if (recipientWallet.status !== 'active') throw new Error('Recipient wallet is not active');

      const senderBalanceBefore = parseFloat(senderWallet.balance);
      const recipientBalanceBefore = parseFloat(recipientWallet.balance);
      const totalDeduction = parseFloat(amount) + parseFloat(fee);

      if (senderBalanceBefore < totalDeduction) {
        throw new Error(`Insufficient balance. Need ${totalDeduction}, have ${senderBalanceBefore}`);
      }

      const txRef = reference || uuidv4();

      // Debit sender
      await senderWallet.update({ balance: senderBalanceBefore - totalDeduction }, { transaction: t });

      // Credit recipient
      await recipientWallet.update({ balance: recipientBalanceBefore + parseFloat(amount) }, { transaction: t });

      // Create transaction records
      const senderTx = await Transaction.create({
        userId: senderId,
        walletId: senderWallet.id,
        type: 'transfer_out',
        status: 'completed',
        amount: parseFloat(amount),
        currency, fee: parseFloat(fee), tax: 0,
        netAmount: parseFloat(amount),
        description: description || 'Transfer sent',
        provider: 'internal',
        counterpartyUserId: recipientId,
        reference: txRef,
        initiatedBy: senderId,
        processedAt: new Date(),
        completedAt: new Date(),
      }, { transaction: t });

      await Transaction.create({
        userId: recipientId,
        walletId: recipientWallet.id,
        type: 'transfer_in',
        status: 'completed',
        amount: parseFloat(amount),
        currency, fee: 0, tax: 0,
        netAmount: parseFloat(amount),
        description: description || 'Transfer received',
        provider: 'internal',
        counterpartyUserId: senderId,
        reference: txRef,
        initiatedBy: senderId,
        processedAt: new Date(),
        completedAt: new Date(),
      }, { transaction: t });

      // Ledger entries
      await LedgerEntry.bulkCreate([
        {
          transactionId: senderTx.id, walletId: senderWallet.id, userId: senderId,
          type: 'debit', amount: totalDeduction, currency,
          balanceBefore: senderBalanceBefore, balanceAfter: senderBalanceBefore - totalDeduction,
          description: 'Transfer sent',
        },
        {
          transactionId: senderTx.id, walletId: recipientWallet.id, userId: recipientId,
          type: 'credit', amount: parseFloat(amount), currency,
          balanceBefore: recipientBalanceBefore, balanceAfter: recipientBalanceBefore + parseFloat(amount),
          description: 'Transfer received',
        },
      ], { transaction: t });

      await t.commit();
      return {
        senderTx,
        senderNewBalance: senderBalanceBefore - totalDeduction,
        recipientNewBalance: recipientBalanceBefore + parseFloat(amount),
      };
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  /**
   * Get transaction history for a user
   */
  static async getTransactions(userId, { type, status, limit = 20, offset = 0 } = {}) {
    const where = { userId };
    if (type) where.type = type;
    if (status) where.status = status;

    return Transaction.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  }

  /**
   * FX conversion — atomically debits one currency wallet and credits another.
   * Wallets are locked in id-order to prevent deadlocks between opposite-direction conversions.
   */
  static async convert(userId, amount, { from = 'UGX', to = 'USD', fee = 0, tax = 0, description, reference, ipAddress } = {}) {
    if (from === to) throw new Error('Cannot convert to the same currency');

    // Ensure destination wallet exists before locking anything
    await this.createWallet(userId, to);

    const t = await sequelize.transaction();
    try {
      // Resolve wallets first so we can lock them in consistent (id) order —
      // prevents deadlocks between users converting in opposite directions.
      const candidates = await Wallet.findAll({
        where: { userId, currency: { [Op.in]: [from, to] } },
      });
      const srcCandidate = candidates.find((w) => w.currency === from);
      const dstCandidate = candidates.find((w) => w.currency === to);
      if (!srcCandidate) throw new Error(`${from} wallet not found`);
      if (!dstCandidate) throw new Error(`${to} wallet could not be created`);

      const pairs = [
        ['source', srcCandidate.id],
        ['destination', dstCandidate.id],
      ].sort((a, b) => (a[1] < b[1] ? -1 : 1));

      const locked = {};
      for (const [key, id] of pairs) {
        locked[key] = await Wallet.findOne({ where: { id }, transaction: t, lock: true });
      }
      const srcWallet = locked.source;
      const dstWallet = locked.destination;

      if (!srcWallet || !dstWallet) throw new Error('Wallet lookup failed');
      if (srcWallet.status !== 'active' || dstWallet.status !== 'active') {
        throw new Error('Wallet is not active');
      }

      const srcBalanceBefore = parseFloat(srcWallet.balance);
      const dstBalanceBefore = parseFloat(dstWallet.balance);
      const amt = parseFloat(amount);
      const totalDeduction = amt + parseFloat(fee) + parseFloat(tax);

      if (srcBalanceBefore < totalDeduction) {
        throw new Error(`Insufficient balance. Need ${totalDeduction} ${from}, have ${srcBalanceBefore}`);
      }

      const { FXService } = require('./fxService');
      const quote = await FXService.convert(amt, from, to);

      // Rate sanity guard — a bad feed must never drain a wallet
      if (!quote.rate || !isFinite(quote.rate) || quote.rate <= 0) {
        throw new Error('Invalid exchange rate received');
      }
      if (from === to) throw new Error('Invalid conversion');
      const plausiblePairs = {
        USD_UGX: [1000, 8000], UGX_USD: [0.0001, 0.001],
        USD_KES: [80, 200], KES_USD: [0.005, 0.013],
        UGX_KES: [0.02, 0.06], KES_UGX: [16, 50],
        UGX_TZS: [0.4, 1.2], TZS_UGX: [0.8, 2.5],
        USD_TZS: [1500, 4000], TZS_USD: [0.00025, 0.0007],
      };
      const band = plausiblePairs[`${from}_${to}`];
      if (band && (quote.rate < band[0] || quote.rate > band[1])) {
        throw new Error(`Exchange rate out of expected range for ${from}/${to}`);
      }
      if (quote.amount <= 0) throw new Error('Conversion result is not positive');

      const txRef = reference || uuidv4();
      const srcBalanceAfter = srcBalanceBefore - totalDeduction;
      const dstBalanceAfter = dstBalanceBefore + quote.amount;

      await srcWallet.update({ balance: srcBalanceAfter }, { transaction: t });
      await dstWallet.update({ balance: dstBalanceAfter }, { transaction: t });

      const desc = description || `Converted ${amt} ${from} to ${quote.amount} ${to}`;

      // Debit leg (source currency)
      const srcTx = await Transaction.create({
        userId,
        walletId: srcWallet.id,
        type: 'fx_convert',
        status: 'completed',
        amount: amt,
        currency: from,
        fee: parseFloat(fee),
        tax: parseFloat(tax),
        netAmount: amt,
        description: desc,
        provider: 'internal',
        fxRate: quote.rate,
        fxCurrency: to,
        fxSourceAmount: amt,
        counterpartyUserId: userId,
        counterpartyWalletId: dstWallet.id,
        reference: txRef,
        metadata: { from, to, rate: quote.rate },
        ipAddress,
        initiatedBy: userId,
        processedAt: new Date(),
        completedAt: new Date(),
      }, { transaction: t });

      // Credit leg (destination currency)
      const dstTx = await Transaction.create({
        userId,
        walletId: dstWallet.id,
        type: 'fx_convert',
        status: 'completed',
        amount: quote.amount,
        currency: to,
        fee: 0,
        tax: 0,
        netAmount: quote.amount,
        description: desc,
        provider: 'internal',
        fxRate: quote.rate,
        fxCurrency: to,
        fxSourceAmount: amt,
        counterpartyUserId: userId,
        counterpartyWalletId: srcWallet.id,
        reference: txRef,
        metadata: { from, to, rate: quote.rate },
        ipAddress,
        initiatedBy: userId,
        processedAt: new Date(),
        completedAt: new Date(),
      }, { transaction: t });

      await LedgerEntry.bulkCreate([
        {
          transactionId: srcTx.id, walletId: srcWallet.id, userId,
          type: 'debit', amount: totalDeduction, currency: from,
          balanceBefore: srcBalanceBefore, balanceAfter: srcBalanceAfter,
          description: desc,
        },
        {
          transactionId: dstTx.id, walletId: dstWallet.id, userId,
          type: 'credit', amount: quote.amount, currency: to,
          balanceBefore: dstBalanceBefore, balanceAfter: dstBalanceAfter,
          description: desc,
        },
      ], { transaction: t });

      await t.commit();

      return {
        reference: txRef,
        sold: amt,
        bought: quote.amount,
        from,
        to,
        rate: quote.rate,
        fee: parseFloat(fee),
        tax: parseFloat(tax),
        sourceNewBalance: srcBalanceAfter,
        destinationNewBalance: dstBalanceAfter,
      };
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  /**
   * Get ledger entries for a wallet
   */
  static async getLedger(walletId, { limit = 50, offset = 0 } = {}) {
    return LedgerEntry.findAndCountAll({
      where: { walletId },
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  }
}

module.exports = WalletEngine;
