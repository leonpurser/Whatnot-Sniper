// Field discovery over captured traffic: walks every JSON payload the page
// receives and indexes keys that look auction-related, so we can see which
// message/path actually carries price, end time, sudden death, etc.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  /**
   * Parse a payload as JSON. Tolerates common framing prefixes such as
   * Socket.IO ("42[...]"). Returns undefined if it is not JSON.
   */
  function tryParseJson(text) {
    if (typeof text !== 'string') return undefined;
    let s = text.trim();
    if (!s) return undefined;
    const framed = s.match(/^\d+(?=[[{])/);
    if (framed) s = s.slice(framed[0].length);
    if (s[0] !== '{' && s[0] !== '[') return undefined;
    try {
      return JSON.parse(s);
    } catch (_) {
      return undefined;
    }
  }

  const ID_LIKE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}|[A-Za-z0-9_-]{20,})$/i;

  /**
   * Depth-first walk. visit(path, key, value) is called for every object key.
   * Array indices are collapsed to [] and id-like object keys to <id> so that
   * paths aggregate across messages.
   */
  function walk(root, visit, { maxDepth = 14, maxNodes = 20000 } = {}) {
    let nodes = 0;
    (function rec(v, path, depth) {
      if (nodes++ > maxNodes || depth > maxDepth || v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        for (const item of v) rec(item, path + '[]', depth + 1);
        return;
      }
      for (const key of Object.keys(v)) {
        const seg = ID_LIKE.test(key) ? '<id>' : key;
        const p = path ? path + '.' + seg : seg;
        let val = v[key];
        visit(p, key, val);
        // Some APIs embed JSON as a string; look inside it too.
        if (typeof val === 'string' && val.length < 100000 && (val[0] === '{' || val[0] === '[')) {
          const inner = tryParseJson(val);
          if (inner !== undefined) {
            rec(inner, p + '{json}', depth + 1);
            continue;
          }
        }
        rec(val, p, depth + 1);
      }
    })(root, '', 0);
  }

  function preview(value) {
    if (value === null) return 'null';
    if (typeof value === 'object') {
      if (Array.isArray(value)) return `Array(${value.length})`;
      const keys = Object.keys(value);
      return `{${keys.slice(0, 6).join(',')}${keys.length > 6 ? ',…' : ''}}`;
    }
    const s = String(value);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }

  function typeOf(v) {
    return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  }

  class FieldIndex {
    constructor(pattern, maxFields = 3000) {
      this.pattern = pattern;
      this.maxFields = maxFields;
      this.map = new Map();
    }

    add(source, json, t) {
      walk(json, (path, key, value) => {
        if (!this.pattern.test(key)) return;
        const id = source + '|' + path;
        let f = this.map.get(id);
        if (!f) {
          if (this.map.size >= this.maxFields) return;
          f = { source, path, count: 0, changes: 0, type: null, lastValue: null, firstT: t, lastT: t };
          this.map.set(id, f);
        }
        const pv = preview(value);
        if (f.count > 0 && pv !== f.lastValue) f.changes++;
        f.count++;
        f.type = typeOf(value);
        f.lastValue = pv;
        f.lastT = t;
      });
    }

    list({ filter = '', limit = 300 } = {}) {
      const needle = filter.trim().toLowerCase();
      const out = [];
      for (const f of this.map.values()) {
        if (needle && !(f.path.toLowerCase().includes(needle) || f.source.toLowerCase().includes(needle))) continue;
        out.push({ ...f });
      }
      out.sort((a, b) => b.lastT - a.lastT);
      return out.slice(0, limit);
    }

    clear() {
      this.map.clear();
    }

    get size() {
      return this.map.size;
    }
  }

  /** Find JSON paths whose leaf value matches the needle (string contains, or numeric equality). */
  function findValuePaths(json, needle, numericCandidates) {
    const hits = [];
    const lower = needle.toLowerCase();
    walk(json, (path, key, value) => {
      if (hits.length >= 20 || value === null || typeof value === 'object') return;
      if (typeof value === 'number' && numericCandidates.includes(value)) hits.push(`${path} = ${value}`);
      else if (String(value).toLowerCase().includes(lower)) hits.push(`${path} = ${preview(value)}`);
    });
    return hits;
  }

  /** For "£18" also look for 18, 18.0 and 1800 (minor units). */
  function numericCandidatesFor(needle) {
    const parsed = WBA.money && WBA.money.parseMoney(needle);
    if (!parsed) return [];
    const major = parsed.minor / 100;
    return Array.from(new Set([major, parsed.minor]));
  }

  WBA.discovery = { tryParseJson, walk, preview, FieldIndex, findValuePaths, numericCandidatesFor };
})(globalThis);
