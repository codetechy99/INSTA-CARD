require('dotenv').config();

module.exports = {
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    name: process.env.DB_NAME || 'instacard',
    user: process.env.DB_USER || 'postgres',
    pass: process.env.DB_PASS || '',
  },
  redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  mtn: {
    apiBase: process.env.MTN_API_BASE || 'https://sandbox.momodeveloper.mtn.com',
    apiKey: process.env.MTN_API_KEY || '',
    apiSecret: process.env.MTN_API_SECRET || '',
    subscriptionKey: process.env.MTN_SUBSCRIPTION_KEY || '',
    environment: process.env.MTN_ENVIRONMENT || 'sandbox',
    callbackUrl: process.env.MTN_CALLBACK_URL || '',
  },
  airtel: {
    apiBase: process.env.AIRTEL_API_BASE || 'https://openapi.sandbox.airtel.africa',
    clientId: process.env.AIRTEL_CLIENT_ID || '',
    clientSecret: process.env.AIRTEL_CLIENT_SECRET || '',
    callbackUrl: process.env.AIRTEL_CALLBACK_URL || '',
  },
  fx: { apiUrl: process.env.FX_API_URL || 'https://api.exchangerate-api.com/v4/latest/USD' },
  sms: {
    apiKey: process.env.AT_API_KEY || '',
    username: process.env.AT_USERNAME || '',
    senderId: process.env.AT_SENDER_ID || 'InstaCard',
  },
  webhookSecret: process.env.WEBHOOK_SECRET || 'dev-webhook-secret',
};
