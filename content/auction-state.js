// The single source of truth for "what auction is running right now".
//
// Sources (content/sources/*) push partial updates via update(). The store:
//   * detects auction identity changes and resets ALL per-auction state,
//   * retires finished auctions so late/out-of-order messages for them are
//     ignored (an update for auction A can never leak into auction B),
//   * tracks end-time changes (normal auctions extend on late bids),
//   * logs every meaningful transition.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  WBA.createAuctionStateStore = function ({ log, now = () => Date.now(), perfNow = () => performance.now() }) {
    let state = WBA.createEmptyAuctionState();
    let streamId = null;
    const retired = new Set(); // auction ids that ended or were superseded
    const listeners = new Set();
    const fmtMoney = (m) => WBA.money.formatMoney(m, state.currency);

    function emit(event) {
      for (const fn of listeners) {
        try {
          fn(event, state);
        } catch (e) {
          console.error('[WBA] state listener failed', e);
        }
      }
    }

    function deriveStatus() {
      if (streamId == null) return WBA.STATUS.NO_STREAM;
      if (state.ended) return WBA.STATUS.ENDED;
      if (state.active) return WBA.STATUS.ACTIVE;
      return WBA.STATUS.IDLE;
    }

    function retire(id) {
      if (id == null) return;
      retired.add(id);
      if (retired.size > 500) retired.delete(retired.values().next().value);
    }

    function reset(reason) {
      const prev = state.auctionId;
      retire(prev);
      state = WBA.createEmptyAuctionState();
      state.status = deriveStatus();
      log.info(`state reset (${reason})${prev ? ` — retired auction ${prev}` : ''}`);
      emit({ type: 'reset', reason, prevAuctionId: prev });
    }

    /**
     * Apply a partial update from a source.
     * @returns {boolean} whether anything was applied
     */
    function update(partial, source) {
      if (!partial || typeof partial !== 'object') return false;
      for (const k of Object.keys(partial)) {
        if (!WBA.AUCTION_FIELDS.includes(k)) {
          log.warn(`source ${source} sent unknown field "${k}" — update rejected`);
          return false;
        }
      }

      const id = partial.auctionId;
      if (id != null && retired.has(id)) {
        log.info(`ignored late update for retired auction ${id} from ${source}`);
        return false;
      }
      if (id != null && id !== state.auctionId) {
        const prev = state.auctionId;
        retire(prev);
        state = WBA.createEmptyAuctionState();
        state.auctionId = id;
        log.info(`Auction detected: ${id}${prev ? ` (replaces ${prev})` : ''} [${source}]`);
        emit({ type: 'auction-changed', prevAuctionId: prev, auctionId: id });
      }

      const t = now();
      let changed = false;
      for (const [k, v] of Object.entries(partial)) {
        if (k === 'auctionId' || v === undefined) continue;
        const old = state[k];
        if (old === v) {
          state.fieldSources[k] = { source, t };
          continue;
        }
        state[k] = v;
        state.fieldSources[k] = { source, t };
        changed = true;
        logChange(k, old, v, source);
        if (k === 'endTime') {
          state.endTimeHistory.push({ t, endTime: v, source });
          if (state.endTimeHistory.length > 50) state.endTimeHistory.shift();
        }
      }

      if (partial.ended === true) {
        state.active = false;
      }
      state.lastUpdate = t;
      state.lastUpdatePerf = perfNow();
      state.lastAlivePerf = state.lastUpdatePerf;
      const status = deriveStatus();
      if (status !== state.status) {
        log.info(`status ${state.status} -> ${status}`);
        state.status = status;
        changed = true;
      }
      if (state.ended) retire(state.auctionId);
      emit({ type: 'update', source, changed });
      return true;
    }

    const QUIET_FIELDS = new Set(['bidCount', 'highestBidder', 'bumpThresholdSeconds', 'bumpValueSeconds', 'currency']);

    function logChange(k, old, v, source) {
      if (QUIET_FIELDS.has(k)) return;
      const tag = `[${source}]`;
      if (k === 'currentBidMinor') {
        const who = state.highestBidder ? ` by ${state.highestBidder}` : '';
        log.info(`bid update ${fmtMoney(old)} -> ${fmtMoney(v)}${who} ${tag}`);
      }
      else if (k === 'nextBidMinor') log.info(`next bid ${fmtMoney(v)} ${tag}`);
      else if (k === 'endTime') {
        const delta = old != null && v != null ? ` (${v - old >= 0 ? '+' : ''}${v - old}ms)` : '';
        log.info(`endTime=${WBA.fmtTime(v)}${delta} ${tag}`);
      } else log.info(`${k}=${JSON.stringify(v)} ${tag}`);
    }

    /** The source is alive (e.g. heartbeat reply) even though no auction data changed. */
    function touch() {
      state.lastAlivePerf = perfNow();
    }

    /** The source lost its connection: state can no longer be trusted as current. */
    function markDead(source, reason) {
      if (state.lastAlivePerf == null) return;
      state.lastAlivePerf = null;
      log.warn(`source ${source} down (${reason}) — state treated as stale`);
      emit({ type: 'update', source, changed: true });
    }

    function setStream(id) {
      if (id === streamId) return;
      const prev = streamId;
      streamId = id;
      log.info(id ? `stream detected: ${id}` : `left stream ${prev}`);
      reset(id ? 'stream changed' : 'left stream');
    }

    return {
      update,
      touch,
      markDead,
      reset,
      setStream,
      getStreamId: () => streamId,
      get: () => state,
      isRetired: (id) => retired.has(id),
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  };
})(globalThis);
