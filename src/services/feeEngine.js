const { FeeConfig } = require('../models');

class FeeEngine {
  /**
   * Calculate fee for a transaction type
   * @param {string} type - 'deposit', 'withdrawal', 'transfer', 'fx'
   * @param {number} amount
   * @param {string} currency
   * @param {string} country
   * @returns {Object} - { fee, tax, total, config }
   */
  static async calculate(type, amount, currency = 'UGX', country = 'UG') {
    const configs = await FeeConfig.findAll({
      where: { isActive: true, currency, country },
    });

    // Find matching config by name/type
    const config = configs.find((c) => c.name === type) || configs.find((c) => c.name === 'default');

    if (!config) return { fee: 0, tax: 0, total: parseFloat(amount), config: null };

    const amt = parseFloat(amount);
    let fee = 0;

    switch (config.type) {
      case 'percentage':
        fee = (amt * parseFloat(config.value)) / 100;
        break;
      case 'fixed':
        fee = parseFloat(config.value);
        break;
      case 'tiered':
        fee = this.calculateTiered(amt, config);
        break;
    }

    // Apply min/max fee
    if (config.minFee && fee < parseFloat(config.minFee)) fee = parseFloat(config.minFee);
    if (config.maxFee && fee > parseFloat(config.maxFee)) fee = parseFloat(config.maxFee);

    // Round to 2 decimal places
    fee = Math.round(fee * 100) / 100;

    // Uganda mobile money tax: 0.5% on withdrawals
    let tax = 0;
    if (type === 'withdrawal' && country === 'UG') {
      tax = Math.round(amt * 0.005 * 100) / 100;
    }

    return {
      fee,
      tax,
      total: fee + tax,
      config: config.toJSON(),
    };
  }

  static calculateTiered(amount, config) {
    // Tiered: config.value contains tiers like [{min: 0, max: 10000, rate: 1}, {min: 10000, max: 100000, rate: 0.75}]
    const tiers = config.metadata?.tiers || [{ min: 0, max: Infinity, rate: parseFloat(config.value) }];
    let fee = 0;

    for (const tier of tiers) {
      if (amount > tier.min) {
        const taxable = Math.min(amount, tier.max) - tier.min;
        fee += (taxable * tier.rate) / 100;
      }
    }

    return fee;
  }

  /**
   * Seed default fee configs
   */
  static async seedDefaults() {
    const defaults = [
      { name: 'deposit', type: 'percentage', value: 0, minFee: 0, maxFee: 0, currency: 'UGX', country: 'UG' },
      { name: 'withdrawal', type: 'percentage', value: 1.0, minFee: 500, maxFee: 10000, currency: 'UGX', country: 'UG' },
      { name: 'transfer', type: 'percentage', value: 0.5, minFee: 100, maxFee: 5000, currency: 'UGX', country: 'UG' },
      { name: 'fx', type: 'percentage', value: 2.0, minFee: 1000, maxFee: 50000, currency: 'UGX', country: 'UG' },
      { name: 'deposit', type: 'percentage', value: 0, minFee: 0, maxFee: 0, currency: 'KES', country: 'KE' },
      { name: 'withdrawal', type: 'percentage', value: 1.0, minFee: 50, maxFee: 500, currency: 'KES', country: 'KE' },
      { name: 'transfer', type: 'percentage', value: 0.5, minFee: 10, maxFee: 250, currency: 'KES', country: 'KE' },
    ];

    for (const d of defaults) {
      await FeeConfig.findOrCreate({ where: { name: d.name, currency: d.currency, country: d.country }, defaults: d });
    }
  }
}

module.exports = FeeEngine;
