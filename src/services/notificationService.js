const axios = require('axios');
const config = require('../config/config');

class NotificationService {
  /**
   * Send SMS via Africa's Talking REST API.
   * Fails soft — money flow must never block on notifications.
   */
  static async sendSMS(phone, message) {
    if (!config.sms.apiKey || !config.sms.username) {
      console.warn('[SMS] not configured, skipping:', message.slice(0, 60));
      return { sent: false, reason: 'not_configured' };
    }

    try {
      const response = await axios.post(
        `${config.sms.apiBase}/version1/messaging`,
        {
          username: config.sms.username,
          to: [phone],
          message,
          ...(config.sms.senderId && config.sms.environment !== 'sandbox'
            ? { from: config.sms.senderId }
            : {}),
          enqueue: true,
        },
        {
          headers: {
            apiKey: config.sms.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 15000,
        }
      );

      const recipient = response.data?.SMSMessageData?.Recipients?.[0];
      const ok = recipient && !String(recipient.status).startsWith('Invalid');
      if (!ok) {
        console.warn('[SMS] provider rejected:', recipient?.status || JSON.stringify(response.data).slice(0, 120));
      }
      return { sent: !!ok, provider: 'africastalking', status: recipient?.status };
    } catch (err) {
      console.error('[SMS] send failed:', err.message);
      return { sent: false, reason: err.message };
    }
  }

  /**
   * Send OTP
   */
  static async sendOTP(phone, code) {
    return this.sendSMS(phone, `Your InstaCard verification code is: ${code}. Valid for 5 minutes.`);
  }

  /**
   * Transaction alert — best effort, never throws
   */
  static async sendTransactionAlert(userId, type, amount, currency, balance) {
    try {
      const { User } = require('../models');
      const user = await User.findByPk(userId);
      if (!user?.phone) return { sent: false, reason: 'no_phone' };

      return await this.sendSMS(
        user.phone,
        `InstaCard: ${String(type).replace(/_/g, ' ')} of ${amount} ${currency} confirmed. New balance: ${balance} ${currency}.`
      );
    } catch (err) {
      console.error('[SMS] transaction alert failed:', err.message);
      return { sent: false, reason: err.message };
    }
  }

  /**
   * Generate OTP code (cryptographically random)
   */
  static generateOTP() {
    const crypto = require('crypto');
    return String(100000 + (crypto.randomInt(0, 900000)));
  }
}

module.exports = NotificationService;
