// The internal auction-state shape. Every reader (DOM, WebSocket, fetch, React…)
// produces partial updates of this object; nothing else in the system cares
// where the data came from.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  WBA.STATUS = Object.freeze({
    NO_STREAM: 'no_stream', // not on a livestream page
    IDLE: 'idle', // on a stream, no auction known
    ACTIVE: 'active', // auction running
    ENDED: 'ended', // auction known to have finished
  });

  // Fields a source may set via store.update(). Anything else is rejected so a
  // typo in a source cannot silently create new state.
  WBA.AUCTION_FIELDS = Object.freeze([
    'auctionId',
    'itemName',
    'active',
    'currentBidMinor',
    'nextBidMinor',
    'currency',
    'endTime', // server epoch ms
    'suddenDeath', // true | false | null (unknown)
    'ended',
    'bidCount',
    'highestBidder', // username of the current high bidder
    'highestBidderId', // user id of the current high bidder (compared with our own id)
    'endTimeExtends', // false for Sudden Death (product.auctionIncrementEndTime)
    'bumpThresholdSeconds', // normal auctions: a bid with < this many seconds left extends the timer
    'bumpValueSeconds', // ...to this many seconds
  ]);

  WBA.createEmptyAuctionState = function () {
    return {
      auctionId: null,
      itemName: null,
      active: false,
      currentBidMinor: null,
      nextBidMinor: null,
      currency: null,
      endTime: null,
      suddenDeath: null,
      ended: false,
      bidCount: null,
      highestBidder: null,
      highestBidderId: null,
      endTimeExtends: null,
      bumpThresholdSeconds: null,
      bumpValueSeconds: null,
      status: WBA.STATUS.IDLE,
      // bookkeeping
      lastUpdate: null, // epoch ms of the last applied update
      lastUpdatePerf: null, // performance.now() of the last applied update
      // performance.now() of the last sign of life from the data source (e.g. a
      // socket heartbeat). Auctions can go seconds without a bid, so freshness is
      // judged on source liveness rather than on the last data change.
      lastAlivePerf: null,
      fieldSources: {}, // field -> { source, t }
      endTimeHistory: [], // [{ t, endTime, source }] — tracks extensions in normal auctions
    };
  };

  /** Milliseconds until the server end time, given an estimate of server "now". */
  WBA.computeRemainingMs = function (state, serverNowMs) {
    if (!state || state.endTime == null || serverNowMs == null) return null;
    return state.endTime - serverNowMs;
  };
})(globalThis);
