const API='';let chart,candleSeries,currentSymbol='XAUUSD',currentTF='1h',signalLines=[],lastSignalData=null;

document.addEventListener('DOMContentLoaded',()=>{
  initChart();loadMarketOverview();loadBacktestResults();loadLiveSignals();
  loadSignalHistory();loadPaperTrading();startClock();loadDataMode();autoScan();
  setInterval(loadMarketOverview,30000);setInterval(loadLiveSignals,60000);
  setInterval(loadSignalHistory,120000);setInterval(loadPaperTrading,5000);
  setInterval(loadDataMode,60000);setInterval(autoScan,120000);
  document.getElementById('assetSelect').addEventListener('change',e=>{currentSymbol=e.target.value;loadChart();autoScan();highlightAsset();});
  document.getElementById('tfSelect').addEventListener('change',e=>{currentTF=e.target.value;loadChart();});
  document.getElementById('btnGenerate').addEventListener('click',generateSignal);
  document.getElementById('btnScanAll').addEventListener('click',scanAll);
  document.querySelectorAll('.nav-item').forEach(n=>n.addEventListener('click',()=>{document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));n.classList.add('active');}));
  loadChart();
});

function initChart(){
  chart=LightweightCharts.createChart(document.getElementById('chart'),{
    layout:{background:{color:'#0B0F14'},textColor:'#64748B',fontFamily:"'IBM Plex Mono',monospace",fontSize:11},
    grid:{vertLines:{color:'#1a1f2e'},horzLines:{color:'#1a1f2e'}},
    crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
    timeScale:{borderColor:'#1F2937',timeVisible:true},rightPriceScale:{borderColor:'#1F2937'}
  });
  candleSeries=chart.addCandlestickSeries({upColor:'#00C853',downColor:'#FF3D00',borderUpColor:'#00C853',borderDownColor:'#FF3D00',wickUpColor:'#00C853',wickDownColor:'#FF3D00'});
}

async function loadChart(){
  document.getElementById('chartTitle').textContent=`${currentSymbol} — ${currentTF.toUpperCase()}`;
  try{
    const candles=await fetchJSON(`/api/ohlcv/${currentSymbol}?tf=${currentTF}&count=300`);
    if(candles&&candles.length){
      candleSeries.setData(candles);chart.timeScale().fitContent();
      const last=candles[candles.length-1];
      const p=document.getElementById('chartPrice');
      p.textContent=`$${fmtN(last.close)}`;p.style.color=last.close>=last.open?'#00C853':'#FF3D00';
    }
  }catch(e){}
}

function addSignalOverlay(s){
  clearSignalOverlay();
  [{price:s.entry_price||s.entry,color:'#2196F3',title:'ENTRY',style:0},
   {price:s.sl_price||s.sl,color:'#FF3D00',title:'SL',style:2},
   {price:s.tp1_price||s.tp1,color:'#FFC107',title:'TP1',style:2},
   {price:s.tp2_price||s.tp2,color:'#00C853',title:'TP2',style:2},
   {price:s.tp3_price||s.tp3,color:'#00C853',title:'TP3',style:2}
  ].forEach(l=>{if(l.price)signalLines.push(candleSeries.createPriceLine({price:l.price,color:l.color,lineWidth:1,lineStyle:l.style,title:l.title,axisLabelVisible:true}));});
}
function clearSignalOverlay(){signalLines.forEach(l=>{try{candleSeries.removePriceLine(l)}catch(e){}});signalLines=[];}

