const express = require('express');
const crypto = require('crypto');
const config = require('../config/config');
const WebhookService = require('../services/webhookService');

const router = express.Router();

// POST /api/webhooks/mtn
router.post('/mtn', async (req, res) => {
  try {
    console.log('[Webhook] MTN:', JSON.stringify(req.body).slice(0, 200));

    const result = await WebhookService.processWebhook('mtn', req);

    if (result.status === 'duplicate') {
      return res.status(200).json({ status: 'ok', message: 'Duplicate event' });
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[Webhook] MTN error:', err);
    res.status(200).json({ status: 'ok' }); // Always 200 to provider
  }
});

// POST /api/webhooks/airtel
router.post('/airtel', async (req, res) => {
  try {
    console.log('[Webhook] Airtel:', JSON.stringify(req.body).slice(0, 200));

    const result = await WebhookService.processWebhook('airtel', req);

    if (result.status === 'duplicate') {
      return res.status(200).json({ status: 'ok', message: 'Duplicate event' });
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[Webhook] Airtel error:', err);
    res.status(200).json({ status: 'ok' });
  }
});

// GET /api/webhooks/status/:provider/:txId
router.get('/status/:provider/:txId', async (req, res) => {
  try {
    const { getProvider } = require('../providers/registry');
    const provider = getProvider(req.params.provider);
    const status = await provider.checkStatus(req.params.txId);
    res.json({ status: 'success', ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
