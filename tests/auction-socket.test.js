// Replays a sanitized real capture of Whatnot's auction socket through the
// capture store -> auction-socket source -> state store pipeline.
const test = require('node:test');
const assert = require('node:assert/strict');
const WBA = require('./load');
const fixture = require('./fixtures/auction-socket-normal.json');

function setup(streamId = fixture.streamId) {
  const log = WBA.createLog({ consoleOut: false });
  const store = WBA.createAuctionStateStore({ log });
  const clock = WBA.createClock();
  const capture = WBA.createCaptureStore({ limit: 100, maxStoreChars: 1000, keyPattern: /x/, maxFields: 10 });
  const source = WBA.createAuctionSocketSource();
  capture.subscribe((entry, json) => source.onCapture(entry, json, { store, clock, log }));
  store.setStream(streamId);
  const replay = (onEach) => {
    for (const e of fixture.entries) {
      const { kind, ...payload } = e;
      const entry = capture.add(kind, payload);
      if (onEach) onEach(entry, JSON.parse(e.text || 'null'), store.get());
    }
  };
  return { log, store, clock, source, replay };
}

const frames = fixture.entries.filter((e) => e.kind === 'ws-in').map((e) => JSON.parse(e.text));
const started = frames.filter((f) => f[3] === 'auction_started').map((f) => f[4].product);

test('tracks a real normal auction from start to end', () => {
  const { store, replay } = setup();
  const seen = [];
  replay((entry, frame, s) => {
    if (frame) seen.push({ event: frame[3], s: JSON.parse(JSON.stringify(s)) });
  });

  // Joining showed a SOLD pinned product: no auction may be established from it.
  const joined = seen.find((x) => x.event === 'user_joined');
  assert.equal(joined.s.auctionId, null);

  const a1 = started[0];
  const atStart = seen.find((x) => x.event === 'auction_started').s;
  assert.equal(atStart.auctionId, a1.id);
  assert.equal(atStart.active, true);
  assert.equal(atStart.status, 'active');
  assert.equal(atStart.suddenDeath, false);
  assert.equal(atStart.currentBidMinor, 0, 'no bids yet');
  assert.equal(atStart.nextBidMinor, 100);
  assert.equal(atStart.currency, 'GBP');
  assert.equal(atStart.endTime, a1.auctionEndTime);
  assert.equal(atStart.bumpThresholdSeconds, 7);

  // The parent listing's product_updated must not disturb the auction.
  const afterParent = seen.find((x) => x.event === 'product_updated').s;
  assert.equal(afterParent.auctionId, a1.id);
  assert.equal(afterParent.active, true);

  // Last bid before the end: £30 high bid, £34 next, end time extended.
  const bids = seen.filter((x) => x.event === 'new_bid' && x.s.auctionId === a1.id);
  const last = bids[bids.length - 1].s;
  assert.equal(last.currentBidMinor, 3000);
  assert.equal(last.nextBidMinor, 3400);
  assert.ok(last.endTime > a1.auctionEndTime, 'late bids extended the end time');
  assert.ok(last.endTimeHistory.length > 1);
  assert.match(last.highestBidder, /^bidder/);

  const ended = seen.find((x) => x.event === 'auction_ended').s;
  assert.equal(ended.auctionId, a1.id);
  assert.equal(ended.ended, true);
  assert.equal(ended.active, false);
  assert.equal(ended.status, 'ended');
  assert.equal(store.isRetired(a1.id), true);

  // Next lot: new identity, everything reset.
  const a2 = started[1];
  const second = seen.filter((x) => x.event === 'auction_started')[1].s;
  assert.equal(second.auctionId, a2.id);
  assert.notEqual(a2.id, a1.id);
  assert.equal(second.currentBidMinor, 0);
  assert.equal(second.bidCount, 0);
  assert.equal(second.highestBidder, null);
  assert.equal(second.endTime, a2.auctionEndTime);
});

test('ignores frames for a different stream', () => {
  const { store, source, replay } = setup('some-other-stream');
  replay();
  assert.equal(store.get().auctionId, null);
  assert.ok(source.stats().ignored > 0);
});

test('server timestamps refine the clock and liveness is tracked', () => {
  const { store, clock, replay } = setup();
  replay();
  const c = clock.snapshot();
  assert.ok(c.samples > 10);
  assert.ok(c.sources.includes('server-timestamp'));
  assert.notEqual(store.get().lastAlivePerf, null);
});

