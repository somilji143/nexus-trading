/**
 * NEXUS — Frontend Application
 * Connects to API, renders chart, signals, backtest results, confluence.
 */
const API = '';
let chart, candleSeries, currentSymbol = 'XAUUSD', currentTF = '1h';
let signalLines = [];

// ─── INIT ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  loadPrices();
  loadConfig();
  loadBacktestResults();
  loadLiveSignals();
  loadSignalHistory();
  loadPerformance();
  loadPaperTrading();
  startClock();
  autoLoadConfluence();
  // Auto-refresh
  setInterval(loadPrices, 30000);
  setInterval(loadLiveSignals, 60000);
  setInterval(loadSignalHistory, 120000);
  setInterval(loadPaperTrading, 5000);
  setInterval(loadPerformance, 30000); // Refresh stats after backtests complete
  setInterval(autoLoadConfluence, 120000); // Refresh confluence every 2 min
  // Controls
  document.getElementById('assetSelect').addEventListener('change', e => { currentSymbol = e.target.value; loadChart(); autoLoadConfluence(); });
  document.getElementById('tfSelect').addEventListener('change', e => { currentTF = e.target.value; loadChart(); });
  document.getElementById('btnGenerate').addEventListener('click', generateSignal);
  document.getElementById('btnScanAll').addEventListener('click', scanAll);
  document.getElementById('btnConfluence').addEventListener('click', viewConfluence);
  loadChart();
});

// ─── CHART ──────────────────────────────────────
function initChart() {
  chart = LightweightCharts.createChart(document.getElementById('chart'), {
    layout: { background: { color: '#0d0d14' }, textColor: '#64748b', fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 },
    grid: { vertLines: { color: '#1a1a2e' }, horzLines: { color: '#1a1a2e' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    timeScale: { borderColor: '#1a1a2e', timeVisible: true },
    rightPriceScale: { borderColor: '#1a1a2e' },
  });
  candleSeries = chart.addCandlestickSeries({ upColor: '#10b981', downColor: '#ef4444', borderUpColor: '#10b981', borderDownColor: '#ef4444', wickUpColor: '#10b981', wickDownColor: '#ef4444' });
}

async function loadChart() {
  document.getElementById('chartTitle').textContent = `${currentSymbol} — ${currentTF.toUpperCase()}`;
  try {
    const candles = await fetchJSON(`/api/ohlcv/${currentSymbol}?tf=${currentTF}&count=300`);
    if (candles && candles.length) {
      candleSeries.setData(candles);
      chart.timeScale().fitContent();
      const last = candles[candles.length - 1];
      document.getElementById('chartPrice').textContent = `$${formatNum(last.close)}`;
    }
  } catch (e) { console.error('Chart load error:', e); }
}

function addSignalOverlay(signal) {
  clearSignalOverlay();
  const isLong = signal.direction === 'LONG';
  const lines = [
    { price: signal.entry_price || signal.entry, color: '#3b82f6', title: 'Entry', style: 0 },
    { price: signal.sl_price || signal.sl, color: '#ef4444', title: 'SL', style: 2 },
    { price: signal.tp1_price || signal.tp1, color: '#10b981', title: 'TP1', style: 2 },
    { price: signal.tp2_price || signal.tp2, color: '#10b981', title: 'TP2', style: 2 },
    { price: signal.tp3_price || signal.tp3, color: '#22c55e', title: 'TP3', style: 2 },
  ];
  for (const l of lines) {
    if (!l.price) continue;
    signalLines.push(candleSeries.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style, title: l.title, axisLabelVisible: true }));
  }
}

function clearSignalOverlay() {
  for (const l of signalLines) { try { candleSeries.removePriceLine(l); } catch (e) {} }
  signalLines = [];
}

