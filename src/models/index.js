const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ============================================
// USERS
// ============================================
const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  email: { type: DataTypes.STRING, allowNull: false, unique: true, lowercase: true },
  phone: { type: DataTypes.STRING, allowNull: false, unique: true },
  name: { type: DataTypes.STRING, allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  pinHash: { type: DataTypes.STRING },
  role: { type: DataTypes.ENUM('user', 'admin', 'super_admin'), defaultValue: 'user' },
  status: { type: DataTypes.ENUM('active', 'suspended', 'pending_kyc'), defaultValue: 'active' },
  kycLevel: { type: DataTypes.ENUM('none', 'basic', 'full'), defaultValue: 'none' },
  country: { type: DataTypes.STRING, defaultValue: 'UG' },
  defaultCurrency: { type: DataTypes.STRING, defaultValue: 'UGX' },
  lastLogin: { type: DataTypes.DATE },
  loginAttempts: { type: DataTypes.INTEGER, defaultValue: 0 },
  lockedUntil: { type: DataTypes.DATE },
}, {
  tableName: 'users',
  hooks: {
    beforeCreate: async (user) => {
      if (user.passwordHash) user.passwordHash = await bcrypt.hash(user.passwordHash, 12);
    },
    beforeUpdate: async (user) => {
      if (user.changed('passwordHash')) user.passwordHash = await bcrypt.hash(user.passwordHash, 12);
    },
  },
});

User.prototype.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

User.prototype.toSafeJSON = function () {
  const obj = this.toJSON();
  delete obj.passwordHash;
  delete obj.pinHash;
  delete obj.loginAttempts;
  delete obj.lockedUntil;
  return obj;
};

// ============================================
// WALLETS (multi-currency)
// ============================================
const Wallet = sequelize.define('Wallet', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false, references: { model: User, key: 'id' } },
  currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'UGX' },
  balance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  pendingBalance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.ENUM('active', 'frozen', 'closed'), defaultValue: 'active' },
}, {
  tableName: 'wallets',
  indexes: [
    { unique: true, fields: ['user_id', 'currency'] },
  ],
});

// ============================================
// TRANSACTIONS (immutable ledger)
// ============================================
const Transaction = sequelize.define('Transaction', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false, references: { model: User, key: 'id' } },
  walletId: { type: DataTypes.UUID, allowNull: false, references: { model: Wallet, key: 'id' } },
  type: {
    type: DataTypes.ENUM('deposit', 'withdrawal', 'transfer_in', 'transfer_out', 'airtime', 'bill_pay', 'fx_convert', 'savings_in', 'savings_out', 'fee', 'refund', 'adjustment'),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed', 'reversed', 'cancelled'),
    defaultValue: 'pending',
  },
  amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'UGX' },
  fee: { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  tax: { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  netAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  description: { type: DataTypes.TEXT },

  // Provider tracking
  provider: { type: DataTypes.STRING }, // 'mtn', 'airtel', 'internal', 'card'
  providerTransactionId: { type: DataTypes.STRING },
  providerStatus: { type: DataTypes.STRING },
  providerRaw: { type: DataTypes.JSONB },

  // Transfer tracking
  counterpartyUserId: { type: DataTypes.UUID, references: { model: User, key: 'id' } },
  counterpartyWalletId: { type: DataTypes.UUID },

  // FX tracking
  fxRate: { type: DataTypes.DECIMAL(12, 6) },
  fxCurrency: { type: DataTypes.STRING(3) },
  fxSourceAmount: { type: DataTypes.DECIMAL(18, 2) },

  // Metadata
  reference: { type: DataTypes.STRING, unique: true }, // idempotency key
  metadata: { type: DataTypes.JSONB },
  ipAddress: { type: DataTypes.STRING },
  userAgent: { type: DataTypes.STRING },

  // Audit
  initiatedBy: { type: DataTypes.UUID, references: { model: User, key: 'id' } },
  processedAt: { type: DataTypes.DATE },
  completedAt: { type: DataTypes.DATE },
}, {
  tableName: 'transactions',
  indexes: [
    { fields: ['user_id', 'status'] },
    { fields: ['provider', 'provider_transaction_id'] },
    { fields: ['reference'] },
    { fields: ['created_at'] },
    { fields: ['counterparty_user_id'] },
  ],
});

