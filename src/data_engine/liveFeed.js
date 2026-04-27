/**
 * NEXUS — Live WebSocket Feed
 * Connects to Binance WebSocket for BTC/ETH real-time klines + trades.
 * Broadcasts to connected frontend clients via local WS server.
 * For XAUUSD: polls REST every 10s (no free WS available).
 */
const WebSocket = require('ws');
const logger = require('../core/logger');
const MOD = 'LiveFeed';

const BINANCE_WS = 'wss://stream.binance.com:9443/ws';
const BINANCE_STREAMS = {
  BTCUSDT: { trade: 'btcusdt@trade', kline1m: 'btcusdt@kline_1m', kline1h: 'btcusdt@kline_1h' },
  ETHUSDT: { trade: 'ethusdt@trade', kline1m: 'ethusdt@kline_1m', kline1h: 'ethusdt@kline_1h' },
};

let binanceWS = null;
let localWSS = null;
let reconnectTimer = null;
const liveState = {
  prices: {},       // { BTCUSDT: { price, time, source } }
  candles: {},      // { BTCUSDT_1h: { open, high, low, close, volume, time, closed } }
  connected: false,
  lastUpdate: null,
};

function initLiveFeed(httpServer) {
  // Local WebSocket server for frontend clients
  localWSS = new WebSocket.Server({ server: httpServer, path: '/ws' });
  localWSS.on('connection', (ws) => {
    logger.info(MOD, `Client connected (total: ${localWSS.clients.size})`);
    // Send current state immediately
    ws.send(JSON.stringify({ type: 'state', data: { prices: liveState.prices, connected: liveState.connected } }));
    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.subscribe) {
          ws._subscribedSymbol = data.subscribe;
        }
      } catch (e) {}
    });
    ws.on('close', () => logger.info(MOD, `Client disconnected (total: ${localWSS.clients.size})`));
  });

  connectBinance();
  // XAUUSD polling (no free WS)
  startXAUUSDPolling();
  logger.info(MOD, 'Live feed initialized');
}

function connectBinance() {
  const streams = [];
  for (const [, s] of Object.entries(BINANCE_STREAMS)) {
    streams.push(s.trade, s.kline1h);
  }
  const url = `${BINANCE_WS}/${streams.join('/')}`;

  try {
    binanceWS = new WebSocket(url);
  } catch (e) {
    logger.error(MOD, 'Binance WS connection failed', { error: e.message });
    scheduleReconnect();
    return;
  }

  binanceWS.on('open', () => {
    liveState.connected = true;
    logger.info(MOD, '✅ Binance WebSocket connected');
    broadcast({ type: 'connection', connected: true });
  });

  binanceWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.e === 'trade') handleTrade(msg);
      else if (msg.e === 'kline') handleKline(msg);
    } catch (e) {}
  });

  binanceWS.on('close', () => {
    liveState.connected = false;
    logger.warn(MOD, 'Binance WS disconnected');
    broadcast({ type: 'connection', connected: false });
    scheduleReconnect();
  });

  binanceWS.on('error', (err) => {
    logger.error(MOD, 'Binance WS error', { error: err.message });
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    logger.info(MOD, 'Reconnecting to Binance...');
    connectBinance();
  }, 5000);
}

function handleTrade(msg) {
  const symbol = msg.s; // e.g. BTCUSDT
  const price = parseFloat(msg.p);
  const time = msg.T;
  liveState.prices[symbol] = { price, time, source: 'BINANCE_WS' };
  liveState.lastUpdate = Date.now();
  broadcast({ type: 'price', symbol, price, time });
}

function handleKline(msg) {
  const k = msg.k;
  const symbol = k.s;
  const tf = k.i; // '1h'
  const key = `${symbol}_${tf}`;
  const candle = {
    time: Math.floor(k.t / 1000),
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
    closed: k.x, // is this candle closed?
  };
  liveState.candles[key] = candle;
  broadcast({ type: 'candle', symbol, tf, candle });
  if (k.x) {
    // Candle just closed — trigger signal recalculation
    broadcast({ type: 'candle_close', symbol, tf, candle });
    logger.info(MOD, `Candle closed: ${symbol} ${tf} @ ${candle.close}`);
  }
}

async function startXAUUSDPolling() {
  const poll = async () => {
    try {
      const fetch = require('node-fetch');
      // Use a lightweight price endpoint
      const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=XAUUSDT');
      if (res.ok) {
        const data = await res.json();
        const price = parseFloat(data.price);
        if (price > 0) {
          liveState.prices.XAUUSD = { price, time: Date.now(), source: 'BINANCE_REST' };
          broadcast({ type: 'price', symbol: 'XAUUSD', price, time: Date.now() });
        }
      }
    } catch (e) {
      // XAUUSD not on Binance — use demo price
      if (!liveState.prices.XAUUSD) {
        liveState.prices.XAUUSD = { price: 0, time: Date.now(), source: 'UNAVAILABLE' };
      }
    }
  };
  await poll();
  setInterval(poll, 10000);
}

function broadcast(data) {
  if (!localWSS) return;
  const msg = JSON.stringify(data);
  localWSS.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function getLiveState() {
  return { ...liveState, clientCount: localWSS ? localWSS.clients.size : 0 };
}

function getLivePrice(symbol) {
  return liveState.prices[symbol] || null;
}

module.exports = { initLiveFeed, getLiveState, getLivePrice, broadcast };
