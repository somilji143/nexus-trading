/**
 * NEXUS v3 — Data Fetcher (Unified)
 * Priority: Live API → Cache → Demo Fallback
 * Always labels data source. Never silently mixes live and demo.
 */
const logger = require('../core/logger');
const config = require('../core/config');
const { fetchLiveOHLCV, getBinancePrice } = require('./liveProvider');
const { generateDemoData, getDemoLivePrice } = require('./demo-data');
const { validateCandles, detectDataSource } = require('./dataQuality');
const MOD = 'Fetcher';

// ─── In-memory cache ────────────────────────────
const cache = {};
const dataMode = {}; // Track per-symbol data mode

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl * 1000) { delete cache[key]; return null; }
  return entry;
}

function setCache(key, data, source, ttlSec) {
  cache[key] = { data, source, ts: Date.now(), ttl: ttlSec };
}

// ─── Rate Limiter ───────────────────────────────
let lastRequestTime = 0;
const MIN_REQUEST_GAP = 100;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Fetch OHLCV ────────────────────────────────
async function fetchOHLCV(symbol, timeframe, count = 500) {
  const cacheKey = `ohlcv:${symbol}:${timeframe}`;
  const cached = getCached(cacheKey);
  if (cached) return cached.data;

  // 1. Try live sources
  let result = null;
  try {
    const now = Date.now();
    if (now - lastRequestTime < MIN_REQUEST_GAP) await sleep(MIN_REQUEST_GAP);
    lastRequestTime = Date.now();

    result = await fetchLiveOHLCV(symbol, timeframe, count);
  } catch (err) {
    logger.warn(MOD, `Live fetch error for ${symbol}/${timeframe}`, { error: err.message });
  }

  let candles, source;

  if (result && result.candles && result.candles.length >= 10) {
    candles = result.candles;
    source = result.source;
    dataMode[symbol] = 'LIVE';
    logger.info(MOD, `✅ LIVE data: ${candles.length} candles for ${symbol}/${timeframe} [${source}]`);
  } else {
    // 2. Fall back to demo
    candles = generateDemoData(symbol, timeframe, count);
    source = 'DEMO';
    dataMode[symbol] = 'DEMO';
    logger.warn(MOD, `⚠️ DEMO data: ${candles.length} candles for ${symbol}/${timeframe} [synthetic]`);
  }

  const ttl = config.cacheTTL[timeframe] || 120;
  setCache(cacheKey, candles, source, ttl);
  return candles;
}

// ─── Fetch all timeframes for a symbol ──────────
async function fetchAllTimeframes(symbol) {
  const result = {};
  for (const tf of config.timeframes) {
    const countMap = { '1w': 200, '1d': 365, '4h': 500, '1h': 500, '15m': 500 };
    result[tf] = await fetchOHLCV(symbol, tf, countMap[tf] || 500);
  }
  return result;
}

// ─── Get latest price ───────────────────────────
async function getLatestPrice(symbol) {
  // 1. Try Binance (crypto)
  if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT') {
    try {
      const binancePrice = await getBinancePrice(symbol);
      if (binancePrice && binancePrice.price > 0) {
        return { price: binancePrice.price, change24h: binancePrice.change24h, source: 'BINANCE' };
      }
    } catch (e) {}
  }

  // 2. Try TwelveData (Gold)
  if (symbol === 'XAUUSD' && config.twelveDataApiKey) {
    try {
      const res = await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${config.twelveDataApiKey}`);
      if (res.ok) {
        const data = await res.json();
        if (data.price) return { price: parseFloat(data.price), change24h: 0, source: 'TWELVEDATA' };
      }
    } catch (e) {}
  }

  // 3. Try CoinGecko (fallback for crypto)
  if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT') {
    const cgId = symbol === 'BTCUSDT' ? 'bitcoin' : 'ethereum';
    try {
      const res = await fetch(`${config.coingeckoBaseUrl}/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true`);
      if (res.ok) {
        const data = await res.json();
        if (data[cgId]) {
          return { price: data[cgId].usd, change24h: data[cgId].usd_24h_change || 0, source: 'COINGECKO' };
        }
      }
    } catch (e) {}
  }

  // 4. Demo fallback
  const cached = getCached(`ohlcv:${symbol}:1h`);
  if (cached && cached.data && cached.data.length) {
    const lastClose = cached.data[cached.data.length - 1].close;
    const prevClose = cached.data.length > 24 ? cached.data[cached.data.length - 25].close : lastClose;
    const change = prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : 0;
    return { price: getDemoLivePrice(symbol), change24h: Math.round(change * 100) / 100, source: 'DEMO' };
  }
  return { price: getDemoLivePrice(symbol), change24h: 0, source: 'DEMO' };
}

// ─── Data Mode Status ───────────────────────────
function getDataMode(symbol) {
  return dataMode[symbol] || 'UNKNOWN';
}

function getAllDataModes() {
  const modes = {};
  for (const sym of Object.keys(config.assets)) {
    modes[sym] = dataMode[sym] || 'UNKNOWN';
  }
  const isAnyLive = Object.values(modes).some(m => m === 'LIVE');
  return {
    modes,
    globalMode: isAnyLive ? 'LIVE' : 'DEMO',
    description: isAnyLive ? 'Connected to live market data' : 'Using synthetic demo data — signals are simulated',
  };
}

module.exports = { fetchOHLCV, fetchAllTimeframes, getLatestPrice, getDataMode, getAllDataModes };
