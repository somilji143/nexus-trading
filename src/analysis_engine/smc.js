/**
 * NEXUS — Smart Money Concepts Engine
 * Swing points, BOS, CHoCH, Order Blocks, FVGs, Liquidity Sweeps,
 * Premium/Discount zones. Full implementation.
 */
const logger = require('../core/logger');
const MOD = 'SMC';

// ─── SWING POINTS ───────────────────────────────
function detectSwingPoints(candles, lookback = 5) {
  const swings = { highs: [], lows: [] };
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) swings.highs.push({ index: i, price: candles[i].high, time: candles[i].time });
    if (isLow) swings.lows.push({ index: i, price: candles[i].low, time: candles[i].time });
  }
  return swings;
}

// ─── MARKET STRUCTURE (BOS / CHoCH) ─────────────
function detectMarketStructure(candles, swings) {
  const events = [];
  const highs = swings.highs;
  const lows = swings.lows;
  let trend = 'ranging';
  let lastStructureHigh = null;
  let lastStructureLow = null;

  // Merge and sort all swings by index
  const allSwings = [
    ...highs.map(h => ({ ...h, type: 'high' })),
    ...lows.map(l => ({ ...l, type: 'low' })),
  ].sort((a, b) => a.index - b.index);

  for (let i = 1; i < allSwings.length; i++) {
    const current = allSwings[i];
    const prev = allSwings[i - 1];

    if (current.type === 'high') {
      if (lastStructureHigh && current.price > lastStructureHigh.price) {
        if (trend === 'bearish') {
          events.push({ type: 'CHoCH_bullish', index: current.index, price: current.price, time: current.time });
          trend = 'bullish';
        } else {
          events.push({ type: 'BOS_bullish', index: current.index, price: current.price, time: current.time });
          trend = 'bullish';
        }
      }
      lastStructureHigh = current;
    } else {
      if (lastStructureLow && current.price < lastStructureLow.price) {
        if (trend === 'bullish') {
          events.push({ type: 'CHoCH_bearish', index: current.index, price: current.price, time: current.time });
          trend = 'bearish';
        } else {
          events.push({ type: 'BOS_bearish', index: current.index, price: current.price, time: current.time });
          trend = 'bearish';
        }
      }
      lastStructureLow = current;
    }
  }

  return { events, trend, lastStructureHigh, lastStructureLow };
}

// ─── ORDER BLOCKS ───────────────────────────────
function detectOrderBlocks(candles, structureEvents) {
  const obs = [];

  for (const event of structureEvents) {
    if (event.type === 'BOS_bullish' || event.type === 'CHoCH_bullish') {
      // Bullish OB = last bearish candle before the bullish break
      for (let j = event.index - 1; j >= Math.max(0, event.index - 10); j--) {
        if (candles[j].close < candles[j].open) { // bearish candle
          const moveAfter = event.price - candles[j].high;
          const strength = Math.min(1, moveAfter / (candles[j].high - candles[j].low + 0.0001));
          obs.push({
            type: 'bullish', high: candles[j].high, low: candles[j].low,
            index: j, time: candles[j].time, mitigated: false, strength: Math.min(1, Math.max(0, strength)),
          });
          break;
        }
      }
    }
    if (event.type === 'BOS_bearish' || event.type === 'CHoCH_bearish') {
      // Bearish OB = last bullish candle before the bearish break
      for (let j = event.index - 1; j >= Math.max(0, event.index - 10); j--) {
        if (candles[j].close > candles[j].open) { // bullish candle
          const moveAfter = candles[j].low - event.price;
          const strength = Math.min(1, moveAfter / (candles[j].high - candles[j].low + 0.0001));
          obs.push({
            type: 'bearish', high: candles[j].high, low: candles[j].low,
            index: j, time: candles[j].time, mitigated: false, strength: Math.min(1, Math.max(0, Math.abs(strength))),
          });
          break;
        }
      }
    }
  }

  // Check mitigation: price returned and closed inside OB
  for (const ob of obs) {
    for (let k = ob.index + 1; k < candles.length; k++) {
      const c = candles[k];
      if (ob.type === 'bullish' && c.close >= ob.low && c.close <= ob.high && c.close < c.open) {
        ob.mitigated = true; break;
      }
      if (ob.type === 'bearish' && c.close >= ob.low && c.close <= ob.high && c.close > c.open) {
        ob.mitigated = true; break;
      }
    }
  }

  return obs;
}