// ─── PRICES ─────────────────────────────────────
async function loadPrices() {
  const symbols = ['XAUUSD', 'BTCUSDT', 'ETHUSDT'];
  const ticker = document.getElementById('priceTicker');
  const items = [];
  for (const sym of symbols) {
    try {
      const data = await fetchJSON(`/api/assets/${sym}/price`);
      const ch = data.change24h || 0;
      const cls = ch >= 0 ? 'up' : 'down';
      const arrow = ch >= 0 ? '▲' : '▼';
      items.push(`<div class="ticker-item"><span class="ticker-symbol">${sym}</span><span class="ticker-price">$${formatNum(data.price)}</span><span class="ticker-change ${cls}">${arrow} ${Math.abs(ch).toFixed(1)}%</span></div>`);
    } catch (e) { items.push(`<div class="ticker-item"><span class="ticker-symbol">${sym}</span><span class="ticker-price">—</span></div>`); }
  }
  ticker.innerHTML = items.join('');
}

// ─── GENERATE SIGNAL ────────────────────────────
async function generateSignal() {
  const btn = document.getElementById('btnGenerate');
  btn.textContent = '⏳ Scanning...'; btn.disabled = true;
  try {
    const res = await fetchJSON(`/api/signals/generate/${currentSymbol}`, { method: 'POST' });
    if (res.status === 'signal' && res.signal) {
      showSignal(res.signal);
      loadLiveSignals();
    } else if (res.status === 'no_signal') {
      showNoSignal(res.confluence);
    } else if (res.status === 'skipped') {
      showNoSignal(null, `Skipped: ${res.reason}`);
    } else if (res.status === 'rejected') {
      showNoSignal(null, `Rejected: ${res.reason?.join(', ') || 'Risk validation failed'}`);
    }
  } catch (e) { console.error(e); }
  btn.textContent = '⚡ Generate Signal'; btn.disabled = false;
}

async function scanAll() {
  const btn = document.getElementById('btnScanAll');
  btn.textContent = '⏳ Scanning...'; btn.disabled = true;
  for (const sym of ['XAUUSD', 'BTCUSDT', 'ETHUSDT']) {
    try { await fetchJSON(`/api/signals/generate/${sym}`, { method: 'POST' }); } catch (e) {}
  }
  await loadLiveSignals();
  btn.textContent = '🔍 Scan All Assets'; btn.disabled = false;
}

function showSignal(signal) {
  document.getElementById('signalEmpty').classList.add('hidden');
  const card = document.getElementById('signalCard');
  card.classList.remove('hidden');
  const dir = signal.direction || 'LONG';
  const dirEl = document.getElementById('sigDirection');
  dirEl.textContent = dir;
  dirEl.className = `signal-direction ${dir.toLowerCase()}`;
  document.getElementById('sigTier').textContent = `${signal.tier || 'B'} TIER`;
  const score = Math.round((signal.finalScore || signal.confluence_score || 0) * 100);
  document.getElementById('sigScoreText').textContent = `${score}%`;
  const fill = document.getElementById('sigScoreFill');
  fill.style.width = `${score}%`;
  fill.style.background = score > 75 ? 'linear-gradient(90deg, #10b981, #22c55e)' : score > 50 ? 'linear-gradient(90deg, #f59e0b, #d97706)' : 'linear-gradient(90deg, #ef4444, #dc2626)';
  document.getElementById('sigEntry').textContent = `$${formatNum(signal.entry_price || signal.entry)}`;
  document.getElementById('sigSL').textContent = `$${formatNum(signal.sl_price || signal.sl)}`;
  document.getElementById('sigTP1').textContent = `$${formatNum(signal.tp1_price || signal.tp1)}`;
  document.getElementById('sigTP2').textContent = `$${formatNum(signal.tp2_price || signal.tp2)}`;
  document.getElementById('sigTP3').textContent = `$${formatNum(signal.tp3_price || signal.tp3)}`;
  document.getElementById('sigRegime').textContent = `Regime: ${signal.regime?.name || signal.regime || '—'} (${(signal.regime?.confidence || 0) * 100}%)`;
  document.getElementById('sigSession').textContent = `Session: ${signal.details?.sessionDetails?.name || '—'}`;
  document.getElementById('sigReasoning').textContent = signal.reasoning || '';
  addSignalOverlay(signal);
}

function showNoSignal(confluence, msg) {
  document.getElementById('signalCard').classList.add('hidden');
  const el = document.getElementById('signalEmpty');
  el.classList.remove('hidden');
  const reason = msg || (confluence ? `Score: ${confluence.finalScore?.toFixed ? confluence.finalScore.toFixed(2) : confluence.finalScore} — ${confluence.reason || 'Confluence in neutral zone'}` : 'No valid setup found');
  el.querySelector('p').textContent = reason;
}