async function loadMarketOverview(){
  const syms=['XAUUSD','BTCUSDT','ETHUSDT'];const el=document.getElementById('marketOverview');const cards=[];
  for(const sym of syms){
    try{
      const d=await fetchJSON(`/api/assets/${sym}/price`);
      const ch=d.change24h||0;const cls=ch>=0?'bullish':'bearish';
      const src=d.source==='DEMO'?'data-warn':'data';
      cards.push(`<div class="market-card ${sym===currentSymbol?'selected':''}" onclick="selectAsset('${sym}')">
        <div class="mc-symbol">${sym}</div>
        <div class="mc-price" style="color:${ch>=0?'#00C853':'#FF3D00'}">$${fmtN(d.price)}</div>
        <div class="mc-change" style="color:${ch>=0?'#00C853':'#FF3D00'}">${ch>=0?'▲':'▼'} ${Math.abs(ch).toFixed(1)}%</div>
        <div class="mc-meta"><span class="mc-tag ${cls}">${ch>=0?'Bullish':'Bearish'}</span><span class="mc-tag ${src}">${d.source||'LIVE'}</span></div>
      </div>`);
    }catch(e){cards.push(`<div class="market-card"><div class="mc-symbol">${sym}</div><div class="mc-price">—</div></div>`);}
  }
  el.innerHTML=cards.join('');
}
function selectAsset(sym){currentSymbol=sym;document.getElementById('assetSelect').value=sym;loadChart();autoScan();loadMarketOverview();}
function highlightAsset(){loadMarketOverview();}

async function loadDataMode(){
  try{
    const dm=await fetchJSON('/api/data-mode');const b=document.getElementById('dataModeBadge');const banner=document.getElementById('demoBanner');
    if(dm.globalMode==='LIVE'){b.className='badge badge-live';b.innerHTML='<span class="mode-dot live"></span>LIVE';banner.classList.add('hidden');}
    else{b.className='badge badge-demo';b.innerHTML='<span class="mode-dot demo"></span>DEMO';banner.classList.remove('hidden');}
  }catch(e){}
}

async function generateSignal(){
  const btn=document.getElementById('btnGenerate');btn.textContent='⏳ Scanning...';btn.disabled=true;
  try{
    const res=await fetchJSON(`/api/signals/generate/${currentSymbol}`,{method:'POST'});
    if(res.status==='signal'&&res.signal){showActiveSignal(res.signal,res);loadLiveSignals();}
    else{showNoTrade(res);}
  }catch(e){showNoTrade({analysis:'Error generating signal'});}
  btn.textContent='⚡ Generate Signal';btn.disabled=false;
}

async function scanAll(){
  const btn=document.getElementById('btnScanAll');btn.textContent='⏳...';btn.disabled=true;
  for(const sym of['XAUUSD','BTCUSDT','ETHUSDT']){try{await fetchJSON(`/api/signals/generate/${sym}`,{method:'POST'});}catch(e){}}
  await loadLiveSignals();btn.textContent='Scan All';btn.disabled=false;
}

async function autoScan(){
  try{
    const data=await fetchJSON(`/api/assets/${currentSymbol}/confluence`);
    if(data&&data.finalScore!==undefined){showNoTrade({confluence:data,analysis:data.reason||`${currentSymbol}: Score ${Math.round(data.finalScore*100)}%`,strategy:data.strategy});renderAnalysis(data);}
  }catch(e){}
}

