// Detects whether the tab is on a livestream and which one. Whatnot is a
// single-page app, so the URL is polled as well as watched via popstate.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  WBA.createStreamDetector = function ({ pattern, onChange, intervalMs = 400 }) {
    let current; // undefined until the first check so the first result always fires

    function check() {
      const m = location.pathname.match(pattern);
      const id = m ? decodeURIComponent(m[1]) : null;
      if (id !== current) {
        const prev = current === undefined ? null : current;
        current = id;
        onChange(id, prev);
      }
    }

    window.addEventListener('popstate', check);
    setInterval(check, intervalMs);
    check();

    return { get: () => (current === undefined ? null : current), check };
  };
})(globalThis);