async function autoLoadConfluence() {
  try {
    const data = await fetchJSON(`/api/assets/${currentSymbol}/confluence`);
    if (data && data.finalScore !== undefined) {
      const score = Math.round((data.finalScore || 0) * 100);
      const el = document.getElementById('signalEmpty');
      el.classList.remove('hidden');
      document.getElementById('signalCard').classList.add('hidden');
      el.querySelector('h3').textContent = score >= 72 ? '🟢 Signal Possible' : score >= 50 ? '🟡 Watching' : '⚪ No Setup';
      el.querySelector('p').textContent = `${currentSymbol} confluence: ${score}% (need 72% for signal)`;
    }
  } catch (e) {}
}

// ─── CONFLUENCE VIEW ────────────────────────────
async function viewConfluence() {
  const section = document.getElementById('confluenceSection');
  section.classList.toggle('hidden');
  if (!section.classList.contains('hidden')) {
    try {
      const data = await fetchJSON(`/api/assets/${currentSymbol}/confluence`);
      renderConfluence(data);
    } catch (e) { console.error(e); }
  }
}

function renderConfluence(data) {
  const grid = document.getElementById('confluenceGrid');
  const items = [
    { label: 'SMART MONEY', score: data.scores?.smc || 0.5 },
    { label: 'MTF TREND', score: data.scores?.mtf || 0.5 },
    { label: 'VOLUME', score: data.scores?.volume || 0.5 },
    { label: 'MOMENTUM', score: data.scores?.momentum || 0.5 },
    { label: 'KEY LEVELS', score: data.scores?.keyLevel || 0.5 },
    { label: 'FINAL SCORE', score: data.finalScore || 0.5 },
  ];
  grid.innerHTML = items.map(item => {
    const pct = Math.round(item.score * 100);
    const color = pct > 60 ? '#10b981' : pct < 40 ? '#ef4444' : '#f59e0b';
    return `<div class="confl-item"><div class="label">${item.label}</div><div class="bar"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div><div class="value" style="color:${color}">${pct}%</div></div>`;
  }).join('');
}

// ─── LIVE SIGNALS ───────────────────────────────
async function loadLiveSignals() {
  try {
    const signals = await fetchJSON('/api/signals/live');
    document.getElementById('liveCount').textContent = signals.length;
    const body = document.getElementById('liveBody');
    if (!signals.length) { body.innerHTML = '<tr><td colspan="9" class="empty">No active signals</td></tr>'; return; }
    body.innerHTML = signals.map(s => {
      const dir = s.direction === 'LONG' ? '<td class="green">LONG</td>' : '<td class="red">SHORT</td>';
      return `<tr><td>${s.asset_symbol}</td>${dir}<td class="gold">${s.tier}</td><td>$${formatNum(s.entry_price)}</td><td class="red">$${formatNum(s.sl_price)}</td><td class="green">$${formatNum(s.tp2_price)}</td><td>${(s.confluence_score * 100).toFixed(0)}%</td><td>${s.status}</td><td>${formatTime(s.created_at)}</td></tr>`;
    }).join('');
  } catch (e) {}
}

// ─── SIGNAL HISTORY ─────────────────────────────
async function loadSignalHistory() {
  try {
    const signals = await fetchJSON('/api/signals/history?limit=50');
    document.getElementById('histCount').textContent = signals.length;
    const body = document.getElementById('histBody');
    if (!signals.length) { body.innerHTML = '<tr><td colspan="8" class="empty">No closed signals yet</td></tr>'; return; }
    body.innerHTML = signals.map(s => {
      const resultCls = s.status === 'WIN' ? 'green' : s.status === 'LOSS' ? 'red' : '';
      const rCls = (s.outcome_r || 0) >= 0 ? 'green' : 'red';
      return `<tr><td>${formatTime(s.closed_at)}</td><td>${s.asset_symbol}</td><td class="${s.direction === 'LONG' ? 'green' : 'red'}">${s.direction}</td><td class="gold">${s.tier}</td><td>$${formatNum(s.entry_price)}</td><td>$${formatNum(s.exit_price || s.sl_price)}</td><td class="${resultCls}">${s.status}</td><td class="${rCls}">${s.outcome_r ? s.outcome_r.toFixed(1) + 'R' : '—'}</td></tr>`;
    }).join('');
  } catch (e) {}
}