function showActiveSignal(sig,res){
  document.getElementById('noTradePanel').classList.add('hidden');
  document.getElementById('activeSignalPanel').classList.remove('hidden');
  const card=document.getElementById('signalCardPrimary');
  const dir=sig.direction||'LONG';const isBuy=dir==='LONG';
  card.className=`card signal-card-primary ${isBuy?'long':'short'}`;
  const de=document.getElementById('sigDir');de.textContent=isBuy?'BUY':'SELL';de.className=`signal-direction ${isBuy?'long':'short'}`;
  document.getElementById('sigStrategy').textContent=sig.strategy?.label||'Multi-factor';
  const tier=sig.tier||'B';const te=document.getElementById('sigTier');te.textContent=tier;
  te.className=`signal-tier-badge ${tier==='A+'?'tier-aplus':tier==='A'?'tier-a':'tier-b'}`;
  const score=Math.round((sig.finalScore||sig.confluence_score||0)*100);
  document.getElementById('sigScoreText').textContent=`${score}%`;
  const fill=document.getElementById('sigScoreFill');fill.style.width=`${score}%`;
  fill.style.background=score>75?'linear-gradient(90deg,#00C853,#4CAF50)':score>50?'linear-gradient(90deg,#FFC107,#FF9800)':'linear-gradient(90deg,#FF3D00,#D32F2F)';
  document.getElementById('sigEntry').textContent=`$${fmtN(sig.entry_price||sig.entry)}`;
  document.getElementById('sigSL').textContent=`$${fmtN(sig.sl_price||sig.sl)}`;
  document.getElementById('sigTP1').textContent=`$${fmtN(sig.tp1_price||sig.tp1)}`;
  document.getElementById('sigTP2').textContent=`$${fmtN(sig.tp2_price||sig.tp2)}`;
  document.getElementById('sigTP3').textContent=`$${fmtN(sig.tp3_price||sig.tp3)}`;
  document.getElementById('sigRR').textContent=sig.effectiveRR||'2.3';
  document.getElementById('sigRegime').textContent=sig.regime?.name||sig.regime||'—';
  document.getElementById('sigSession').textContent=sig.details?.sessionDetails?.name||'—';
  const dm=document.getElementById('sigDataMode');dm.textContent=sig.dataMode||'—';
  dm.className=`mc-tag ${sig.dataMode==='LIVE'?'data':'data-warn'}`;
  lastSignalData=sig;addSignalOverlay(sig);
  renderAnalysis(res?.confluence||sig);renderRisks(sig.risks||[]);
  if(sig.invalidationReason){document.getElementById('analysisInvalidation').classList.remove('hidden');document.getElementById('analysisInvalidationText').textContent=sig.invalidationReason;}
  document.getElementById('analysisSummary').textContent=sig.analysis||'Signal generated based on multi-factor confluence.';
  document.getElementById('confCard').classList.remove('hidden');
  renderConfBreakdown(res?.confluence||sig);
}

function showNoTrade(res){
  document.getElementById('activeSignalPanel').classList.add('hidden');
  document.getElementById('noTradePanel').classList.remove('hidden');
  const card=document.getElementById('signalCardPrimary');card.className='card signal-card-primary no-trade';
  const analysis=res?.analysis||res?.confluence?.reason||'Scanning market conditions...';
  document.getElementById('noTradeReason').textContent=analysis;
  const wf=document.getElementById('waitingFor');
  const blockers=res?.confluence?.blockers||res?.blockers||[];
  if(blockers.length>0){
    wf.innerHTML=`<h4>Conditions Needed</h4>${blockers.map(b=>`<div class="waiting-item"><span class="waiting-dot"></span>${b}</div>`).join('')}`;
  }else{wf.innerHTML='';}
  document.getElementById('analysisSummary').textContent=analysis;
  if(res?.confluence)renderAnalysis(res.confluence);
  clearSignalOverlay();document.getElementById('confCard').classList.add('hidden');
  document.getElementById('analysisRisksSection').classList.add('hidden');
  document.getElementById('analysisInvalidation').classList.add('hidden');
}

function renderAnalysis(data){
  if(!data)return;
  const cl=document.getElementById('analysisChecklist');const title=document.getElementById('analysisReasonsTitle');
  if(data.direction&&data.direction!=='NO_SIGNAL'){title.textContent='✅ Why This Signal';title.style.color='#00C853';}
  else{title.textContent='⛔ Why No Trade';title.style.color='#FF3D00';}
  if(data.checklist&&data.checklist.length>0){
    cl.innerHTML=data.checklist.map(c=>`<div class="check-row ${c.pass?'pass':'fail'}"><span><span class="check-icon">${c.pass?'✓':'✗'}</span><span class="check-name">${c.system}</span></span><span class="check-val">${c.value}</span></div>`).join('');
  }else{cl.innerHTML='<div class="check-row"><span class="check-name">Waiting for data...</span></div>';}
}

function renderRisks(risks){
  const section=document.getElementById('analysisRisksSection');const list=document.getElementById('analysisRisks');
  if(risks&&risks.length>0){section.classList.remove('hidden');list.innerHTML=risks.map(r=>`<li>${r}</li>`).join('');}
  else{section.classList.add('hidden');}
}

