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

  // ------------------------------------------------------------ connection --
  async function connect() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/(www\.)?whatnot\.com\//.test(tab.url || '')) {
      setConn('open a Whatnot tab', 'off');
      dropPort();
      tabId = tab ? tab.id : null;
      snap = null;
      render();
      return;
    }
    if (port && tabId === tab.id) return;
    dropPort();
    tabId = tab.id;
    port = chrome.tabs.connect(tab.id, { name: C.PORT_NAME });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      setConn('disconnected — reload the Whatnot tab if this persists', 'off');
      setTimeout(connect, 1500);
    });
    try {
      const s = await request(M.GET_SNAPSHOT);
      setConn('connected', 'on');
      snap = s;
      $('log').textContent = '';
      (s.log || []).forEach(appendLog);
      if (s.lastPick) showProbe(s.lastPick);
      render();
    } catch (e) {
      setConn('content script not responding — reload the Whatnot tab', 'off');
    }
  }
  function dropPort() {
    if (port) {
      try {
        port.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    port = null;
    for (const { reject } of pending.values()) reject(new Error('disconnected'));
    pending.clear();
  }
  chrome.tabs.onActivated.addListener(() => connect());
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (info.status === 'complete' || info.url) {
      if (id === tabId) dropPort();
      connect();
    }
  });

  function setConn(text, cls) {
    $('conn').textContent = text;
    $('conn').className = 'pill ' + cls;
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
  chrome.storage.local.get('settings').then(({ settings: s }) => {
    settings = { ...C.DEFAULT_SETTINGS, ...(s || {}) };
    $('maxBid').value = settings.maxBidMinor != null ? (settings.maxBidMinor / 100).toString() : '';
    $('targetMs').value = settings.targetMs;
  });
  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    return chrome.storage.local.set({ settings });
  }
  $('maxBid').addEventListener('change', () => {
    const raw = $('maxBid').value.trim();
    if (!raw) return saveSettings({ maxBidMinor: null });
    const parsed = WBA.money.parseMoney(raw);
    if (!parsed || parsed.minor <= 0) {
      $('maxBid').classList.add('bad');
      return;
    }
    $('maxBid').classList.remove('bad');
    saveSettings({ maxBidMinor: parsed.minor });
  });
  $('targetMs').addEventListener('change', () => {
    const v = Math.round(Number($('targetMs').value));
    const clamped = Math.min(C.TARGET_MS_MAX, Math.max(C.TARGET_MS_MIN, Number.isFinite(v) ? v : C.DEFAULT_SETTINGS.targetMs));
    $('targetMs').value = clamped;
    saveSettings({ targetMs: clamped });
  });

  // ---------------------------------------------------------------- render --
  function render() {
    const s = snap && snap.state;
    const cur = s && s.currency;
    $('streamId').textContent = (snap && snap.streamId) || (snap ? 'not on a livestream page' : '—');
    $('itemName').textContent = (s && s.itemName) || '—';
    $('current').textContent = !s
      ? '—'
      : s.bidCount === 0
        ? 'no bids'
        : fmtMoney(s.currentBidMinor, cur) + (s.highestBidder ? ` (${s.highestBidder})` : '');
    $('next').textContent = s ? fmtMoney(s.nextBidMinor, cur) : '—';
    $('type').textContent = !s || s.suddenDeath == null ? 'unknown' : s.suddenDeath ? 'SUDDEN DEATH' : 'NORMAL';
    $('type').className = 'v' + (s && s.suddenDeath ? ' sd' : '');
    const armed = snap && snap.armed;
    $('status').textContent = !snap ? '—' : armed ? `ARMED (${armed.auctionId})` : s.status.toUpperCase();
    $('arm').classList.toggle('armed', !!armed);
    $('noSources').classList.toggle('hidden', !!(snap && snap.sources && snap.sources.length));
    const live = !!(snap && snap.liveMode);
    $('dryRun').checked = !live;
    $('modeNote').textContent = live ? 'LIVE — the sniper places real bids' : 'sniper sends nothing';
    const canBid = s && s.active && Number.isInteger(s.nextBidMinor);
    $('bidNow').textContent = canBid ? `BID ${fmtMoney(s.nextBidMinor, cur)}` : 'BID';
    $('bidNow').disabled = !canBid;
    $('arm').textContent = armed ? 'DISARM' : live ? 'ARM AUTO BID (LIVE)' : 'ARM AUTO BID (dry run)';
    document.body.classList.toggle('live', live);
    renderHistory(snap && snap.history, cur);
    renderAttempt(snap && snap.lastAttempt, cur);
    renderDebug();
    if (snap) {
      const c = snap.capture;
      $('capStats').textContent =
        `${c.recording ? 'REC' : 'PAUSED'} · buffered ${c.buffered}/${c.limit} · fields ${c.fields} · ` +
        Object.entries(c.counts)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ');
      $('recToggle').textContent = c.recording ? 'Pause recording' : 'Resume recording';
    }
  }

  function renderAttempt(a, cur) {
    const el = $('lastAttempt');
    if (!a) return el.classList.add('hidden');
    el.classList.remove('hidden');
    el.className = 'attempt ' + (a.ok ? 'ok' : 'fail');
    const lines = [
      `${WBA.fmtTime(a.t)} ${a.trigger || ''} → ${a.ok ? 'OK' : 'NOT PLACED'} (${a.reason})`,
      a.amountMinor != null ? `bid ${fmtMoney(a.amountMinor, cur)} / max ${fmtMoney(a.maxBidMinor, cur)}` : '',
    ];
    el.textContent = lines.filter(Boolean).join('\n');
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
    table.className = 'fields';
    table.innerHTML =
      '<tr><th>time</th><th>how</th><th>result</th><th>bid</th><th>est. left</th><th>server left</th><th>rtt</th><th>sched late</th></tr>';
    for (const a of rows) {
      const tr = document.createElement('tr');
      const vals = [
        WBA.fmtTime(a.t),
        `${a.trigger}${a.dryRun ? ' (dry)' : ''}${a.suddenDeath ? ' SD' : ''}`,
        a.reason,
        a.amountMinor != null ? fmtMoney(a.amountMinor, a.currency || cur) : '—',
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
    if (!snap) return void (t.innerHTML = '');
    const s = snap.state;
    const cur = s.currency;
    const fs = s.fieldSources || {};
    const srcOf = (k) => (fs[k] ? `${fs[k].source} @ ${WBA.fmtTime(fs[k].t)}` : '—');
    const a = snap.lastAttempt;
    const ck = snap.clock;
    const rows = [
      ['Page hook', snap.hookReady ? 'ready' : 'NOT DETECTED (reload tab)'],
      ['Auction ID', s.auctionId ?? '—'],
      ['Auction status', s.status],
      ['Active / ended', `${s.active} / ${s.ended}`],
      ['Current price', `${fmtMoney(s.currentBidMinor, cur)}  (${srcOf('currentBidMinor')})`],
      ['Next bid', `${fmtMoney(s.nextBidMinor, cur)}  (${srcOf('nextBidMinor')})`],
      ['Maximum', fmtMoney(snap.settings.maxBidMinor, cur)],
      ['Bids', `${s.bidCount ?? '—'}${s.highestBidder ? ' — high: ' + s.highestBidder : ''}`],
      ['Sudden Death', `${s.suddenDeath}  (${srcOf('suddenDeath')})`],
      ['Bump rule', s.bumpThresholdSeconds != null ? `bid with <${s.bumpThresholdSeconds}s left → ${s.bumpValueSeconds}s` : '—'],
      ['End timestamp', s.endTime ? `${WBA.fmtTime(s.endTime)}  (${srcOf('endTime')})` : '—'],
      ['End-time changes', String(Math.max(0, (s.endTimeHistory || []).length - 1))],
      ['Remaining (calc)', s.endTime ? `${Math.round(s.endTime - serverNow())} ms` : '—'],
      ['Last state update', s.lastUpdate ? WBA.fmtTime(s.lastUpdate) : '—'],
      ['State sources', snap.sources.length ? snap.sources.join(', ') : 'none configured'],
      ...Object.entries(snap.sourceStats || {}).map(([name, st]) => [
        `  ${name}`,
        st
          ? `socket ${st.socketOpen ? 'open' : 'closed'} · ${st.frames} frames · last ${st.lastEvent || '—'}` +
            `${st.lastLatencyMs != null ? ` · latency ~${st.lastLatencyMs}ms` : ''} · ignored ${st.ignored}`
          : '—',
      ]),
      ['Source alive', s.lastAlivePerf != null ? 'yes' : 'NO (stale)'],
      ['Armed', snap.armed ? `yes — ${snap.armed.auctionId}` : 'no'],
      ['Target timing', `${snap.settings.targetMs} ms`],
      ['Mode', snap.liveMode ? 'LIVE — real bids' : 'dry run'],
      ['Our user id', snap.selfUserId ?? 'unknown (needed to avoid bidding against yourself)'],
      ['Sniper plan', snap.plan ? `fire at ${WBA.fmtTime(snap.plan.endTime - snap.plan.targetMs)} (server)` : '—'],
      [
        'Clock offset',
        ck.samples
          ? `${ck.offsetMs} ms ± ${ck.uncertaintyMs ?? '?'} (${ck.samples} samples, ${ck.sources.join('+')}, resets ${ck.resets}, rejected ${ck.rejected})`
          : 'no samples yet (assuming 0)',
      ],
      ['DOM watch', snap.domWatch ? 'on' : 'off'],
      ['Last bid attempt', a ? `${WBA.fmtTime(a.t)} ${a.trigger}` : '—'],
      ['Last bid result', a ? `${a.ok ? 'OK' : 'NOT PLACED'} — ${a.reason}` : '—'],
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

  // High-resolution remaining-time display against the server end time.
  function tick() {
    const s = snap && snap.state;
    if (s && s.endTime != null) {
      const ms = s.endTime - serverNow();
      $('remaining').textContent = ms > 0 ? `${(ms / 1000).toFixed(3)} sec` : 'ended';
      $('remaining').classList.toggle('urgent', ms > 0 && ms < 5000);
    } else $('remaining').textContent = '—';
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

  $('bidNow').addEventListener('click', (ev) =>
    run(ev.target, async () => {
      await request(M.BID_NOW, {
        expectedAuctionId: snap && snap.state.auctionId,
        expectedStreamId: snap && snap.streamId,
      });
    })
  );
  async function setLive(on) {
    try {
      await request(M.SET_LIVE, { on, confirmed: on });
    } catch (e) {
      appendLog({ t: Date.now(), level: 'error', msg: `panel: ${e.message}` });
    }
    render();
  }
  $('dryRun').addEventListener('change', () => {
    if ($('dryRun').checked) {
      $('liveConfirm').classList.add('hidden');
      return setLive(false);
    }
    // Going live: keep the box ticked until explicitly confirmed.
    $('dryRun').checked = true;
    $('liveMax').textContent =
      settings.maxBidMinor != null ? WBA.money.formatMoney(settings.maxBidMinor, snap && snap.state.currency) : 'NOT SET';
    $('liveConfirm').classList.remove('hidden');
  });
  $('liveYes').addEventListener('click', () => {
    $('liveConfirm').classList.add('hidden');
    setLive(true);
  });
  $('liveNo').addEventListener('click', () => $('liveConfirm').classList.add('hidden'));
  $('arm').addEventListener('click', (ev) =>
    run(ev.target, () => request(snap && snap.armed ? M.DISARM : M.ARM))
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
