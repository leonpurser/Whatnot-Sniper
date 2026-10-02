// Auction-state source registry.
//
// A source turns one kind of raw observation into partial auction-state
// updates. Sources are added here once milestone 1 inspection has shown where
// Whatnot's auction data actually lives — none are registered yet on purpose,
// so no state is ever inferred from guessed selectors or message formats.
//
// Interface:
//   WBA.sources.register({
//     name: 'ws-auction',                 // shown as the field's "source"
//     onCapture(entry, json, store) {},   // every page observation (ws-in, fetch, xhr, dom …)
//     start(ctx) {}, stop() {},           // optional lifecycle; ctx = { store, clock, log }
//   });
//
// Sources must call store.update({ auctionId, ... }, name) with ONLY fields from
// WBA.AUCTION_FIELDS and must include auctionId whenever the data identifies it.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  const list = [];
  WBA.sources = {
    register(src) {
      if (!src || !src.name) throw new Error('source needs a name');
      list.push(src);
    },
    all: () => list.slice(),
  };
})(globalThis);
