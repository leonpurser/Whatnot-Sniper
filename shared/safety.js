// Pure pre-bid validation. Every check is evaluated (no short-circuit) so the
// UI and logs can show exactly why a bid was or wasn't allowed. A bid may only
// proceed when EVERY check passes; anything unknown counts as a failure.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  /**
   * @param {object} ctx
   * @param {object} ctx.state            current auction state (WBA.createEmptyAuctionState shape)
   * @param {string} ctx.expectedAuctionId auction the caller intends to bid on
   * @param {string|null} ctx.streamId    stream the tab is on right now
   * @param {string|null} ctx.expectedStreamId stream the caller intends (armed/started on)
   * @param {number|null} ctx.maxBidMinor user maximum
   * @param {number} ctx.serverNowMs      best estimate of server epoch ms
   * @param {number} ctx.nowPerf          performance.now() at validation time
   * @param {number} ctx.staleMs          max age of auction state
   * @param {boolean} ctx.requireArmed    automatic bids require the sniper to be armed
   * @param {boolean} ctx.armed
   * @param {string|null} ctx.armedAuctionId
   * @param {string|null} ctx.selfUserId  our Whatnot user id (to avoid bidding against ourselves)
   * @param {boolean} [ctx.enforceMax=true] false for a manual BID NOW, which (like Whatnot's
   *        own bid button) bids the next amount without a user maximum
   */
  function validateBid(ctx) {
    const s = ctx.state || {};
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

    if (ctx.requireArmed) {
      add('armed', ctx.armed === true, ctx.armed ? '' : 'sniper not armed');
      add(
        'armed-auction-matches',
        ctx.armedAuctionId != null && ctx.armedAuctionId === ctx.expectedAuctionId,
        `armed=${ctx.armedAuctionId} expected=${ctx.expectedAuctionId}`
      );
    }

    add(
      'stream-matches',
      ctx.streamId != null && ctx.streamId === ctx.expectedStreamId,
      `stream=${ctx.streamId} expected=${ctx.expectedStreamId}`
    );

    add(
      'auction-identity',
      s.auctionId != null && ctx.expectedAuctionId != null && s.auctionId === ctx.expectedAuctionId,
      `current=${s.auctionId} expected=${ctx.expectedAuctionId}`
    );

    add('auction-active', s.active === true && s.ended !== true, `active=${s.active} ended=${s.ended}`);

    const age = s.lastAlivePerf == null ? null : ctx.nowPerf - s.lastAlivePerf;
    add('state-fresh', age != null && age >= 0 && age <= ctx.staleMs, `age=${age == null ? 'unknown' : Math.round(age) + 'ms'}`);

    add('price-known', Number.isInteger(s.currentBidMinor), `current=${s.currentBidMinor}`);

    // We never invent bid increments: the required amount must come from Whatnot.
    const required = Number.isInteger(s.nextBidMinor) ? s.nextBidMinor : null;
    add('next-bid-known', required != null, `next=${s.nextBidMinor}`);
    add(
      'next-bid-above-current',
      required != null && Number.isInteger(s.currentBidMinor) && required > s.currentBidMinor,
      `next=${required} current=${s.currentBidMinor}`
    );

    // Never raise our own winning bid. With no bids nobody is winning; otherwise
    // both ids must be known.
    const noBids = s.bidCount === 0;
    const selfKnown = ctx.selfUserId != null;
    add(
      'not-already-highest',
      noBids || (selfKnown && s.highestBidderId != null && String(s.highestBidderId) !== String(ctx.selfUserId)),
      noBids ? 'no bids yet' : `high=${s.highestBidderId} self=${ctx.selfUserId ?? 'unknown'}`
    );

    if (ctx.enforceMax !== false) {
      const max = ctx.maxBidMinor;
      add('max-set', Number.isInteger(max) && max > 0, `max=${max}`);
      add('within-max', required != null && Number.isInteger(max) && required <= max, `required=${required} max=${max}`);
    }

    const remaining = s.endTime == null || ctx.serverNowMs == null ? null : s.endTime - ctx.serverNowMs;
    add('end-time-known', s.endTime != null, `endTime=${s.endTime}`);
    add('not-ended', remaining != null && remaining > 0, `remaining=${remaining == null ? 'unknown' : Math.round(remaining) + 'ms'}`);

    return {
      ok: checks.every((c) => c.ok),
      checks,
      bidAmountMinor: required,
      remainingMs: remaining,
    };
  }

  WBA.safety = { validateBid };
})(globalThis);
