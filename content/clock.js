// Server/client clock offset estimation.
//
// offset = serverTime - localTime (epoch ms). serverNow() = Date.now() + offset.
//
// Each observation constrains the offset to an interval; we intersect the
// intervals so the estimate tightens over time:
//   * HTTP Date header (1 s resolution): the server stamped it at some local
//     time in [requestStart, responseEnd] with a value in [D, D+1000), so
//     offset ∈ [D - end, D + 1000 - start].
//   * A server timestamp S in a pushed message received at local time R:
//     S was generated before R, so server time at R is ≥ S, giving
//     offset ≥ S - R (a lower bound only; the latency is unknown).
//   * A request sent at local Ts, accepted by the server at A, replied at R and
//     received at local Tr: offset ∈ [R - Tr, A - Ts] (two-sided, usually tight).
// If the intersection becomes empty (clock jump, cached Date header) we reset
// to the newest sample.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  WBA.createClock = function () {
    let lo = -Infinity;
    let hi = Infinity;
    let samples = 0;
    let resets = 0;
    let rejected = 0;
    const sources = new Set();

    function constrain(sLo, sHi, source) {
      const nLo = Math.max(lo, sLo);
      const nHi = Math.min(hi, sHi);
      if (nLo > nHi) {
        // Conflict. A two-sided sample (HTTP Date) is self-contained, so restart
        // from it (clock jump, or an earlier cached Date). A one-sided sample
        // (server timestamp) cannot be trusted over the existing interval.
        if (!Number.isFinite(sLo) || !Number.isFinite(sHi)) {
          rejected++;
          return;
        }
        lo = sLo;
        hi = sHi;
        resets++;
      } else {
        lo = nLo;
        hi = nHi;
      }
      samples++;
      sources.add(source);
    }

    return {
      addDateSample(header, startEpoch, endEpoch) {
        const d = Date.parse(header);
        if (!Number.isFinite(d) || !Number.isFinite(startEpoch) || !Number.isFinite(endEpoch)) return false;
        constrain(d - endEpoch, d + 1000 - startEpoch, 'http-date');
        return true;
      },
      addRoundTrip(sendEpoch, recvEpoch, acceptedMs, respondedMs) {
        if (![sendEpoch, recvEpoch, acceptedMs, respondedMs].every(Number.isFinite)) return false;
        constrain(respondedMs - recvEpoch, acceptedMs - sendEpoch, 'round-trip');
        return true;
      },
      addServerTimestamp(serverMs, recvEpoch) {
        if (!Number.isFinite(serverMs) || !Number.isFinite(recvEpoch)) return false;
        constrain(serverMs - recvEpoch, Infinity, 'server-timestamp');
        return true;
      },
      /** Best offset estimate in ms (0 when nothing is known). */
      offsetMs() {
        if (!samples) return 0;
        if (Number.isFinite(lo) && Number.isFinite(hi)) return (lo + hi) / 2;
        if (Number.isFinite(lo)) return lo;
        if (Number.isFinite(hi)) return hi;
        return 0;
      },
      serverNow() {
        return Date.now() + this.offsetMs();
      },
      snapshot() {
        const bounded = Number.isFinite(lo) && Number.isFinite(hi);
        return {
          offsetMs: Math.round(this.offsetMs()),
          uncertaintyMs: bounded ? Math.round((hi - lo) / 2) : null,
          lo: Number.isFinite(lo) ? Math.round(lo) : null,
          hi: Number.isFinite(hi) ? Math.round(hi) : null,
          samples,
          resets,
          rejected,
          sources: Array.from(sources),
        };
      },
    };
  };
})(globalThis);
