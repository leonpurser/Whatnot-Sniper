// Content-script entry point: wires page observations -> capture/discovery ->
// auction-state sources -> state store -> side panel, and exposes the
// inspection + bid commands to the side panel over a Port.
(function (g) {
  'use strict';
  const WBA = g.WBA;
  const C = WBA.constants;
  const M = WBA.MSG;

  if (g.__wbaContentStarted) return;
  g.__wbaContentStarted = true;

  const log = WBA.createLog({ prefix: 'WBA' });
  const clock = WBA.createClock();
  const store = WBA.createAuctionStateStore({ log });
  const capture = WBA.createCaptureStore({
    limit: C.CAPTURE_LIMIT,
    maxStoreChars: C.MAX_STORE_CHARS,
    keyPattern: C.DISCOVERY_KEY_PATTERN,
    maxFields: C.MAX_DISCOVERY_FIELDS,
  });

  let settings = { ...C.DEFAULT_SETTINGS };
  let hookReady = false;
  let lastPick = null;
  const ports = new Set();

  // LIVE bidding is deliberately not persisted: every page load, stream change
  // and extension reload starts in dry run, and going live needs an explicit
  // confirmation in the side panel.
  let liveMode = false;
  const socketSource = WBA.sources.all().find((x) => x.name === 'auction-socket');
  const selfUserId = () => (socketSource ? socketSource.getSelfUserId() : null);

  let sniper = null;
  const executor = WBA.createBidExecutor({
    log,
    getContext: () => ({
      state: store.get(),
      streamId: store.getStreamId(),
      serverNow: () => clock.serverNow(),
      clockUncertaintyMs: clock.snapshot().uncertaintyMs,
      staleMs: C.STALE_STATE_MS,
      armed: !!(sniper && sniper.armed),
      armedAuctionId: sniper && sniper.armed ? sniper.armed.auctionId : null,
      selfUserId: selfUserId(),
      dryRun: !liveMode,
    }),
    sendBid: ({ auctionId, amountMinor, currency }) =>
      bridge.request(
        'place-bid',
        { topic: `commerce:${store.getStreamId()}`, productId: auctionId, amountMinor, currency },
        8000
      ),
  });
  sniper = WBA.createSniper({ log, store, getSettings: () => settings, executor, clock, getSelfUserId: selfUserId, isLive: () => liveMode, onChange: () => schedulePush() });

  // ------------------------------------------------------------ settings --
  chrome.storage.local.get('settings').then(({ settings: s }) => {
    settings = { ...C.DEFAULT_SETTINGS, ...(s || {}) };
    applyDomWatch();
    schedulePush();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = { ...C.DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    applyDomWatch();
    sniper.reschedule(); // target timing may have changed
    schedulePush();
  });

  // ---------------------------------------------------- page observations --
  const bridge = WBA.createPageBridge({
    channel: C.CHANNEL,
    onEvent(kind, payload) {
      if (kind === 'hook-ready') {
        hookReady = true;
        log.info('page hook ready');
        return;
      }
      if (kind === 'pick-result') {
        lastPick = payload;
        broadcast(M.TOPIC_PICK, payload);
        return;
      }
      // Coarse server clock from HTTP Date headers. Only non-GET (API) responses:
      // cached GET responses can carry an old Date.
      if ((kind === 'fetch' || kind === 'xhr') && payload.dateHeader && payload.method !== 'GET' && payload.start && payload.end) {
        clock.addDateSample(payload.dateHeader, payload.start.t, payload.end.t);
      }
      if (kind === 'ws-connect' || kind === 'ws-close') {
        log.info(`${kind} #${payload.socket} ${String(payload.url).split('?')[0]}${kind === 'ws-close' ? ` code=${payload.code}` : ''}`);
      }
      capture.add(kind, payload);
    },
  });

  // Each capture is offered to every registered auction-state source.
  const sourceCtx = { store, clock, log };
  capture.subscribe((entry, json) => {
    for (const src of WBA.sources.all()) {
      if (typeof src.onCapture !== 'function') continue;
      try {
        src.onCapture(entry, json, sourceCtx);
      } catch (e) {
        log.error(`source ${src.name} failed`, String(e));
      }
    }
  });
  for (const src of WBA.sources.all()) {
    if (typeof src.start === 'function') src.start(sourceCtx);
  }

  // ------------------------------------------------------------ DOM watch --
  const watcher = WBA.domProbe.createWatcher((change) => capture.add('dom', { p: change.p, url: location.href, ...change }));
  function applyDomWatch() {
    const want = settings.domWatch && store.getStreamId() != null;
    if (want && !watcher.running) {
      if (document.body) watcher.start();
      else document.addEventListener('DOMContentLoaded', applyDomWatch, { once: true });
    } else if (!want && watcher.running) watcher.stop();
  }

  // -------------------------------------------------------- stream detect --
  WBA.createStreamDetector({
    pattern: C.STREAM_PATH_PATTERN,
    onChange(id) {
      if (liveMode) log.info('stream changed — auto-bid back to DRY RUN');
      liveMode = false;
      store.setStream(id);
      applyDomWatch();
      capture.add('note', { url: location.href, text: id ? `stream ${id}` : 'not on a stream' });
    },
  });

  // ---------------------------------------------------- push to the panel --
  let pushTimer = null;
  let lastBadge = null;
  function snapshot() {
    const s = store.get();
    return {
      at: Date.now(),
      href: location.href,
      streamId: store.getStreamId(),
      hookReady,
      state: s,
      settings,
      armed: sniper.armed,
      plan: sniper.plan,
      liveMode,
      selfUserId: selfUserId(),
      clock: clock.snapshot(),
      capture: capture.stats(),
      domWatch: watcher.running,
      sources: WBA.sources.all().map((x) => x.name),
      sourceStats: Object.fromEntries(WBA.sources.all().map((x) => [x.name, typeof x.stats === 'function' ? x.stats() : null])),
      lastAttempt: executor.getLastAttempt(),
      history: executor.getHistory().slice(0, 15).map(({ checks, response, ...rest }) => rest),
    };
  }
  function schedulePush() {
    updateBadge();
    if (pushTimer || !ports.size) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      broadcast(M.TOPIC_SNAPSHOT, snapshot());
    }, 100);
  }
  function broadcast(topic, data) {
    for (const p of ports) {
      try {
        p.postMessage({ type: M.PUSH, topic, data });
      } catch (_) {
        ports.delete(p);
      }
    }
  }
  function updateBadge() {
    const s = store.get();
    const text = sniper.armed ? (liveMode ? 'LIVE' : 'ARM') : s.status === WBA.STATUS.ACTIVE ? 'LIVE' : store.getStreamId() ? 'ON' : '';
    if (text === lastBadge) return;
    lastBadge = text;
    try {
      chrome.runtime.sendMessage({ type: M.BADGE, text, color: sniper.armed ? '#d93025' : '#1a73e8' }).catch(() => {});
    } catch (_) {
      /* extension reloaded; this content script is orphaned */
    }
  }

  store.subscribe(schedulePush);
  log.subscribe((entry) => broadcast(M.TOPIC_LOG, entry));
  setInterval(schedulePush, 1000); // capture counters, clock

  // ---------------------------------------------------- panel requests --
  const handlers = {
    [M.GET_SNAPSHOT]: () => ({ ...snapshot(), log: log.entries().slice(-200), lastPick }),
    [M.SET_RECORDING]: ({ on }) => (capture.setRecording(on), capture.stats()),
    [M.CLEAR_CAPTURE]: () => (capture.clear(), capture.stats()),
    [M.EXPORT_CAPTURE]: () => ({
      ...capture.exportData(),
      clock: clock.snapshot(),
      state: store.get(),
      bidHistory: executor.getHistory(),
      log: log.entries(),
    }),
    [M.LIST_FIELDS]: ({ filter }) => capture.listFields({ filter: filter || '', limit: 400 }),
    [M.SEARCH_CAPTURE]: ({ needle }) => capture.search(needle),
    [M.DOM_SCAN]: () => WBA.domProbe.scan(),
    [M.REACT_PROBE]: ({ selector }) => bridge.request('react-probe', { selector: selector || null }),
    [M.PICK_ELEMENT]: () => bridge.request('pick-start'),
    [M.GLOBALS_PROBE]: () => bridge.request('globals-probe'),
    [M.ADD_MARKER]: ({ label }) => {
      const e = capture.add('marker', { p: performance.now(), url: location.href, text: String(label || 'marker') });
      log.info(`MARKER: ${e.text}`);
      return { seq: e.seq };
    },
    [M.BID_DIAGNOSTICS]: async () => {
      const page = await bridge.request('bid-diagnostics', { topic: `commerce:${store.getStreamId()}` });
      const s = store.get();
      return {
        bidNow: 'always real (like Whatnot\'s bid button)',
        autoBid: liveMode ? 'LIVE' : 'DRY RUN (the sniper sends nothing to Whatnot)',
        pageHook: page,
        selfUserId: selfUserId(),
        maxBid: settings.maxBidMinor,
        auction: { id: s.auctionId, active: s.active, next: s.nextBidMinor, highestBidderId: s.highestBidderId },
        lastAttempt: executor.getLastAttempt(),
      };
    },
    [M.SET_LIVE]: ({ on, confirmed }) => {
      if (on && confirmed !== true) throw new Error('live mode needs confirmation');
      liveMode = !!on;
      log.warn(liveMode ? 'auto-bid LIVE — the sniper will place real bids' : 'auto-bid back to DRY RUN');
      schedulePush();
      return { liveMode };
    },
    [M.BID_NOW]: async ({ expectedAuctionId, expectedStreamId }) => {
      try {
        return await executor.placeBid(expectedAuctionId || null, null, {
          trigger: 'manual',
          expectedStreamId: expectedStreamId || null,
        });
      } finally {
        schedulePush();
      }
    },
    [M.ARM]: () => {
      const r = sniper.arm();
      schedulePush();
      return r;
    },
    [M.DISARM]: () => {
      sniper.disarm('user');
      schedulePush();
      return { ok: true };
    },
  };

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== C.PORT_NAME) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener(async (msg) => {
      if (!msg || msg.id == null) return;
      const h = handlers[msg.type];
      try {
        if (!h) throw new Error('unknown request ' + msg.type);
        const result = await h(msg.args || {});
        port.postMessage({ replyTo: msg.id, ok: true, result });
      } catch (e) {
        try {
          port.postMessage({ replyTo: msg.id, ok: false, error: String((e && e.message) || e) });
        } catch (_) {
          /* port gone */
        }
      }
    });
    schedulePush();
  });

  log.info(`content script loaded on ${location.pathname}`);
})(globalThis);
