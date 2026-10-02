// DOM inspection. These are DISCOVERY heuristics (text patterns, not
// Whatnot-specific selectors): they list candidate elements so we can find the
// real, stable hooks (data-testid, aria attributes, React props) for the
// auction widgets. Nothing here feeds the auction state.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  const MONEY_RE = /^\s*(?:[£$€]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?[£$€])\s*$/;
  const TIMER_RE = /^\s*(?:(?:\d{1,2}:)?\d{1,2}:\d{2}|\d{1,3}(?:\.\d+)?\s?s)\s*$/;
  const BID_RE = /\bbid\b/i;
  const SUDDEN_RE = /sudden\s*death|💀|skull/i;
  const SUDDEN_ATTRS = ['aria-label', 'title', 'alt', 'data-testid', 'src', 'class'];

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

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  }

  function describe(el) {
    const cls = el.getAttribute('class') || '';
    return {
      path: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100),
      testId: el.getAttribute('data-testid'),
      ariaLabel: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      title: el.getAttribute('title'),
      classes: cls.length > 120 ? cls.slice(0, 120) + '…' : cls,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      visible: isVisible(el),
    };
  }

  /** Smallest element whose own text matches re (no child matches on its own). */
  function smallestMatch(el, re, maxLen) {
    const t = (el.textContent || '').trim();
    if (!t || t.length > maxLen || !re.test(t)) return false;
    for (const c of el.children) if (re.test((c.textContent || '').trim())) return false;
    return true;
  }

  function suddenHint(el) {
    for (const a of SUDDEN_ATTRS) {
      const v = el.getAttribute(a);
      if (v && SUDDEN_RE.test(v)) return `${a}="${v.slice(0, 80)}"`;
    }
    if (el.tagName === 'title' && SUDDEN_RE.test(el.textContent || '')) return 'svg <title>';
    if (el.childElementCount === 0 && SUDDEN_RE.test(el.textContent || '')) return 'text';
    return null;
  }

  function scan() {
    const res = { at: Date.now(), href: location.href, bidButtons: [], money: [], timers: [], suddenDeath: [], ariaLive: [], testIds: [] };
    if (!document.body) return res;
    const testIds = new Map();
    for (const el of document.body.querySelectorAll('*')) {
      const tid = el.getAttribute('data-testid');
      if (tid) testIds.set(tid, (testIds.get(tid) || 0) + 1);

      const isButton = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
      if (isButton && res.bidButtons.length < 30 && (BID_RE.test(el.textContent || '') || BID_RE.test(el.getAttribute('aria-label') || ''))) {
        res.bidButtons.push(describe(el));
      }
      if (res.money.length < 60 && smallestMatch(el, MONEY_RE, 14)) res.money.push(describe(el));
      if (res.timers.length < 30 && smallestMatch(el, TIMER_RE, 10)) res.timers.push(describe(el));
      const hint = res.suddenDeath.length < 30 && suddenHint(el);
      if (hint) res.suddenDeath.push({ hint, ...describe(el) });
      if (el.hasAttribute('aria-live') && res.ariaLive.length < 30) res.ariaLive.push({ live: el.getAttribute('aria-live'), ...describe(el) });
    }
    res.testIds = Array.from(testIds, ([id, count]) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id));
    return res;
  }

  /**
   * Records DOM text changes that look like prices, timers or sudden-death
   * markers into the capture timeline, so DOM update timing can be compared
   * with network/WebSocket timing.
   */
  function createWatcher(onChange) {
    let observer = null;
    const last = new Map(); // path -> text, to drop no-op mutations

    function classify(text) {
      if (MONEY_RE.test(text)) return 'money';
      if (TIMER_RE.test(text)) return 'timer';
      if (SUDDEN_RE.test(text)) return 'sudden';
      return null;
    }

    function handle(records) {
      const p = performance.now();
      const seen = new Set();
      for (const r of records) {
        const el = r.type === 'characterData' ? r.target.parentElement : r.target;
        if (!el || el.nodeType !== 1 || seen.has(el)) continue;
        seen.add(el);
        const text = (el.textContent || '').trim();
        if (!text || text.length > 40) continue;
        const match = classify(text);
        if (!match) continue;
        const path = cssPath(el);
        if (last.get(path) === text) continue;
        last.set(path, text);
        if (last.size > 2000) last.clear();
        onChange({ p, path, text, match });
      }
    }

    return {
      start() {
        if (observer || !document.body) return false;
        observer = new MutationObserver(handle);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        return true;
      },
      stop() {
        if (observer) observer.disconnect();
        observer = null;
      },
      get running() {
        return !!observer;
      },
    };
  }

  WBA.domProbe = { scan, createWatcher, cssPath, describe };
})(globalThis);
