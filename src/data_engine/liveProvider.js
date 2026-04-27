/**
 * NEXUS v3 — Live Data Provider
 * Uses Binance public API for BTC/ETH OHLCV (no auth required).
 * Uses CoinGecko for prices. TwelveData for Gold if key provided.
 * Returns clean { candles, source, quality } objects.
 */
const logger = require('../core/logger');
const config = require('../core/config');
const { validateCandles } = require('./dataQuality');
const MOD = 'LiveProvider';

/**
 * Fetch OHLCV from Binance (crypto) — free, no auth, reliable.
 */
async function fetchBinanceOHLCV(symbol, timeframe, limit = 500) {
  const binanceSymbol = symbol === 'BTCUSDT' ? 'BTCUSDT' : symbol === 'ETHUSDT' ? 'ETHUSDT' : null;
  if (!binanceSymbol) return null;

  const tfMap = { '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' };
  const interval = tfMap[timeframe];
  if (!interval) return null;

  const url = `${config.binanceBaseUrl}/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;

  try {
    const res = await fetchWithTimeout(url, 10000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) return null;

    const candles = data.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    logger.info(MOD, `Binance: ${candles.length} candles for ${symbol}/${timeframe}`);
    return { candles, source: 'BINANCE' };
  } catch (err) {
    logger.warn(MOD, `Binance fetch failed: ${symbol}/${timeframe}`, { error: err.message });
    return null;
  }
}

/**
 * Fetch OHLCV from TwelveData (Gold) — requires API key.
 */
async function fetchTwelveDataOHLCV(timeframe, limit = 500) {
  if (!config.twelveDataApiKey) return null;

  const tfMap = { '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week' };
  const tf = tfMap[timeframe];
  if (!tf) return null;

  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${tf}&outputsize=${limit}&apikey=${config.twelveDataApiKey}`;

  try {
    const res = await fetchWithTimeout(url, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.values || !Array.isArray(data.values)) return null;

    const candles = data.values.reverse().map(v => ({
      time: Math.floor(new Date(v.datetime).getTime() / 1000),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseInt(v.volume) || 0, // Gold volume can be 0 from TwelveData
    }));

    logger.info(MOD, `TwelveData: ${candles.length} candles for XAUUSD/${timeframe}`);
    return { candles, source: 'TWELVEDATA' };
  } catch (err) {
    logger.warn(MOD, `TwelveData fetch failed: XAUUSD/${timeframe}`, { error: err.message });
    return null;
  }
}

/**
 * Get live price from Binance ticker.
 */
async function getBinancePrice(symbol) {
  const binanceSymbol = symbol === 'BTCUSDT' ? 'BTCUSDT' : symbol === 'ETHUSDT' ? 'ETHUSDT' : null;
  if (!binanceSymbol) return null;

  try {
    const url = `${config.binanceBaseUrl}/api/v3/ticker/24hr?symbol=${binanceSymbol}`;
    const res = await fetchWithTimeout(url, 5000);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      price: parseFloat(data.lastPrice),
      change24h: parseFloat(data.priceChangePercent),
      volume24h: parseFloat(data.volume),
      source: 'BINANCE',
    };
  } catch (err) {
    return null;
  }
}

/**
 * Master fetch function: tries live sources, validates quality, labels source.
 */
async function fetchLiveOHLCV(symbol, timeframe, limit = 500) {
  let result = null;

  // Try live sources
  if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT') {
    result = await fetchBinanceOHLCV(symbol, timeframe, limit);
  } else if (symbol === 'XAUUSD') {
    result = await fetchTwelveDataOHLCV(timeframe, limit);
  }

  if (!result || !result.candles || result.candles.length < 10) {
    return null; // No live data available
  }

  // Validate quality
  const quality = validateCandles(result.candles, symbol, timeframe);

  return {
    candles: result.candles,
    source: result.source,
    quality,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchLiveOHLCV, fetchBinanceOHLCV, fetchTwelveDataOHLCV, getBinancePrice };