function getNearestOB(obs, currentPrice, direction) {
  const valid = obs.filter(ob => !ob.mitigated);
  if (direction === 'long') {
    // Nearest bullish OB below price
    const below = valid.filter(ob => ob.type === 'bullish' && ob.high <= currentPrice);
    below.sort((a, b) => b.high - a.high); // closest first
    return below[0] || null;
  } else {
    // Nearest bearish OB above price
    const above = valid.filter(ob => ob.type === 'bearish' && ob.low >= currentPrice);
    above.sort((a, b) => a.low - b.low);
    return above[0] || null;
  }
}

// ─── FAIR VALUE GAPS ────────────────────────────
function detectFVG(candles) {
  const fvgs = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish FVG: candle[i-1].high < candle[i+1].low
    if (prev.high < next.low) {
      const size = next.low - prev.high;
      fvgs.push({ type: 'bullish', top: next.low, bottom: prev.high, index: i, time: curr.time, filled: false, size });
    }
    // Bearish FVG: candle[i-1].low > candle[i+1].high
    if (prev.low > next.high) {
      const size = prev.low - next.high;
      fvgs.push({ type: 'bearish', top: prev.low, bottom: next.high, index: i, time: curr.time, filled: false, size });
    }
  }

  // Check fill status
  for (const fvg of fvgs) {
    for (let k = fvg.index + 2; k < candles.length; k++) {
      if (fvg.type === 'bullish' && candles[k].close <= fvg.bottom) { fvg.filled = true; break; }
      if (fvg.type === 'bearish' && candles[k].close >= fvg.top) { fvg.filled = true; break; }
    }
  }

  return fvgs;
}

// ─── LIQUIDITY SWEEPS ───────────────────────────
function detectLiquiditySweeps(candles, swings, threshold = 0.001) {
  const sweeps = [];
  const { highs, lows } = swings;

  // Find equal highs (liquidity pools above)
  for (let i = 0; i < highs.length - 1; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      const diff = Math.abs(highs[i].price - highs[j].price) / highs[i].price;
      if (diff < threshold) {
        const level = Math.max(highs[i].price, highs[j].price);
        // Check for sweep: wick above level then close below
        for (let k = highs[j].index + 1; k < candles.length; k++) {
          if (candles[k].high > level && candles[k].close < level) {
            sweeps.push({ type: 'bearish_sweep', level, index: k, time: candles[k].time, candlesSince: candles.length - 1 - k });
            break;
          }
        }
      }
    }
  }

  // Find equal lows
  for (let i = 0; i < lows.length - 1; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      const diff = Math.abs(lows[i].price - lows[j].price) / lows[i].price;
      if (diff < threshold) {
        const level = Math.min(lows[i].price, lows[j].price);
        for (let k = lows[j].index + 1; k < candles.length; k++) {
          if (candles[k].low < level && candles[k].close > level) {
            sweeps.push({ type: 'bullish_sweep', level, index: k, time: candles[k].time, candlesSince: candles.length - 1 - k });
            break;
          }
        }
      }
    }
  }

  return sweeps;
}

// ─── PREMIUM / DISCOUNT ZONES ───────────────────
function getPremiumDiscount(swings, currentPrice) {
  const allHighs = swings.highs;
  const allLows = swings.lows;
  if (!allHighs.length || !allLows.length) return { zone: 'neutral', ratio: 0.5 };

  const recentHigh = allHighs[allHighs.length - 1].price;
  const recentLow = allLows[allLows.length - 1].price;
  const range = recentHigh - recentLow;
  if (range <= 0) return { zone: 'neutral', ratio: 0.5 };

  const ratio = (currentPrice - recentLow) / range;
  if (ratio > 0.5) return { zone: 'premium', ratio };  // Sell zone
  return { zone: 'discount', ratio };  // Buy zone
}

