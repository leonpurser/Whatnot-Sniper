// Loads the extension's classic scripts into this Node process (they attach to globalThis.WBA).
const path = require('path');
const files = [
  'shared/constants.js',
  'shared/log.js',
  'shared/money.js',
  'shared/state.js',
  'shared/safety.js',
  'shared/discovery.js',
  'shared/messages.js',
  'content/clock.js',
  'content/capture-store.js',
  'content/auction-state.js',
  'content/sources/registry.js',
  'content/bid-executor.js',
  'content/sniper.js',
];
for (const f of files) require(path.join(__dirname, '..', f));
module.exports = globalThis.WBA;