// Builds a store tracking one live auction (fed through the source itself).
function liveAuction() {
  const log = WBA.createLog({ consoleOut: false });
  const store = WBA.createAuctionStateStore({ log });
  store.setStream(fixture.streamId);
  const src = WBA.createAuctionSocketSource();
  const ctx = { store, clock: WBA.createClock(), log };
  const url = fixture.entries[0].url;
  const send = (event, product) =>
    src.onCapture({ kind: 'ws-in', url, socket: 1, t: Date.now() }, [null, null, `commerce:${fixture.streamId}`, event, { product }], ctx);
  const product = (bidCount, cents) => ({
    id: 'lot-x',
    isAuctionActive: true,
    auctionEndTime: Date.now() + 9000,
    bidCount,
    highestBid: { priceCents: cents },
    nextBidPrice: { amount: cents + 100, currency: 'GBP' },
    livestreamId: fixture.streamId,
  });
  send('auction_started', product(0, 100));
  return { store, src, ctx, url, send, product };
}

test('socket close marks the state stale', () => {
  const { store, src, ctx, url } = liveAuction();
  assert.notEqual(store.get().lastAlivePerf, null);
  src.onCapture({ kind: 'ws-close', url, socket: 1, code: 1006 }, undefined, ctx);
  assert.equal(store.get().lastAlivePerf, null);
});

test('out-of-order older snapshot is ignored', () => {
  const { store, send, product } = liveAuction();
  send('new_bid', product(20, 5000));
  send('new_bid', product(19, 4000));
  assert.equal(store.get().currentBidMinor, 5000);
});

test('a live auction from the socket passes validation only within max', () => {
  const { store } = liveAuction();
  const base = {
    state: store.get(),
    expectedAuctionId: 'lot-x',
    streamId: fixture.streamId,
    expectedStreamId: fixture.streamId,
    serverNowMs: Date.now(),
    nowPerf: performance.now(),
    staleMs: WBA.constants.STALE_STATE_MS,
    requireArmed: false,
  };
  const ok = WBA.safety.validateBid({ ...base, maxBidMinor: 3000 });
  assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((c) => !c.ok)));
  assert.equal(ok.bidAmountMinor, 200);
  assert.equal(WBA.safety.validateBid({ ...base, maxBidMinor: 199 }).ok, false);
});

const bidsFx = require('./fixtures/auction-socket-bids.json');
function replayBids(streamId) {
  const log = WBA.createLog({ consoleOut: false });
  const store = WBA.createAuctionStateStore({ log });
  const clock = WBA.createClock();
  const capture = WBA.createCaptureStore({ limit: 10, maxStoreChars: 100, keyPattern: /x/, maxFields: 1 });
  const source = WBA.createAuctionSocketSource();
  capture.subscribe((entry, json) => source.onCapture(entry, json, { store, clock, log }));
  store.setStream(streamId);
  const seen = [];
  for (const e of bidsFx.entries) {
    const { kind, ...payload } = e;
    capture.add(kind, payload);
    const f = e.text ? JSON.parse(e.text) : null;
    if (f) seen.push({ kind, event: f[3], s: JSON.parse(JSON.stringify(store.get())) });
  }
  return { store, clock, source, seen };
}

test('real Sudden Death auction (joined 590ms before end) is recognised', () => {
  const { seen, source } = replayBids(bidsFx.sdStreamId);
  const joined = seen.find((x) => x.event === 'user_joined').s;
  assert.equal(joined.active, true);
  assert.equal(joined.suddenDeath, true);
  assert.equal(joined.endTimeExtends, false);
  assert.equal(joined.currentBidMinor, 1100);
  assert.equal(joined.nextBidMinor, 1300);
  const ended = seen.find((x) => x.event === 'auction_ended').s;
  assert.equal(ended.status, 'ended');
  assert.equal(source.stats().endLagsMs.length, 1);
  assert.equal(source.getSelfUserId(), '1000001');
});

test('real bids: own bid recognised, round trips tighten the clock', () => {
  const { seen, clock } = replayBids(bidsFx.bidStreamId);
  const bids = seen.filter((x) => x.event === 'new_bid');
  const mine = bids.filter((x) => x.s.highestBidderId === '1000001');
  assert.equal(mine.length, 2, 'both of our bids seen as highest');
  assert.equal(mine[0].s.currentBidMinor, 100);
  assert.equal(mine[1].s.currentBidMinor, 700);
  const c = clock.snapshot();
  assert.ok(c.sources.includes('round-trip'));
  assert.ok(c.hi - c.lo < 100, `offset interval ${c.lo}..${c.hi}`);

  // While we are the highest bidder, validation refuses to bid against ourselves.
  const s = mine[1].s;
  const v = WBA.safety.validateBid({
    state: { ...s, lastAlivePerf: 0 },
    expectedAuctionId: s.auctionId,
    streamId: bidsFx.bidStreamId,
    expectedStreamId: bidsFx.bidStreamId,
    maxBidMinor: 5000,
    serverNowMs: s.endTime - 3000,
    nowPerf: 0,
    staleMs: 15000,
    selfUserId: '1000001',
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.checks.filter((c) => !c.ok).map((c) => c.name), ['not-already-highest']);
});