function renderConfBreakdown(data){
  if(!data||!data.scores)return;const grid=document.getElementById('confGrid');
  const cats=[
    {label:'Smart Money (SMC)',score:data.scores.smc||0.5,max:15},
    {label:'Multi-TF Trend',score:data.scores.mtf||0.5,max:15},
    {label:'Market Regime',score:data.regime?.confidence||0.5,max:15},
    {label:'Volume',score:data.scores.volume||0.5,max:10},
    {label:'Momentum',score:data.scores.momentum||0.5,max:10},
    {label:'Key Levels',score:data.scores.keyLevel||0.5,max:10},
    {label:'Data Quality',score:data.dataQuality?.grade?({'A':1,'B':0.8,'C':0.6,'D':0.4}[data.dataQuality.grade]||0.5):0.5,max:10},
    {label:'Session Quality',score:data.details?.sessionDetails?.multiplier||0.8,max:5},
  ];
  grid.innerHTML=cats.map(c=>{
    const pct=Math.round(c.score*100);const pts=Math.round(c.score*c.max);
    const color=pct>60?'#00C853':pct<40?'#FF3D00':'#FFC107';
    return `<div class="conf-row"><span class="conf-label">${c.label}</span><div class="conf-bar"><div class="conf-fill" style="width:${pct}%;background:${color}"></div></div><span class="conf-score" style="color:${color}">${pts}/${c.max}</span></div>`;
  }).join('');
}

function copyTradePlan(){
  if(!lastSignalData)return;const s=lastSignalData;
  const text=`${currentSymbol} ${s.direction==='LONG'?'BUY':'SELL'}\nEntry: $${fmtN(s.entry_price||s.entry)}\nSL: $${fmtN(s.sl_price||s.sl)}\nTP1: $${fmtN(s.tp1_price||s.tp1)}\nTP2: $${fmtN(s.tp2_price||s.tp2)}\nTP3: $${fmtN(s.tp3_price||s.tp3)}\nR:R: ${s.effectiveRR||'2.3'}\nTier: ${s.tier||'B'} | Score: ${Math.round((s.finalScore||0)*100)}%\nStrategy: ${s.strategy?.label||'Multi-factor'}\n—NEXUS Signal Platform`;
  navigator.clipboard.writeText(text).then(()=>alert('Trade plan copied!')).catch(()=>{});
}

async function loadLiveSignals(){
  try{
    const signals=await fetchJSON('/api/signals/live');document.getElementById('liveCount').textContent=signals.length;
    const body=document.getElementById('liveBody');
    if(!signals.length){body.innerHTML='<tr><td colspan="10" class="empty">No active signals — system scans every 5 minutes</td></tr>';return;}
    body.innerHTML=signals.map(s=>{
      const dir=s.direction==='LONG'?'<td class="green">LONG</td>':'<td class="red">SHORT</td>';
      const cb=s.confluence_breakdown;const strat=cb?.strategy?.label||'—';
      return `<tr><td>${s.asset_symbol}</td>${dir}<td class="gold">${s.tier}</td><td>${strat}</td><td>$${fmtN(s.entry_price)}</td><td class="red">$${fmtN(s.sl_price)}</td><td class="green">$${fmtN(s.tp2_price)}</td><td>${(s.confluence_score*100).toFixed(0)}%</td><td>${s.status}</td><td>${fmtT(s.created_at)}</td></tr>`;
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
      return `<tr><td>${fmtT(s.closed_at)}</td><td>${s.asset_symbol}</td><td class="${s.direction==='LONG'?'green':'red'}">${s.direction}</td><td class="gold">${s.tier}</td><td>$${fmtN(s.entry_price)}</td><td>$${fmtN(s.exit_price||s.sl_price)}</td><td class="${rc}">${s.status}</td><td class="${(s.outcome_r||0)>=0?'green':'red'}">${s.outcome_r?s.outcome_r.toFixed(1)+'R':'—'}</td></tr>`;
    }).join('');
  }catch(e){}
}

