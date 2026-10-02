// Timestamped logging: console output plus an in-memory ring buffer that the
// side panel displays.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  function pad(n, w) {
    return String(n).padStart(w, '0');
  }

  /** Format an epoch-ms timestamp as local HH:MM:SS.mmm. */
  function fmtTime(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
  }

  function createLog({ limit = 500, prefix = 'WBA', consoleOut = true } = {}) {
    const entries = [];
    const listeners = new Set();

    function write(level, msg, data) {
      const entry = { t: Date.now(), level, msg, data: data === undefined ? null : data };
      entries.push(entry);
      if (entries.length > limit) entries.shift();
      if (consoleOut && g.console) {
        const line = `[${prefix} ${fmtTime(entry.t)}] ${msg}`;
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        if (data === undefined) fn(line);
        else fn(line, data);
      }
      for (const l of listeners) {
        try {
          l(entry);
        } catch (_) {
          /* listener errors must not break logging */
        }
      }
      return entry;
    }

    return {
      info: (m, d) => write('info', m, d),
      warn: (m, d) => write('warn', m, d),
      error: (m, d) => write('error', m, d),
      entries: () => entries.slice(),
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  }

  WBA.fmtTime = fmtTime;
  WBA.createLog = createLog;
})(globalThis);
