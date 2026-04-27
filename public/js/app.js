const API='';let chart,candleSeries,currentSymbol='XAUUSD',currentTF='1h',signalLines=[];

document.addEventListener('DOMContentLoaded',()=>{
  initChart();loadPrices();loadConfig();loadBacktestResults();loadLiveSignals();
  loadSignalHistory();loadPerformance();loadPaperTrading();startClock();
  loadDataMode();autoLoadConfluence();
  setInterval(loadPrices,30000);setInterval(loadLiveSignals,60000);
  setInterval(loadSignalHistory,120000);setInterval(loadPaperTrading,5000);
  setInterval(loadPerformance,30000);setInterval(autoLoadConfluence,120000);
  setInterval(loadDataMode,60000);
  document.getElementById('assetSelect').addEventListener('change',e=>{currentSymbol=e.target.value;loadChart();autoLoadConfluence();});
  document.getElementById('tfSelect').addEventListener('change',e=>{currentTF=e.target.value;loadChart();});
  document.getElementById('btnGenerate').addEventListener('click',generateSignal);
  document.getElementById('btnScanAll').addEventListener('click',scanAll);
  document.getElementById('btnConfluence').addEventListener('click',viewConfluence);
  loadChart();
});

function initChart(){
  chart=LightweightCharts.createChart(document.getElementById('chart'),{
    layout:{background:{color:'#0d0d14'},textColor:'#64748b',fontFamily:"'IBM Plex Mono',monospace",fontSize:11},
    grid:{vertLines:{color:'#1a1a2e'},horzLines:{color:'#1a1a2e'}},
    crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
    timeScale:{borderColor:'#1a1a2e',timeVisible:true},rightPriceScale:{borderColor:'#1a1a2e'}
  });
  candleSeries=chart.addCandlestickSeries({upColor:'#10b981',downColor:'#ef4444',borderUpColor:'#10b981',borderDownColor:'#ef4444',wickUpColor:'#10b981',wickDownColor:'#ef4444'});
}

async function loadChart(){
  document.getElementById('chartTitle').textContent=`${currentSymbol} — ${currentTF.toUpperCase()}`;
  try{
    const candles=await fetchJSON(`/api/ohlcv/${currentSymbol}?tf=${currentTF}&count=300`);
    if(candles&&candles.length){
      candleSeries.setData(candles);chart.timeScale().fitContent();
      const last=candles[candles.length-1];
      document.getElementById('chartPrice').textContent=`$${formatNum(last.close)}`;
      document.getElementById('chartPrice').style.color=last.close>=last.open?'#10b981':'#ef4444';
    }
  }catch(e){console.error('Chart error:',e);}
}

function addSignalOverlay(s){
  clearSignalOverlay();
  const lines=[
    {price:s.entry_price||s.entry,color:'#3b82f6',title:'ENTRY',style:0},
    {price:s.sl_price||s.sl,color:'#ef4444',title:'SL',style:2},
    {price:s.tp1_price||s.tp1,color:'#f59e0b',title:'TP1',style:2},
    {price:s.tp2_price||s.tp2,color:'#22c55e',title:'TP2',style:2},
    {price:s.tp3_price||s.tp3,color:'#22c55e',title:'TP3',style:2},
  ];
  for(const l of lines){if(!l.price)continue;signalLines.push(candleSeries.createPriceLine({price:l.price,color:l.color,lineWidth:1,lineStyle:l.style,title:l.title,axisLabelVisible:true}));}
}
function clearSignalOverlay(){for(const l of signalLines){try{candleSeries.removePriceLine(l);}catch(e){}}signalLines=[];}

async function loadPrices(){
  const symbols=['XAUUSD','BTCUSDT','ETHUSDT'];
  const ticker=document.getElementById('priceTicker');const items=[];
  for(const sym of symbols){
    try{
      const data=await fetchJSON(`/api/assets/${sym}/price`);
      const ch=data.change24h||0;const cls=ch>=0?'up':'down';const arrow=ch>=0?'▲':'▼';
      const src=data.source==='DEMO'?' ᴅ':'';
      items.push(`<div class="ticker-item"><span class="ticker-symbol">${sym}${src}</span><span class="ticker-price">$${formatNum(data.price)}</span><span class="ticker-change ${cls}">${arrow} ${Math.abs(ch).toFixed(1)}%</span></div>`);
    }catch(e){items.push(`<div class="ticker-item"><span class="ticker-symbol">${sym}</span><span class="ticker-price">—</span></div>`);}
  }
  ticker.innerHTML=items.join('');
}

