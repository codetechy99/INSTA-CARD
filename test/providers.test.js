const { test, describe } = require('node:test');
const assert = require('node:assert');
const MTNProvider = require('../src/providers/mtn');
const AirtelProvider = require('../src/providers/airtel');

describe('MTN provider webhook parsing', () => {
  const provider = new MTNProvider({});

  test('maps SUCCESSFUL to completed', () => {
    const parsed = provider.parseWebhook({
      status: 'SUCCESSFUL',
      externalId: 'ref-123',
      financialTransactionId: 'ft-999',
      amount: '5000',
      currency: 'UGX',
    });
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.providerTxId, 'ref-123');
    assert.equal(parsed.eventId, 'ft-999');
    assert.equal(parsed.amount, 5000);
  });

  test('maps FAILED/TIMEOUT to failed', () => {
    for (const s of ['FAILED', 'REJECTED', 'TIMEOUT']) {
      assert.equal(provider.parseWebhook({ status: s }).status, 'failed');
    }
  });

  test('unknown status defaults to pending', () => {
    assert.equal(provider.parseWebhook({ status: 'WHATEVER' }).status, 'pending');
  });

  test('validateWebhook requires externalId', () => {
    assert.equal(provider.validateWebhook({ body: { externalId: 'x' } }), true);
    assert.equal(provider.validateWebhook({ body: {} }), false);
  });

  test('missing eventId is rejected upstream', () => {
    const parsed = provider.parseWebhook({});
    assert.ok(!parsed.eventId, 'no eventId — webhookService must throw');
  });
});

describe('Airtel provider webhook parsing', () => {
  const provider = new AirtelProvider({});

  test('maps TS to completed with airtel_money_id ref', () => {
    const parsed = provider.parseWebhook({
      transaction: { id: 'tx-1', status: 'TS', airtel_money_id: 'am-77', amount: '1200' },
    });
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.providerRef, 'am-77');
    assert.equal(parsed.amount, 1200);
  });

  test('maps TF to failed', () => {
    assert.equal(provider.parseWebhook({ transaction: { id: 'x', status: 'TF' } }).status, 'failed');
  });

  test('validateWebhook requires transaction.id', () => {
    assert.equal(provider.validateWebhook({ body: { transaction: { id: '1' } } }), true);
    assert.equal(provider.validateWebhook({ body: {} }), false);
  });
});
