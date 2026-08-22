const MTNProvider = require('./mtn');
const AirtelProvider = require('./airtel');
const config = require('../config/config');

const providers = {};

function initProviders() {
  providers.mtn = new MTNProvider(config.mtn);
  providers.airtel = new AirtelProvider(config.airtel);
}

function getProvider(name) {
  if (!providers[name]) throw new Error(`Provider '${name}' not found`);
  return providers[name];
}

function listProviders() {
  return Object.keys(providers).map((name) => ({
    name,
    displayName: providers[name].config.displayName || name,
  }));
}

initProviders();

module.exports = { getProvider, listProviders, providers };
