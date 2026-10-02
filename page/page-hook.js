// Runs in the PAGE's JavaScript world ("world": "MAIN") at document_start so it
// is installed before Whatnot's own code creates sockets or issues requests.
//
// Purpose:
//   * observe data the page legitimately receives: WebSocket frames, fetch and
//     XHR responses. The page's own requests/responses are never modified or delayed.
//   * answer inspection requests from the content script: React fiber probes,
//     page globals (Apollo cache etc.), click-to-pick an element.
//   * place a bid on request (see "bid execution" below): sends the same
//     place_bid push the Whatnot page itself sends, on the page's own
//     authenticated auction socket, after a last-moment check here.
//
// Everything is forwarded to the isolated-world content script with
// window.postMessage tagged with CHANNEL.
(() => {
  'use strict';
  const CHANNEL = 'wba-v1'; // must match WBA.constants.CHANNEL
  const HOOKED = Symbol.for('wba.hooked');
  if (window[HOOKED]) return;
  Object.defineProperty(window, HOOKED, { value: true });

  const MAX_TEXT = 200000;
  const BINARY_PREVIEW_BYTES = 4096;
  const TEXTUAL_CT = /json|text\/plain|graphql/i;
  const AUCTION_SOCKET = /^wss:\/\/(?:www\.)?whatnot\.com\/services\/auction\/socket\/websocket/;
  const INTERESTING =
    /auction|bid|price|amount|endsAt|endAt|endTime|ends_at|end_time|expir|timer|countdown|sudden|death|listing|lot|winner|sold|increment/i;

  // ---------------------------------------------------------------- bridge --
  function post(kind, payload) {
    try {
      window.postMessage({ __wba: CHANNEL, dir: 'page', kind, payload }, window.location.origin);
    } catch (_) {
      /* never let inspection break the page */
    }
  }
  const stamp = () => ({ t: Date.now(), p: performance.now() });
  const clip = (s) => (s.length > MAX_TEXT ? { text: s.slice(0, MAX_TEXT), truncated: s.length } : { text: s, truncated: 0 });

  // ------------------------------------------------------- payload helpers --
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  function describeBinary(buf) {
    const bytes = new Uint8Array(buf);
    try {
      return { encoding: 'utf8-binary', size: bytes.length, ...clip(utf8.decode(bytes)) };
    } catch (_) {
      /* not UTF-8: fall through to base64 */
    }
    const head = bytes.subarray(0, BINARY_PREVIEW_BYTES);
    let bin = '';
    for (let i = 0; i < head.length; i++) bin += String.fromCharCode(head[i]);
    return {
      encoding: 'base64',
      size: bytes.length,
      text: btoa(bin),
      truncated: bytes.length > head.length ? bytes.length : 0,
    };
  }
  function describeData(data) {
    if (typeof data === 'string') return { encoding: 'text', size: data.length, ...clip(data) };
    if (data instanceof ArrayBuffer) return describeBinary(data);
    if (ArrayBuffer.isView(data)) return describeBinary(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.arrayBuffer().then(describeBinary);
    return { encoding: 'unknown', size: 0, text: String(data), truncated: 0 };
  }

  // ------------------------------------------------------------- WebSocket --
  const NativeWS = window.WebSocket;
  if (NativeWS) {
    let nextSocketId = 1;
    const socketIds = new WeakMap();
    const nativeSend = NativeWS.prototype.send;

    NativeWS.prototype.send = function (data) {
      const ts = stamp();
      const socket = socketIds.get(this) || null;
      if (typeof data === 'string' && auctionSockets.has(socket)) observeAuctionSend(socket, data);
      const url = this.url;
      try {
        Promise.resolve(describeData(data))
          .then((d) => post('ws-out', { socket, url, ...ts, ...d }))
          .catch(() => {});
      } catch (_) {
        /* ignore */
      }
      return nativeSend.apply(this, arguments);
    };

    const Hooked = class WebSocket extends NativeWS {
      constructor(...args) {
        super(...args);
        const socket = nextSocketId++;
        socketIds.set(this, socket);
        const url = this.url;
        const isAuction = AUCTION_SOCKET.test(url);
        if (isAuction) auctionSockets.set(socket, { ws: this, joins: new Map() });
        post('ws-connect', { socket, url, ...stamp() });
        this.addEventListener('open', () => post('ws-open', { socket, url, protocol: this.protocol, ...stamp() }));
        this.addEventListener('close', (e) => {
          auctionSockets.delete(socket);
          post('ws-close', { socket, url, code: e.code, reason: e.reason, ...stamp() });
        });
        this.addEventListener('message', (e) => {
          // e.timeStamp: when the event was created (same timeline as performance.now()).
          const ts = { ...stamp(), ev: e.timeStamp };
          if (isAuction && typeof e.data === 'string') observeAuctionFrame(socket, e.data, ts);
          Promise.resolve(describeData(e.data))
            .then((d) => post('ws-in', { socket, url, ...ts, ...d }))
            .catch(() => {});
        });
      }
    };
    window.WebSocket = Hooked;
  }

  // ------------------------------------------------- auction socket state --
  // Minimal tracking of the auction socket so a bid can be checked against the
  // freshest data at the moment it is sent (the content script's copy of the
  // state lags by a postMessage hop).
  //   joins:  topic -> { joinRef, ok }        (from our observation of the page's phx_join)
  //   latest: topic -> { id, active, next, currency, endTime, t }
  const auctionSockets = new Map(); // socketId -> { ws, joins }
  const latestByTopic = new Map();
  const pendingReplies = new Map(); // ref -> resolve
  function parsePhx(text) {
    try {
      const j = JSON.parse(text);
      return Array.isArray(j) && j.length === 5 ? j : null;
    } catch (_) {
      return null;
    }
  }
  function observeAuctionSend(socket, text) {
    const f = parsePhx(text);
    if (!f) return;
    const [joinRef, ref, topic, event] = f;
    const s = auctionSockets.get(socket);
    if (event === 'phx_join') s.joins.set(topic, { joinRef, ref, ok: false });
    else if (event === 'phx_leave') s.joins.delete(topic);
  }
  function observeAuctionFrame(socket, text, ts) {
    const f = parsePhx(text);
    if (!f) return;
    const [, ref, topic, event, payload] = f;
    const s = auctionSockets.get(socket);
    if (event === 'phx_reply') {
      const j = s && s.joins.get(topic);
      if (j && j.ref === ref) j.ok = payload && payload.status === 'ok';
      const pending = pendingReplies.get(ref);
      if (pending) {
        pendingReplies.delete(ref);
        pending({ payload, ts });
      }
      return;
    }
    if (event === 'phx_close' || event === 'phx_error') {
      if (s) s.joins.delete(topic);
      return;
    }
    const pr = payload && (payload.product || payload.pinnedProduct);
    if (!pr || typeof pr.id !== 'string') return;
    const cur = latestByTopic.get(topic);
    if (pr.isAuctionActive === true) {
      const next = pr.nextBidPrice && Number.isInteger(pr.nextBidPrice.amount) ? pr.nextBidPrice.amount : null;
      latestByTopic.set(topic, {
        id: pr.id,
        active: true,
        next,
        currency: pr.nextBidPrice ? pr.nextBidPrice.currency : null,
        endTime: pr.auctionEndTime,
        t: ts.t,
      });
    } else if (cur && cur.id === pr.id) {
      cur.active = false; // this auction ended; inactive parent listings are ignored
    }
  }

  // -------------------------------------------------------- bid execution --
  // Sends exactly the frame the Whatnot page sends when you press bid:
  //   [joinRef, ref, "commerce:<livestreamId>", "place_bid",
  //    { bidType: "STANDARD_BID", isCustomBid: false, price: {amount, currency},
  //      productId, validatePotentialTrollBid: false }]
  // (the page also adds telemetry "sloStories"; omitted). Our refs are prefixed
  // strings so they can never collide with the page's numeric refs; the page's
  // Phoenix client ignores replies to refs it did not issue.
  let bidSeq = 0;
  function placeBid({ topic, productId, amountMinor, currency, timeoutMs = 4000 }) {
    const fail = (reason, detail) => ({ sent: false, reason, detail: detail || null });
    if (typeof topic !== 'string' || typeof productId !== 'string' || !Number.isInteger(amountMinor) || amountMinor <= 0) {
      return fail('BAD_ARGS');
    }
    let target = null;
    for (const s of auctionSockets.values()) {
      const j = s.joins.get(topic);
      if (s.ws.readyState === NativeWS.OPEN && j && j.ok) target = { ws: s.ws, joinRef: j.joinRef };
    }
    if (!target) return fail('NO_JOINED_SOCKET');
    const latest = latestByTopic.get(topic);
    if (!latest) return fail('NO_AUCTION_SEEN');
    if (latest.id !== productId) return fail('AUCTION_CHANGED', `page=${latest.id}`);
    if (!latest.active) return fail('AUCTION_NOT_ACTIVE');
    if (latest.next !== amountMinor) return fail('PRICE_MOVED', `page next=${latest.next}`);
    if (currency && latest.currency && latest.currency !== currency) return fail('CURRENCY_MISMATCH');

    const ref = `wba${++bidSeq}`;
    const frame = JSON.stringify([
      target.joinRef,
      ref,
      topic,
      'place_bid',
      {
        bidType: 'STANDARD_BID',
        isCustomBid: false,
        price: { amount: amountMinor, currency: latest.currency || currency },
        productId,
        validatePotentialTrollBid: false,
      },
    ]);
    return new Promise((resolve) => {
      let send = null;
      const timer = setTimeout(() => {
        pendingReplies.delete(ref);
        resolve({ sent: true, ref, send, reply: null, reason: 'NO_REPLY' });
      }, timeoutMs);
      pendingReplies.set(ref, ({ payload, ts }) => {
        clearTimeout(timer);
        resolve({ sent: true, ref, send, reply: { ...ts, status: payload && payload.status, response: ser(payload && payload.response, 3) } });
      });
      try {
        send = stamp();
        target.ws.send(frame); // goes through the observed send, so it appears in the capture as ws-out
      } catch (e) {
        clearTimeout(timer);
        pendingReplies.delete(ref);
        resolve(fail('SEND_FAILED', String(e)));
      }
    });
  }

  // ----------------------------------------------------------------- fetch --
  const nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      const start = stamp();
      let url = '';
      let method = 'GET';
      let reqBody = null;
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          url = input.url;
          method = input.method;
        } else {
          url = String(input);
        }
        if (init && init.method) method = String(init.method).toUpperCase();
        if (init && typeof init.body === 'string') reqBody = clip(init.body).text;
      } catch (_) {
        /* ignore */
      }
      const promise = nativeFetch.apply(window, arguments);
      promise.then(
        (res) => observeResponse(res, { url, method, reqBody, start }),
        (err) => post('fetch', { url, method, reqBody, error: String(err), start, end: stamp() })
      );
      return promise;
    };
  }

  function observeResponse(res, info) {
    try {
      const end = stamp();
      const ct = res.headers.get('content-type') || '';
      const base = {
        url: res.url || info.url,
        method: info.method,
        status: res.status,
        contentType: ct,
        dateHeader: res.headers.get('date'),
        reqBody: info.reqBody,
        start: info.start,
        end,
      };
      if (!TEXTUAL_CT.test(ct)) return post('fetch', base);
      res
        .clone()
        .text()
        .then(
          (txt) => post('fetch', { ...base, ...clip(txt) }),
          () => post('fetch', base)
        );
    } catch (_) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------- XHR --
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const meta = new WeakMap();
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      meta.set(this, { method: String(method).toUpperCase(), url: String(url) });
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const m = meta.get(this) || {};
      const start = stamp();
      const reqBody = typeof body === 'string' ? clip(body).text : null;
      this.addEventListener(
        'loadend',
        () => {
          try {
            const headers = parseHeaders(this.getAllResponseHeaders());
            const ct = headers['content-type'] || '';
            const out = {
              url: this.responseURL || m.url,
              method: m.method,
              status: this.status,
              contentType: ct,
              dateHeader: headers.date || null,
              reqBody,
              start,
              end: stamp(),
            };
            let text = null;
            if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
            else if (this.responseType === 'json') text = JSON.stringify(this.response);
            if (text != null && TEXTUAL_CT.test(ct)) Object.assign(out, clip(text));
            post('xhr', out);
          } catch (_) {
            /* ignore */
          }
        },
        { once: true }
      );
      return send.apply(this, arguments);
    };
  }
  function parseHeaders(raw) {
    const out = {};
    for (const line of (raw || '').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return out;
  }

  // ------------------------------------------------------ safe serialising --
  const SKIP_KEYS = new Set(['_owner', 'return', 'child', 'sibling', 'stateNode', 'alternate', '_store']);
  function safe(v, depth, seen) {
    const t = typeof v;
    if (v === null || v === undefined || t === 'boolean' || t === 'number') return v;
    if (t === 'string') return v.length > 500 ? v.slice(0, 500) + '…' : v;
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return String(v);
    if (t === 'function') return `[fn ${v.name || 'anonymous'}]`;
    if (seen.has(v)) return '[circular]';
    if (typeof Node !== 'undefined' && v instanceof Node) return `[${v.nodeName}]`;
    if (v.$$typeof) return '[ReactElement]';
    if (v instanceof Date) return v.toISOString();
    if (depth <= 0) return Array.isArray(v) ? `[Array(${v.length})]` : '[Object]';
    seen.add(v);
    if (Array.isArray(v)) {
      const out = v.slice(0, 20).map((x) => safe(x, depth - 1, seen));
      if (v.length > 20) out.push(`…${v.length - 20} more`);
      return out;
    }
    if (v instanceof Map) return { '[Map]': safe(Array.from(v.entries()).slice(0, 20), depth - 1, seen) };
    if (v instanceof Set) return { '[Set]': safe(Array.from(v).slice(0, 20), depth - 1, seen) };
    const out = {};
    let keys;
    try {
      keys = Object.keys(v);
    } catch (_) {
      return '[unreadable]';
    }
    keys.slice(0, 40).forEach((k) => {
      if (SKIP_KEYS.has(k)) return void (out[k] = '[skipped]');
      let x;
      try {
        x = v[k];
      } catch (_) {
        x = '[throws]';
      }
      out[k] = safe(x, depth - 1, seen);
    });
    if (keys.length > 40) out['…'] = `${keys.length - 40} more keys`;
    return out;
  }
  const ser = (v, depth = 4) => safe(v, depth, new WeakSet());

  function hasInteresting(obj) {
    if (!obj || typeof obj !== 'object') return false;
    try {
      return Object.keys(obj).some((k) => INTERESTING.test(k));
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------- React probe --
  function fiberOf(el) {
    for (const k of Object.keys(el)) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return el[k];
    }
    return null;
  }
  function componentName(f) {
    const t = f.type;
    if (!t) return '(host-root)';
    if (typeof t === 'string') return t;
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || '(anonymous)';
  }
  function unwrapHook(s) {
    if (Array.isArray(s) && s.length === 2 && Array.isArray(s[1])) return s[0]; // useMemo/useCallback [value, deps]
    if (s && typeof s === 'object' && 'current' in s && Object.keys(s).length === 1) return s.current; // useRef
    return s;
  }
  function probeElement(el, maxUp = 40) {
    const found = new Map();
    let f = fiberOf(el);
    const hasReact = !!f;
    let depth = 0;
    while (f && depth < maxUp && found.size < 60) {
      const name = componentName(f);
      const props = f.memoizedProps;
      if (props && typeof props === 'object') {
        for (const k of Object.keys(props)) {
          if (k === 'children') continue;
          const v = props[k];
          if (INTERESTING.test(k) || hasInteresting(v)) {
            const id = `${name}|props.${k}`;
            if (!found.has(id)) found.set(id, { depth, component: name, where: `props.${k}`, value: ser(v) });
          }
        }
      }
      if (typeof f.type === 'function' || (f.type && typeof f.type === 'object')) {
        let h = f.memoizedState;
        if (h && typeof h === 'object' && 'next' in h && 'memoizedState' in h) {
          for (let i = 0; h && i < 40; i++, h = h.next) {
            const s = unwrapHook(h.memoizedState);
            if (hasInteresting(s)) {
              const id = `${name}|hook[${i}]`;
              if (!found.has(id)) found.set(id, { depth, component: name, where: `hook[${i}]`, value: ser(s) });
            }
          }
        } else if (hasInteresting(h)) {
          const id = `${name}|state`;
          if (!found.has(id)) found.set(id, { depth, component: name, where: 'state', value: ser(h) });
        }
      }
      f = f.return;
      depth++;
    }
    return { hasReact, findings: Array.from(found.values()) };
  }

  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 8) {
      let part = el.tagName.toLowerCase();
      const tid = el.getAttribute('data-testid');
      if (el.id) {
        parts.unshift(`${part}#${CSS.escape(el.id)}`);
        break;
      }
      if (tid) {
        parts.unshift(`${part}[data-testid="${tid}"]`);
        break;
      }
      const parent = el.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(' > ');
  }

  function describeElement(el) {
    const html = el.outerHTML || '';
    return {
      path: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 200),
      outerHTML: html.length > 3000 ? html.slice(0, 3000) + '…' : html,
    };
  }

  // Elements worth probing automatically: bid-ish buttons and short price/timer texts.
  const MONEY_RE = /^\s*[£$€]\s?\d[\d,]*(?:\.\d{1,2})?\s*$/;
  const TIMER_RE = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*$|^\s*\d{1,3}\s?s\s*$/;
  function autoCandidates() {
    const out = [];
    for (const el of document.querySelectorAll('button,[role="button"]')) {
      if (/\bbid\b/i.test(el.textContent || '') || /\bbid\b/i.test(el.getAttribute('aria-label') || '')) out.push(el);
    }
    for (const el of document.querySelectorAll('span,div,p,strong,b')) {
      const t = (el.textContent || '').trim();
      if (t.length > 12 || el.childElementCount > 0) continue;
      if (MONEY_RE.test(t) || TIMER_RE.test(t)) out.push(el);
    }
    return out.slice(0, 12);
  }

  function reactProbe({ selector } = {}) {
    const els = selector ? Array.from(document.querySelectorAll(selector)).slice(0, 8) : autoCandidates();
    return els.map((el) => ({ element: describeElement(el), ...probeElement(el) }));
  }

  // -------------------------------------------------------- globals probe --
  function globalsProbe() {
    let base = new Set();
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.documentElement.appendChild(iframe);
      base = new Set(Object.getOwnPropertyNames(iframe.contentWindow));
      iframe.remove();
    } catch (_) {
      /* fall back to listing everything */
    }
    const globals = [];
    for (const name of Object.getOwnPropertyNames(window)) {
      if (base.has(name)) continue;
      let v;
      try {
        v = window[name];
      } catch (_) {
        continue;
      }
      let keys;
      if (v && typeof v === 'object') {
        try {
          keys = Object.keys(v).slice(0, 25);
        } catch (_) {
          keys = ['[unreadable]'];
        }
      }
      globals.push({
        name,
        type: typeof v,
        keys,
        flagged: /apollo|relay|urql|redux|store|state|next|query|cache|graphql|auction|whatnot|socket|pusher|ably/i.test(name),
      });
    }
    globals.sort((a, b) => Number(b.flagged) - Number(a.flagged) || a.name.localeCompare(b.name));

    let apollo = null;
    try {
      const ac = window.__APOLLO_CLIENT__;
      if (ac && ac.cache && typeof ac.cache.extract === 'function') {
        const data = ac.cache.extract();
        const keys = Object.keys(data);
        apollo = {
          totalKeys: keys.length,
          interesting: keys
            .filter((k) => INTERESTING.test(k) || hasInteresting(data[k]))
            .slice(0, 60)
            .map((k) => ({ key: k, value: ser(data[k], 3) })),
        };
      }
    } catch (e) {
      apollo = { error: String(e) };
    }
    return { globals, apollo, hasNextData: !!document.getElementById('__NEXT_DATA__') };
  }

  // ----------------------------------------------------------- pick mode --
  // Highlights the hovered element; the next click is swallowed (never reaches
  // Whatnot, so picking the bid button cannot bid) and that element is probed.
  let picking = null;
  function startPick() {
    if (picking) return { already: true };
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ff3d7f;background:rgba(255,61,127,.12);transition:all 40ms;';
    document.documentElement.appendChild(box);
    const block = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const move = (e) => {
      const r = e.target.getBoundingClientRect();
      Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    };
    const click = (e) => {
      block(e);
      const el = e.target;
      stopPick();
      post('pick-result', { element: describeElement(el), ...probeElement(el), t: Date.now() });
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        block(e);
        stopPick();
        post('pick-result', { cancelled: true });
      }
    };
    const blockers = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick'];
    for (const t of blockers) window.addEventListener(t, block, true);
    window.addEventListener('mousemove', move, true);
    window.addEventListener('click', click, true);
    window.addEventListener('keydown', key, true);
    picking = () => {
      for (const t of blockers) window.removeEventListener(t, block, true);
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('keydown', key, true);
      box.remove();
    };
    return { started: true };
  }
  function stopPick() {
    if (picking) picking();
    picking = null;
  }

  // ------------------------------------------------------ command channel --
  const COMMANDS = {
    'react-probe': reactProbe,
    'globals-probe': globalsProbe,
    'pick-start': startPick,
    'pick-stop': () => (stopPick(), { stopped: true }),
    'place-bid': placeBid,
  };
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.__wba !== CHANNEL || d.dir !== 'content') return;
    const reply = (result, error) => {
      try {
        window.postMessage({ __wba: CHANNEL, dir: 'page-reply', id: d.id, result, error }, window.location.origin);
      } catch (e) {
        window.postMessage({ __wba: CHANNEL, dir: 'page-reply', id: d.id, error: 'unserialisable result: ' + e }, window.location.origin);
      }
    };
    try {
      if (!COMMANDS[d.cmd]) throw new Error('unknown command ' + d.cmd);
      Promise.resolve(COMMANDS[d.cmd](d.args || {})).then(
        (r) => reply(r, null),
        (e) => reply(undefined, String((e && e.stack) || e))
      );
    } catch (e) {
      reply(undefined, String((e && e.stack) || e));
    }
  });

  post('hook-ready', { ...stamp(), href: location.href });
})();