// ─── PERFORMANCE ────────────────────────────────
async function loadPerformance() {
  try {
    // Try to get backtest results for top stats (more meaningful than live)
    const btData = await fetchJSON('/api/backtest');
    if (btData && btData.status === 'done' && btData.results) {
      let bestWR = 0, bestPF = 0, bestR = 0, bestSharpe = 0, bestDD = Infinity, totalSignals = 0;
      for (const [sym, tfs] of Object.entries(btData.results)) {
        for (const [tf, r] of Object.entries(tfs)) {
          if (r.error || !r.totalTrades) continue;
          if (r.winRate > bestWR) bestWR = r.winRate;
          if (r.profitFactor > bestPF && r.profitFactor < 999) bestPF = r.profitFactor;
          if (r.totalR > bestR) bestR = r.totalR;
          if (r.sharpe > bestSharpe) bestSharpe = r.sharpe;
          if (r.maxDrawdown < bestDD) bestDD = r.maxDrawdown;
          totalSignals += r.totalTrades || 0;
        }
      }
      const wrEl = document.getElementById('statWR');
      const pfEl = document.getElementById('statPF');
      const ddEl = document.getElementById('statDD');
      document.getElementById('statSignals').textContent = totalSignals;
      wrEl.textContent = `${bestWR}%`; wrEl.className = `stat-value ${bestWR >= 55 ? 'green' : 'red'}`;
      pfEl.textContent = bestPF.toFixed(2); pfEl.className = `stat-value ${bestPF >= 1.4 ? 'green' : 'red'}`;
      document.getElementById('statTotalR').textContent = `${bestR}R`;
      ddEl.textContent = `${bestDD}%`; ddEl.className = `stat-value ${bestDD <= 20 ? 'green' : 'red'}`;
      document.getElementById('statSharpe').textContent = bestSharpe.toFixed(2);
      return;
    }
  } catch (e) {}

  // Fallback: live performance
  try {
    const stats = await fetchJSON('/api/performance');
    document.getElementById('statSignals').textContent = stats.totalSignals || 0;
    document.getElementById('statWR').textContent = stats.winRate ? `${stats.winRate}%` : 'N/A';
    document.getElementById('statPF').textContent = stats.profitFactor || 'N/A';
    document.getElementById('statTotalR').textContent = stats.totalR ? `${stats.totalR}R` : '0R';
    document.getElementById('statDD').textContent = stats.maxDrawdown ? `${stats.maxDrawdown}%` : '0%';
    document.getElementById('statSharpe').textContent = stats.sharpe || 'N/A';
  } catch (e) {}
}

// ─── BACKTEST ───────────────────────────────────
async function loadBacktestResults() {
  try {
    const data = await fetchJSON('/api/backtest');
    document.getElementById('btStatus').textContent = data.status === 'done' ? 'Validated' : data.status;
    document.getElementById('btStatus').style.color = data.status === 'done' ? '#10b981' : '#f59e0b';
    const body = document.getElementById('btBody');
    const rows = [];
    let bestMC = null;
    for (const [sym, tfs] of Object.entries(data.results || {})) {
      for (const [tf, r] of Object.entries(tfs)) {
        if (r.error) { rows.push(`<tr><td>${sym}</td><td>${tf.toUpperCase()}</td><td colspan="8" class="red">${r.error}</td></tr>`); continue; }
        const valid = r.isValid;
        const wrCls = r.winRate >= 55 ? 'green' : 'red';
        const pfCls = r.profitFactor >= 1.4 ? 'green' : 'red';
        rows.push(`<tr><td>${sym}</td><td>${tf.toUpperCase()}</td><td>${r.totalTrades}</td><td class="${wrCls}">${r.winRate}%</td><td class="${pfCls}">${r.profitFactor}</td><td>${r.sharpe}</td><td>${r.maxDrawdown}%</td><td>${r.avgRR}</td><td class="${r.totalR >= 0 ? 'green' : 'red'}">${r.totalR}R</td><td class="${valid ? 'green' : 'red'}">${valid ? '✅ VALID' : '⚠️'}</td></tr>`);
        if (r.monteCarlo && (!bestMC || r.totalTrades > bestMC.trades)) bestMC = { mc: r.monteCarlo, sym, tf, eq: r.equityCurve, trades: r.totalTrades };
      }
    }
    body.innerHTML = rows.join('') || '<tr><td colspan="10" class="empty">No results</td></tr>';
    if (bestMC) renderMonteCarlo(bestMC);
  } catch (e) { console.error('Backtest load error:', e); }
}

