// Auction-state source: Whatnot's auction WebSocket.
//
// Verified from a live capture (normal auctions only so far):
//   socket  wss://www.whatnot.com/services/auction/socket/websocket  (Phoenix channels)
//   frame   [joinRef, ref, topic, event, payload]   (Phoenix v2 JSON serializer)
//   topic   "commerce:<livestreamId>"  — livestreamId is the id in /live/<id>
//   events  auction_started, new_bid, auction_ended, product_updated,
//           payment_succeeded, user_joined (payload.pinnedProduct on join),
//           phx_reply (heartbeat replies on topic "phoenix" every ~10 s;
//           join replies carry response.serverTimestamps)
//   payload.product (payload.pinnedProduct for user_joined):
//     id                   the auction (a new id per lot; parentId = the listing)
//     name                 item title
//     isAuctionActive      bool
//     auctionEndTime       server epoch ms; extended by bids in the last
//                          bumpThresholdSeconds to bid time + bumpValueSeconds
//     isSuddenDeath        bool
//     highestBid.priceCents, nextBidPrice {amount,currency} / nextBidCents
//     bidCount, livestreamId, status (ACTIVE / SOLD)
//   payload.timestamp      server epoch ms on auction_started / new_bid
//
// The parent listing also gets product_updated (isAuctionActive=false,
// different id) right after auction_started; that must not touch the auction.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  const NAME = 'auction-socket';
  const SOCKET_PATH = /^wss:\/\/(?:www\.)?whatnot\.com\/services\/auction\/socket\/websocket/;
  const PRODUCT_EVENTS = new Set(['auction_started', 'new_bid', 'auction_ended', 'product_updated', 'payment_succeeded', 'user_joined']);

  function createSource() {
    let socketId = null; // which page socket is the auction socket
    const lastBidCount = new Map(); // auctionId -> highest bidCount applied (guards out-of-order frames)
    const stats = { frames: 0, lastEvent: null, lastEventT: null, lastLatencyMs: null, ignored: 0, socketOpen: false };

    function money(obj) {
      return obj && Number.isInteger(obj.amount) ? obj.amount : null;
    }

    /** Map a Whatnot product object to a partial auction-state update. */
    function toUpdate(pr, event) {
      const hb = pr.highestBid;
      let current = hb && Number.isInteger(hb.priceCents) ? hb.priceCents : money(hb && hb.price);
      // No bids yet: current is 0 and the next bid is the starting price.
      if (current == null && pr.bidCount === 0 && hb == null) current = 0;
      const next = money(pr.nextBidPrice) ?? (Number.isInteger(pr.nextBidCents) ? pr.nextBidCents : null);
      const currency =
        (pr.nextBidPrice && pr.nextBidPrice.currency) ||
        (hb && hb.price && hb.price.currency) ||
        (pr.auctionMinimumPrice && pr.auctionMinimumPrice.currency) ||
        undefined;
      const ended = event === 'auction_ended' || pr.isAuctionActive === false;
      const u = {
        auctionId: pr.id,
        itemName: typeof pr.name === 'string' ? pr.name : undefined,
        active: pr.isAuctionActive === true && !ended,
        ended,
        currentBidMinor: current ?? undefined,
        nextBidMinor: next ?? undefined,
        currency,
        endTime: Number.isFinite(pr.auctionEndTime) ? pr.auctionEndTime : undefined,
        suddenDeath: typeof pr.isSuddenDeath === 'boolean' ? pr.isSuddenDeath : undefined,
        bidCount: Number.isInteger(pr.bidCount) ? pr.bidCount : undefined,
        bumpThresholdSeconds: Number.isFinite(pr.bumpThresholdSeconds) ? pr.bumpThresholdSeconds : undefined,
        bumpValueSeconds: Number.isFinite(pr.bumpValueSeconds) ? pr.bumpValueSeconds : undefined,
      };
      for (const k of Object.keys(u)) if (u[k] === undefined) delete u[k];
      return u;
    }

    function onCapture(entry, json, { store, clock }) {
      if (!SOCKET_PATH.test(entry.url || '')) return;

      if (entry.kind === 'ws-open') {
        socketId = entry.socket;
        stats.socketOpen = true;
        return;
      }
      if (entry.kind === 'ws-close') {
        if (entry.socket === socketId) {
          stats.socketOpen = false;
          store.markDead(NAME, `socket closed code=${entry.code}`);
        }
        return;
      }
      if (entry.kind !== 'ws-in' || !Array.isArray(json) || json.length !== 5) return;
      socketId = entry.socket;
      stats.socketOpen = true;
      stats.frames++;

      const [, , topic, event, payload] = json;
      const streamId = store.getStreamId();

      if (topic === 'phoenix') {
        // Heartbeat reply: the socket is alive, auction state is still current.
        if (streamId) store.touch();
        return;
      }
      if (typeof topic !== 'string' || !topic.startsWith('commerce:')) return;
      const topicStream = topic.slice('commerce:'.length);
      if (!streamId || topicStream !== streamId) {
        stats.ignored++; // a channel for another (previous) stream
        return;
      }
      store.touch();

      if (payload && typeof payload === 'object') {
        const st = payload.response && payload.response.serverTimestamps;
        if (st && Number.isFinite(st.responded)) clock.addServerTimestamp(st.responded, entry.t);
        if (Number.isFinite(payload.timestamp) && (event === 'new_bid' || event === 'auction_started')) {
          clock.addServerTimestamp(payload.timestamp, entry.t);
          stats.lastLatencyMs = Math.round(entry.t + clock.offsetMs() - payload.timestamp);
        }
      }
      if (!PRODUCT_EVENTS.has(event) || !payload) return;
      stats.lastEvent = event;
      stats.lastEventT = entry.t;

      const pr = event === 'user_joined' ? payload.pinnedProduct : payload.product;
      if (!pr || typeof pr !== 'object' || typeof pr.id !== 'string') return;
      if (pr.livestreamId && pr.livestreamId !== streamId) {
        stats.ignored++;
        return;
      }

      if (store.isRetired(pr.id)) return; // e.g. payment_succeeded after auction_ended
      const current = store.get().auctionId;
      const isCurrent = pr.id === current;
      // Only a live auction may establish a new auction identity; inactive
      // products (parent listing updates, sold items on join) only matter when
      // they are the auction we are already tracking.
      const isLiveAuction = pr.isAuctionActive === true && Number.isFinite(pr.auctionEndTime);
      if (!isCurrent && !isLiveAuction) {
        stats.ignored++;
        return;
      }

      const bc = Number.isInteger(pr.bidCount) ? pr.bidCount : null;
      const prevBc = lastBidCount.get(pr.id);
      if (bc != null && prevBc != null && bc < prevBc && event !== 'auction_ended') {
        stats.ignored++; // out-of-order (older) snapshot
        return;
      }
      if (bc != null) lastBidCount.set(pr.id, bc);
      if (lastBidCount.size > 200) lastBidCount.delete(lastBidCount.keys().next().value);

      const update = toUpdate(pr, event);
      if (event === 'new_bid' && payload.highestBidder && typeof payload.highestBidder.username === 'string') {
        update.highestBidder = payload.highestBidder.username;
      }
      store.update(update, `${NAME}:${event}`);
    }

    return { name: NAME, onCapture, stats: () => ({ ...stats }) };
  }

  WBA.createAuctionSocketSource = createSource;
  if (WBA.sources) WBA.sources.register(createSource());
})(globalThis);
