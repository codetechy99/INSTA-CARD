/**
 * Base PaymentProvider — all providers must implement these methods
 * This ensures we can swap providers without touching wallet logic
 */
class PaymentProvider {
  constructor(name, config) {
    this.name = name;
    this.config = config;
  }

  /**
   * Initiate a collection (deposit from mobile money to wallet)
   * @param {Object} params - { amount, currency, phone, reference, callbackUrl }
   * @returns {Object} - { providerTxId, status, raw }
   */
  async collect(params) {
    throw new Error('collect() not implemented');
  }

  /**
   * Initiate a disbursement (withdraw from wallet to mobile money)
   * @param {Object} params - { amount, currency, phone, reference, callbackUrl }
   * @returns {Object} - { providerTxId, status, raw }
   */
  async disburse(params) {
    throw new Error('disburse() not implemented');
  }

  /**
   * Check transaction status with provider
   * @param {string} providerTxId
   * @returns {Object} - { status, raw }
   */
  async checkStatus(providerTxId) {
    throw new Error('checkStatus() not implemented');
  }

  /**
   * Validate webhook signature
   * @param {Object} req - Express request
   * @returns {boolean}
   */
  validateWebhook(req) {
    return true; // Override in providers that support signature verification
  }

  /**
   * Parse webhook payload into standard format
   * @param {Object} body - Raw webhook body
   * @returns {Object} - { eventId, eventType, status, providerTxId, amount, currency, raw }
   */
  parseWebhook(body) {
    throw new Error('parseWebhook() not implemented');
  }

  /**
   * Health check
   * @returns {boolean}
   */
  async healthCheck() {
    return true;
  }
}

module.exports = PaymentProvider;
