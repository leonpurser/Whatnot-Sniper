// Money is always handled as integer minor units (pence/cents) to avoid
// floating point comparisons in the max-bid check.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  const SYMBOLS = { '£': 'GBP', $: 'USD', '€': 'EUR' };
  const SYMBOL_FOR = { GBP: '£', USD: '$', EUR: '€' };

  /**
   * Parse user/display text like "£18", "£1,234.50", "30", "30.5".
   * Returns { minor, currency } or null if it is not an unambiguous amount.
   */
  function parseMoney(text) {
    if (text == null) return null;
    const s = String(text).trim();
    const m = s.match(/^([£$€])?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*([£$€])?$/);
    if (!m) return null;
    if (m[1] && m[4]) return null;
    const whole = Number(m[2].replace(/,/g, ''));
    const frac = m[3] ? Number(m[3].padEnd(2, '0')) : 0;
    if (!Number.isSafeInteger(whole)) return null;
    const sym = m[1] || m[4] || null;
    return { minor: whole * 100 + frac, currency: sym ? SYMBOLS[sym] : null };
  }

  function formatMoney(minor, currency) {
    if (minor == null || !Number.isFinite(minor)) return '—';
    const sym = SYMBOL_FOR[currency] || (currency ? currency + ' ' : '£');
    const neg = minor < 0 ? '-' : '';
    const abs = Math.abs(minor);
    const major = Math.floor(abs / 100);
    const cents = abs % 100;
    return `${neg}${sym}${major}${cents ? '.' + String(cents).padStart(2, '0') : ''}`;
  }

  WBA.money = { parseMoney, formatMoney };
})(globalThis);
