const axios = require('axios');
const config = require('../config/config');
const { cacheGet, cacheSet } = require('../utils/cache');

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

class FXService {
  /**
   * Get exchange rate between two currencies
   */
  static async getRate(from, to) {
    if (from === to) return 1;

    const cacheKey = `fx:${from}_${to}`;
    const cached = await cacheGet(cacheKey);
    if (cached !== null) return cached;

    try {
      const response = await axios.get(`${config.fx.apiUrl}/${from}`, { timeout: 10000 });
      const rate = response.data.rates[to];

    if (rate) {
      await cacheSet(cacheKey, rate, CACHE_TTL);
      return rate;
    }
    } catch (err) {
      console.error('FX rate fetch failed:', err.message);
    }

    // Fallback rates (should be updated periodically)
    const fallback = {
      'UGX_USD': 0.00027,
      'USD_UGX': 3700,
      'KES_UGX': 28.5,
      'UGX_KES': 0.035,
      'KES_USD': 0.0077,
      'USD_KES': 130,
      'TZS_UGX': 1.5,
      'UGX_TZS': 0.67,
      'NGN_UGX': 2.4,
      'UGX_NGN': 0.42,
      'GHS_UGX': 30,
      'UGX_GHS': 0.033,
    };

    return fallback[cacheKey] || 1;
  }

  /**
   * Convert amount between currencies
   */
  static async convert(amount, from, to) {
    const rate = await this.getRate(from, to);
    const converted = Math.round(parseFloat(amount) * rate * 100) / 100;
    return { amount: converted, rate, from, to };
  }

  /**
   * Get all rates for a base currency
   */
  static async getAllRates(base = 'USD') {
    try {
      const response = await axios.get(`${config.fx.apiUrl}/${base}`, { timeout: 10000 });
      return response.data.rates;
    } catch {
      return {};
    }
  }

  /**
   * Invalidate in-memory cache (Redis entries expire via TTL)
   */
  static invalidateCache() {
    const { clearMemory } = require('../utils/cache');
    clearMemory();
  }
}

module.exports = FXService;
