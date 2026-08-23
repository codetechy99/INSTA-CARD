const crypto = require('crypto');
const { Op } = require('sequelize');
const config = require('../config/config');
const { WebhookEvent, Transaction } = require('../models');
const { getProvider } = require('../providers/registry');
const WalletEngine = require('./walletEngine');

class WebhookService {
  /**
   * Process incoming webhook with validation + idempotency check
   */
  static async processWebhook(providerName, req) {
    const provider = getProvider(providerName);

    // 1. Raw bytes — express.raw delivers a Buffer, keep it for signature checks
    const raw = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

    // 2. HMAC verification when the provider signs its callbacks
    const signature = req.headers['x-webhook-signature'];
    if (signature) {
      const expected = crypto.createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
      const a = Buffer.from(String(signature));
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new Error('Invalid webhook signature');
      }
    }

    // 3. Parse JSON safely (raw body arrives as a Buffer)
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Error('Invalid JSON in webhook payload');
    }

    // 4. Provider-level validation BEFORE trusting anything in the payload
    const valid = await Promise.resolve(provider.validateWebhook({ headers: req.headers, body }));
    if (!valid) {
      throw new Error(`Webhook failed ${providerName} validation`);
    }

    // 5. Parse into standard event format
    const parsed = provider.parseWebhook(body);
    if (!parsed.eventId) {
      throw new Error('Webhook payload missing event id');
    }

    // 6. Idempotency check — have we seen this event before?
    const existing = await WebhookEvent.findOne({
      where: { provider: providerName, eventId: parsed.eventId },
    });

    if (existing) {
      // Already processed — return success, don't reprocess
      if (existing.status === 'processed' || existing.status === 'duplicate') {
        return { status: 'duplicate', message: 'Event already processed' };
      }
      // If it was failed before, allow retry
      if (existing.status === 'failed') {
        await existing.update({ status: 'processing' });
      } else {
        return { status: 'duplicate', message: 'Event already received' };
      }
    } else {
      // New event — record it
      await WebhookEvent.create({
        provider: providerName,
        eventId: parsed.eventId,
        eventType: parsed.eventType,
        payload: body,
        status: 'processing',
      });
    }

    // 7. Process the event
    try {
      await this.handleEvent(providerName, parsed);

      // Mark as processed
      await WebhookEvent.update(
        { status: 'processed', processedAt: new Date() },
        { where: { provider: providerName, eventId: parsed.eventId } }
      );

      return { status: 'processed', eventId: parsed.eventId };
    } catch (err) {
      await WebhookEvent.update(
        { status: 'failed', error: err.message },
        { where: { provider: providerName, eventId: parsed.eventId } }
      );
      throw err;
    }
  }

  /**
   * Handle a parsed webhook event
   * Also used by the reconciliation job — safe against double-processing
   * via an atomic status claim before any money moves.
   */
  static async handleEvent(providerName, parsed) {
    const { providerTxId, status } = parsed;

    if (!providerTxId) return;

    // Find the transaction by our reference (externalId sent to the provider)
    const tx = await Transaction.findOne({
      where: { provider: providerName, reference: providerTxId },
    });

    if (!tx) {
      console.warn(`No transaction found for ${providerName}:${providerTxId}`);
      return;
    }

    // Terminal states — never reprocess
    if (!['pending', 'processing'].includes(tx.status)) return;

    // Atomic claim: only ONE caller wins the pending→processing transition.
    // Prevents webhook + reconciler racing to double-credit/refund.
    const [claimed] = await Transaction.update(
      { status: 'processing' },
      { where: { id: tx.id, status: { [Op.in]: ['pending', 'processing'] } } }
    );
    if (!claimed) return;

    if (status === 'completed') {
      // Credit the wallet (if this was a collection/deposit)
      if (tx.type === 'deposit') {
        await WalletEngine.credit(tx.userId, tx.amount, {
          currency: tx.currency,
          type: 'deposit',
          description: `${providerName.toUpperCase()} deposit confirmed`,
          provider: providerName,
          providerTxId: parsed.providerRef,
          providerRaw: parsed.raw,
          reference: tx.reference,
        });
      }

      // Update the original transaction to its terminal state
      await tx.update({
        status: 'completed',
        providerTransactionId: parsed.providerRef || tx.providerTransactionId,
        providerStatus: parsed.status,
        providerRaw: parsed.raw,
        completedAt: new Date(),
      });
    } else if (status === 'failed') {
      await tx.update({
        status: 'failed',
        providerTransactionId: parsed.providerRef || tx.providerTransactionId,
        providerStatus: parsed.status,
        providerRaw: parsed.raw,
      });

      // If it was a withdrawal that failed, refund the wallet
      if (tx.type === 'withdrawal') {
        await WalletEngine.credit(tx.userId, tx.amount, {
          currency: tx.currency,
          type: 'refund',
          description: `Refund: ${providerName.toUpperCase()} withdrawal failed`,
          provider: providerName,
          providerTxId: parsed.providerRef,
          reference: `refund-${tx.reference}`,
        });
      }
    } else {
      // Still pending at the provider — release the claim back
      await tx.update({ status: 'pending' });
    }
  }
}

module.exports = WebhookService;
