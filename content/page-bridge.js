// Isolated-world side of the page bridge: receives observations from
// page/page-hook.js and sends inspection commands to it.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  WBA.createPageBridge = function ({ channel, onEvent }) {
    const pending = new Map();
    let nextId = 1;

    window.addEventListener('message', (ev) => {
      const d = ev.data;
      // Only same-window messages carrying our tag. NOTE: the page itself can
      // also post these; observations are treated as page-provided data.
      if (ev.source !== window || !d || d.__wba !== channel) return;
      if (d.dir === 'page') onEvent(d.kind, d.payload || {});
      else if (d.dir === 'page-reply' && pending.has(d.id)) {
        const { resolve, reject, timer } = pending.get(d.id);
        pending.delete(d.id);
        clearTimeout(timer);
        if (d.error) reject(new Error(d.error));
        else resolve(d.result);
      }
    });

    function request(cmd, args, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`page command "${cmd}" timed out (is the page hook loaded?)`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        window.postMessage({ __wba: channel, dir: 'content', id, cmd, args }, window.location.origin);
      });
    }

    return { request };
  };
})(globalThis);