async function loadDataMode(){
  try{
    const dm=await fetchJSON('/api/data-mode');
    const badge=document.getElementById('dataModeBadge');
    const banner=document.getElementById('demoBanner');
    if(dm.globalMode==='LIVE'){
      badge.className='data-mode-badge live';
      badge.querySelector('.mode-text').textContent='LIVE';
      banner.classList.add('hidden');
    }else{
      badge.className='data-mode-badge demo';
      badge.querySelector('.mode-text').textContent='DEMO';
      banner.classList.remove('hidden');
    }
  }catch(e){}
}

async function generateSignal(){
  const btn=document.getElementById('btnGenerate');
  btn.textContent='⏳ Scanning...';btn.disabled=true;
  try{
    const res=await fetchJSON(`/api/signals/generate/${currentSymbol}`,{method:'POST'});
    if(res.status==='signal'&&res.signal){showSignal(res.signal);showExplanation(res.signal);loadLiveSignals();}
    else if(res.status==='no_signal'){showNoSignal(res.confluence);showExplanation(res.confluence);}
    else if(res.status==='skipped'){showNoSignal(null,`Skipped: ${res.reason}`);if(res.confluence)showExplanation(res.confluence);}
    else if(res.status==='rejected'){showNoSignal(null,`Rejected: ${(res.reason||[]).join(', ')}`);if(res.confluence)showExplanation(res.confluence);}
    else if(res.error){showNoSignal(null,res.error);}
  }catch(e){showNoSignal(null,'Error generating signal');}
  btn.textContent='⚡ Generate Signal';btn.disabled=false;
}

async function scanAll(){
  const btn=document.getElementById('btnScanAll');
  btn.textContent='⏳ Scanning...';btn.disabled=true;
  for(const sym of['XAUUSD','BTCUSDT','ETHUSDT']){try{await fetchJSON(`/api/signals/generate/${sym}`,{method:'POST'});}catch(e){}}
  await loadLiveSignals();btn.textContent='🔍 Scan All Assets';btn.disabled=false;
}

function showSignal(signal){
  document.getElementById('signalEmpty').classList.add('hidden');
  const card=document.getElementById('signalCard');card.classList.remove('hidden');
  const dir=signal.direction||'LONG';
  const dirEl=document.getElementById('sigDirection');dirEl.textContent=dir;dirEl.className=`signal-direction ${dir.toLowerCase()}`;
  document.getElementById('sigTier').textContent=`${signal.tier||'B'} TIER`;
  const score=Math.round((signal.finalScore||signal.confluence_score||0)*100);
  document.getElementById('sigScoreText').textContent=`${score}%`;
  const fill=document.getElementById('sigScoreFill');fill.style.width=`${score}%`;
  fill.style.background=score>75?'linear-gradient(90deg,#10b981,#22c55e)':score>50?'linear-gradient(90deg,#f59e0b,#d97706)':'linear-gradient(90deg,#ef4444,#dc2626)';
  document.getElementById('sigEntry').textContent=`$${formatNum(signal.entry_price||signal.entry)}`;
  document.getElementById('sigSL').textContent=`$${formatNum(signal.sl_price||signal.sl)}`;
  document.getElementById('sigTP1').textContent=`$${formatNum(signal.tp1_price||signal.tp1)}`;
  document.getElementById('sigTP2').textContent=`$${formatNum(signal.tp2_price||signal.tp2)}`;
  document.getElementById('sigTP3').textContent=`$${formatNum(signal.tp3_price||signal.tp3)}`;
  document.getElementById('sigRegime').textContent=`Regime: ${signal.regime?.name||signal.regime||'—'}`;
  document.getElementById('sigSession').textContent=`Session: ${signal.details?.sessionDetails?.name||'—'}`;
  const dq=document.getElementById('sigDataQuality');
  dq.textContent=`Data: ${signal.dataMode||'—'}`;
  dq.className=`signal-data-quality ${signal.dataMode==='LIVE'?'live':'demo'}`;
  document.getElementById('sigInvalidation').textContent=signal.invalidationReason||'';
  document.getElementById('sigReasoning').textContent=signal.reasoning||'';
  addSignalOverlay(signal);
}