// ─── SMC SCORE CALCULATOR ───────────────────────
function calculateSMCScore(candles1h, candles4h, currentPrice) {
  // Run all SMC on 1H
  const swings1h = detectSwingPoints(candles1h, 5);
  const structure1h = detectMarketStructure(candles1h, swings1h);
  const obs1h = detectOrderBlocks(candles1h, structure1h.events);
  const fvgs1h = detectFVG(candles1h);
  const sweeps1h = detectLiquiditySweeps(candles1h, swings1h);
  const pd1h = getPremiumDiscount(swings1h, currentPrice);

  // Run on 4H
  const swings4h = detectSwingPoints(candles4h, 3);
  const structure4h = detectMarketStructure(candles4h, swings4h);

  let score = 0.5; // Neutral start

  // 4H trend direction
  if (structure4h.trend === 'bullish') score += 0.10;
  else if (structure4h.trend === 'bearish') score -= 0.10;

  // 1H trend direction
  if (structure1h.trend === 'bullish') score += 0.08;
  else if (structure1h.trend === 'bearish') score -= 0.08;

  // Recent BOS/CHoCH on 1H
  const recentEvents = structure1h.events.filter(e => e.index > candles1h.length - 20);
  for (const e of recentEvents) {
    if (e.type === 'BOS_bullish') score += 0.07;
    if (e.type === 'BOS_bearish') score -= 0.07;
    if (e.type === 'CHoCH_bullish') score += 0.10;
    if (e.type === 'CHoCH_bearish') score -= 0.10;
  }

  // Nearest order block
  const nearBullOB = getNearestOB(obs1h, currentPrice, 'long');
  const nearBearOB = getNearestOB(obs1h, currentPrice, 'short');
  if (nearBullOB) {
    const dist = (currentPrice - nearBullOB.high) / currentPrice;
    if (dist < 0.01) score += 0.12 * nearBullOB.strength; // At OB
  }
  if (nearBearOB) {
    const dist = (nearBearOB.low - currentPrice) / currentPrice;
    if (dist < 0.01) score -= 0.12 * nearBearOB.strength;
  }

  // Unfilled FVGs
  const recentFVGs = fvgs1h.filter(f => !f.filled && f.index > candles1h.length - 50);
  for (const f of recentFVGs.slice(-3)) {
    if (f.type === 'bullish' && currentPrice >= f.bottom && currentPrice <= f.top) score += 0.08;
    if (f.type === 'bearish' && currentPrice >= f.bottom && currentPrice <= f.top) score -= 0.08;
  }

  // Liquidity sweeps (recent)
  const recentSweeps = sweeps1h.filter(s => s.candlesSince < 10);
  for (const s of recentSweeps) {
    if (s.type === 'bullish_sweep') score += 0.08;
    if (s.type === 'bearish_sweep') score -= 0.08;
  }

  // Premium/Discount
  if (pd1h.zone === 'discount') score += 0.03;
  if (pd1h.zone === 'premium') score -= 0.03;

  score = Math.max(0, Math.min(1, score));

  return {
    score,
    trend1h: structure1h.trend,
    trend4h: structure4h.trend,
    activeOB: nearBullOB || nearBearOB,
    activeFVGs: recentFVGs.filter(f => !f.filled).slice(-3),
    recentSweeps: recentSweeps.slice(-3),
    premiumDiscount: pd1h,
    structureEvents: recentEvents.slice(-5),
  };
}

module.exports = {
  detectSwingPoints, detectMarketStructure, detectOrderBlocks, getNearestOB,
  detectFVG, detectLiquiditySweeps, getPremiumDiscount, calculateSMCScore,
};