async function loadBacktestResults(){
  try{
    const data=await fetchJSON('/api/backtest');
    const st=document.getElementById('btStatus');st.textContent=data.status==='done'?'Validated':data.status;st.className=`badge ${data.status==='done'?'badge-verified':'badge-warning'}`;
    const body=document.getElementById('btBody');const rows=[];let bestMC=null;let bestWR=0,bestPF=0,bestR=0,bestSh=0,bestSo=0,worstDD=0;
    for(const[sym,tfs]of Object.entries(data.results||{})){
      for(const[tf,r]of Object.entries(tfs)){
        if(r.error){rows.push(`<tr><td>${sym}</td><td>${tf.toUpperCase()}</td><td colspan="9" class="red">${r.error}</td></tr>`);continue;}
        const src=r.dataSource==='DEMO'?'<span class="src-demo">DEMO</span>':`<span class="src-live">${r.dataSource||'LIVE'}</span>`;
        const st=r.isValid?'✅ VALID':r.totalTrades<50?'⚠️ LOW N':'⚠️';
        rows.push(`<tr><td>${sym}</td><td>${tf.toUpperCase()}</td><td>${r.totalTrades}</td><td class="${r.winRate>=55?'green':'red'}">${r.winRate}%</td><td class="${r.profitFactor>=1.4?'green':'red'}">${r.profitFactor}</td><td>${r.sharpe}</td><td>${r.sortino||'—'}</td><td>${r.maxDrawdown}%</td><td class="${r.totalR>=0?'green':'red'}">${r.totalR}R</td><td>${src}</td><td class="${r.isValid?'green':'red'}">${st}</td></tr>`);
        if(r.winRate>bestWR)bestWR=r.winRate;if(r.profitFactor>bestPF&&r.profitFactor<999)bestPF=r.profitFactor;
        if(r.totalR>bestR)bestR=r.totalR;if(r.sharpe>bestSh)bestSh=r.sharpe;if(r.sortino>bestSo)bestSo=r.sortino;if(r.maxDrawdown>worstDD)worstDD=r.maxDrawdown;
        if(r.monteCarlo&&(!bestMC||r.totalTrades>bestMC.trades))bestMC={mc:r.monteCarlo,eq:r.equityCurve,trades:r.totalTrades};
      }
    }
    body.innerHTML=rows.join('')||'<tr><td colspan="11" class="empty">No results</td></tr>';
    const wrE=document.getElementById('statWR');wrE.textContent=`${bestWR}%`;wrE.className=`stat-value ${bestWR>=55?'green':'red'}`;
    const pfE=document.getElementById('statPF');pfE.textContent=bestPF.toFixed(2);pfE.className=`stat-value ${bestPF>=1.4?'green':'red'}`;
    document.getElementById('statTotalR').textContent=`${bestR}R`;
    const ddE=document.getElementById('statDD');ddE.textContent=`${worstDD}%`;ddE.className=`stat-value ${worstDD<=20?'green':'red'}`;
    document.getElementById('statSharpe').textContent=bestSh.toFixed(2);
    document.getElementById('statSortino').textContent=bestSo.toFixed?bestSo.toFixed(2):'—';
    if(bestMC)renderMonteCarlo(bestMC);
  }catch(e){}
}

function renderMonteCarlo(data){
  const{mc,eq}=data;if(!mc)return;
  document.getElementById('mcGrid').innerHTML=[
    {label:'5th PERCENTILE',value:`$${mc.percentile5?.equity}`,color:'#FF3D00'},
    {label:'MEDIAN',value:`$${mc.median?.equity}`,color:'#FFC107'},
    {label:'95th PERCENTILE',value:`$${mc.percentile95?.equity}`,color:'#00C853'},
    {label:'PROFITABLE SIMS',value:`${mc.profitableSims}%`,color:mc.profitableSims>50?'#00C853':'#FF3D00'},
  ].map(i=>`<div class="mc-card"><div class="label">${i.label}</div><div class="value" style="color:${i.color}">${i.value}</div></div>`).join('');
  if(eq&&eq.length>5){
    const c2=LightweightCharts.createChart(document.getElementById('equityChart'),{
      layout:{background:{color:'#0B0F14'},textColor:'#64748B',fontFamily:"'IBM Plex Mono',monospace",fontSize:10},
      grid:{vertLines:{color:'#1a1f2e'},horzLines:{color:'#1a1f2e'}},rightPriceScale:{borderColor:'#1F2937'},timeScale:{borderColor:'#1F2937',timeVisible:true}
    });
    c2.addLineSeries({color:'#2196F3',lineWidth:2}).setData(eq.map(e=>({time:e.time,value:e.equity})));c2.timeScale().fitContent();
  }
}

