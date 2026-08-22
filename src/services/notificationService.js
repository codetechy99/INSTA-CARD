const config = require('../config/config');

class NotificationService {
  /**
   * Send SMS via Africa's Talking
   */
  static async sendSMS(phone, message) {
    if (!config.sms.apiKey || !config.sms.username) {
      console.warn('SMS not configured, skipping:', message);
      return { sent: false, reason: 'not_configured' };
    }

    // Africa's Talking SDK integration
    // const AfricasTalking = require('africastalking');
    // const at = AfricasTalking({ apiKey: config.sms.apiKey, username: config.sms.username });
    // await at.SMS.send({ to: [phone], message, from: config.sms.senderId });

    console.log(`[SMS] To: ${phone} | Message: ${message}`);
    return { sent: true, provider: 'africastalking' };
  }

  /**
   * Send OTP
   */
  static async sendOTP(phone, code) {
    return this.sendSMS(phone, `Your InstaCard verification code is: ${code}. Valid for 5 minutes.`);
  }

  /**
   * Send transaction notification
   */
  static async sendTransactionAlert(userId, type, amount, currency, balance) {
    // In production, look up user's phone and send SMS
    // For now, log it
    console.log(`[NOTIFICATION] User ${userId}: ${type} ${amount} ${currency} | Balance: ${balance}`);
    return { sent: true };
  }

  /**
   * Generate OTP code
   */
  static generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
}

module.exports = NotificationService;