// ============================================
// LEDGER ENTRIES (double-entry bookkeeping)
// ============================================
const LedgerEntry = sequelize.define('LedgerEntry', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  transactionId: { type: DataTypes.UUID, allowNull: false, references: { model: Transaction, key: 'id' } },
  walletId: { type: DataTypes.UUID, allowNull: false, references: { model: Wallet, key: 'id' } },
  userId: { type: DataTypes.UUID, allowNull: false, references: { model: User, key: 'id' } },
  type: { type: DataTypes.ENUM('debit', 'credit'), allowNull: false },
  amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  currency: { type: DataTypes.STRING(3), allowNull: false },
  balanceBefore: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  balanceAfter: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  description: { type: DataTypes.TEXT },
}, {
  tableName: 'ledger_entries',
  indexes: [
    { fields: ['wallet_id', 'created_at'] },
    { fields: ['transaction_id'] },
  ],
});

// ============================================
// WEBHOOK EVENTS (idempotency log)
// ============================================
const WebhookEvent = sequelize.define('WebhookEvent', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  provider: { type: DataTypes.STRING, allowNull: false },
  eventId: { type: DataTypes.STRING, allowNull: false, unique: true },
  eventType: { type: DataTypes.STRING },
  payload: { type: DataTypes.JSONB },
  status: { type: DataTypes.ENUM('received', 'processing', 'processed', 'failed', 'duplicate'), defaultValue: 'received' },
  processedAt: { type: DataTypes.DATE },
  error: { type: DataTypes.TEXT },
}, {
  tableName: 'webhook_events',
  indexes: [{ fields: ['provider', 'event_id'], unique: true }],
});

// ============================================
// FEE CONFIGURATION
// ============================================
const FeeConfig = sequelize.define('FeeConfig', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  type: { type: DataTypes.ENUM('percentage', 'fixed', 'tiered'), allowNull: false },
  value: { type: DataTypes.DECIMAL(10, 4), allowNull: false },
  minAmount: { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  maxAmount: { type: DataTypes.DECIMAL(18, 2) },
  minFee: { type: DataTypes.DECIMAL(18, 2), defaultValue: 0 },
  maxFee: { type: DataTypes.DECIMAL(18, 2) },
  currency: { type: DataTypes.STRING(3), defaultValue: 'UGX' },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  country: { type: DataTypes.STRING(2), defaultValue: 'UG' },
}, { tableName: 'fee_configs' });

// ============================================
// PROVIDER CONFIGURATION
// ============================================
const ProviderConfig = sequelize.define('ProviderConfig', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false, unique: true }, // 'mtn', 'airtel'
  displayName: { type: DataTypes.STRING, allowNull: false },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: false },
  environment: { type: DataTypes.ENUM('sandbox', 'production'), defaultValue: 'sandbox' },
  config: { type: DataTypes.JSONB, defaultValue: {} },
  status: { type: DataTypes.ENUM('healthy', 'degraded', 'down'), defaultValue: 'healthy' },
  lastHealthCheck: { type: DataTypes.DATE },
}, { tableName: 'provider_configs' });

// ============================================
// RATE LIMITS (track per-user)
// ============================================
const RateLimit = sequelize.define('RateLimit', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, references: { model: User, key: 'id' } },
  action: { type: DataTypes.STRING, allowNull: false },
  count: { type: DataTypes.INTEGER, defaultValue: 1 },
  windowStart: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'rate_limits' });

// ============================================
// ASSOCIATIONS
// ============================================
User.hasMany(Wallet, { foreignKey: 'userId' });
Wallet.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Transaction, { foreignKey: 'userId' });
Transaction.belongsTo(User, { foreignKey: 'userId' });

Wallet.hasMany(Transaction, { foreignKey: 'walletId' });
Transaction.belongsTo(Wallet, { foreignKey: 'walletId' });

Transaction.hasMany(LedgerEntry, { foreignKey: 'transactionId' });
LedgerEntry.belongsTo(Transaction, { foreignKey: 'transactionId' });

Wallet.hasMany(LedgerEntry, { foreignKey: 'walletId' });
LedgerEntry.belongsTo(Wallet, { foreignKey: 'walletId' });

User.hasMany(LedgerEntry, { foreignKey: 'userId' });
LedgerEntry.belongsTo(User, { foreignKey: 'userId' });

Transaction.belongsTo(User, { as: 'counterparty', foreignKey: 'counterpartyUserId' });

module.exports = {
  sequelize,
  User, Wallet, Transaction, LedgerEntry,
  WebhookEvent, FeeConfig, ProviderConfig, RateLimit,
};
