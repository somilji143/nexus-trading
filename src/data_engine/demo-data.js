/**
 * NEXUS — Demo Data Generator v5
 * SEEDED + CACHED: Same symbol/tf always returns same data within a session.
 * Extends in real-time with small realistic increments.
 * Structured market regimes: TRENDING, RANGING, VOLATILE, LOW_VOL
 */

// ─── Seeded Random (deterministic per symbol) ───
function seededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s >>> 0) / 0x7fffffff;
  };
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ─── Session Cache (persistent within server lifetime) ───
const sessionCache = {};
const livePrices = {};

function generateDemoData(symbol, timeframe = '1h', count = 8760) {
  const key = `${symbol}:${timeframe}:${count}`;
  if (sessionCache[key]) return sessionCache[key];

  const cfgs = {
    XAUUSD: { start: 3300, vol: 0.0012, tv: 0.0025 },
    BTCUSDT: { start: 94000, vol: 0.004, tv: 0.007 },
    ETHUSDT: { start: 1800, vol: 0.005, tv: 0.009 },
  };
  const ints = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
  const c = cfgs[symbol] || cfgs.BTCUSDT;
  const iSec = ints[timeframe] || 3600;
  const sc = Math.sqrt(iSec / 3600);
  const bv = c.vol * sc, tv = c.tv * sc;

  // Seeded random for deterministic data
  const rand = seededRandom(hashStr(symbol + timeframe + String(count)));

  const candles = [];
  let price = c.start;
  const now = Math.floor(Date.now() / 1000);
  const st = now - count * iSec;

  const plan = buildPlan(count, tv, rand);

  for (let i = 0; i < count; i++) {
    const o = price;
    const mv = plan[i].move * price + (rand() - 0.5) * bv * price * 0.4;
    const cl = o + mv;
    const ph = plan[i].phase;
    const wm = ph === 'volatile' ? 1.2 : ph === 'low_vol' ? 0.1 : ph.includes('trend') ? 0.5 : 0.3;
    const wu = rand() * bv * price * wm;
    const wd = rand() * bv * price * wm;
    const h = Math.max(o, cl) + wu;
    const l = Math.min(o, cl) - wd;
    let vol = 2000 + rand() * 3000;
    if (ph.includes('trend') || ph.includes('bounce')) vol *= 1.8;
    if (ph === 'volatile') vol *= 2.5;
    if (ph === 'low_vol') vol *= 0.3;
    candles.push({ time: st + i * iSec, open: r(o), high: r(h), low: r(l), close: r(cl), volume: Math.round(vol) });
    price = cl;
    if (price < c.start * 0.3) price = c.start * 0.35;
    if (price > c.start * 3) price = c.start * 2.8;
  }

  // Store last price for consistent live pricing
  livePrices[symbol] = candles[candles.length - 1].close;

  sessionCache[key] = candles;
  return candles;
}

/**
 * Get the current live price for demo mode.
 * Returns a slowly drifting price based on cached data.
 */
function getDemoLivePrice(symbol) {
  if (!livePrices[symbol]) {
    // Generate base data to seed the price
    generateDemoData(symbol, '1h', 500);
  }
  const base = livePrices[symbol];
  // Small random walk: ±0.05% per tick
  const drift = base * (Math.random() - 0.5) * 0.001;
  livePrices[symbol] = r(base + drift);
  return livePrices[symbol];
}

function buildPlan(total, tv, rand) {
  const cy = []; let i = 0, dir = rand() > 0.5 ? 1 : -1;
  while (i < total) {
    const roll = rand();
    if (roll < 0.38) {
      const tl = 15 + Math.floor(rand() * 30);
      for (let j = 0; j < tl && i < total; j++, i++) { const s = (0.3 + rand() * 0.7) * (0.5 + rand() * 0.5); cy.push({ phase: dir > 0 ? 'trend_up' : 'trend_down', move: (rand() < 0.72 ? dir : -dir * 0.25) * tv * s }); }
      const pl = 5 + Math.floor(rand() * 8);
      for (let j = 0; j < pl && i < total; j++, i++) { cy.push({ phase: 'pullback', move: -dir * tv * (1 - j / pl * 0.5) * (0.3 + rand() * 0.2) * 0.6 }); }
      const bl = 2 + Math.floor(rand() * 3);
      for (let j = 0; j < bl && i < total; j++, i++) { cy.push({ phase: dir > 0 ? 'bounce_up' : 'bounce_down', move: dir * tv * (0.6 + rand() * 0.5) }); }
      const cl2 = 8 + Math.floor(rand() * 20);
      for (let j = 0; j < cl2 && i < total; j++, i++) { cy.push({ phase: dir > 0 ? 'trend_up' : 'trend_down', move: (rand() < 0.65 ? dir * tv * (0.3 + rand() * 0.5) : -dir * tv * 0.15) }); }
    } else if (roll < 0.52) {
      const l = 10 + Math.floor(rand() * 20);
      for (let j = 0; j < l && i < total; j++, i++) cy.push({ phase: 'range', move: (rand() - 0.5) * tv * 0.3 });
    } else if (roll < 0.62) {
      const l = 3 + Math.floor(rand() * 5);
      for (let j = 0; j < l && i < total; j++, i++) cy.push({ phase: 'volatile', move: (rand() - 0.5) * tv * 1.5 });
    } else if (roll < 0.72) {
      const l = 8 + Math.floor(rand() * 15);
      for (let j = 0; j < l && i < total; j++, i++) cy.push({ phase: 'low_vol', move: (rand() - 0.5) * tv * 0.1 });
    } else if (roll < 0.82) {
      dir *= -1;
      for (let j = 0; j < 5 && i < total; j++, i++) cy.push({ phase: dir > 0 ? 'trend_up' : 'trend_down', move: dir * tv * (0.5 + rand() * 0.6) });
    } else if (roll < 0.92) {
      const l = 8 + Math.floor(rand() * 15);
      for (let j = 0; j < l && i < total; j++, i++) cy.push({ phase: dir > 0 ? 'trend_up' : 'trend_down', move: dir * tv * (0.6 + rand() * 0.6) });
    } else {
      const l = 8 + Math.floor(rand() * 12);
      for (let j = 0; j < l && i < total; j++, i++) cy.push({ phase: 'chop', move: (rand() - 0.5) * tv * 0.6 });
      if (rand() > 0.5) dir *= -1;
    }
  }
  return cy.slice(0, total);
}

function r(v) { return Math.round(v * 100) / 100; }
module.exports = { generateDemoData, getDemoLivePrice };
