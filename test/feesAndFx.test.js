process.env.FX_API_URL = 'http://127.0.0.1:9'; // closed port — forces fallback rates

const { test, describe } = require('node:test');
const assert = require('node:assert');
const FeeEngine = require('../src/services/feeEngine');

describe('FeeEngine.calculateTiered', () => {
  test('applies tier rates progressively', () => {
    const config = {
      metadata: { tiers: [
        { min: 0, max: 10000, rate: 1 },
        { min: 10000, max: 100000, rate: 0.75 },
      ] },
    };
    // 5000 → all in tier 1: 5000 * 1% = 50
    assert.equal(FeeEngine.calculateTiered(5000, config), 50);
    // 50000 → 10000*1% + 40000*0.75% = 100 + 300 = 400
    assert.equal(FeeEngine.calculateTiered(50000, config), 400);
  });

  test('falls back to flat value without tiers', () => {
    const config = { value: '2.5', metadata: null };
    assert.equal(FeeEngine.calculateTiered(1000, config), 25);
  });
});

describe('FX fallback rates (feed unreachable)', () => {
  const FXService = require('../src/services/fxService');

  test('returns hardcoded rate when the feed is down', async () => {
    const rate = await FXService.getRate('UGX', 'USD');
    assert.equal(rate, 0.00027);
  });

  test('same-currency conversion is always 1', async () => {
    assert.equal(await FXService.getRate('UGX', 'UGX'), 1);
  });

  test('convert rounds to 2 decimals', async () => {
    const out = await FXService.convert(1234.567, 'USD', 'KES'); // rate 130
    assert.equal(out.amount, 160493.71);
  });

  test('unknown pair falls back to 1 rather than zeroing money', async () => {
    const rate = await FXService.getRate('XXX', 'YYY');
    assert.equal(rate, 1);
  });
});
