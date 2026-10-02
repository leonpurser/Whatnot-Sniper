const test = require('node:test');
const assert = require('node:assert/strict');
const WBA = require('./load');

const quietLog = () => WBA.createLog({ consoleOut: false });

test('money parsing and formatting', () => {
  assert.deepEqual(WBA.money.parseMoney('£18'), { minor: 1800, currency: 'GBP' });
  assert.deepEqual(WBA.money.parseMoney('£1,234.5'), { minor: 123450, currency: 'GBP' });
  assert.deepEqual(WBA.money.parseMoney('30'), { minor: 3000, currency: null });
  assert.equal(WBA.money.parseMoney('£18 bid'), null);
  assert.equal(WBA.money.parseMoney('$5£'), null);
  assert.equal(WBA.money.formatMoney(1905, 'GBP'), '£19.05');
  assert.equal(WBA.money.formatMoney(3000, 'GBP'), '£30');
});

function goodCtx(over = {}) {
  const state = {
    ...WBA.createEmptyAuctionState(),
    auctionId: 'A1',
    active: true,
    currentBidMinor: 2200,
    nextBidMinor: 2300,
    endTime: 10_000,
    lastAlivePerf: 1000,
    bidCount: 5,
    highestBidderId: '999',
  };
  return {
    state: { ...state, ...(over.state || {}) },
    expectedAuctionId: 'A1',
    streamId: 'S1',
    expectedStreamId: 'S1',
    maxBidMinor: 3000,
    serverNowMs: 9_500,
    nowPerf: 1500,
    staleMs: 3000,
    requireArmed: false,
    selfUserId: '1',
    ...over,
    ...(over.state ? { state: { ...state, ...over.state } } : {}),
  };
}

test('validateBid passes when everything is verified', () => {
  const v = WBA.safety.validateBid(goodCtx());
  assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)));
  assert.equal(v.bidAmountMinor, 2300);
  assert.equal(v.remainingMs, 500);
});

test('validateBid fails safe on every unknown or violated condition', () => {
  const cases = {
    'above max': [{ maxBidMinor: 2299 }, 'within-max'],
    'no max': [{ maxBidMinor: null }, 'max-set'],
    'auction changed': [{ state: { auctionId: 'B2' } }, 'auction-identity'],
    'no expected id': [{ expectedAuctionId: null }, 'auction-identity'],
    'stream changed': [{ streamId: 'S2' }, 'stream-matches'],
    inactive: [{ state: { active: false } }, 'auction-active'],
    ended: [{ state: { ended: true } }, 'auction-active'],
    stale: [{ nowPerf: 1000 + 3001 }, 'state-fresh'],
    'price unknown': [{ state: { currentBidMinor: null } }, 'price-known'],
    'next unknown': [{ state: { nextBidMinor: null } }, 'next-bid-known'],
    'next not above current': [{ state: { nextBidMinor: 2200 } }, 'next-bid-above-current'],
    'end unknown': [{ state: { endTime: null } }, 'end-time-known'],
    'already past end': [{ serverNowMs: 10_001 }, 'not-ended'],
    'auto but not armed': [{ requireArmed: true, armed: false, armedAuctionId: 'A1' }, 'armed'],
    'armed on other auction': [{ requireArmed: true, armed: true, armedAuctionId: 'A0' }, 'armed-auction-matches'],
    'already winning': [{ selfUserId: '999' }, 'not-already-highest'],
    'self unknown with bids': [{ selfUserId: null }, 'not-already-highest'],
    'high bidder unknown': [{ state: { highestBidderId: null } }, 'not-already-highest'],
  };
  for (const [name, [over, check]] of Object.entries(cases)) {
    const v = WBA.safety.validateBid(goodCtx(over));
    assert.equal(v.ok, false, name);
    assert.ok(v.checks.some((c) => c.name === check && !c.ok), `${name}: expected ${check} to fail`);
  }
});