function renderMonteCarlo(data) {
  const { mc, eq } = data;
  if (!mc) return;
  const grid = document.getElementById('mcGrid');
  const items = [
    { label: '5th %ile', value: `$${mc.percentile5?.equity}`, color: '#ef4444' },
    { label: 'MEDIAN', value: `$${mc.median?.equity}`, color: '#f59e0b' },
    { label: '95th %ile', value: `$${mc.percentile95?.equity}`, color: '#10b981' },
    { label: 'PROFITABLE', value: `${mc.profitableSims}%`, color: mc.profitableSims > 50 ? '#10b981' : '#ef4444' },
  ];
  grid.innerHTML = items.map(i => `<div class="mc-card"><div class="label">${i.label}</div><div class="value" style="color:${i.color}">${i.value}</div></div>`).join('');
  // Equity chart
  if (eq && eq.length > 5) {
    const eqChart = LightweightCharts.createChart(document.getElementById('equityChart'), {
      layout: { background: { color: '#0d0d14' }, textColor: '#64748b', fontFamily: "'IBM Plex Mono', monospace", fontSize: 10 },
      grid: { vertLines: { color: '#1a1a2e' }, horzLines: { color: '#1a1a2e' } },
      rightPriceScale: { borderColor: '#1a1a2e' }, timeScale: { borderColor: '#1a1a2e', timeVisible: true },
    });
    const lineSeries = eqChart.addLineSeries({ color: '#3b82f6', lineWidth: 2 });
    lineSeries.setData(eq.map(e => ({ time: e.time, value: e.equity })));
    eqChart.timeScale().fitContent();
  }
}

// ─── CONFIG ─────────────────────────────────────
async function loadConfig() {
  try {
    const cfg = await fetchJSON('/api/config');
    const session = cfg.session;
    document.getElementById('sessionBadge').textContent = session?.name || 'Unknown';
  } catch (e) {}
}

// ─── CLOCK ──────────────────────────────────────
function startClock() {
  setInterval(() => {
    const now = new Date();
    document.getElementById('clock').textContent = now.toUTCString().slice(-12, -4) + ' UTC';
  }, 1000);
}

// ─── PAPER TRADING ──────────────────────────────
let ptEnabled = true;

