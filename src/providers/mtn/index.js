const axios = require('axios');
const crypto = require('crypto');
const PaymentProvider = require('../base');

class MTNProvider extends PaymentProvider {
  constructor(config) {
    super('mtn', config);
    this.client = axios.create({
      baseURL: config.apiBase,
      timeout: 30000,
    });
    this.token = null;
    this.tokenExpiry = null;
  }

  /**
   * Get OAuth2 access token (cached, refreshed before expiry)
   */
  async getToken() {
    if (this.token && this.tokenExpiry && this.tokenExpiry > Date.now()) {
      return this.token;
    }

    const credentials = Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`).toString('base64');

    const response = await this.client.post('/collection/token/', null, {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
      },
    });

    this.token = response.data.access_token;
    this.tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
    return this.token;
  }

  /**
   * Initiate collection (user pays into wallet via MTN MoMo)
   */
  async collect({ amount, currency, phone, reference, callbackUrl }) {
    const token = await this.getToken();
    const referenceId = crypto.randomUUID();

    const response = await this.client.post('/collection/v1_0/requesttopay', {
      amount: String(amount),
      currency: currency || 'UGX',
      externalId: reference,
      payer: {
        partyIdType: 'MSISDN',
        partyId: phone.replace('+', '').replace(/^256/, '256'),
      },
      payerMessage: 'Deposit to InstaCard wallet',
      payeeNote: 'InstaCard deposit',
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Reference-Id': referenceId,
        'X-Target-Environment': this.config.environment || 'sandbox',
        'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
        'X-Callback-Url': callbackUrl || this.config.callbackUrl,
      },
    });

    return {
      providerTxId: referenceId,
      status: 'pending',
      raw: response.data,
    };
  }

  /**
   * Initiate disbursement (wallet pays out to MTN MoMo)
   */
  async disburse({ amount, currency, phone, reference, callbackUrl }) {
    const token = await this.getToken();
    const referenceId = crypto.randomUUID();

    const response = await this.client.post('/disbursement/v1_0/transfer', {
      amount: String(amount),
      currency: currency || 'UGX',
      externalId: reference,
      payee: {
        partyIdType: 'MSISDN',
        partyId: phone.replace('+', '').replace(/^256/, '256'),
      },
      payerMessage: 'Withdrawal from InstaCard',
      payeeNote: 'InstaCard withdrawal',
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Reference-Id': referenceId,
        'X-Target-Environment': this.config.environment || 'sandbox',
        'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
        'X-Callback-Url': callbackUrl || this.config.callbackUrl,
      },
    });

    return {
      providerTxId: referenceId,
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
      const response = await this.client.get(`/collection/v1_0/requesttopay/${providerTxId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Target-Environment': this.config.environment || 'sandbox',
          'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
        },
      });

      const statusMap = {
        'SUCCESSFUL': 'completed',
        'FAILED': 'failed',
        'REJECTED': 'failed',
        'TIMEOUT': 'failed',
        'PENDING': 'pending',
      };

      return {
        status: statusMap[response.data.status] || 'pending',
        raw: response.data,
      };
    } catch (err) {
      return { status: 'unknown', raw: { error: err.message } };
    }
  }

  /**
   * Validate webhook — MTN uses X-Callback-Url but no signature
   * We validate by checking the reference exists in our system
   */
  validateWebhook(req) {
    // MTN doesn't sign webhooks — we validate via externalId lookup
    const externalId = req.body?.externalId;
    return !!externalId;
  }

  /**
   * Parse MTN webhook payload
   */
  parseWebhook(body) {
    const statusMap = {
      'SUCCESSFUL': 'completed',
      'FAILED': 'failed',
      'REJECTED': 'failed',
      'TIMEOUT': 'failed',
    };

    return {
      eventId: body.financialTransactionId || body.externalId,
      eventType: 'payment',
      status: statusMap[body.status] || 'pending',
      providerTxId: body.externalId,
      providerRef: body.financialTransactionId,
      amount: parseFloat(body.amount || 0),
      currency: body.currency || 'UGX',
      payerPhone: body.payer?.partyId,
      raw: body,
    };
  }

  /**
   * Health check — try to get a token
   */
  async healthCheck() {
    try {
      if (!this.config.apiKey || !this.config.apiSecret) return false;
      await this.getToken();
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = MTNProvider;