function showNoSignal(confluence,msg){
  document.getElementById('signalCard').classList.add('hidden');
  const el=document.getElementById('signalEmpty');el.classList.remove('hidden');
  const reason=msg||(confluence?`Score: ${confluence.finalScore?.toFixed?confluence.finalScore.toFixed(2):confluence.finalScore} — ${confluence.reason||'Neutral zone'}`:'No valid setup found');
  el.querySelector('p').textContent=reason;
}

function showExplanation(data){
  const panel=document.getElementById('explanationPanel');
  panel.classList.remove('hidden');
  const cl=document.getElementById('signalChecklist');
  const bl=document.getElementById('signalBlockers');
  const title=document.getElementById('explanationTitle');
  if(data.direction&&data.direction!=='NO_SIGNAL'){
    title.textContent='✅ Why This Signal';title.style.color='#10b981';
  }else{
    title.textContent='⛔ Why No Trade';title.style.color='#ef4444';
  }
  if(data.checklist&&data.checklist.length>0){
    cl.innerHTML=data.checklist.map(c=>`<div class="check-item ${c.pass?'pass':'fail'}"><span class="check-icon">${c.pass?'✓':'✗'}</span><span class="check-system">${c.system}</span><span class="check-value">${c.value}</span><span class="check-detail">${c.detail||''}</span></div>`).join('');
  }else{cl.innerHTML='<div class="check-item">No checklist data</div>';}
  if(data.blockers&&data.blockers.length>0){
    bl.innerHTML='<h5>Blockers:</h5>'+data.blockers.map(b=>`<div class="blocker-item">⚠️ ${b}</div>`).join('');
  }else{bl.innerHTML='';}
}

async function autoLoadConfluence(){
  try{
    const data=await fetchJSON(`/api/assets/${currentSymbol}/confluence`);
    if(data&&data.finalScore!==undefined){
      const score=Math.round((data.finalScore||0)*100);
      const el=document.getElementById('signalEmpty');el.classList.remove('hidden');
      document.getElementById('signalCard').classList.add('hidden');
      el.querySelector('h3').textContent=score>=72?'🟢 Signal Possible':score>=50?'🟡 Watching':'⚪ No Setup';
      el.querySelector('p').textContent=`${currentSymbol} confluence: ${score}% (need 72% for signal)`;
      showExplanation(data);
    }
  }catch(e){}
}

async function viewConfluence(){
  const section=document.getElementById('confluenceSection');section.classList.toggle('hidden');
  if(!section.classList.contains('hidden')){
    try{const data=await fetchJSON(`/api/assets/${currentSymbol}/confluence`);renderConfluence(data);}catch(e){}
  }
}

function renderConfluence(data){
  const grid=document.getElementById('confluenceGrid');if(!data||!data.scores)return;
  const items=[
    {label:'SMART MONEY',score:data.scores.smc||0.5},{label:'MULTI-TF TREND',score:data.scores.mtf||0.5},
    {label:'VOLUME',score:data.scores.volume||0.5},{label:'MOMENTUM',score:data.scores.momentum||0.5},
    {label:'KEY LEVELS',score:data.scores.keyLevel||0.5},{label:'FINAL SCORE',score:data.finalScore||0.5},
  ];
  grid.innerHTML=items.map(item=>{
    const pct=Math.round(item.score*100);const color=pct>60?'#10b981':pct<40?'#ef4444':'#f59e0b';
    return `<div class="confl-item"><div class="label">${item.label}</div><div class="bar"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div><div class="value" style="color:${color}">${pct}%</div></div>`;
  }).join('');
}

