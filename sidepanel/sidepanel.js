// Side panel UI. A side panel (rather than a popup) stays open while you
// interact with the stream. It holds no auction logic: it renders snapshots
// pushed by the content script in the active Whatnot tab and sends requests.
(function () {
  'use strict';
  const WBA = globalThis.WBA;
  const C = WBA.constants;
  const M = WBA.MSG;
  const $ = (id) => document.getElementById(id);
  const fmtMoney = (m, cur) => WBA.money.formatMoney(m, cur);

  let port = null;
  let tabId = null;
  let snap = null;
  let nextReqId = 1;
  const pending = new Map();
  let lastProbe = null;
  let bidBusy = false; // a BID NOW request is in flight

  // ------------------------------------------------------------ connection --
  // The panel talks to the content script in the active Whatnot tab over a Port.
  // A reload/navigation of that tab kills the content script, which closes the
  // Port; we then reconnect. Whatnot's in-app URL changes do NOT need a new Port.
  const WHATNOT_ORIGINS = ['https://www.whatnot.com/*', 'https://whatnot.com/*'];
  let connecting = null; // serialise connect() calls
  let problem = null; // { title, body, action? } when we cannot reach the tab

  function connect() {
    if (!connecting) connecting = doConnect().finally(() => (connecting = null));
    return connecting;
  }

  async function doConnect() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/(www\.)?whatnot\.com\//.test(tab.url || '')) {
      setConn('Not on Whatnot', '');
      dropPort();
      tabId = tab ? tab.id : null;
      snap = null;
      problem = null;
      render();
      return;
    }
    if (port && tabId === tab.id) return;
    dropPort();
    tabId = tab.id;

    // Diagnose the usual reasons the content script is not running.
    if (tab.incognito && !(await chrome.extension.isAllowedIncognitoAccess())) {
      return showProblem({
        title: 'Incognito isn’t allowed',
        body: 'Open the show in a normal window, or enable “Allow in Incognito” for Bid Assistant in chrome://extensions.',
      });
    }
    const granted = await chrome.permissions.contains({ origins: WHATNOT_ORIGINS }).catch(() => true);
    if (!granted) {
      return showProblem({
        title: 'Allow access to Whatnot',
        body: 'Chrome is blocking the assistant on whatnot.com (site access). Allow it, then reload the Whatnot tab.',
        action: { label: 'Allow on whatnot.com', run: requestAccess },
      });
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const s = await openPort(tab.id);
        problem = null;
        snap = s;
        $('log').textContent = '';
        (s.log || []).forEach(appendLog);
        if (s.lastPick) showProbe(s.lastPick);
        render();
        return;
      } catch (e) {
        if (attempt === 3) {
          const missing = /Receiving end does not exist|Could not establish connection|disconnected/i.test(String(e.message));
          if (/failed to start/i.test(String(e.message))) {
            return showProblem({
              title: 'Bid Assistant couldn’t start',
              body: 'Something on this page stopped the assistant from starting. Reload the tab; if it keeps happening, send the error below to whoever set it up.',
              action: { label: 'Reload Whatnot tab', run: () => chrome.tabs.reload(tab.id) },
              detail: String(e.message),
            });
          }
          return showProblem({
            title: 'Reload the Whatnot tab',
            body: missing
              ? 'The assistant isn’t running in this tab yet. Reload it once the extension is installed or updated. If it still doesn’t connect, check the extension is enabled and has site access to whatnot.com (puzzle icon › Bid Assistant).'
              : `The Whatnot tab didn’t respond (${e.message}). Reload the tab.`,
            action: { label: 'Reload Whatnot tab', run: () => chrome.tabs.reload(tab.id) },
            detail: String(e.message),
          });
        }
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  /** Open a Port to the tab and fetch the first snapshot. Rejects if nobody answers. */
  function openPort(id) {
    return new Promise((resolve, reject) => {
      const p = chrome.tabs.connect(id, { name: C.PORT_NAME });
      let settled = false;
      p.onMessage.addListener(onPortMessage);
      p.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        if (port === p) {
          port = null;
          for (const { reject: rj } of pending.values()) rj(new Error('disconnected'));
          pending.clear();
          // The tab reloaded or navigated away: reconnect shortly.
          setConn('Reconnecting…', '');
          setTimeout(connect, 800);
        }
        if (!settled) {
          settled = true;
          reject(new Error((err && err.message) || 'disconnected'));
        }
      });
      port = p;
      request(M.GET_SNAPSHOT, {}, 5000).then(
        (s) => {
          settled = true;
          resolve(s);
        },
        (e) => {
          if (settled) return;
          settled = true;
          if (port === p) dropPort();
          reject(e);
        }
      );
    });
  }

  async function requestAccess() {
    try {
      const ok = await chrome.permissions.request({ origins: WHATNOT_ORIGINS });
      if (ok && tabId != null) chrome.tabs.reload(tabId);
    } catch (e) {
      appendLog({ t: Date.now(), level: 'error', msg: `panel: ${e.message}` });
    }
  }

  function showProblem(p) {
    problem = p;
    snap = null;
    setConn(p.title, '');
    render();
  }

  function dropPort() {
    const p = port;
    port = null;
    if (p) {
      try {
        p.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    for (const { reject } of pending.values()) reject(new Error('disconnected'));
    pending.clear();
  }
  chrome.tabs.onActivated.addListener(() => connect());
  chrome.tabs.onUpdated.addListener((id, info) => {
    // Only a finished load (or switching to/from Whatnot) needs attention; connect()
    // is a no-op while the Port to this tab is still open.
    if (info.status === 'complete' || (info.url && id !== tabId)) connect();
  });
  chrome.permissions.onAdded.addListener(() => connect());

  function setConn(text, cls) {
    $('connText').textContent = text;
    $('conn').className = 'conn ' + cls;
  }

  function request(type, args = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!port) return reject(new Error('not connected'));
      const id = nextReqId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${type} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      port.postMessage({ id, type, args });
    });
  }

  function onPortMessage(msg) {
    if (msg.replyTo != null) {
      const p = pending.get(msg.replyTo);
      if (!p) return;
      pending.delete(msg.replyTo);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
      return;
    }
    if (msg.type !== M.PUSH) return;
    if (msg.topic === M.TOPIC_SNAPSHOT) {
      snap = msg.data;
      render();
    } else if (msg.topic === M.TOPIC_LOG) appendLog(msg.data);
    else if (msg.topic === M.TOPIC_PICK) showProbe(msg.data);
  }

  // -------------------------------------------------------------- settings --
  let settings = { ...C.DEFAULT_SETTINGS };
  const MODE_HELP = {
    snipe: 'One bid at your chosen moment before the end. Normal auctions re-snipe automatically if you are outbid, because their timer resets.',
    'snipe-rebid': 'Snipes at the end. If someone outbids you after that and there is still time, it bids again straight away. Best for Sudden Death.',
    'keep-winning': 'Bids whenever you are not the highest bidder, at any time, until your max.',
  };
  chrome.storage.local.get('settings').then(({ settings: s }) => {
    settings = { ...C.DEFAULT_SETTINGS, ...(s || {}) };
    $('maxBid').value = settings.maxBidMinor != null ? (settings.maxBidMinor / 100).toString() : '';
    $('targetMs').value = settings.targetMs;
    $('minRebidMs').value = settings.minRebidMs;
    renderMode();
  });
  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    return chrome.storage.local.set({ settings });
  }
  function renderMode() {
    const m = settings.autoMode;
    for (const b of $('modeSeg').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.mode === m));
    $('modeHelp').textContent = MODE_HELP[m] || '';
    $('timingField').classList.toggle('hidden', m === 'keep-winning');
    $('rebidField').classList.toggle('hidden', m !== 'snipe-rebid');
  }
  $('modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    saveSettings({ autoMode: b.dataset.mode });
    renderMode();
  });
  $('maxBid').addEventListener('change', () => {
    const pill = $('maxBid').parentElement;
    const raw = $('maxBid').value.trim();
    if (!raw) {
      pill.classList.remove('bad');
      return saveSettings({ maxBidMinor: null });
    }
    const parsed = WBA.money.parseMoney(raw);
    pill.classList.toggle('bad', !parsed || parsed.minor <= 0);
    if (parsed && parsed.minor > 0) saveSettings({ maxBidMinor: parsed.minor });
  });
  $('targetMs').addEventListener('change', () => {
    const v = Math.round(Number($('targetMs').value));
    const clamped = Math.min(C.TARGET_MS_MAX, Math.max(C.TARGET_MS_MIN, Number.isFinite(v) ? v : C.DEFAULT_SETTINGS.targetMs));
    $('targetMs').value = clamped;
    saveSettings({ targetMs: clamped });
  });
  $('minRebidMs').addEventListener('change', () => {
    const v = Math.min(5000, Math.max(0, Math.round(Number($('minRebidMs').value)) || 0));
    $('minRebidMs').value = v;
    saveSettings({ minRebidMs: v });
  });

  // ---------------------------------------------------------------- render --
  const shortMoney = (m, cur) => (m == null ? '—' : fmtMoney(m, cur));

  function render() {
    const onStream = !!(snap && snap.streamId);
    $('emptyState').classList.toggle('hidden', onStream);
    $('app').classList.toggle('hidden', !onStream);
    if (!onStream) {
      const btn = $('emptyAction');
      if (problem) {
        $('emptyTitle').textContent = problem.title;
        $('emptyBody').textContent = problem.body;
        btn.classList.toggle('hidden', !problem.action);
        if (problem.action) btn.textContent = problem.action.label;
        $('emptyDetail').textContent = problem.detail || '';
      } else {
        $('emptyTitle').textContent = snap ? 'Open a live show' : 'Open a Whatnot show';
        $('emptyBody').textContent = snap
          ? 'You’re on Whatnot. Open a live show and this panel will follow the auction.'
          : 'Go to a live show on whatnot.com and this panel will follow the auction.';
        btn.classList.add('hidden');
        $('emptyDetail').textContent = '';
      }
      document.body.classList.remove('live');
      return;
    }

    const s = snap.state;
    const cur = s.currency;
    const live = !!snap.liveMode;
    const armed = snap.armed;
    const alive = s.lastAlivePerf != null;
    setConn(live ? 'Auto-bid live' : alive ? 'Connected' : 'Waiting for show data', live ? 'on live' : alive ? 'on' : '');
    document.body.classList.toggle('live', live);

    // ---- auction card
    const running = s.active && !s.ended;
    const badge = $('typeBadge');
    if (!s.auctionId) {
      badge.textContent = 'Waiting';
      badge.className = 'badge';
    } else if (s.ended) {
      badge.textContent = s.suddenDeath ? 'Sudden death · ended' : 'Ended';
      badge.className = 'badge';
    } else if (s.suddenDeath) {
      badge.textContent = '☠ Sudden death';
      badge.className = 'badge sd';
    } else {
      badge.textContent = 'Live auction';
      badge.className = 'badge live';
    }
    $('bidCount').textContent = s.bidCount != null && s.auctionId ? `${s.bidCount} bid${s.bidCount === 1 ? '' : 's'}` : '';
    $('itemName').textContent = s.itemName || (s.auctionId ? 'Untitled item' : 'Waiting for the next auction…');
    $('current').textContent = !s.auctionId ? '—' : s.bidCount === 0 ? 'No bids' : shortMoney(s.currentBidMinor, cur);

    const win = $('winner');
    const youWin = s.bidCount > 0 && snap.selfUserId != null && String(s.highestBidderId) === String(snap.selfUserId);
    win.classList.toggle('hidden', !s.auctionId || !s.bidCount);
    win.classList.toggle('win', youWin);
    win.textContent = youWin ? (s.ended ? 'You won' : 'You’re winning') : s.highestBidder ? `@${s.highestBidder}` : '';

    // A bid result belongs to the auction it was for.
    if (showBidResult.auctionId && showBidResult.auctionId !== s.auctionId) {
      $('bidResult').classList.add('hidden');
      showBidResult.auctionId = null;
    }
    const canBid = running && Number.isInteger(s.nextBidMinor) && !youWin;
    $('bidNow').disabled = !canBid || bidBusy;
    $('bidNow').classList.toggle('winning', youWin && running);
    $('bidNow').textContent = youWin && running ? 'You’re the top bidder' : running && Number.isInteger(s.nextBidMinor) ? `Bid ${shortMoney(s.nextBidMinor, cur)}` : 'Bid';

    // ---- auto-bid card
    const toggle = $('liveToggle');
    toggle.checked = live;
    toggle.closest('.switch').classList.toggle('on', live);
    $('liveLabel').textContent = live ? 'Live' : 'Dry run';
    const arm = $('arm');
    arm.classList.toggle('armed', !!armed);
    arm.classList.toggle('dry', !!armed && !live);
    arm.textContent = armed ? (live ? 'Armed · tap to disarm' : 'Armed (dry run) · tap to disarm') : 'Arm auto-bid';
    arm.disabled = !armed && !running;
    renderAutoStatus(s, cur, live, armed);

    renderHistory(snap.history, cur);
    renderAttempt(snap.lastAttempt, cur);
    renderDebug();
    const c = snap.capture;
    $('capStats').textContent =
      `${c.recording ? 'REC' : 'PAUSED'} · buffered ${c.buffered}/${c.limit} · fields ${c.fields} · ` +
      Object.entries(c.counts)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
    $('recToggle').textContent = c.recording ? 'Pause recording' : 'Resume recording';
  }

  function renderAutoStatus(s, cur, live, armed) {
    const el = $('autoStatus');
    el.classList.toggle('live', !!armed && live);
    const a = snap.lastAttempt;
    if (armed) {
      const plan = snap.plan;
      const max = shortMoney(snap.settings.maxBidMinor, cur);
      if (armed.mode === 'keep-winning') el.textContent = `Keeping you on top up to ${max}`;
      else if (plan) el.textContent = `Will bid ${snap.settings.targetMs} ms before the end · max ${max}`;
      else el.textContent = `Watching · max ${max}`;
    } else if (a && a.trigger === 'auto') {
      el.textContent = `Last auto-bid: ${friendly(a, cur).title}`;
    } else {
      el.textContent = Number.isInteger(snap.settings.maxBidMinor) ? '' : 'Set a max bid to arm';
    }
  }

  const CHECK_TEXT = {
    'not-already-highest': 'You’re already the highest bidder',
    'auction-active': 'This auction isn’t live',
    'not-ended': 'The auction has ended',
    'end-time-known': 'Waiting for the auction timer',
    'state-fresh': 'Lost the live connection — reload the Whatnot tab',
    'next-bid-known': 'Waiting for the next bid amount',
    'next-bid-above-current': 'Waiting for the next bid amount',
    'price-known': 'Waiting for the current price',
    'auction-identity': 'The auction changed — try again',
    'stream-matches': 'The show changed — try again',
    'within-max': 'Next bid is above your max',
    'max-set': 'Set a max bid first',
    armed: 'Auto-bid isn’t armed',
    'armed-auction-matches': 'Armed on a different auction',
  };
  const NOT_SENT_TEXT = {
    PRICE_MOVED: 'The price just moved — tap again',
    AUCTION_CHANGED: 'The auction just changed',
    AUCTION_NOT_ACTIVE: 'The auction just ended',
    NO_JOINED_SOCKET: 'Not connected to the auction — reload the Whatnot tab',
    NO_AUCTION_SEEN: 'Not connected to the auction — reload the Whatnot tab',
  };

  /** Human summary of a bid attempt: { tone, title, sub }. */
  function friendly(a, cur) {
    const amt = shortMoney(a.amountMinor, a.currency || cur);
    if (a.reason === 'ACCEPTED') {
      const sub = [a.rttMs != null ? `confirmed in ${a.rttMs} ms` : '', a.serverRemainingMs != null && a.serverRemainingMs < 10000 ? `${a.serverRemainingMs} ms before the end` : '']
        .filter(Boolean)
        .join(' · ');
      return { tone: 'ok', title: `Bid placed · ${amt}`, sub };
    }
    if (a.reason === 'DRY_RUN') return { tone: '', title: `Dry run · would bid ${amt}`, sub: a.remainingMs != null ? `${a.remainingMs} ms before the end` : '' };
    if (a.reason === 'VALIDATION_FAILED') {
      const first = (a.failed || []).map((n) => CHECK_TEXT[n]).find(Boolean);
      return { tone: 'fail', title: first || 'Bid blocked by a safety check', sub: '' };
    }
    if (a.reason && a.reason.startsWith('NOT_SENT_')) {
      const k = a.reason.slice('NOT_SENT_'.length);
      return { tone: 'fail', title: NOT_SENT_TEXT[k] || 'Bid not sent', sub: a.detail || '' };
    }
    if (a.reason === 'REJECTED') return { tone: 'fail', title: `Whatnot rejected the ${amt} bid`, sub: 'Someone may have bid first' };
    if (a.reason === 'NO_REPLY') return { tone: 'warn', title: 'Sent, but Whatnot didn’t confirm', sub: 'Check the stream to see if it landed' };
    if (a.reason === 'DUPLICATE') return { tone: 'fail', title: `Already bid ${amt}`, sub: '' };
    if (a.reason === 'BID_IN_PROGRESS') return { tone: 'fail', title: 'A bid is already in progress', sub: '' };
    return { tone: 'fail', title: 'Bid failed', sub: a.error || a.reason || '' };
  }

  function showBidResult(a) {
    const el = $('bidResult');
    if (!a) return el.classList.add('hidden');
    const f = friendly(a, snap && snap.state.currency);
    showBidResult.auctionId = a.expectedAuctionId || null;
    el.className = `result ${f.tone}`;
    el.textContent = f.title;
    if (f.sub) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = f.sub;
      el.appendChild(sub);
    }
    clearTimeout(showBidResult.t);
    showBidResult.t = setTimeout(() => el.classList.add('hidden'), 6000);
  }

  function renderAttempt(a, cur) {
    const el = $('lastAttempt');
    el.innerHTML = '';
    if (!a) return;
    const head = document.createElement('div');
    head.textContent = `${WBA.fmtTime(a.t)} ${a.shot || a.trigger || ''} → ${a.reason} ${a.amountMinor != null ? shortMoney(a.amountMinor, cur) : ''}`;
    el.appendChild(head);
    if (a.checks) {
      const ul = document.createElement('ul');
      for (const c of a.checks) {
        const li = document.createElement('li');
        li.className = c.ok ? 'ok' : 'fail';
        li.textContent = `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`;
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }
  }

  function renderHistory(rows, cur) {
    const out = $('history');
    out.innerHTML = '';
    if (!rows || !rows.length) return;
    const table = document.createElement('table');
    table.className = 'grid';
    table.innerHTML =
      '<tr><th>time</th><th>how</th><th>result</th><th>bid</th><th>est. left</th><th>server left</th><th>rtt</th><th>late</th></tr>';
    for (const a of rows) {
      const tr = document.createElement('tr');
      const vals = [
        WBA.fmtTime(a.t),
        `${a.shot || a.trigger}${a.dryRun ? ' (dry)' : ''}${a.suddenDeath ? ' SD' : ''}`,
        a.reason,
        a.amountMinor != null ? shortMoney(a.amountMinor, a.currency || cur) : '—',
        a.remainingMs != null ? `${a.remainingMs}ms` : '—',
        a.serverRemainingMs != null ? `${a.serverRemainingMs}ms` : '—',
        a.rttMs != null ? `${a.rttMs}ms` : '—',
        a.plannedLateMs != null ? `${a.plannedLateMs}ms` : '—',
      ];
      for (const v of vals) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      tr.className = a.ok ? 'ok' : a.outcomeUnknown ? 'unknown' : '';
      table.appendChild(tr);
    }
    out.appendChild(table);
  }

  function serverNow() {
    return Date.now() + ((snap && snap.clock && snap.clock.offsetMs) || 0);
  }

  function renderDebug() {
    const t = $('debugTable');
    if (!$('devTools').open) return; // only maintain the table while it is visible
    const s = snap.state;
    const cur = s.currency;
    const fs = s.fieldSources || {};
    const srcOf = (k) => (fs[k] ? `${fs[k].source} @ ${WBA.fmtTime(fs[k].t)}` : '—');
    const ck = snap.clock;
    const rows = [
      ['Stream', snap.streamId],
      ['Page hook', snap.hookReady ? 'ready' : 'NOT DETECTED (reload tab)'],
      ['Auction ID', s.auctionId ?? '—'],
      ['Status', `${s.status} (active ${s.active}, ended ${s.ended})`],
      ['Current', `${shortMoney(s.currentBidMinor, cur)} (${srcOf('currentBidMinor')})`],
      ['Next', `${shortMoney(s.nextBidMinor, cur)} (${srcOf('nextBidMinor')})`],
      ['High bidder', `${s.highestBidder ?? '—'} (${s.highestBidderId ?? '—'})`],
      ['Sudden Death', `${s.suddenDeath} · extends ${s.endTimeExtends}`],
      ['End time', s.endTime ? `${WBA.fmtTime(s.endTime)} · ${Math.max(0, (s.endTimeHistory || []).length - 1)} changes` : '—'],
      ['Remaining', s.endTime ? `${Math.round(s.endTime - serverNow())} ms` : '—'],
      ['Source alive', s.lastAlivePerf != null ? 'yes' : 'NO (stale)'],
      ...Object.entries(snap.sourceStats || {}).map(([name, st]) => [
        name,
        st
          ? `socket ${st.socketOpen ? 'open' : 'closed'} · ${st.frames} frames · last ${st.lastEvent || '—'}` +
            `${st.lastLatencyMs != null ? ` · ~${st.lastLatencyMs}ms` : ''} · ignored ${st.ignored}` +
            `${st.endLagsMs && st.endLagsMs.length ? ` · end lag ${st.endLagsMs.join(',')}ms` : ''}`
          : '—',
      ]),
      ['Our user id', snap.selfUserId ?? 'unknown'],
      ['Auto-bid', `${snap.armed ? `armed ${snap.armed.mode} on ${snap.armed.auctionId}` : 'not armed'} · ${snap.liveMode ? 'LIVE' : 'dry run'}`],
      ['Plan', snap.plan ? `fire at ${WBA.fmtTime(snap.plan.endTime - snap.plan.targetMs)} (server)` : '—'],
      [
        'Clock offset',
        ck.samples
          ? `${ck.offsetMs} ms ± ${ck.uncertaintyMs ?? '?'} (${ck.samples} samples: ${ck.sources.join('+')}; resets ${ck.resets}, rejected ${ck.rejected})`
          : 'no samples yet',
      ],
    ];
    t.innerHTML = '';
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      const td = document.createElement('td');
      th.textContent = k;
      td.textContent = v;
      tr.append(th, td);
      t.appendChild(tr);
    }
  }
  $('emptyAction').addEventListener('click', () => problem && problem.action && problem.action.run());
  $('devTools').addEventListener('toggle', () => snap && snap.streamId && renderDebug());

  // ------------------------------------------------- countdown (per frame) --
  // Anchored to the server end time via the clock offset; the progress bar is
  // measured from when this panel first saw the auction's end time.
  const seen = { id: null, start: 0 };
  function tick() {
    const s = snap && snap.state;
    const main = $('timerMain');
    const frac = $('timerFrac');
    const timer = $('timer');
    const bar = $('progressBar');
    if (s && s.endTime != null && s.auctionId) {
      const now = serverNow();
      if (seen.id !== s.auctionId) {
        seen.id = s.auctionId;
        seen.start = Math.min(now, s.endTime);
      }
      const ms = s.endTime - now;
      const total = Math.max(1, s.endTime - seen.start);
      if (ms > 0 && !s.ended) {
        const secs = Math.floor(ms / 1000);
        main.textContent = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : String(secs);
        frac.textContent = secs >= 60 ? '' : `.${String(Math.floor(ms % 1000)).padStart(3, '0')}s`;
        const urgent = ms < 3000;
        timer.className = 'timer' + (urgent ? ' urgent' : '');
        bar.className = 'progress-bar' + (urgent ? ' urgent' : '');
        bar.style.width = `${Math.min(100, (ms / total) * 100)}%`;
      } else {
        // Whatnot announces the end ~1 s after the end time; until then it's closing.
        main.textContent = s.ended ? 'Sold' : 'Closing…';
        frac.textContent = '';
        timer.className = s.ended ? 'timer done' : 'timer closing';
        bar.style.width = '0%';
      }
    } else if (main) {
      main.textContent = '--';
      frac.textContent = '';
      timer.className = 'timer done';
      bar.style.width = '0%';
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ------------------------------------------------------------------- log --
  function appendLog(e) {
    const box = $('log');
    const line = document.createElement('div');
    line.className = 'l-' + e.level;
    line.textContent = `[${WBA.fmtTime(e.t)}] ${e.msg}`;
    box.appendChild(line);
    while (box.childElementCount > 400) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  }

  // --------------------------------------------------------------- actions --
  async function run(btn, fn) {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      appendLog({ t: Date.now(), level: 'error', msg: `panel: ${e.message}` });
    } finally {
      btn.disabled = false;
    }
  }

  $('bidNow').addEventListener('click', async () => {
    if (bidBusy || !snap) return;
    bidBusy = true;
    $('bidNow').disabled = true;
    try {
      const r = await request(M.BID_NOW, { expectedAuctionId: snap.state.auctionId, expectedStreamId: snap.streamId });
      showBidResult(r);
    } catch (e) {
      showBidResult({ reason: 'EXCEPTION', error: e.message });
    } finally {
      bidBusy = false;
      render();
    }
  });

  async function setLive(on) {
    try {
      await request(M.SET_LIVE, { on, confirmed: on });
    } catch (e) {
      appendLog({ t: Date.now(), level: 'error', msg: `panel: ${e.message}` });
    }
    render();
  }
  $('liveToggle').addEventListener('change', () => {
    const toggle = $('liveToggle');
    if (!toggle.checked) {
      $('liveConfirm').classList.add('hidden');
      return setLive(false);
    }
    // Going live needs explicit confirmation; stay off until then.
    toggle.checked = false;
    $('liveMax').textContent = settings.maxBidMinor != null ? shortMoney(settings.maxBidMinor, snap && snap.state.currency) : 'your max (not set yet)';
    $('liveConfirm').classList.remove('hidden');
  });
  $('liveYes').addEventListener('click', () => {
    $('liveConfirm').classList.add('hidden');
    setLive(true);
  });
  $('liveNo').addEventListener('click', () => $('liveConfirm').classList.add('hidden'));
  $('arm').addEventListener('click', (ev) =>
    run(ev.target, async () => {
      const r = await request(snap && snap.armed ? M.DISARM : M.ARM);
      if (r && r.ok === false) {
        const msg = { NO_MAX: 'Set a max bid first', NOT_ACTIVE: 'No live auction to arm on', NO_AUCTION: 'No live auction to arm on' }[r.reason];
        $('autoStatus').textContent = msg || 'Could not arm';
      }
    })
  );

  $('recToggle').addEventListener('click', (ev) =>
    run(ev.target, () => request(M.SET_RECORDING, { on: !(snap && snap.capture.recording) }))
  );
  $('clearCap').addEventListener('click', (ev) => run(ev.target, () => request(M.CLEAR_CAPTURE)));
  $('exportCap').addEventListener('click', (ev) =>
    run(ev.target, async () => {
      const data = await request(M.EXPORT_CAPTURE, {}, 60000);
      const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `whatnot-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    })
  );
  $('addMarker').addEventListener('click', (ev) =>
    run(ev.target, async () => {
      await request(M.ADD_MARKER, { label: $('markerLabel').value || 'marker' });
      $('markerLabel').value = '';
    })
  );

  $('searchBtn').addEventListener('click', (ev) =>
    run(ev.target, async () => {
      const hits = await request(M.SEARCH_CAPTURE, { needle: $('searchNeedle').value });
      const out = $('searchOut');
      out.innerHTML = '';
      if (!hits.length) return void (out.textContent = 'no matches in the buffer');
      for (const h of hits) {
        const div = document.createElement('div');
        div.className = 'hit';
        div.textContent = `#${h.seq} ${WBA.fmtTime(h.t)} ${h.source}\n${h.paths.join('\n')}${h.snippet ? '\n…' + h.snippet + '…' : ''}`;
        out.appendChild(div);
      }
    })
  );

  async function refreshFields() {
    const rows = await request(M.LIST_FIELDS, { filter: $('fieldFilter').value });
    const out = $('fieldsOut');
    out.innerHTML = '';
    if (!rows.length) return void (out.textContent = 'nothing yet — leave recording on during an auction');
    const table = document.createElement('table');
    table.className = 'fields';
    table.innerHTML = '<tr><th>path</th><th>n</th><th>Δ</th><th>last value</th></tr>';
    for (const f of rows) {
      const tr = document.createElement('tr');
      tr.title = `${f.source}\ntype=${f.type} last=${WBA.fmtTime(f.lastT)}`;
      for (const v of [`${f.path}\n${f.source}`, f.count, f.changes, f.lastValue]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    out.appendChild(table);
  }
  $('fieldsBtn').addEventListener('click', (ev) => run(ev.target, refreshFields));
  $('fieldFilter').addEventListener('keydown', (e) => e.key === 'Enter' && refreshFields().catch(() => {}));
  $('searchNeedle').addEventListener('keydown', (e) => e.key === 'Enter' && $('searchBtn').click());

  function showProbe(data) {
    lastProbe = data;
    $('probeOut').textContent = JSON.stringify(data, null, 2);
  }
  $('pickBtn').addEventListener('click', (ev) =>
    run(ev.target, async () => {
      await request(M.PICK_ELEMENT);
      showProbe({ hint: 'Click an element on the Whatnot page (the click is NOT passed to Whatnot). Esc cancels.' });
    })
  );
  $('domScanBtn').addEventListener('click', (ev) => run(ev.target, async () => showProbe(await request(M.DOM_SCAN))));
  $('reactBtn').addEventListener('click', (ev) =>
    run(ev.target, async () => showProbe(await request(M.REACT_PROBE, { selector: $('reactSelector').value.trim() })))
  );
  $('diagBtn').addEventListener('click', (ev) => run(ev.target, async () => showProbe(await request(M.BID_DIAGNOSTICS))));
  $('globalsBtn').addEventListener('click', (ev) => run(ev.target, async () => showProbe(await request(M.GLOBALS_PROBE))));
  $('copyProbe').addEventListener('click', () => {
    if (lastProbe) navigator.clipboard.writeText(JSON.stringify(lastProbe, null, 2)).catch(() => {});
  });

  connect();
  render();
})();
