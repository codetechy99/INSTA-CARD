// WEBHOOK_SECRET must be set BEFORE config.js is required
process.env.WEBHOOK_SECRET = 'test-secret';
process.env.FX_API_URL = 'http://127.0.0.1:9'; // closed port — forces FX fallback path

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

describe('webhook HMAC rejection', () => {
  test('rejects a bad signature before any DB access', async () => {
    const WebhookService = require('../src/services/webhookService');
    const body = Buffer.from(JSON.stringify({ status: 'SUCCESSFUL', externalId: 'x' }));
    const req = {
      body,
      headers: { 'x-webhook-signature': 'deadbeef'.repeat(8) },
    };

    await assert.rejects(
      () => WebhookService.processWebhook('mtn', req),
      /Invalid webhook signature/
    );
  });

  test('valid HMAC passes to provider validation stage (no DB touched)', async () => {
    const WebhookService = require('../src/services/webhookService');
    // Body fails MTN's own validation (no externalId) — this happens BEFORE
    // any database access, so the test proves the pipeline order without a DB.
    const body = Buffer.from(JSON.stringify({ status: 'SUCCESSFUL' }));
    const sig = crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
    const req = { body, headers: { 'x-webhook-signature': sig } };

    await assert.rejects(
      () => WebhookService.processWebhook('mtn', req),
      /validation/
    );
  });

  test('rejects malformed JSON with valid signature', async () => {
    const WebhookService = require('../src/services/webhookService');
    const body = Buffer.from('not-json{{');
    const sig = crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');

    await assert.rejects(
      () => WebhookService.processWebhook('mtn', { body, headers: { 'x-webhook-signature': sig } }),
      /Invalid JSON/
    );
  });
});