async function loadLiveSignals(){
  try{
    const signals=await fetchJSON('/api/signals/live');document.getElementById('liveCount').textContent=signals.length;
    const body=document.getElementById('liveBody');
    if(!signals.length){body.innerHTML='<tr><td colspan="9" class="empty">No active signals — system scanning every 5 min</td></tr>';return;}
    body.innerHTML=signals.map(s=>{
      const dir=s.direction==='LONG'?'<td class="green">LONG</td>':'<td class="red">SHORT</td>';
      return `<tr><td>${s.asset_symbol}</td>${dir}<td class="gold">${s.tier}</td><td>$${formatNum(s.entry_price)}</td><td class="red">$${formatNum(s.sl_price)}</td><td class="green">$${formatNum(s.tp2_price)}</td><td>${(s.confluence_score*100).toFixed(0)}%</td><td>${s.status}</td><td>${formatTime(s.created_at)}</td></tr>`;
    }).join('');
  }catch(e){}
}

async function loadSignalHistory(){
  try{
    const signals=await fetchJSON('/api/signals/history?limit=50');document.getElementById('histCount').textContent=signals.length;
    const body=document.getElementById('histBody');
    if(!signals.length){body.innerHTML='<tr><td colspan="8" class="empty">No closed signals yet</td></tr>';return;}
    body.innerHTML=signals.map(s=>{
      const rc=s.status==='WIN'?'green':s.status==='LOSS'?'red':'';
      return `<tr><td>${formatTime(s.closed_at)}</td><td>${s.asset_symbol}</td><td class="${s.direction==='LONG'?'green':'red'}">${s.direction}</td><td class="gold">${s.tier}</td><td>$${formatNum(s.entry_price)}</td><td>$${formatNum(s.exit_price||s.sl_price)}</td><td class="${rc}">${s.status}</td><td class="${(s.outcome_r||0)>=0?'green':'red'}">${s.outcome_r?s.outcome_r.toFixed(1)+'R':'—'}</td></tr>`;
    }).join('');
  }catch(e){}
}

async function loadPerformance(){
  try{
    const btData=await fetchJSON('/api/backtest');
    if(btData&&btData.status==='done'&&btData.results){
      let bestWR=0,bestPF=0,bestR=0,bestSharpe=0,bestDD=Infinity,totalSignals=0;
      for(const[,tfs]of Object.entries(btData.results)){
        for(const[,r]of Object.entries(tfs)){
          if(r.error||!r.totalTrades)continue;
          if(r.winRate>bestWR)bestWR=r.winRate;
          if(r.profitFactor>bestPF&&r.profitFactor<999)bestPF=r.profitFactor;
          if(r.totalR>bestR)bestR=r.totalR;
          if(r.sharpe>bestSharpe)bestSharpe=r.sharpe;
          if(r.maxDrawdown<bestDD)bestDD=r.maxDrawdown;
          totalSignals+=r.totalTrades||0;
        }
      }
      document.getElementById('statSignals').textContent=totalSignals;
      const wrEl=document.getElementById('statWR');wrEl.textContent=`${bestWR}%`;wrEl.className=`stat-value ${bestWR>=55?'green':'red'}`;
      const pfEl=document.getElementById('statPF');pfEl.textContent=bestPF.toFixed(2);pfEl.className=`stat-value ${bestPF>=1.4?'green':'red'}`;
      document.getElementById('statTotalR').textContent=`${bestR}R`;
      const ddEl=document.getElementById('statDD');ddEl.textContent=`${bestDD}%`;ddEl.className=`stat-value ${bestDD<=20?'green':'red'}`;
      document.getElementById('statSharpe').textContent=bestSharpe.toFixed(2);
      return;
    }
  }catch(e){}
  try{
    const stats=await fetchJSON('/api/performance');
    document.getElementById('statSignals').textContent=stats.totalSignals||0;
    document.getElementById('statWR').textContent=stats.winRate?`${stats.winRate}%`:'N/A';
    document.getElementById('statPF').textContent=stats.profitFactor||'N/A';
    document.getElementById('statTotalR').textContent=stats.totalR?`${stats.totalR}R`:'0R';
    document.getElementById('statDD').textContent=stats.maxDrawdown?`${stats.maxDrawdown}%`:'0%';
    document.getElementById('statSharpe').textContent=stats.sharpe||'N/A';
  }catch(e){}
}

