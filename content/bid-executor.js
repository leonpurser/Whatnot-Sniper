// Bid executor. The timing engine and the UI only ever call placeBid(); how a
// bid is physically executed is the injected sendBid() (today: the page hook's
// place_bid push on Whatnot's own auction socket — see page/page-hook.js).
//
// Two kinds of bid:
//   manual (BID NOW)  behaves like Whatnot's own bid button: always real, bids the
//                     next amount, no user maximum.
//   auto (sniper)     needs the sniper armed on this auction, enforces the user
//                     maximum, and is dry-run unless live mode is on.
//
// Order of operations for every bid:
//   lock → validate every safety check → dedupe → dry-run? log : sendBid
//   → (page hook re-checks auction id / active / exact next price at send time)
//   → record timings and the server's verdict.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  WBA.createBidExecutor = function ({ log, getContext, sendBid }) {
    let bidInProgress = false;
    const firedKeys = new Set(); // `${mode}:${auctionId}:${amount}` already sent (live) or logged (dry run)
    const history = []; // recent attempts, newest first
    let lastAttempt = null;

    /**
     * @param {string} expectedAuctionId
     * @param {number|null} maxBidMinor  required for auto bids, ignored for manual ones
     * @param {{ trigger: 'manual'|'auto', expectedStreamId: string, targetMs?: number, plannedLateMs?: number }} opts
     */
    async function placeBid(expectedAuctionId, maxBidMinor, opts = {}) {
      const trigger = opts.trigger || 'manual';
      if (bidInProgress) {
        log.warn('bid rejected: another bid is in progress');
        return record({ ok: false, reason: 'BID_IN_PROGRESS', trigger, expectedAuctionId });
      }
      bidInProgress = true;
      try {
        const auto = trigger === 'auto';
        const ctx = { ...getContext() };
        if (!auto) {
          ctx.dryRun = false; // a manual click is a real bid, exactly like Whatnot's button
          maxBidMinor = null;
        }
        const tValidate = performance.now();
        const serverNow = ctx.serverNow();
        const v = WBA.safety.validateBid({
          state: ctx.state,
          expectedAuctionId,
          streamId: ctx.streamId,
          expectedStreamId: opts.expectedStreamId ?? null,
          maxBidMinor,
          serverNowMs: serverNow,
          nowPerf: tValidate,
          staleMs: ctx.staleMs,
          requireArmed: auto,
          enforceMax: auto,
          armed: ctx.armed,
          armedAuctionId: ctx.armedAuctionId,
          selfUserId: ctx.selfUserId,
        });
        const s = ctx.state;
        const base = {
          trigger,
          shot: opts.shot || null,
          expectedAuctionId,
          suddenDeath: s.suddenDeath,
          amountMinor: v.bidAmountMinor,
          currentMinor: s.currentBidMinor,
          currency: s.currency,
          maxBidMinor,
          endTime: s.endTime,
          remainingMs: v.remainingMs == null ? null : Math.round(v.remainingMs),
          targetMs: opts.targetMs ?? null,
          plannedLateMs: opts.plannedLateMs ?? null,
          clockUncertaintyMs: ctx.clockUncertaintyMs ?? null,
          checks: v.checks,
          dryRun: ctx.dryRun,
        };
        if (!v.ok) {
          const failed = v.checks.filter((c) => !c.ok).map((c) => c.name);
          log.warn(`bid ABORTED — failed checks: ${failed.join(', ')}`);
          return record({ ...base, ok: false, reason: 'VALIDATION_FAILED', failed });
        }

        // Dry runs and live bids are deduplicated separately: a rehearsal must not
        // block the real bid that follows it.
        const key = `${ctx.dryRun ? 'dry' : 'live'}:${expectedAuctionId}:${v.bidAmountMinor}`;
        if (firedKeys.has(key)) {
          log.warn(`bid ABORTED — already submitted ${key}`);
          return record({ ...base, ok: false, reason: 'DUPLICATE' });
        }
        firedKeys.add(key);
        if (firedKeys.size > 1000) firedKeys.delete(firedKeys.values().next().value);

        const fm = (m) => WBA.money.formatMoney(m, s.currency);
        if (ctx.dryRun) {
          log.info(
            `DRY RUN — nothing sent. WOULD BID auction=${expectedAuctionId} current=${fm(base.currentMinor)} bid=${fm(v.bidAmountMinor)} ` +
              `max=${fm(maxBidMinor)} target=${base.targetMs ?? '—'}ms triggered=${base.remainingMs}ms before end`
          );
          return record({ ...base, ok: true, reason: 'DRY_RUN' });
        }

        log.info(`BID TRIGGERED ${fm(v.bidAmountMinor)} on ${expectedAuctionId} (${base.remainingMs}ms before end)`);
        const r = await sendBid({ auctionId: expectedAuctionId, amountMinor: v.bidAmountMinor, currency: s.currency });
        if (!r || !r.sent) {
          firedKeys.delete(key); // nothing left the browser; a later attempt is allowed
          const reason = `NOT_SENT_${(r && r.reason) || 'UNKNOWN'}`;
          log.warn(`bid not sent: ${reason}${r && r.detail ? ' (' + r.detail + ')' : ''}`);
          return record({ ...base, ok: false, reason, detail: r && r.detail });
        }
        return record({ ...base, ...interpret(r, base) });
      } catch (e) {
        log.error('bid executor error — aborted', String(e));
        return record({ ok: false, reason: 'EXCEPTION', error: String(e), trigger, expectedAuctionId });
      } finally {
        bidInProgress = false;
      }
    }

    /** Turn the page hook's send/reply record into a result with timing metrics. */
    function interpret(r, base) {
      const out = { sentAt: r.send ? r.send.t : null };
      if (!r.reply) {
        // The frame left the browser but no reply arrived: the bid MAY have been placed.
        log.warn('bid sent but NO REPLY — outcome unknown, check the stream');
        return { ...out, ok: false, reason: 'NO_REPLY', outcomeUnknown: true };
      }
      const rtt = r.reply.p - r.send.p;
      const st = (r.reply.response && r.reply.response.serverTimestamps) || {};
      const accepted = Number.isFinite(st.accepted) ? st.accepted : null;
      Object.assign(out, {
        replyAt: r.reply.t,
        rttMs: Math.round(rtt),
        serverAccepted: accepted,
        // Exact, clock-independent: how far before the (then) end time the server took the bid.
        serverRemainingMs: accepted != null && base.endTime != null ? base.endTime - accepted : null,
        response: r.reply.response,
      });
      const ok = r.reply.status === 'ok';
      const timing = `rtt=${out.rttMs}ms server-remaining=${out.serverRemainingMs ?? '?'}ms`;
      if (ok) log.info(`bid acknowledgement OK ${timing}`);
      else log.warn(`bid REJECTED status=${r.reply.status} ${timing}`, r.reply.response);
      return { ...out, ok, reason: ok ? 'ACCEPTED' : 'REJECTED' };
    }

    function record(r) {
      lastAttempt = { t: Date.now(), ...r };
      history.unshift(lastAttempt);
      if (history.length > 50) history.pop();
      return lastAttempt;
    }

    return {
      placeBid,
      getLastAttempt: () => lastAttempt,
      getHistory: () => history.slice(),
      isBusy: () => bidInProgress,
    };
  };
})(globalThis);
