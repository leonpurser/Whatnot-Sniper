// Bid executor. The timing engine and the UI only ever call placeBid(); how a
// bid is physically executed lives entirely in performBidAction().
//
// MILESTONE 1: performBidAction() is deliberately NOT implemented. We have not
// yet inspected how the real Whatnot page performs a bid, so this module can
// validate and dry-run, but it cannot place a real bid under any settings.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  WBA.createBidExecutor = function ({ log, getContext }) {
    let bidInProgress = false;
    const firedKeys = new Set(); // `${auctionId}:${amount}` already submitted (real or dry)
    let lastAttempt = null;

    async function performBidAction(/* auctionId, amountMinor */) {
      // To be implemented after inspecting the real bid interaction (see docs/INSPECTION.md).
      return { ok: false, reason: 'EXECUTOR_NOT_IMPLEMENTED' };
    }

    /**
     * @param {string} expectedAuctionId
     * @param {number} maxBidMinor
     * @param {{ trigger: 'manual'|'auto', expectedStreamId: string, targetMs?: number }} opts
     */
    async function placeBid(expectedAuctionId, maxBidMinor, opts = {}) {
      const trigger = opts.trigger || 'manual';
      if (bidInProgress) {
        log.warn('bid rejected: another bid is in progress');
        return record({ ok: false, reason: 'BID_IN_PROGRESS', trigger, expectedAuctionId });
      }
      bidInProgress = true;
      try {
        const ctx = getContext();
        const tValidate = performance.now();
        const v = WBA.safety.validateBid({
          state: ctx.state,
          expectedAuctionId,
          streamId: ctx.streamId,
          expectedStreamId: opts.expectedStreamId ?? null,
          maxBidMinor,
          serverNowMs: ctx.serverNow(),
          nowPerf: tValidate,
          staleMs: ctx.staleMs,
          requireArmed: trigger === 'auto',
          armed: ctx.armed,
          armedAuctionId: ctx.armedAuctionId,
        });
        const base = {
          trigger,
          expectedAuctionId,
          amountMinor: v.bidAmountMinor,
          currentMinor: ctx.state.currentBidMinor,
          maxBidMinor,
          remainingMs: v.remainingMs,
          targetMs: opts.targetMs ?? null,
          checks: v.checks,
          dryRun: ctx.dryRun,
        };
        if (!v.ok) {
          const failed = v.checks.filter((c) => !c.ok).map((c) => c.name);
          log.warn(`bid ABORTED — failed checks: ${failed.join(', ')}`);
          return record({ ...base, ok: false, reason: 'VALIDATION_FAILED', failed });
        }

        const key = `${expectedAuctionId}:${v.bidAmountMinor}`;
        if (firedKeys.has(key)) {
          log.warn(`bid ABORTED — already submitted ${key}`);
          return record({ ...base, ok: false, reason: 'DUPLICATE' });
        }
        firedKeys.add(key);
        if (firedKeys.size > 1000) firedKeys.delete(firedKeys.values().next().value);

        const cur = ctx.state.currency;
        if (ctx.dryRun) {
          log.info(
            `WOULD BID auction=${expectedAuctionId} current=${WBA.money.formatMoney(base.currentMinor, cur)} ` +
              `bid=${WBA.money.formatMoney(v.bidAmountMinor, cur)} max=${WBA.money.formatMoney(maxBidMinor, cur)} ` +
              `target=${base.targetMs ?? '—'}ms triggered=${Math.round(v.remainingMs)}ms before end`
          );
          return record({ ...base, ok: true, reason: 'DRY_RUN' });
        }

        log.info(`BID TRIGGERED ${WBA.money.formatMoney(v.bidAmountMinor, cur)} on ${expectedAuctionId}`);
        const tStart = performance.now();
        const result = await performBidAction(expectedAuctionId, v.bidAmountMinor);
        const latency = performance.now() - tStart;
        if (!result.ok) log.warn(`bid not executed: ${result.reason}`);
        return record({ ...base, ...result, latencyMs: Math.round(latency) });
      } catch (e) {
        log.error('bid executor error — aborted', String(e));
        return record({ ok: false, reason: 'EXCEPTION', error: String(e), trigger, expectedAuctionId });
      } finally {
        bidInProgress = false;
      }
    }

    function record(r) {
      lastAttempt = { t: Date.now(), ...r };
      return lastAttempt;
    }

    return { placeBid, getLastAttempt: () => lastAttempt, isBusy: () => bidInProgress };
  };
})(globalThis);
