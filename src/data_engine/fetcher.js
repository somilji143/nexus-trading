/**
 * NEXUS — Data Fetcher
 * Fetches OHLCV from CoinGecko (BTC/ETH) and TwelveData (XAUUSD).
 * Retry logic, rate limiting, caching. Falls back to demo data.
 */
const logger = require('../core/logger');
const config = require('../core/config');
const { generateDemoData, getDemoLivePrice } = require('./demo-data');

const MOD = 'Fetcher';

// ─── In-memory cache ────────────────────────────
const cache = {};

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl * 1000) { delete cache[key]; return null; }
  return entry.data;
}

function setCache(key, data, ttlSec) {
  cache[key] = { data, ts: Date.now(), ttl: ttlSec };
}

// ─── Rate Limiter ───────────────────────────────
let lastRequestTime = 0;
const MIN_REQUEST_GAP = 100; // ms

async function rateLimitedFetch(url, options) {
  const now = Date.now();
  const gap = now - lastRequestTime;
  if (gap < MIN_REQUEST_GAP) await sleep(MIN_REQUEST_GAP - gap);
  lastRequestTime = Date.now();
  return fetch(url, options);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Retry Logic ────────────────────────────────
async function fetchWithRetry(url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await rateLimitedFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      logger.warn(MOD, `Fetch attempt ${attempt}/${maxRetries} failed: ${url}`, { error: err.message });
      if (attempt < maxRetries) await sleep(2000 * attempt); // exponential backoff
    }
  }
  return null;
}

// ─── Symbol Normalization ───────────────────────
function normalizeSymbol(symbol) {
  const map = {
    XAUUSD: { source: 'twelvedata', tdSymbol: 'XAU/USD' },
    BTCUSDT: { source: 'coingecko', cgId: 'bitcoin' },
    ETHUSDT: { source: 'coingecko', cgId: 'ethereum' },
  };
  return map[symbol] || map.BTCUSDT;
}

// ─── Fetch OHLCV ────────────────────────────────
async function fetchOHLCV(symbol, timeframe, count = 500) {
  const cacheKey = `ohlcv:${symbol}:${timeframe}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const norm = normalizeSymbol(symbol);
  let candles = null;

  try {
    if (norm.source === 'coingecko') {
      candles = await fetchCoinGeckoOHLC(norm.cgId, timeframe, count);
    } else if (norm.source === 'twelvedata' && config.twelveDataApiKey) {
      candles = await fetchTwelveDataOHLC(norm.tdSymbol, timeframe, count);
    }
  } catch (err) {
    logger.error(MOD, `Fetch failed for ${symbol}/${timeframe}`, { error: err.message });
  }

  if (!candles || candles.length < 10) {
    logger.warn(MOD, `Using demo data for ${symbol}/${timeframe}`);
    candles = generateDemoData(symbol, timeframe, count);
  }

  const ttl = config.cacheTTL[timeframe] || 120;
  setCache(cacheKey, candles, ttl);
  logger.debug(MOD, `Fetched ${candles.length} candles for ${symbol}/${timeframe}`);
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
  const norm = normalizeSymbol(symbol);
  try {
    if (norm.source === 'coingecko') {
      const data = await fetchWithRetry(`${config.coingeckoBaseUrl}/simple/price?ids=${norm.cgId}&vs_currencies=usd&include_24hr_change=true`);
      if (data && data[norm.cgId]) {
        return { price: data[norm.cgId].usd, change24h: data[norm.cgId].usd_24h_change || 0 };
      }
    } else if (norm.source === 'twelvedata' && config.twelveDataApiKey) {
      const data = await fetchWithRetry(`https://api.twelvedata.com/price?symbol=${norm.tdSymbol}&apikey=${config.twelveDataApiKey}`);
      if (data && data.price) return { price: parseFloat(data.price), change24h: 0 };
    }
  } catch (err) {
    logger.error(MOD, `Price fetch failed for ${symbol}`, { error: err.message });
  }
  // Fallback: use demo live price (consistent small-drift pricing)
  const cached = getCached(`ohlcv:${symbol}:1h`);
  if (cached && cached.length) {
    const lastClose = cached[cached.length - 1].close;
    const prevClose = cached.length > 24 ? cached[cached.length - 25].close : lastClose;
    const change = prevClose > 0 ? ((lastClose - prevClose) / prevClose) * 100 : 0;
    return { price: getDemoLivePrice(symbol), change24h: Math.round(change * 100) / 100 };
  }
  return { price: getDemoLivePrice(symbol), change24h: 0 };
}

// ─── CoinGecko OHLC ────────────────────────────
async function fetchCoinGeckoOHLC(cgId, timeframe, count) {
  const daysMap = { '15m': 1, '1h': 7, '4h': 30, '1d': 365, '1w': 365 };
  const days = daysMap[timeframe] || 7;
  const url = `${config.coingeckoBaseUrl}/coins/${cgId}/ohlc?vs_currency=usd&days=${days}`;
  const data = await fetchWithRetry(url);
  if (!data || !Array.isArray(data)) return null;

  return data.map(([ts, o, h, l, c]) => ({
    time: Math.floor(ts / 1000),
    open: o, high: h, low: l, close: c,
    volume: Math.round(1000 + Math.random() * 5000),
  }));
}

// ─── TwelveData OHLC ────────────────────────────
async function fetchTwelveDataOHLC(tdSymbol, timeframe, count) {
  const tfMap = { '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week' };
  const tf = tfMap[timeframe] || '1h';
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${tf}&outputsize=${count}&apikey=${config.twelveDataApiKey}`;
  const data = await fetchWithRetry(url);
  if (!data || !data.values) return null;

  return data.values.reverse().map(v => ({
    time: Math.floor(new Date(v.datetime).getTime() / 1000),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    volume: parseInt(v.volume) || 1000,
  }));
}

module.exports = { fetchOHLCV, fetchAllTimeframes, getLatestPrice, normalizeSymbol };
