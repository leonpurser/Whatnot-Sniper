// Shared constants. Loaded as a classic script in the content script, the side
// panel and the Node tests; everything hangs off the global `WBA` namespace.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  WBA.constants = Object.freeze({
    // postMessage tag between the MAIN-world page hook and the content script.
    // page/page-hook.js hard-codes the same string (it cannot load this file).
    CHANNEL: 'wba-v1',
    PORT_NAME: 'wba-panel',

    // Verified: /live/<livestreamId>; the same id appears in the auction socket
    // channel topic "commerce:<livestreamId>".
    STREAM_PATH_PATTERN: /^\/live\/([^/?#]+)/,

    CAPTURE_LIMIT: 3000, // entries kept in the inspection ring buffer
    MAX_STORE_CHARS: 32000, // per-entry payload kept in the buffer (full text is still indexed)
    MAX_DISCOVERY_FIELDS: 3000,

    // The auction-state source must have shown signs of life (any message on the
    // auction socket, incl. Phoenix heartbeat replies every ~10 s) within this window.
    STALE_STATE_MS: 15000,

    TARGET_MS_MIN: 50,
    TARGET_MS_MAX: 10000,

    DEFAULT_SETTINGS: Object.freeze({
      maxBidMinor: null, // user maximum, integer minor units (pence/cents)
      targetMs: 500, // sniper trigger offset before server end time
      keepArmedAcrossAuctions: false,
      domWatch: true, // record price/timer DOM mutations into the capture timeline
    }),

    // Keys worth surfacing in field discovery (JSON keys in captured traffic).
    DISCOVERY_KEY_PATTERN:
      /auction|bid|price|amount|end|expir|timer|countdown|sudden|death|listing|lot|product|item|winner|sold|status|clock|time|stamp|deadline|duration|increment|currency/i,
  });
})(globalThis);