async function loadBacktestResults(){
  try{
    const data=await fetchJSON('/api/backtest');
    document.getElementById('btStatus').textContent=data.status==='done'?'Validated':data.status;
    document.getElementById('btStatus').style.color=data.status==='done'?'#10b981':'#f59e0b';
    const body=document.getElementById('btBody');const rows=[];let bestMC=null;
    for(const[sym,tfs]of Object.entries(data.results||{})){
      for(const[tf,r]of Object.entries(tfs)){
        if(r.error){rows.push(`<tr><td>${sym}</td><td>${tf.toUpperCase()}</td><td colspan="9" class="red">${r.error}</td></tr>`);continue;}
        const srcBadge=r.dataSource==='DEMO'?'<span class="src-demo">DEMO</span>':`<span class="src-live">${r.dataSource||'LIVE'}</span>`;
        const wrCls=r.winRate>=55?'green':'red';const pfCls=r.profitFactor>=1.4?'green':'red';
        const minTrades=r.totalTrades>=50;
        const statusText=r.isValid?'✅ VALID':(!minTrades?'⚠️ LOW N':'⚠️');
        rows.push(`<tr><td>${sym}</td><td>${tf.toUpperCase()}</td><td>${r.totalTrades}</td><td class="${wrCls}">${r.winRate}%</td><td class="${pfCls}">${r.profitFactor}</td><td>${r.sharpe}</td><td>${r.maxDrawdown}%</td><td>${r.avgRR}</td><td class="${r.totalR>=0?'green':'red'}">${r.totalR}R</td><td>${srcBadge}</td><td class="${r.isValid?'green':'red'}">${statusText}</td></tr>`);
        if(r.monteCarlo&&(!bestMC||r.totalTrades>bestMC.trades))bestMC={mc:r.monteCarlo,sym,tf,eq:r.equityCurve,trades:r.totalTrades};
      }
    }
    body.innerHTML=rows.join('')||'<tr><td colspan="11" class="empty">No results</td></tr>';
    if(bestMC)renderMonteCarlo(bestMC);
  }catch(e){console.error('Backtest load error:',e);}
}

function renderMonteCarlo(data){
  const{mc,eq}=data;if(!mc)return;
  const grid=document.getElementById('mcGrid');
  grid.innerHTML=[
    {label:'5th %ile',value:`$${mc.percentile5?.equity}`,color:'#ef4444'},
    {label:'MEDIAN',value:`$${mc.median?.equity}`,color:'#f59e0b'},
    {label:'95th %ile',value:`$${mc.percentile95?.equity}`,color:'#10b981'},
    {label:'PROFITABLE',value:`${mc.profitableSims}%`,color:mc.profitableSims>50?'#10b981':'#ef4444'},
  ].map(i=>`<div class="mc-card"><div class="label">${i.label}</div><div class="value" style="color:${i.color}">${i.value}</div></div>`).join('');
  if(eq&&eq.length>5){
    const eqChart=LightweightCharts.createChart(document.getElementById('equityChart'),{
      layout:{background:{color:'#0d0d14'},textColor:'#64748b',fontFamily:"'IBM Plex Mono',monospace",fontSize:10},
      grid:{vertLines:{color:'#1a1a2e'},horzLines:{color:'#1a1a2e'}},
      rightPriceScale:{borderColor:'#1a1a2e'},timeScale:{borderColor:'#1a1a2e',timeVisible:true}
    });
    eqChart.addLineSeries({color:'#3b82f6',lineWidth:2}).setData(eq.map(e=>({time:e.time,value:e.equity})));
    eqChart.timeScale().fitContent();
  }
}

async function loadConfig(){
  try{
    const cfg=await fetchJSON('/api/config');
    document.getElementById('sessionBadge').textContent=cfg.session?.name||'Unknown';
  }catch(e){}
}

function startClock(){
  setInterval(()=>{
    const now=new Date();const h=String(now.getUTCHours()).padStart(2,'0');
    const m=String(now.getUTCMinutes()).padStart(2,'0');const s=String(now.getUTCSeconds()).padStart(2,'0');
    document.getElementById('clock').textContent=`${h}:${m}:${s} UTC`;
  },1000);
}