test('state store resets on auction change and ignores retired auctions', () => {
  const store = WBA.createAuctionStateStore({ log: quietLog() });
  store.setStream('S1');
  const events = [];
  store.subscribe((e) => events.push(e.type));
  store.update({ auctionId: 'A', active: true, currentBidMinor: 1000, nextBidMinor: 1100, endTime: 5000, suddenDeath: true }, 't');
  assert.equal(store.get().status, 'active');
  store.update({ auctionId: 'B', active: true, currentBidMinor: 100 }, 't');
  const s = store.get();
  assert.equal(s.auctionId, 'B');
  assert.equal(s.nextBidMinor, null, 'stale next bid from A must be cleared');
  assert.equal(s.endTime, null, 'stale end time from A must be cleared');
  assert.equal(s.suddenDeath, null);
  assert.ok(events.includes('auction-changed'));
  // A late message for A must not switch back.
  assert.equal(store.update({ auctionId: 'A', currentBidMinor: 9999 }, 'late'), false);
  assert.equal(store.get().auctionId, 'B');
  assert.equal(store.get().currentBidMinor, 100);
});

test('state store rejects unknown fields and tracks end-time extensions', () => {
  const store = WBA.createAuctionStateStore({ log: quietLog() });
  store.setStream('S1');
  assert.equal(store.update({ auctionId: 'A', bogus: 1 }, 't'), false);
  store.update({ auctionId: 'A', active: true, endTime: 1000 }, 't');
  store.update({ auctionId: 'A', endTime: 16000 }, 't');
  assert.equal(store.get().endTimeHistory.length, 2);
  store.update({ auctionId: 'A', ended: true }, 't');
  assert.equal(store.get().status, 'ended');
  assert.equal(store.get().active, false);
  assert.equal(store.isRetired('A'), true);
});

test('stream change resets state', () => {
  const store = WBA.createAuctionStateStore({ log: quietLog() });
  store.setStream('S1');
  store.update({ auctionId: 'A', active: true }, 't');
  store.setStream('S2');
  assert.equal(store.get().auctionId, null);
  assert.equal(store.isRetired('A'), true);
});

test('clock intersects Date-header intervals', () => {
  const clock = WBA.createClock();
  const D = Date.parse('Fri, 02 Oct 2026 12:00:00 GMT');
  // Local clock is 2300ms behind the server. The server stamps whole seconds,
  // so both responses (server time D+10..D+110 and D+900..D+990) carry Date: D.
  clock.addDateSample(new Date(D).toUTCString(), D + 10 - 2300, D + 110 - 2300);
  const s1 = clock.snapshot();
  assert.ok(s1.lo <= 2300 && s1.hi >= 2300);
  clock.addDateSample(new Date(D).toUTCString(), D + 900 - 2300, D + 990 - 2300);
  const s2 = clock.snapshot();
  assert.ok(s2.lo <= 2300 && s2.hi >= 2300, JSON.stringify(s2));
  assert.ok(s2.hi - s2.lo < s1.hi - s1.lo, 'interval narrows');
});

test('discovery indexes auction-like keys and tolerates framing', () => {
  assert.deepEqual(WBA.discovery.tryParseJson('42["bid",{"a":1}]'), ['bid', { a: 1 }]);
  assert.equal(WBA.discovery.tryParseJson('hello'), undefined);
  const idx = new WBA.discovery.FieldIndex(WBA.constants.DISCOVERY_KEY_PATTERN);
  idx.add('ws x', { payload: { data: { auction: { currentBid: 1800, endsAt: 123 } } } }, 1);
  idx.add('ws x', { payload: { data: { auction: { currentBid: 1900, endsAt: 123 } } } }, 2);
  const f = idx.list().find((x) => x.path === 'payload.data.auction.currentBid');
  assert.equal(f.count, 2);
  assert.equal(f.changes, 1);
  assert.equal(f.lastValue, '1900');
  const hits = WBA.discovery.findValuePaths({ a: { price: 1800 } }, '£18', WBA.discovery.numericCandidatesFor('£18'));
  assert.deepEqual(hits, ['a.price = 1800']);
});

