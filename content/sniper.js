// Sniper / timing engine.
//
// MILESTONE 1: only the armed-state bookkeeping exists (arm is bound to one
// auction id + stream and is cleared whenever the auction changes). The
// scheduler that fires at T-targetMs is milestone 2 — it needs a verified
// server end time first. Planned design:
//   * coarse setTimeout to ~T-150ms, then a requestAnimationFrame/MessageChannel
//     spin against performance.now() anchored to the server end time
//   * re-read endTime on every state update (normal auctions extend)
//   * call executor.placeBid(armedAuctionId, max, { trigger: 'auto' }) — the
//     executor re-validates everything, so a stale timer can never bid on a
//     different auction.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  WBA.createSniper = function ({ log, store, getSettings }) {
    let armed = null; // { auctionId, streamId, t }

    function arm() {
      const s = store.get();
      const streamId = store.getStreamId();
      if (!s.auctionId || !streamId) {
        log.warn('cannot arm: no identified auction on this stream');
        return { ok: false, reason: 'NO_AUCTION' };
      }
      if (!s.active) {
        log.warn('cannot arm: auction not active');
        return { ok: false, reason: 'NOT_ACTIVE' };
      }
      armed = { auctionId: s.auctionId, streamId, t: Date.now() };
      log.info(`ARMED on auction ${s.auctionId} target=${getSettings().targetMs}ms (scheduler not implemented yet)`);
      return { ok: true };
    }

    function disarm(reason) {
      if (!armed) return;
      log.info(`disarmed (${reason})`);
      armed = null;
    }

    store.subscribe((event, state) => {
      if (!armed) return;
      if (event.type === 'reset') return disarm(event.reason);
      if (event.type === 'auction-changed') {
        // Never carry an arm over to a different auction unless explicitly configured,
        // and even then re-bind to the new id rather than keeping the old one.
        if (getSettings().keepArmedAcrossAuctions && state.auctionId) {
          armed = { auctionId: state.auctionId, streamId: store.getStreamId(), t: Date.now() };
          log.info(`re-armed on new auction ${state.auctionId} (keepArmedAcrossAuctions)`);
        } else disarm('auction changed');
        return;
      }
      if (state.ended) disarm('auction ended');
    });

    return {
      arm,
      disarm,
      get armed() {
        return armed;
      },
    };
  };
})(globalThis);