async function loadPaperTrading() {
  try {
    const data = await fetchJSON('/api/paper-trading');
    ptEnabled = data.enabled;

    // Toggle button
    const btn = document.getElementById('ptToggle');
    btn.textContent = data.enabled ? '● LIVE' : '● OFF';
    btn.className = `btn-toggle ${data.enabled ? 'active' : 'inactive'}`;

    // Stats
    const pnlCls = data.pnl >= 0 ? 'color:#10b981' : 'color:#ef4444';
    const retCls = data.pnlPercent >= 0 ? 'color:#10b981' : 'color:#ef4444';
    document.getElementById('ptEquity').textContent = `$${formatNum(data.equity)}`;
    document.getElementById('ptPnL').innerHTML = `<span style="${pnlCls}">$${data.pnl >= 0 ? '+' : ''}${formatNum(data.pnl)}</span>`;
    document.getElementById('ptReturn').innerHTML = `<span style="${retCls}">${data.pnlPercent >= 0 ? '+' : ''}${data.pnlPercent}%</span>`;
    document.getElementById('ptWinRate').textContent = data.totalTrades > 0 ? `${data.winRate}%` : '—';
    document.getElementById('ptTotalR').innerHTML = `<span style="${data.totalR >= 0 ? 'color:#10b981' : 'color:#ef4444'}">${data.totalR}R</span>`;
    document.getElementById('ptWL').textContent = `${data.wins} / ${data.losses}`;
    document.getElementById('ptDD').textContent = `${data.maxDrawdown}%`;
    document.getElementById('ptActive').textContent = data.activeCount;

    // Active trades table
    const activeBody = document.getElementById('ptActiveBody');
    if (!data.activeTrades || data.activeTrades.length === 0) {
      activeBody.innerHTML = '<tr><td colspan="12" class="empty">No active paper trades — signals auto-open trades</td></tr>';
    } else {
      activeBody.innerHTML = data.activeTrades.map(t => {
        const dirCls = t.direction === 'LONG' ? 'green' : 'red';
        const pnlCls2 = t.unrealizedPnL >= 0 ? 'green' : 'red';
        const rCls = t.unrealizedR >= 0 ? 'green' : 'red';
        let statusBadge = t.status;
        if (t.tp1Hit) statusBadge = '🎯 TP1';
        if (t.tp2Hit) statusBadge = '🎯🎯 TP2';
        return `<tr>
          <td>#${t.id}</td><td>${t.symbol}</td><td class="${dirCls}">${t.direction}</td><td class="gold">${t.tier}</td>
          <td>$${formatNum(t.entryPrice)}</td><td>$${formatNum(t.currentPrice)}</td>
          <td class="red">$${formatNum(t.trailingSL || t.slPrice)}</td>
          <td class="green">$${formatNum(t.tp1Price)}</td><td class="green">$${formatNum(t.tp2Price)}</td>
          <td>${statusBadge}</td><td class="${pnlCls2}">$${t.unrealizedPnL >= 0 ? '+' : ''}${formatNum(t.unrealizedPnL)}</td>
          <td class="${rCls}">${t.unrealizedR}R</td></tr>`;
      }).join('');
    }

    // Closed trades table
    const closedBody = document.getElementById('ptClosedBody');
    if (!data.recentClosed || data.recentClosed.length === 0) {
      closedBody.innerHTML = '<tr><td colspan="9" class="empty">No closed trades yet</td></tr>';
    } else {
      closedBody.innerHTML = data.recentClosed.map(t => {
        const pnlCls3 = t.totalPnL >= 0 ? 'green' : 'red';
        const rCls2 = t.totalR >= 0 ? 'green' : 'red';
        const dirCls2 = t.direction === 'LONG' ? 'green' : 'red';
        const dur = t.closedAt && t.openedAt ? formatDuration(new Date(t.closedAt) - new Date(t.openedAt)) : '—';
        return `<tr>
          <td>#${t.id}</td><td>${t.symbol}</td><td class="${dirCls2}">${t.direction}</td>
          <td>$${formatNum(t.entryPrice)}</td><td>$${formatNum(t.exitPrice)}</td>
          <td>${t.closeReason || '—'}</td>
          <td class="${pnlCls3}">$${t.totalPnL >= 0 ? '+' : ''}${formatNum(t.totalPnL)}</td>
          <td class="${rCls2}">${t.totalR}R</td><td>${dur}</td></tr>`;
      }).join('');
    }
  } catch (e) { console.error('Paper trading load error:', e); }
}

async function togglePaperTrading() {
  ptEnabled = !ptEnabled;
  await fetchJSON('/api/paper-trading/toggle', { method: 'POST', body: JSON.stringify({ enabled: ptEnabled }) });
  loadPaperTrading();
}

async function closeAllPaperTrades() {
  if (!confirm('Close all active paper trades?')) return;
  await fetchJSON('/api/paper-trading/close-all', { method: 'POST' });
  loadPaperTrading();
}

async function resetPaperTrading() {
  if (!confirm('Reset paper trading? This clears all history.')) return;
  await fetchJSON('/api/paper-trading/reset', { method: 'POST' });
  loadPaperTrading();
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

// ─── HELPERS ────────────────────────────────────
async function fetchJSON(url, opts = {}) {
  const res = await fetch(API + url, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } });
  return res.json();
}
function formatNum(n) { if (!n && n !== 0) return '—'; return Math.abs(n) >= 1000 ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n.toFixed(2); }
function formatTime(t) { if (!t) return '—'; const d = new Date(t); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); }
