// Sniper / timing engine.
//
// Modes (settings.autoMode):
//   'snipe'         one bid at endTime - targetMs. Normal auctions move their end
//                   time when outbid, so it naturally re-snipes at the new end.
//   'snipe-rebid'   as 'snipe', plus: if outbid after our snipe while at least
//                   minRebidMs remain (Sudden Death: the end never moves), bid
//                   again immediately.
//   'keep-winning'  bid as soon as we are not the highest bidder, at any point,
//                   up to the maximum (a proxy bidder). No end-time shot.
// Every bid goes through executor.placeBid(..., { trigger: 'auto' }), which enforces
// the maximum, the armed auction id, freshness and "never bid against ourselves".
//
// Armed on ONE auction id (and stream). It plans a fire time of
//   serverEndTime - targetMs   (server clock)
// converts it to the local performance.now() timeline via the clock offset,
// and re-plans on every state update, because normal auctions move their end time.
// Timing: a coarse setTimeout wakes ~SPIN_MS early, then a MessageChannel loop
// (which yields to the page between ticks) fires on the first tick past the target.
//
// The engine knows nothing about how a bid is sent: it calls
// executor.placeBid(armedAuctionId, max, { trigger: 'auto', ... }), and the executor
// re-validates everything. So a stale timer can never bid on a different auction.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});
  const SPIN_MS = 30; // wake this early from the coarse timer, then spin
  const BUSY_WAIT_MS = 1.5;

  WBA.AUTO_MODES = Object.freeze(['snipe', 'snipe-rebid', 'keep-winning']);

  WBA.createSniper = function ({
    log,
    store,
    getSettings,
    executor,
    clock,
    getSelfUserId = () => null,
    isLive = () => false,
    onChange = () => {},
  }) {
    let armed = null; // { auctionId, streamId, t, mode }
    let inFlight = false; // an auto bid is awaiting its result
    let pendingReact = false;
    const sniped = new Set(); // auction ids where the end-time shot has fired
    const warned = new Set(); // one-off warnings per auction
    let plan = null; // { endTime, targetMs, firePerf, key }
    let timer = null;
    let spinning = false;
    const fired = new Set(); // plan keys already fired (one shot per end time)
    // Fast yielding tick: setImmediate where it exists (Node tests), otherwise a
    // MessageChannel round trip (sub-millisecond in Chrome, not clamped like setTimeout).
    let tick;
    if (typeof setImmediate === 'function') tick = () => setImmediate(spinTick);
    else {
      const channel = new MessageChannel();
      channel.port1.onmessage = spinTick;
      tick = () => channel.port2.postMessage(null);
    }

    function cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      spinning = false;
      plan = null;
    }

    function arm() {
      const s = store.get();
      const streamId = store.getStreamId();
      const settings = getSettings();
      if (!s.auctionId || !streamId) return refuse('NO_AUCTION', 'no identified auction on this stream');
      if (!s.active) return refuse('NOT_ACTIVE', 'auction not active');
      if (!Number.isInteger(settings.maxBidMinor) || settings.maxBidMinor <= 0) return refuse('NO_MAX', 'set a maximum first');
      const mode = WBA.AUTO_MODES.includes(settings.autoMode) ? settings.autoMode : 'snipe';
      armed = { auctionId: s.auctionId, streamId, t: Date.now(), mode };
      const kind = s.suddenDeath === true ? 'SUDDEN DEATH' : s.suddenDeath === false ? 'NORMAL (late bids extend the timer)' : 'unknown type';
      const how = mode === 'keep-winning' ? 'keep-winning' : `${mode} target=${settings.targetMs}ms`;
      log.info(`ARMED on ${s.auctionId} [${kind}] ${how} max=${WBA.money.formatMoney(settings.maxBidMinor, s.currency)}${isLive() ? ' — LIVE' : ' (dry run)'}`);
      if (typeof document !== 'undefined' && document.hidden) log.warn('tab is hidden: Chrome throttles timers in background tabs — keep the stream tab visible');
      react();
      return { ok: true };
    }

    function refuse(reason, msg) {
      log.warn(`cannot arm: ${msg}`);
      return { ok: false, reason };
    }

    function disarm(reason) {
      if (!armed) return;
      log.info(`disarmed (${reason})`);
      armed = null;
      cancel();
      onChange();
    }

    // ---------------------------------------------------- immediate bids --
    function isOutbid(s) {
      if (s.bidCount === 0) return true; // nobody is winning yet
      const self = getSelfUserId();
      return self != null && s.highestBidderId != null && String(s.highestBidderId) !== String(self);
    }

    function isWinning(s) {
      const self = getSelfUserId();
      return s.bidCount > 0 && self != null && String(s.highestBidderId) === String(self);
    }

    function warnOnce(key, msg) {
      if (warned.has(key)) return;
      warned.add(key);
      if (warned.size > 500) warned.delete(warned.values().next().value);
      log.warn(msg);
    }

    /** Decide on an immediate bid (keep-winning / re-bid) and keep the end-time plan current. */
    function react() {
      if (!armed || inFlight) return;
      const s = store.get();
      if (s.auctionId !== armed.auctionId || !s.active) return cancel();
      const settings = getSettings();
      const mode = armed.mode;

      if (mode !== 'keep-winning') reschedule();
      else cancel();

      const outbid = isOutbid(s);
      if (!outbid) return;
      if (s.bidCount > 0 && getSelfUserId() == null) {
        return warnOnce(`self:${s.auctionId}`, 'cannot tell who is winning: our user id is unknown (reload the tab)');
      }
      if (Number.isInteger(s.nextBidMinor) && s.nextBidMinor > settings.maxBidMinor) {
        return warnOnce(
          `max:${s.auctionId}:${s.nextBidMinor}`,
          `max reached: next bid ${WBA.money.formatMoney(s.nextBidMinor, s.currency)} is above your maximum — not bidding`
        );
      }
      if (mode === 'keep-winning') return fireNow('keep-winning');
      if (mode === 'snipe-rebid' && sniped.has(s.auctionId) && s.endTime != null) {
        const remaining = s.endTime - clock.serverNow();
        const minRebid = Number.isFinite(settings.minRebidMs) ? settings.minRebidMs : 150;
        // Only inside the snipe window (a normal auction that moved its end is re-sniped by the plan).
        if (remaining >= minRebid && remaining <= settings.targetMs) return fireNow('rebid');
        if (remaining > 0 && remaining < minRebid) {
          warnOnce(`late:${s.auctionId}:${s.bidCount}`, `outbid with ${Math.round(remaining)}ms left (< ${minRebid}ms) — too late to re-bid`);
        }
      }
    }

    function fireNow(shot) {
      if (inFlight || pendingReact) return;
      pendingReact = true;
      // Leave the current store notification before bidding.
      queueMicrotask(() => {
        pendingReact = false;
        if (armed && !inFlight) shoot(shot, null);
      });
    }

    async function shoot(shot, p) {
      const settings = getSettings();
      inFlight = true;
      try {
        const lateMs = p ? performance.now() - p.firePerf : null;
        log.info(p ? `sniper fire (scheduler late by ${lateMs.toFixed(1)}ms)` : `auto-bid: ${shot}`);
        await executor.placeBid(armed.auctionId, settings.maxBidMinor, {
          trigger: 'auto',
          shot,
          expectedStreamId: armed.streamId,
          targetMs: p ? p.targetMs : null,
          plannedLateMs: p ? Math.round(lateMs * 10) / 10 : null,
        });
      } finally {
        inFlight = false;
      }
      onChange();
      react(); // state may have moved while the bid was in flight
    }

    // ------------------------------------------------- end-time snipe plan --
    function reschedule() {
      if (!armed || armed.mode === 'keep-winning') return cancel();
      const s = store.get();
      if (s.auctionId !== armed.auctionId || !s.active || s.endTime == null) return cancel();
      const targetMs = getSettings().targetMs;
      const key = `${s.auctionId}:${s.endTime}:${targetMs}`;
      if (fired.has(key)) return cancel(); // already fired for this end time
      if (plan && plan.key === key && (timer || spinning)) return; // unchanged

      const offset = clock.offsetMs();
      const fireEpochLocal = s.endTime - targetMs - offset;
      const firePerf = performance.now() + (fireEpochLocal - Date.now());
      const wasPlanned = plan != null;
      cancel();
      plan = { endTime: s.endTime, targetMs, firePerf, key };
      const wait = firePerf - performance.now();
      if (wasPlanned || wait > 0) {
        log.info(`sniper plan: fire at ${WBA.fmtTime(s.endTime - targetMs)} server (${Math.round(wait)}ms from now)`);
      }
      if (wait <= 0) {
        // Armed (or extended) inside the window: fire now if the auction has not ended.
        if (s.endTime - clock.serverNow() > 0) {
          log.info('already inside the bid window — firing now');
          plan.firePerf = performance.now();
          return fire();
        }
        return cancel();
      }
      timer = setTimeout(startSpin, Math.max(0, wait - SPIN_MS));
    }

    function startSpin() {
      timer = null;
      if (!plan) return;
      log.info('sniper preparation');
      spinning = true;
      tick();
    }

    function spinTick() {
      if (!spinning || !plan) return;
      const left = plan.firePerf - performance.now();
      if (left > BUSY_WAIT_MS) return tick();
      while (performance.now() < plan.firePerf) {
        /* final ≤1.5 ms: busy-wait for precision */
      }
      fire();
    }

    function fire() {
      const p = plan;
      spinning = false;
      if (!p || !armed) return;
      fired.add(p.key);
      if (fired.size > 500) fired.delete(fired.values().next().value);
      plan = null;
      sniped.add(armed.auctionId);
      if (sniped.size > 500) sniped.delete(sniped.values().next().value);
      if (inFlight) return log.warn('sniper fire skipped: another auto bid is still in flight');
      if (isWinning(store.get())) return log.info('sniper: you are already winning — no bid needed');
      shoot('snipe', p);
    }

    store.subscribe((event, state) => {
      if (!armed) return;
      if (event.type === 'reset') return disarm(event.reason);
      if (event.type === 'auction-changed') {
        // Never carry an arm over to a different auction unless explicitly configured,
        // and even then re-bind to the new id rather than keeping the old one.
        cancel();
        if (getSettings().keepArmedAcrossAuctions && state.auctionId) {
          armed = { auctionId: state.auctionId, streamId: store.getStreamId(), t: Date.now() };
          log.info(`re-armed on new auction ${state.auctionId} (keepArmedAcrossAuctions)`);
        } else disarm('auction changed');
        return;
      }
      if (state.ended) return disarm('auction ended');
      react();
    });

    return {
      arm,
      disarm,
      reschedule: () => react(),
      get armed() {
        return armed;
      },
      get plan() {
        return plan ? { endTime: plan.endTime, targetMs: plan.targetMs } : null;
      },
    };
  };
})(globalThis);