async function loadPaperTrading(){
  try{
    const pt=await fetchJSON('/api/paper-trading');
    document.getElementById('ptEquity').textContent=`$${fmtN(pt.equity)}`;
    const pnlE=document.getElementById('ptPnL');pnlE.textContent=`$${pt.pnl>=0?'+':''}${fmtN(pt.pnl)}`;pnlE.style.color=pt.pnl>=0?'#00C853':'#FF3D00';
    const retE=document.getElementById('ptReturn');retE.textContent=`${pt.pnlPercent>=0?'+':''}${pt.pnlPercent}%`;retE.style.color=pt.pnlPercent>=0?'#00C853':'#FF3D00';
    document.getElementById('ptWR').textContent=pt.winRate?`${pt.winRate}%`:'—';
    document.getElementById('ptTotalR').textContent=`${pt.totalR}R`;
    document.getElementById('ptWL').textContent=`${pt.wins}/${pt.losses}`;
    document.getElementById('ptActive').textContent=pt.activeCount;
    const ab=document.getElementById('ptActiveBody');
    if(!pt.activeTrades||!pt.activeTrades.length){ab.innerHTML='<tr><td colspan="10" class="empty">No active paper trades</td></tr>';}
    else{ab.innerHTML=pt.activeTrades.map(t=>{
      const dc=t.direction==='LONG'?'green':'red';const pc=t.unrealizedPnL>=0?'green':'red';
      return `<tr><td>#${t.id}</td><td>${t.symbol}</td><td class="${dc}">${t.direction}</td><td>$${fmtN(t.entryPrice)}</td><td>$${fmtN(t.currentPrice)}</td><td class="red">$${fmtN(t.slPrice)}</td><td>$${fmtN(t.tp1Price)}</td><td>${t.status}</td><td class="${pc}">$${fmtN(t.unrealizedPnL)}</td><td class="${pc}">${t.unrealizedR}R</td></tr>`;
    }).join('');}
    const tog=document.getElementById('ptToggle');
    if(pt.enabled){tog.textContent='● LIVE';tog.className='btn btn-success btn-sm';}
    else{tog.textContent='○ OFF';tog.className='btn btn-secondary btn-sm';}
  }catch(e){}
}

function togglePT(){const t=document.getElementById('ptToggle');const en=t.textContent.includes('OFF');fetchJSON('/api/paper-trading/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:en})}).then(loadPaperTrading).catch(()=>{});}
function closeAllPT(){fetchJSON('/api/paper-trading/close-all',{method:'POST'}).then(loadPaperTrading).catch(()=>{});}
function resetPT(){if(!confirm('Reset all paper trading data?'))return;fetchJSON('/api/paper-trading/reset',{method:'POST'}).then(loadPaperTrading).catch(()=>{});}

function startClock(){setInterval(()=>{const n=new Date();document.getElementById('clock').textContent=`${String(n.getUTCHours()).padStart(2,'0')}:${String(n.getUTCMinutes()).padStart(2,'0')}:${String(n.getUTCSeconds()).padStart(2,'0')} UTC`;},1000);}

async function fetchJSON(url,opts){const r=await fetch(API+url,opts);if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
function fmtN(n){if(n==null||isNaN(n))return'—';return Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function fmtT(t){if(!t)return'—';const d=new Date(t);return d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false})+' '+d.toLocaleDateString('en-US',{month:'short',day:'numeric'});}
