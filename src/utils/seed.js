require('dotenv').config();
const { sequelize, ProviderConfig, User } = require('../models');
const FeeEngine = require('../services/feeEngine');

// Seeds reference data: fee configs, provider registry entries,
// and (optionally) the first admin user via ADMIN_EMAIL/ADMIN_PASSWORD env vars.
async function seed() {
  try {
    await sequelize.authenticate();

    // Fee configs
    await FeeEngine.seedDefaults();
    console.log('[seed] fee configs ok');

    // Provider registry entries
    const providers = [
      { name: 'mtn', displayName: 'MTN Mobile Money' },
      { name: 'airtel', displayName: 'Airtel Money' },
    ];
    for (const p of providers) {
      await ProviderConfig.findOrCreate({ where: { name: p.name }, defaults: p });
    }
    console.log('[seed] provider configs ok');

    // First admin — only if env vars are provided
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const email = process.env.ADMIN_EMAIL.toLowerCase();
      const existing = await User.findOne({ where: { email } });
      if (existing) {
        console.log(`[seed] admin already exists: ${email}`);
      } else {
        await User.create({
          email,
          phone: process.env.ADMIN_PHONE || `+256000${Date.now()}`.slice(0, 12),
          name: process.env.ADMIN_NAME || 'InstaCard Admin',
          passwordHash: process.env.ADMIN_PASSWORD,
          role: 'super_admin',
          status: 'active',
        });
        console.log(`[seed] admin created: ${email}`);
      }
    }

    console.log('[seed] complete');
    process.exit(0);
  } catch (err) {
    console.error('[seed] failed:', err);
    process.exit(1);
  }
}

seed();
