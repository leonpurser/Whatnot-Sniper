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
    lastUpdatePerf: 1000,
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

function makeExecutor(stateOver = {}, ctxOver = {}) {
  const state = { ...WBA.createEmptyAuctionState(), auctionId: 'A1', active: true, currentBidMinor: 2200, nextBidMinor: 2300, endTime: Date.now() + 5000, lastUpdatePerf: performance.now(), ...stateOver };
  const log = quietLog();
  const ex = WBA.createBidExecutor({
    log,
    getContext: () => ({ state, streamId: 'S1', serverNow: () => Date.now(), staleMs: 3000, armed: false, armedAuctionId: null, dryRun: true, ...ctxOver }),
  });
  return { ex, log };
}

test('executor dry-run logs WOULD BID and blocks duplicates', async () => {
  const { ex, log } = makeExecutor();
  const r1 = await ex.placeBid('A1', 3000, { trigger: 'manual', expectedStreamId: 'S1' });
  assert.equal(r1.ok, true);
  assert.equal(r1.reason, 'DRY_RUN');
  assert.ok(log.entries().some((e) => e.msg.startsWith('WOULD BID auction=A1')));
  const r2 = await ex.placeBid('A1', 3000, { trigger: 'manual', expectedStreamId: 'S1' });
  assert.equal(r2.reason, 'DUPLICATE');
});

test('executor lock rejects concurrent bids', async () => {
  // Non-dry-run awaits the (unimplemented) action, so the first call holds the lock.
  const { ex } = makeExecutor({}, { dryRun: false });
  const [a, b] = await Promise.all([
    ex.placeBid('A1', 3000, { trigger: 'manual', expectedStreamId: 'S1' }),
    ex.placeBid('A1', 3000, { trigger: 'manual', expectedStreamId: 'S1' }),
  ]);
  assert.deepEqual([a.reason, b.reason].sort(), ['BID_IN_PROGRESS', 'EXECUTOR_NOT_IMPLEMENTED']);
});

test('executor never places a real bid in milestone 1', async () => {
  const { ex } = makeExecutor({}, { dryRun: false });
  const r = await ex.placeBid('A1', 3000, { trigger: 'manual', expectedStreamId: 'S1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'EXECUTOR_NOT_IMPLEMENTED');
});

test('executor aborts on wrong auction or over max', async () => {
  let { ex } = makeExecutor();
  assert.equal((await ex.placeBid('OTHER', 3000, { trigger: 'manual', expectedStreamId: 'S1' })).reason, 'VALIDATION_FAILED');
  ({ ex } = makeExecutor());
  const r = await ex.placeBid('A1', 2000, { trigger: 'manual', expectedStreamId: 'S1' });
  assert.equal(r.reason, 'VALIDATION_FAILED');
  assert.ok(r.failed.includes('within-max'));
});

test('sniper disarms when the auction changes', () => {
  const log = quietLog();
  const store = WBA.createAuctionStateStore({ log });
  store.setStream('S1');
  const settings = { ...WBA.constants.DEFAULT_SETTINGS };
  const sniper = WBA.createSniper({ log, store, getSettings: () => settings });
  assert.equal(sniper.arm().ok, false, 'cannot arm without an auction');
  store.update({ auctionId: 'A', active: true }, 't');
  assert.equal(sniper.arm().ok, true);
  assert.equal(sniper.armed.auctionId, 'A');
  store.update({ auctionId: 'B', active: true }, 't');
  assert.equal(sniper.armed, null);
});
