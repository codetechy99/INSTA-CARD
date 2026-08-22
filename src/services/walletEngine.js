const { v4: uuidv4 } = require('uuid');
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
