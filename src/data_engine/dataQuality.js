/**
 * NEXUS v3 — Data Quality Gate
 * Validates OHLCV data before any signal generation.
 * Catches: stale candles, missing fields, gaps, insufficient depth.
 */
const logger = require('../core/logger');
const MOD = 'DataQuality';

/**
 * @param {Array} candles
 * @param {string} symbol
 * @param {string} timeframe
 * @returns {{ passed: boolean, issues: string[], stats: object }}
 */
function validateCandles(candles, symbol, timeframe) {
  const issues = [];
  const stats = { count: 0, staleMinutes: 0, gaps: 0, missingFields: 0, duplicates: 0 };

  if (!candles || !Array.isArray(candles)) {
    return { passed: false, issues: ['No candle data'], stats, grade: 'F' };
  }

  stats.count = candles.length;

  // 1. Minimum candle count
  const minCounts = { '15m': 100, '1h': 60, '4h': 50, '1d': 30, '1w': 10 };
  const minRequired = minCounts[timeframe] || 60;
  if (candles.length < minRequired) {
    issues.push(`Insufficient candles: ${candles.length} < ${minRequired} required for ${timeframe}`);
  }

  // 2. Check for missing OHLCV fields
  let missingFields = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.open == null || c.high == null || c.low == null || c.close == null) {
      missingFields++;
    }
    if (c.high < c.low) {
      issues.push(`Invalid candle at index ${i}: high (${c.high}) < low (${c.low})`);
    }
    if (c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) {
      // Tolerate small floating point issues
      const tolerance = Math.abs(c.close) * 0.001;
      if (c.high < c.close - tolerance || c.low > c.close + tolerance) {
        missingFields++;
      }
    }
  }
  stats.missingFields = missingFields;
  if (missingFields > candles.length * 0.05) {
    issues.push(`${missingFields} candles have missing/invalid OHLC fields (${(missingFields / candles.length * 100).toFixed(1)}%)`);
  }

  // 3. Staleness check — how old is the latest candle?
  if (candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const lastTime = lastCandle.time ? lastCandle.time * 1000 : Date.now();
    const staleMs = Date.now() - lastTime;
    stats.staleMinutes = Math.round(staleMs / 60000);

    const maxStaleMinutes = { '15m': 30, '1h': 120, '4h': 480, '1d': 2880, '1w': 20160 };
    const maxStale = maxStaleMinutes[timeframe] || 120;
    if (stats.staleMinutes > maxStale) {
      issues.push(`Data is stale: last candle ${stats.staleMinutes}m ago (max ${maxStale}m for ${timeframe})`);
    }
  }

  // 4. Gap detection
  if (candles.length > 2) {
    const intervalSec = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
    const expectedGap = intervalSec[timeframe] || 3600;
    let gapCount = 0;
    for (let i = 1; i < candles.length; i++) {
      const diff = (candles[i].time || 0) - (candles[i - 1].time || 0);
      if (diff > expectedGap * 2.5) gapCount++;
    }
    stats.gaps = gapCount;
    if (gapCount > candles.length * 0.1) {
      issues.push(`${gapCount} time gaps detected (${(gapCount / candles.length * 100).toFixed(1)}%)`);
    }
  }

  // 5. Duplicate timestamps
  const times = new Set();
  let dupes = 0;
  for (const c of candles) {
    if (times.has(c.time)) dupes++;
    times.add(c.time);
  }
  stats.duplicates = dupes;
  if (dupes > 0) issues.push(`${dupes} duplicate timestamps`);

  // Grade
  const grade = issues.length === 0 ? 'A' : issues.length <= 2 ? 'B' : issues.length <= 4 ? 'C' : 'F';
  const passed = grade !== 'F';

  if (!passed) {
    logger.warn(MOD, `Data quality FAILED for ${symbol}/${timeframe}`, { issues, stats });
  }

  return { passed, issues, stats, grade };
}

/**
 * Validate all timeframes for a symbol. Returns aggregate quality report.
 */
function validateAllTimeframes(symbol, allTF) {
  const reports = {};
  let overallPassed = true;
  const criticalTFs = ['1h', '4h']; // Must pass for signal generation

  for (const [tf, candles] of Object.entries(allTF)) {
    reports[tf] = validateCandles(candles, symbol, tf);
    if (criticalTFs.includes(tf) && !reports[tf].passed) {
      overallPassed = false;
    }
  }

  return {
    symbol,
    overallPassed,
    reports,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Detect if candles are from live source or synthetic/demo.
 */
function detectDataSource(candles) {
  if (!candles || candles.length === 0) return 'UNKNOWN';

  // Demo data has perfectly spaced timestamps and no volume variance
  const volumes = candles.slice(-50).map(c => c.volume);
  const avgVol = volumes.reduce((s, v) => s + v, 0) / volumes.length;
  const volStdDev = Math.sqrt(volumes.reduce((s, v) => s + (v - avgVol) ** 2, 0) / volumes.length);
  const volCV = avgVol > 0 ? volStdDev / avgVol : 0;

  // Real market data has much higher volume coefficient of variation
  // Demo data typically has volCV < 0.5, real data > 0.8
  if (volCV < 0.4) return 'SYNTHETIC';
  if (volCV < 0.7) return 'LIKELY_SYNTHETIC';
  return 'LIVE';
}

module.exports = { validateCandles, validateAllTimeframes, detectDataSource };