async function loadPaperTrading(){
  try{
    const pt=await fetchJSON('/api/paper-trading');
    document.getElementById('ptEquity').textContent=`$${formatNum(pt.equity)}`;
    const pnlEl=document.getElementById('ptPnL');pnlEl.textContent=`$${pt.pnl>=0?'+':''}${formatNum(pt.pnl)}`;pnlEl.className=`pt-value ${pt.pnl>=0?'green':'red'}`;
    const retEl=document.getElementById('ptReturn');retEl.textContent=`${pt.pnlPercent>=0?'+':''}${pt.pnlPercent}%`;retEl.className=`pt-value ${pt.pnlPercent>=0?'green':'red'}`;
    document.getElementById('ptWinRate').textContent=pt.winRate?`${pt.winRate}%`:'—';
    document.getElementById('ptTotalR').textContent=`${pt.totalR}R`;
    document.getElementById('ptWL').textContent=`${pt.wins} / ${pt.losses}`;
    document.getElementById('ptDD').textContent=`${pt.maxDrawdown}%`;
    document.getElementById('ptActive').textContent=pt.activeCount;
    const ab=document.getElementById('ptActiveBody');
    if(!pt.activeTrades||!pt.activeTrades.length){ab.innerHTML='<tr><td colspan="12" class="empty">No active paper trades</td></tr>';}
    else{ab.innerHTML=pt.activeTrades.map(t=>{
      const dc=t.direction==='LONG'?'green':'red';const pc=t.unrealizedPnL>=0?'green':'red';
      return `<tr><td>#${t.id}</td><td>${t.symbol}</td><td class="${dc}">${t.direction}</td><td class="gold">${t.tier||'—'}</td><td>$${formatNum(t.entryPrice)}</td><td>$${formatNum(t.currentPrice)}</td><td class="red">$${formatNum(t.slPrice)}</td><td>$${formatNum(t.tp1Price)}</td><td>$${formatNum(t.tp2Price)}</td><td>${t.status}</td><td class="${pc}">$${formatNum(t.unrealizedPnL)}</td><td class="${pc}">${t.unrealizedR}R</td></tr>`;
    }).join('');}
    const cb=document.getElementById('ptClosedBody');
    if(!pt.recentClosed||!pt.recentClosed.length){cb.innerHTML='<tr><td colspan="9" class="empty">No closed trades yet</td></tr>';}
    else{cb.innerHTML=pt.recentClosed.map(t=>{
      const pc=t.totalPnL>=0?'green':'red';const dur=t.barsHeld?`${t.barsHeld} bars`:'—';
      return `<tr><td>#${t.id}</td><td>${t.symbol}</td><td class="${t.direction==='LONG'?'green':'red'}">${t.direction}</td><td>$${formatNum(t.entryPrice)}</td><td>$${formatNum(t.exitPrice||0)}</td><td>${t.closeReason||'—'}</td><td class="${pc}">$${formatNum(t.totalPnL)}</td><td class="${pc}">${t.totalR}R</td><td>${dur}</td></tr>`;
    }).join('');}
    const toggle=document.getElementById('ptToggle');
    if(pt.enabled){toggle.textContent='● LIVE';toggle.className='btn-toggle active';}
    else{toggle.textContent='○ OFF';toggle.className='btn-toggle';}
  }catch(e){}
}

async function togglePaperTrading(){
  const t=document.getElementById('ptToggle');const enable=t.textContent.includes('OFF');
  try{await fetchJSON('/api/paper-trading/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:enable})});loadPaperTrading();}catch(e){}
}
async function closeAllPaperTrades(){try{await fetchJSON('/api/paper-trading/close-all',{method:'POST'});loadPaperTrading();}catch(e){}}
async function resetPaperTrading(){if(!confirm('Reset all paper trading data?'))return;try{await fetchJSON('/api/paper-trading/reset',{method:'POST'});loadPaperTrading();}catch(e){}}

async function fetchJSON(url,opts){const r=await fetch(API+url,opts);if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
function formatNum(n){if(n==null||isNaN(n))return'—';return Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function formatTime(t){if(!t)return'—';const d=new Date(t);return d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false})+' '+d.toLocaleDateString('en-US',{month:'short',day:'numeric'});}
