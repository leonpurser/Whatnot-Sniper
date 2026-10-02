// Sniper / timing engine.
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

  WBA.createSniper = function ({ log, store, getSettings, executor, clock, isLive = () => false, onChange = () => {} }) {
    let armed = null; // { auctionId, streamId, t }
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
      armed = { auctionId: s.auctionId, streamId, t: Date.now() };
      const kind = s.suddenDeath === true ? 'SUDDEN DEATH' : s.suddenDeath === false ? 'NORMAL (late bids extend the timer)' : 'unknown type';
      log.info(`ARMED on ${s.auctionId} [${kind}] target=${settings.targetMs}ms max=${WBA.money.formatMoney(settings.maxBidMinor, s.currency)}${isLive() ? ' — LIVE' : ' (dry run)'}`);
      if (typeof document !== 'undefined' && document.hidden) log.warn('tab is hidden: Chrome throttles timers in background tabs — keep the stream tab visible');
      reschedule();
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

    function reschedule() {
      if (!armed) return cancel();
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
        if (s.endTime - clock.serverNow() > 0) return fire();
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

    async function fire() {
      const p = plan;
      spinning = false;
      if (!p || !armed) return;
      fired.add(p.key);
      if (fired.size > 500) fired.delete(fired.values().next().value);
      plan = null;
      const lateMs = performance.now() - p.firePerf;
      log.info(`sniper fire (scheduler late by ${lateMs.toFixed(1)}ms)`);
      const settings = getSettings();
      await executor.placeBid(armed.auctionId, settings.maxBidMinor, {
        trigger: 'auto',
        expectedStreamId: armed.streamId,
        targetMs: p.targetMs,
        plannedLateMs: Math.round(lateMs * 10) / 10,
      });
      onChange();
      reschedule(); // normal auctions: a new end time may need another shot
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
      reschedule();
    });

    return {
      arm,
      disarm,
      reschedule,
      get armed() {
        return armed;
      },
      get plan() {
        return plan ? { endTime: plan.endTime, targetMs: plan.targetMs } : null;
      },
    };
  };
})(globalThis);
