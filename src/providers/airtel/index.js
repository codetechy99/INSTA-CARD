const axios = require('axios');
const PaymentProvider = require('../base');

class AirtelProvider extends PaymentProvider {
  constructor(config) {
    super('airtel', config);
    this.client = axios.create({
      baseURL: config.apiBase,
      timeout: 30000,
    });
    this.token = null;
    this.tokenExpiry = null;
  }

  /**
   * Get OAuth2 access token
   */
  async getToken() {
    if (this.token && this.tokenExpiry && this.tokenExpiry > Date.now()) {
      return this.token;
    }

    const response = await this.client.post('/auth/oauth2/token', {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'client_credentials',
    });

    this.token = response.data.access_token;
    this.tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
    return this.token;
  }

  /**
   * Initiate collection (user pays into wallet via Airtel Money)
   */
  async collect({ amount, currency, phone, reference }) {
    const token = await this.getToken();

    const response = await this.client.post('/merchant/v1/payments/', {
      subscriber: {
        msisdn: phone.replace('+', ''),
      },
      transaction: {
        amount: String(amount),
        id: reference,
        currency: currency || 'UGX',
      },
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Country': 'UG',
        'X-Currency': currency || 'UGX',
      },
    });

    return {
      providerTxId: reference,
      status: response.data.status?.success ? 'pending' : 'failed',
      raw: response.data,
    };
  }

  /**
   * Initiate disbursement (wallet pays out to Airtel Money)
   */
  async disburse({ amount, currency, phone, reference }) {
    const token = await this.getToken();

    const response = await this.client.post('/standard/v1/disbursements/', {
      receiver: {
        msisdn: phone.replace('+', ''),
      },
      amount: String(amount),
      currency: currency || 'UGX',
      reference: reference,
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Country': 'UG',
        'X-Currency': currency || 'UGX',
      },
    });

    return {
      providerTxId: reference,
      status: 'processing',
      raw: response.data,
    };
  }

  /**
   * Check transaction status
   */
  async checkStatus(providerTxId) {
    const token = await this.getToken();

    try {
      const response = await this.client.get(`/standard/v1/payments/${providerTxId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Country': 'UG',
          'X-Currency': 'UGX',
        },
      });

      const status = response.data.data?.status;
      const statusMap = { 'TS': 'completed', 'TF': 'failed', 'TN': 'pending', 'TA': 'pending' };

      return {
        status: statusMap[status] || 'pending',
        raw: response.data,
      };
    } catch (err) {
      return { status: 'unknown', raw: { error: err.message } };
    }
  }

  /**
   * Validate Airtel webhook
   */
  validateWebhook(req) {
    const txId = req.body?.transaction?.id;
    return !!txId;
  }

  /**
   * Parse Airtel webhook payload
   */
  parseWebhook(body) {
    const tx = body.transaction || {};
    const statusMap = { 'TS': 'completed', 'TF': 'failed', 'TN': 'pending', 'TA': 'pending' };

    return {
      eventId: tx.airtel_money_id || tx.id,
      eventType: 'payment',
      status: statusMap[tx.status] || 'pending',
      providerTxId: tx.id,
      providerRef: tx.airtel_money_id,
      amount: parseFloat(tx.amount || 0),
      currency: tx.currency || 'UGX',
      payerPhone: tx.msisdn,
      raw: body,
    };
  }

  async healthCheck() {
    try {
      if (!this.config.clientId || !this.config.clientSecret) return false;
      await this.getToken();
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = AirtelProvider;