function makeExecutor(stateOver = {}, ctxOver = {}, sendBid) {
  const state = {
    ...WBA.createEmptyAuctionState(),
    auctionId: 'A1',
    active: true,
    currentBidMinor: 2200,
    nextBidMinor: 2300,
    currency: 'GBP',
    bidCount: 3,
    highestBidderId: '999',
    endTime: Date.now() + 5000,
    lastAlivePerf: performance.now(),
    ...stateOver,
  };
  const log = quietLog();
  const sent = [];
  const ex = WBA.createBidExecutor({
    log,
    getContext: () => ({ state, streamId: 'S1', serverNow: () => Date.now(), staleMs: 3000, armed: false, armedAuctionId: null, selfUserId: '1', dryRun: true, ...ctxOver }),
    sendBid: async (args) => {
      sent.push(args);
      return sendBid ? sendBid(args, state) : { sent: false, reason: 'NO_SENDER' };
    },
  });
  return { ex, log, sent, state };
}
const BID = { trigger: 'manual', expectedStreamId: 'S1' };
const okReply = (state) => ({
  sent: true,
  send: { t: Date.now(), p: performance.now() },
  reply: { t: Date.now() + 100, p: performance.now() + 100, status: 'ok', response: { serverTimestamps: { accepted: state.endTime - 4321, responded: state.endTime - 4300 } } },
});

test('executor dry-run logs WOULD BID, sends nothing and blocks duplicates', async () => {
  const { ex, log, sent } = makeExecutor();
  const r1 = await ex.placeBid('A1', 3000, BID);
  assert.equal(r1.ok, true);
  assert.equal(r1.reason, 'DRY_RUN');
  assert.equal(sent.length, 0);
  assert.ok(log.entries().some((e) => e.msg.includes('WOULD BID auction=A1')));
  assert.equal((await ex.placeBid('A1', 3000, BID)).reason, 'DUPLICATE');
});

test('executor live bid: sends exact next amount and records server timing', async () => {
  const { ex, sent } = makeExecutor({}, { dryRun: false }, (args, state) => okReply(state));
  const r = await ex.placeBid('A1', 3000, BID);
  assert.deepEqual(sent, [{ auctionId: 'A1', amountMinor: 2300, currency: 'GBP' }]);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ACCEPTED');
  assert.equal(r.serverRemainingMs, 4321);
  assert.equal(r.rttMs, 100);
  assert.equal((await ex.placeBid('A1', 3000, BID)).reason, 'DUPLICATE', 'never sends the same bid twice');
});

test('executor: not sent by page pre-check frees the slot; no reply is flagged unknown', async () => {
  let mode = 'moved';
  const { ex } = makeExecutor({}, { dryRun: false }, () =>
    mode === 'moved' ? { sent: false, reason: 'PRICE_MOVED', detail: 'page next=2400' } : { sent: true, send: { t: 1, p: 1 }, reply: null, reason: 'NO_REPLY' }
  );
  assert.equal((await ex.placeBid('A1', 3000, BID)).reason, 'NOT_SENT_PRICE_MOVED');
  mode = 'silent';
  const r = await ex.placeBid('A1', 3000, BID);
  assert.equal(r.reason, 'NO_REPLY');
  assert.equal(r.outcomeUnknown, true);
});

test('executor lock rejects concurrent bids', async () => {
  const { ex } = makeExecutor({}, { dryRun: false }, (args, state) => new Promise((res) => setTimeout(() => res(okReply(state)), 20)));
  const [a, b] = await Promise.all([ex.placeBid('A1', 3000, BID), ex.placeBid('A1', 3000, BID)]);
  assert.deepEqual([a.reason, b.reason].sort(), ['ACCEPTED', 'BID_IN_PROGRESS']);
});

test('executor aborts on wrong auction, over max or when already winning', async () => {
  let { ex, sent } = makeExecutor({}, { dryRun: false });
  assert.equal((await ex.placeBid('OTHER', 3000, BID)).reason, 'VALIDATION_FAILED');
  const over = await ex.placeBid('A1', 2000, BID);
  assert.ok(over.failed.includes('within-max'));
  ({ ex, sent } = makeExecutor({ highestBidderId: '1' }, { dryRun: false }));
  const mine = await ex.placeBid('A1', 3000, BID);
  assert.ok(mine.failed.includes('not-already-highest'));
  assert.equal(sent.length, 0);
});

