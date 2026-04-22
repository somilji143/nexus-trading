/**
 * NEXUS — Demo Data Generator v4
 * Structured market regimes: TRENDING, RANGING, VOLATILE, LOW_VOL
 */
function generateDemoData(symbol, timeframe = '1h', count = 8760) {
  const cfgs = {
    XAUUSD: { start: 2400, vol: 0.0018, tv: 0.0035 },
    BTCUSDT: { start: 65000, vol: 0.005, tv: 0.009 },
    ETHUSDT: { start: 2800, vol: 0.006, tv: 0.011 },
  };
  const ints = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
  const c = cfgs[symbol] || cfgs.BTCUSDT;
  const iSec = ints[timeframe] || 3600;
  const sc = Math.sqrt(iSec / 3600);
  const bv = c.vol * sc, tv = c.tv * sc;
  const candles = [];
  let price = c.start;
  const now = Math.floor(Date.now() / 1000);
  const st = now - count * iSec;
  const plan = buildPlan(count, tv);
  for (let i = 0; i < count; i++) {
    const o = price;
    const mv = plan[i].move * price + (Math.random() - 0.5) * bv * price * 0.4;
    const cl = o + mv;
    const ph = plan[i].phase;
    const wm = ph === 'volatile' ? 1.2 : ph === 'low_vol' ? 0.1 : ph.includes('trend') ? 0.5 : 0.3;
    const wu = Math.random() * bv * price * wm;
    const wd = Math.random() * bv * price * wm;
    const h = Math.max(o, cl) + wu;
    const l = Math.min(o, cl) - wd;
    let vol = 2000 + Math.random() * 3000;
    if (ph.includes('trend') || ph.includes('bounce')) vol *= 1.8;
    if (ph === 'volatile') vol *= 2.5;
    if (ph === 'low_vol') vol *= 0.3;
    candles.push({ time: st + i * iSec, open: r(o), high: r(h), low: r(l), close: r(cl), volume: Math.round(vol) });
    price = cl;
    if (price < c.start * 0.3) price = c.start * 0.35;
    if (price > c.start * 3) price = c.start * 2.8;
  }
  return candles;
}
function buildPlan(total, tv) {
  const cy = []; let i = 0, dir = Math.random() > 0.5 ? 1 : -1;
  while (i < total) {
    const roll = Math.random();
    if (roll < 0.38) {
      const tl = 15 + Math.floor(Math.random() * 30);
      for (let j = 0; j < tl && i < total; j++, i++) { const s = (0.3 + Math.random() * 0.7) * (0.5 + Math.random() * 0.5); cy.push({ phase: dir > 0 ? 'trend_up' : 'trend_down', move: (Math.random() < 0.72 ? dir : -dir * 0.25) * tv * s }); }
      const pl = 5 + Math.floor(Math.random() * 8);
      for (let j = 0; j < pl && i < total; j++, i++) { cy.push({ phase: 'pullback', move: -dir * tv * (1 - j / pl * 0.5) * (0.3 + Math.random() * 0.2) * 0.6 }); }
      const bl = 2 + Math.floor(Math.random() * 3);
      for (let j = 0; j < bl && i < total; j++, i++) { cy.push({ phase: dir > 0 ? 'bounce_up' : 'bounce_down', move: dir * tv * (0.6 + Math.random() * 0.5) }); }
      const cl2 = 8 + Math.floor(Math.random() * 20);
      for (let j = 0; j < cl2 && i < total; j++, i++) { cy.push({ phase: dir > 0 ? 'trend_up' : 'trend_down', move: (Math.random() < 0.65 ? dir * tv * (0.3 + Math.random() * 0.5) : -dir * tv * 0.15) }); }
    } else if (roll < 0.52) {
      const l = 10 + Math.floor(Math.random() * 20);
      for (let j = 0; j < l && i < total; j++, i++) cy.push({ phase: 'range', move: (Math.random() - 0.5) * tv * 0.3 });
    } else if (roll < 0.62) {
      const l = 3 + Math.floor(Math.random() * 5);
      for (let j = 0; j < l && i < total; j++, i++) cy.push({ phase: 'volatile', move: (Math.random() - 0.5) * tv * 1.5 });
    } else if (roll < 0.72) {
      const l = 8 + Math.floor(Math.random() * 15);
      for (let j = 0; j < l && i < total; j++, i++) cy.push({ phase: 'low_vol', move: (Math.random() - 0.5) * tv * 0.1 });
    } else if (roll < 0.82) {
      dir *= -1;
      for (let j = 0; j < 5 && i < total; j++, i++) cy.push({ phase: dir > 0 ? 'trend_up' : 'trend_down', move: dir * tv * (0.5 + Math.random() * 0.6) });
    } else if (roll < 0.92) {
      const l = 8 + Math.floor(Math.random() * 15);
      for (let j = 0; j < l && i < total; j++, i++) cy.push({ phase: dir > 0 ? 'trend_up' : 'trend_down', move: dir * tv * (0.6 + Math.random() * 0.6) });
    } else {
      const l = 8 + Math.floor(Math.random() * 12);
      for (let j = 0; j < l && i < total; j++, i++) cy.push({ phase: 'chop', move: (Math.random() - 0.5) * tv * 0.6 });
      if (Math.random() > 0.5) dir *= -1;
    }
  }
  return cy.slice(0, total);
}
function r(v) { return Math.round(v * 100) / 100; }
module.exports = { generateDemoData };
