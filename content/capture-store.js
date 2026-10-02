// Ring buffer of everything the page hook observed (WebSocket frames,
// fetch/XHR responses, DOM changes, manual markers), plus field discovery.
//
// Listeners (auction-state sources) always receive every entry; "recording"
// only controls whether entries are kept in the buffer for inspection/export.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  function shortUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.host + u.pathname;
    } catch (_) {
      return String(url || '').split('?')[0];
    }
  }

  /** Aggregation key: which channel/operation a payload came from. */
  function sourceKey(entry, json, reqJson) {
    const kind = entry.kind.startsWith('ws-') ? entry.kind : entry.kind === 'xhr' ? 'fetch' : entry.kind;
    let key = `${kind} ${shortUrl(entry.url)}`;
    const op = reqJson && !Array.isArray(reqJson) && typeof reqJson.operationName === 'string' ? reqJson.operationName : null;
    if (op) key += ` op=${op}`;
    if (json && !Array.isArray(json) && typeof json === 'object') {
      for (const k of ['type', 'event', 'op', 'action', 'channel', 'topic']) {
        const v = json[k];
        if (typeof v === 'string' && v.length <= 40) {
          key += ` ${k}=${v}`;
          break;
        }
      }
    }
    return key;
  }

  WBA.createCaptureStore = function ({ limit, maxStoreChars, keyPattern, maxFields }) {
    const entries = [];
    const counts = {};
    const listeners = new Set();
    const fields = new WBA.discovery.FieldIndex(keyPattern, maxFields);
    let seq = 0;
    let recording = true;

    function add(kind, payload) {
      const entry = { seq: ++seq, kind, t: Date.now(), ...payload };
      counts[kind] = (counts[kind] || 0) + 1;

      let json;
      if (typeof entry.text === 'string' && entry.encoding !== 'base64') json = WBA.discovery.tryParseJson(entry.text);
      const reqJson = typeof entry.reqBody === 'string' ? WBA.discovery.tryParseJson(entry.reqBody) : undefined;
      entry.source = sourceKey(entry, json, reqJson);
      entry.json = json !== undefined;

      for (const fn of listeners) {
        try {
          fn(entry, json);
        } catch (e) {
          console.error('[WBA] capture listener failed', e);
        }
      }

      if (!recording) return entry;
      if (json !== undefined) fields.add(entry.source, json, entry.t);
      const stored = { ...entry };
      if (typeof stored.text === 'string' && stored.text.length > maxStoreChars) {
        stored.storedTruncated = stored.text.length;
        stored.text = stored.text.slice(0, maxStoreChars);
      }
      entries.push(stored);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      return entry;
    }

    function search(needle, max = 100) {
      const n = String(needle || '').trim();
      if (!n) return [];
      const lower = n.toLowerCase();
      const nums = WBA.discovery.numericCandidatesFor(n);
      const out = [];
      for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
        const e = entries[i];
        const hay = typeof e.text === 'string' ? e.text : '';
        const json = e.json ? WBA.discovery.tryParseJson(hay) : undefined;
        const paths = json !== undefined ? WBA.discovery.findValuePaths(json, n, nums) : [];
        const at = hay.toLowerCase().indexOf(lower);
        if (at < 0 && !paths.length) continue;
        out.push({
          seq: e.seq,
          kind: e.kind,
          t: e.t,
          source: e.source,
          paths,
          snippet: at >= 0 ? hay.slice(Math.max(0, at - 80), at + lower.length + 80) : '',
        });
      }
      return out;
    }

    return {
      add,
      search,
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      setRecording(on) {
        recording = !!on;
      },
      clear() {
        entries.length = 0;
        fields.clear();
        for (const k of Object.keys(counts)) delete counts[k];
      },
      listFields: (opts) => fields.list(opts),
      stats: () => ({ recording, buffered: entries.length, limit, counts: { ...counts }, fields: fields.size }),
      exportData() {
        return {
          format: 'wba-capture-v1',
          exportedAt: new Date().toISOString(),
          href: location.href,
          userAgent: navigator.userAgent,
          timeOrigin: performance.timeOrigin,
          counts: { ...counts },
          entries: entries.slice(),
        };
      },
    };
  };
})(globalThis);
