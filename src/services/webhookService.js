const { WebhookEvent, Transaction, Wallet } = require('../models');
const { getProvider } = require('../providers/registry');
const WalletEngine = require('./walletEngine');

class WebhookService {
  /**
   * Process incoming webhook with idempotency check
   */
  static async processWebhook(providerName, req) {
    const provider = getProvider(providerName);

    // 1. Parse the webhook
    const parsed = provider.parseWebhook(req.body);

    // 2. Idempotency check — have we seen this event before?
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
        payload: req.body,
        status: 'processing',
      });
    }

    // 3. Process the event
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
   */
  static async handleEvent(providerName, parsed) {
    const { providerTxId, status } = parsed;

    // Find the pending transaction by provider reference
    const tx = await Transaction.findOne({
      where: { provider: providerName, reference: providerTxId, status: 'pending' },
    });

    if (!tx) {
      console.warn(`No pending transaction found for ${providerName}:${providerTxId}`);
      return;
    }

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

      // Update the original pending transaction
      await tx.update({
        status: 'completed',
        providerTransactionId: parsed.providerRef,
        providerStatus: parsed.status,
        providerRaw: parsed.raw,
        completedAt: new Date(),
      });
    } else if (status === 'failed') {
      await tx.update({
        status: 'failed',
        providerTransactionId: parsed.providerRef,
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
    }
  }
}

module.exports = WebhookService;
