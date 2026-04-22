/**
 * NEXUS — Session & Timing Edge Engine
 * Session detection, validity rules, confidence multipliers.
 */

function getCurrentSession(utcTime) {
  const d = utcTime instanceof Date ? utcTime : new Date(utcTime);
  const h = d.getUTCHours();
  const dow = d.getUTCDay(); // 0=Sun

  if (h >= 0 && h < 7) return { name: 'Asian', code: 'asian' };
  if (h >= 7 && h < 8) return { name: 'London Pre', code: 'london_pre' };
  if (h >= 8 && h < 12) return { name: 'London', code: 'london' };
  if (h >= 12 && h < 13) return { name: 'London Close', code: 'london_close' };
  if (h >= 13 && h < 17) return { name: 'New York', code: 'ny' };
  if (h >= 17 && h < 20) return { name: 'NY Close', code: 'ny_close' };
  return { name: 'Dead Zone', code: 'dead' };
}

function isValidSessionForSignal(symbol, utcTime) {
  const session = getCurrentSession(utcTime);
  const d = utcTime instanceof Date ? utcTime : new Date(utcTime);
  const dow = d.getUTCDay();
  const h = d.getUTCHours();

  if (symbol === 'XAUUSD') {
    // Gold: no Asian, no dead zone, no Friday after 17 UTC
    if (session.code === 'asian') return { valid: false, reason: 'Asian session — no Gold signals' };
    if (session.code === 'dead') return { valid: false, reason: 'Dead zone — no Gold signals' };
    if (dow === 5 && h >= 17) return { valid: false, reason: 'Friday close — weekend risk' };
    if (dow === 0 || dow === 6) return { valid: false, reason: 'Weekend — Gold market closed' };
    return { valid: true, reason: null };
  }

  // BTC/ETH: 24/7 with restrictions
  if (dow === 0 && h < 4) return { valid: false, reason: 'Weekly open volatility — wait for confirmation' };
  if (dow === 6 && h >= 20) return { valid: false, reason: 'Saturday low liquidity' };
  return { valid: true, reason: null };
}

function getSessionMultiplier(symbol, utcTime) {
  const session = getCurrentSession(utcTime);
  const d = utcTime instanceof Date ? utcTime : new Date(utcTime);
  const dow = d.getUTCDay();
  const h = d.getUTCHours();

  if (symbol === 'XAUUSD') {
    if (session.code === 'london' && h >= 8 && h <= 10) return 1.3; // London open breakout
    if (session.code === 'ny' && h >= 13 && h <= 15) return 1.2; // NY open
    if (dow === 1 && h >= 8 && h <= 10) return 1.4; // Monday sweep
    if (session.code === 'london_close') return 0.8;
    if (session.code === 'ny_close') return 0.7;
    return 1.0;
  }

  // BTC/ETH
  if (session.code === 'ny') return 1.15; // NY volatility expansion
  if (dow === 0 && h >= 4 && h <= 8) return 1.1; // Weekly open first candles
  if (session.code === 'asian') return 0.85;
  if (dow === 6) return 0.75; // Weekend
  return 1.0;
}

function calculateSessionScore(symbol, utcTime) {
  const validity = isValidSessionForSignal(symbol, utcTime);
  const multiplier = getSessionMultiplier(symbol, utcTime);
  const session = getCurrentSession(utcTime);

  return {
    session,
    valid: validity.valid,
    reason: validity.reason,
    multiplier: Math.round(multiplier * 100) / 100,
    score: validity.valid ? Math.round(Math.min(1, multiplier / 1.5) * 100) / 100 : 0,
  };
}

module.exports = { getCurrentSession, isValidSessionForSignal, getSessionMultiplier, calculateSessionScore };
