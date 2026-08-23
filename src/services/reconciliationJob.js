const { Op } = require('sequelize');
const { Transaction } = require('../models');
const { getProvider } = require('../providers/registry');
const WebhookService = require('./webhookService');

// How long to wait for a webhook before polling the provider ourselves
const STALE_AFTER_MS = 2 * 60 * 1000;
// A 'processing' claim older than this means we crashed mid-processing — recover it
const STUCK_PROCESSING_MS = 10 * 60 * 1000;
// Don't poll transactions older than this (provider has forgotten them)
const MAX_AGE_HOURS = 24;
const INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 50;

class ReconciliationJob {
  static start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.run().catch((err) => console.error('[Reconciliation] run failed:', err.message));
    }, INTERVAL_MS);
    this.timer.unref();
    console.log('Reconciliation job started (every 60s)');
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  static async run() {
    const now = Date.now();

    // Pending too long for a webhook, or processing claims stuck by a crash
    const stale = await Transaction.findAll({
      where: {
        provider: { [Op.in]: ['mtn', 'airtel'] },
        createdAt: { [Op.gte]: new Date(now - MAX_AGE_HOURS * 60 * 60 * 1000) },
        [Op.or]: [
          { status: 'pending', createdAt: { [Op.lte]: new Date(now - STALE_AFTER_MS) } },
          { status: 'processing', updatedAt: { [Op.lte]: new Date(now - STUCK_PROCESSING_MS) } },
        ],
      },
      limit: BATCH_SIZE,
    });

    let settled = 0;

    for (const tx of stale) {
      try {
        const provider = getProvider(tx.provider);
        const result = await provider.checkStatus(tx.providerTransactionId || tx.reference);

        if (result.status === 'completed' || result.status === 'failed') {
          // Route through the same handler as webhooks — it is
          // idempotent and claims the transaction atomically.
          await WebhookService.handleEvent(tx.provider, {
            eventId: `recon-${tx.id}`,
            eventType: 'payment',
            status: result.status,
            providerTxId: tx.reference,
            providerRef: tx.providerTransactionId || null,
            amount: parseFloat(tx.amount),
            currency: tx.currency,
            raw: { source: 'reconciliation', ...(result.raw || {}) },
          });
          settled += 1;
        }
      } catch (err) {
        console.error(`[Reconciliation] ${tx.id} (${tx.provider}):`, err.message);
      }
    }

    if (stale.length > 0) {
      console.log(`[Reconciliation] checked ${stale.length}, settled ${settled}`);
    }

    return { checked: stale.length, settled };
  }
}

module.exports = ReconciliationJob;