test('sniper disarms when the auction changes', () => {
  const log = quietLog();
  const store = WBA.createAuctionStateStore({ log });
  store.setStream('S1');
  const settings = { ...WBA.constants.DEFAULT_SETTINGS, maxBidMinor: 3000 };
  const sniper = WBA.createSniper({ log, store, getSettings: () => settings, executor: { placeBid: async () => ({}) }, clock: WBA.createClock() });
  assert.equal(sniper.arm().ok, false, 'cannot arm without an auction');
  store.update({ auctionId: 'A', active: true, endTime: Date.now() + 60000 }, 't');
  assert.equal(sniper.arm().ok, true);
  assert.equal(sniper.armed.auctionId, 'A');
  store.update({ auctionId: 'B', active: true }, 't');
  assert.equal(sniper.armed, null);
});

test('sniper fires once at endTime - target, re-plans when the end time moves', async () => {
  const log = quietLog();
  const store = WBA.createAuctionStateStore({ log });
  store.setStream('S1');
  const settings = { ...WBA.constants.DEFAULT_SETTINGS, maxBidMinor: 3000, targetMs: 100 };
  const calls = [];
  const executor = {
    placeBid: async (id, max, opts) => {
      calls.push({ id, max, opts, remaining: store.get().endTime - Date.now() });
      return { ok: true };
    },
  };
  const sniper = WBA.createSniper({ log, store, getSettings: () => settings, executor, clock: WBA.createClock() });
  store.update({ auctionId: 'A', active: true, endTime: Date.now() + 300 }, 't');
  assert.equal(sniper.arm().ok, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls.length, 0, 'not yet');
  // A late bid extends the auction by 250ms: plan moves.
  store.update({ auctionId: 'A', endTime: store.get().endTime + 250 }, 't');
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(calls.length, 1, 'fired exactly once');
  const c = calls[0];
  assert.equal(c.id, 'A');
  assert.equal(c.opts.trigger, 'auto');
  assert.equal(c.opts.expectedStreamId, 'S1');
  assert.ok(c.remaining <= 105 && c.remaining >= 60, `fired ${c.remaining}ms before end`);
  assert.ok(c.opts.plannedLateMs < 15, `scheduler late ${c.opts.plannedLateMs}ms`);
  sniper.disarm('test');
});

test('sniper never fires after the auction changes', async () => {
  const log = quietLog();
  const store = WBA.createAuctionStateStore({ log });
  store.setStream('S1');
  const settings = { ...WBA.constants.DEFAULT_SETTINGS, maxBidMinor: 3000, targetMs: 100 };
  let calls = 0;
  const sniper = WBA.createSniper({ log, store, getSettings: () => settings, executor: { placeBid: async () => calls++ }, clock: WBA.createClock() });
  store.update({ auctionId: 'A', active: true, endTime: Date.now() + 200 }, 't');
  sniper.arm();
  store.update({ auctionId: 'B', active: true, endTime: Date.now() + 150 }, 't');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(calls, 0);
  assert.equal(sniper.armed, null);
});

test('clock round trips give a tight two-sided interval', () => {
  const clock = WBA.createClock();
  // Real numbers from a captured bid: sent 553974, accepted 554031, responded 554047, received 554139.
  clock.addRoundTrip(1790960553974, 1790960554139, 1790960554031, 1790960554047);
  const s = clock.snapshot();
  assert.equal(s.lo, -92);
  assert.equal(s.hi, 57);
});

test('a dry run does not block the live bid that follows it', async () => {
  const mode = { dryRun: true };
  const state = { ...WBA.createEmptyAuctionState(), auctionId: 'A1', active: true, currentBidMinor: 0, nextBidMinor: 100, currency: 'GBP', bidCount: 0, endTime: Date.now() + 5000, lastAlivePerf: performance.now() };
  const sent = [];
  const ex = WBA.createBidExecutor({
    log: quietLog(),
    getContext: () => ({ state, streamId: 'S1', serverNow: () => Date.now(), staleMs: 3000, selfUserId: '1', dryRun: mode.dryRun }),
    sendBid: async (a) => (sent.push(a), okReply(state)),
  });
  assert.equal((await ex.placeBid('A1', 3000, BID)).reason, 'DRY_RUN');
  mode.dryRun = false;
  assert.equal((await ex.placeBid('A1', 3000, BID)).reason, 'ACCEPTED');
  assert.equal(sent.length, 1);
});
