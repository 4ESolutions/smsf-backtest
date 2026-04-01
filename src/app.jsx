import { useState, useCallback, useRef } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend
} from "recharts";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const CORS_PROXY = "https://corsproxy.io/?";
const YF_BASE    = "https://query1.finance.yahoo.com/v8/finance/chart/";
const PERIOD1    = Math.floor(new Date("2009-01-01").getTime() / 1000);
const PERIOD2    = Math.floor(Date.now() / 1000);

const PRESET_PORTFOLIO = [
  { ticker:"VAS.AX",  name:"Vanguard AU Shares",        weight:12, color:"#22c55e" },
  { ticker:"AQLT.AX", name:"Betashares AU Quality",      weight:6,  color:"#16a34a" },
  { ticker:"MVB.AX",  name:"VanEck AU Banks",            weight:5,  color:"#15803d" },
  { ticker:"IVV.AX",  name:"iShares S&P 500",            weight:10, color:"#3b82f6" },
  { ticker:"IOO.AX",  name:"iShares Global 100",         weight:7,  color:"#2563eb" },
  { ticker:"QUAL.AX", name:"VanEck MSCI Quality",        weight:5,  color:"#1d4ed8" },
  { ticker:"NDQ.AX",  name:"Betashares Nasdaq 100",      weight:5,  color:"#a855f7" },
  { ticker:"SEMI.AX", name:"Global X Semiconductors",    weight:4,  color:"#7c3aed" },
  { ticker:"HACK.AX", name:"Betashares Cybersecurity",   weight:3,  color:"#6d28d9" },
  { ticker:"GMG.AX",  name:"Goodman Group",              weight:4,  color:"#f97316" },
  { ticker:"VAP.AX",  name:"Vanguard AU Property",       weight:3,  color:"#ea580c" },
  { ticker:"IAF.AX",  name:"iShares Core Bonds",         weight:6,  color:"#eab308" },
  { ticker:"VAF.AX",  name:"Vanguard AU Fixed Interest",  weight:4,  color:"#ca8a04" },
  { ticker:"ARMR.AX", name:"Betashares Global Defence",  weight:2,  color:"#ef4444" },
  { ticker:"GOLD.AX", name:"Perth Mint Gold ETF",        weight:2,  color:"#f59e0b" },
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmtMoney = v => v == null ? "—" : v >= 1e6
  ? `$${(v/1e6).toFixed(2)}M`
  : `$${Math.round(v).toLocaleString()}`;

const fmtPct = v => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function calcCAGR(start, end, years) {
  if (!start || !end || years <= 0) return null;
  return ((Math.pow(end / start, 1 / years) - 1) * 100);
}

function calcMaxDrawdown(values) {
  let peak = -Infinity, maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// Convert raw Yahoo monthly closes → { year: annualReturn% }
function buildAnnualReturns(timestamps, closes) {
  const monthly = {};
  timestamps.forEach((ts, i) => {
    if (closes[i] == null) return;
    const d = new Date(ts * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    monthly[key] = closes[i];
  });

  const annual = {};
  const years = [...new Set(Object.keys(monthly).map(k => k.split("-")[0]))].sort();
  years.forEach(yr => {
    const janKey = `${yr}-01`, decKey = `${yr}-12`;
    // Use first available month close of year and last available
    const yearKeys = Object.keys(monthly).filter(k => k.startsWith(yr)).sort();
    if (yearKeys.length < 2) return;
    const startClose = monthly[yearKeys[0]];
    const endClose   = monthly[yearKeys[yearKeys.length - 1]];
    if (startClose && endClose && startClose !== 0) {
      annual[parseInt(yr)] = ((endClose - startClose) / startClose) * 100;
    }
  });
  return annual;
}

// ─── FETCH ONE TICKER ─────────────────────────────────────────────────────────
async function fetchTickerData(ticker) {
  const url = `${CORS_PROXY}${encodeURIComponent(
    `${YF_BASE}${ticker}?period1=${PERIOD1}&period2=${PERIOD2}&interval=1mo&events=history&includeAdjustedClose=true`
  )}`;

  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No data returned");

  const timestamps = result.timestamp || [];
  const closes     = result.indicators?.adjclose?.[0]?.adjclose
                  ?? result.indicators?.quote?.[0]?.close
                  ?? [];
  const meta       = result.meta || {};

  const annualReturns = buildAnnualReturns(timestamps, closes);
  const name          = meta.longName || meta.shortName || ticker;
  const currency      = meta.currency || "AUD";
  const currentPrice  = meta.regularMarketPrice || closes[closes.length - 1];
  const inception     = timestamps.length
    ? new Date(timestamps[0] * 1000).getFullYear()
    : null;

  return { ticker, name, currency, currentPrice, inception, annualReturns, closes, timestamps };
}

// ─── BACKTEST ENGINE ──────────────────────────────────────────────────────────
function runBacktest(holdings, startBalance, annualContrib) {
  // Gather all years with data
  const allYears = new Set();
  holdings.forEach(h => Object.keys(h.data.annualReturns).forEach(y => allYears.add(parseInt(y))));
  const years = [...allYears].sort();

  let balance = startBalance;
  const growthData = [{ year: "Start", balance, portfolioReturn: null }];
  const annualData = [];

  years.forEach(yr => {
    // Weighted portfolio return — only include holdings that have data for this year
    let weightedReturn = 0, totalWeight = 0;
    holdings.forEach(h => {
      const ret = h.data.annualReturns[yr];
      if (ret != null && !isNaN(ret)) {
        weightedReturn += ret * h.weight;
        totalWeight    += h.weight;
      }
    });
    if (totalWeight === 0) return; // skip year if no data

    // Normalise to full portfolio weight (handles missing ETFs)
    const totalPortfolioWeight = holdings.reduce((s, h) => s + h.weight, 0);
    const portReturn = (weightedReturn / totalWeight) * (totalPortfolioWeight / 100);

    balance = balance * (1 + portReturn / 100) + annualContrib;
    growthData.push({ year: yr, balance: Math.round(balance), portfolioReturn: parseFloat(portReturn.toFixed(2)) });
    annualData.push({ year: yr, return: parseFloat(portReturn.toFixed(2)) });
  });

  const numYears = years.length;
  const cagr = calcCAGR(startBalance, balance, numYears);
  const maxDD = calcMaxDrawdown(growthData.map(d => d.balance));
  const returns = annualData.map(d => d.return);
  const positiveYears = returns.filter(r => r > 0).length;
  const avgReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const bestYear  = Math.max(...returns);
  const worstYear = Math.min(...returns);

  return { growthData, annualData, years, cagr, maxDD, positiveYears, avgReturn, bestYear, worstYear, finalBalance: balance };
}

// ─── CUSTOM TOOLTIP ───────────────────────────────────────────────────────────
const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:8, padding:"10px 14px", fontSize:12 }}>
      <div style={{ color:"#60a5fa", fontWeight:700, marginBottom:4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || "#e2e8f0", marginBottom:2 }}>
          {p.name}: {typeof p.value === "number"
            ? (p.name?.includes("Balance") || p.name?.includes("Value") ? fmtMoney(p.value) : fmtPct(p.value))
            : p.value}
        </div>
      ))}
    </div>
  );
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function SMSFDynamicBacktest() {
  const [holdings, setHoldings] = useState(
    PRESET_PORTFOLIO.map(p => ({ ...p, weight: p.weight, data: null, status: "idle", error: null }))
  );
  const [newTicker, setNewTicker]   = useState("");
  const [newWeight, setNewWeight]   = useState(5);
  const [startBalance, setStartBalance] = useState(220000);
  const [annualContrib, setAnnualContrib] = useState(24000);
  const [loading, setLoading]       = useState(false);
  const [backtestRun, setBacktestRun] = useState(false);
  const [result, setResult]         = useState(null);
  const [activeTab, setActiveTab]   = useState("growth");
  const [fetchLog, setFetchLog]     = useState([]);
  const abortRef = useRef(null);

  const log = msg => setFetchLog(prev => [...prev.slice(-30), msg]);

  // ── Load all tickers ────────────────────────────────────────────────────────
  const runFetch = useCallback(async () => {
    setLoading(true);
    setBacktestRun(false);
    setResult(null);
    setFetchLog([]);
    const controller = new AbortController();
    abortRef.current = controller;

    const updated = [...holdings];

    for (let i = 0; i < updated.length; i++) {
      if (controller.signal.aborted) break;
      const h = updated[i];
      updated[i] = { ...h, status: "loading", error: null };
      setHoldings([...updated]);

      log(`⏳ Fetching ${h.ticker}…`);
      try {
        const data = await fetchTickerData(h.ticker);
        updated[i] = { ...updated[i], data, status: "ok" };
        const yrs = Object.keys(data.annualReturns).length;
        log(`✅ ${h.ticker} — ${yrs} years of data (inception ${data.inception})`);
      } catch (e) {
        updated[i] = { ...updated[i], status: "error", error: e.message };
        log(`❌ ${h.ticker} — ${e.message}`);
      }
      setHoldings([...updated]);
      await new Promise(r => setTimeout(r, 300)); // rate-limit
    }

    setLoading(false);
    log("✔ Fetch complete. Running backtest…");

    // Auto-run backtest
    const loaded = updated.filter(h => h.status === "ok");
    if (loaded.length) {
      const res = runBacktest(loaded, startBalance, annualContrib);
      setResult(res);
      setBacktestRun(true);
      log(`📊 Backtest complete — ${loaded.length}/${updated.length} tickers used.`);
    }
  }, [holdings, startBalance, annualContrib]);

  // ── Add ticker ──────────────────────────────────────────────────────────────
  const addTicker = () => {
    const t = newTicker.trim().toUpperCase();
    if (!t) return;
    if (holdings.find(h => h.ticker === t)) {
      alert("Ticker already in list"); return;
    }
    const COLORS = ["#06b6d4","#84cc16","#f43f5e","#fb923c","#a78bfa","#34d399","#38bdf8"];
    setHoldings(prev => [...prev, {
      ticker: t, name: t, weight: newWeight,
      color: COLORS[prev.length % COLORS.length],
      data: null, status: "idle", error: null
    }]);
    setNewTicker("");
  };

  const removeTicker = t => setHoldings(prev => prev.filter(h => h.ticker !== t));

  const updateWeight = (ticker, val) =>
    setHoldings(prev => prev.map(h => h.ticker === ticker ? { ...h, weight: parseFloat(val) || 0 } : h));

  const totalWeight = holdings.reduce((s, h) => s + (parseFloat(h.weight) || 0), 0);

  // ── Rerun backtest with current loaded data ─────────────────────────────────
  const reRunBacktest = () => {
    const loaded = holdings.filter(h => h.status === "ok");
    if (!loaded.length) return;
    const res = runBacktest(loaded, startBalance, annualContrib);
    setResult(res);
    setBacktestRun(true);
  };

  // ── Per-ticker table data ───────────────────────────────────────────────────
  const tickerTableRows = holdings.map(h => {
    if (!h.data) return { ...h, cagr: null, avg: null, best: null, worst: null, years: 0 };
    const rets = Object.values(h.data.annualReturns).filter(r => r != null && !isNaN(r));
    if (!rets.length) return { ...h, cagr: null, avg: null, best: null, worst: null, years: 0 };
    let bal = 10000;
    rets.forEach(r => bal *= (1 + r/100));
    return {
      ...h,
      cagr: ((Math.pow(bal/10000, 1/rets.length) - 1)*100).toFixed(1),
      avg: (rets.reduce((a,b)=>a+b,0)/rets.length).toFixed(1),
      best: Math.max(...rets).toFixed(1),
      worst: Math.min(...rets).toFixed(1),
      years: rets.length
    };
  });

  const allYearsForTable = result?.years || [];

  // ── Status badge ────────────────────────────────────────────────────────────
  const StatusBadge = ({ status }) => {
    const cfg = {
      idle:    { bg:"#1e293b", color:"#64748b", label:"PENDING" },
      loading: { bg:"#1e3a5f", color:"#60a5fa", label:"LOADING…" },
      ok:      { bg:"#14532d", color:"#4ade80", label:"LOADED" },
      error:   { bg:"#450a0a", color:"#f87171", label:"ERROR" },
    }[status] || {};
    return (
      <span style={{ background:cfg.bg, color:cfg.color, fontSize:10, padding:"2px 7px",
        borderRadius:4, fontWeight:700, letterSpacing:0.5 }}>
        {cfg.label}
      </span>
    );
  };

  const tabs = [
    { id:"growth",  label:"📈 Growth Curve" },
    { id:"annual",  label:"📊 Annual Returns" },
    { id:"tickers", label:"📋 Per-Ticker Stats" },
    { id:"table",   label:"🗂 Full Table" },
  ];

  return (
    <div style={{ fontFamily:"'DM Mono','Courier New',monospace", background:"#050e1c", minHeight:"100vh", color:"#e2e8f0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        input{background:#0a1628;border:1px solid #1e3a5f;color:#e2e8f0;border-radius:6px;padding:8px 12px;font-family:inherit;font-size:12px;outline:none}
        input:focus{border-color:#3b82f6}
        button{cursor:pointer;font-family:inherit}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:#050e1c}
        ::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:3px}
        .tab-btn{background:transparent;border:1px solid #1e3a5f;color:#64748b;padding:8px 16px;border-radius:6px;font-size:12px;transition:all .2s}
        .tab-btn.active{background:#1e3a5f;color:#60a5fa;border-color:#3b82f6}
        .tab-btn:hover:not(.active){border-color:#334155;color:#cbd5e1}
        .card{background:#0a1628;border:1px solid #1e3a5f;border-radius:10px}
        .pos{color:#4ade80} .neg{color:#f87171} .dim{color:#334155}
        table{width:100%;border-collapse:collapse;font-size:11px}
        th{background:#070f1e;color:#60a5fa;padding:9px 10px;text-align:left;border-bottom:1px solid #1e3a5f;white-space:nowrap;position:sticky;top:0;z-index:1}
        td{padding:7px 10px;border-bottom:1px solid #0d1f3b;white-space:nowrap}
        tr:hover td{background:#0d1e36}
        .pulse{animation:pulse 1.5s ease-in-out infinite}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
      `}</style>

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <div style={{ background:"linear-gradient(135deg,#050e1c 0%,#0d1f3b 60%,#050e1c 100%)",
        borderBottom:"1px solid #1e3a5f", padding:"24px 28px 20px" }}>
        <div style={{ fontFamily:"Syne,sans-serif", fontSize:26, fontWeight:800, color:"#f8fafc", letterSpacing:-0.5 }}>
          SMSF Dynamic Backtest
        </div>
        <div style={{ color:"#475569", fontSize:11, marginTop:3 }}>
          Live data via Yahoo Finance · Add any ASX / global ticker · Weighted portfolio backtest
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"320px 1fr", gap:0, minHeight:"calc(100vh - 68px)" }}>

        {/* ── LEFT PANEL ───────────────────────────────────────────────────── */}
        <div style={{ borderRight:"1px solid #1e3a5f", padding:20, display:"flex", flexDirection:"column", gap:16, overflowY:"auto" }}>

          {/* Portfolio Settings */}
          <div className="card" style={{ padding:16 }}>
            <div style={{ fontFamily:"Syne,sans-serif", fontSize:13, fontWeight:700, color:"#f1f5f9", marginBottom:12 }}>
              ⚙️ Settings
            </div>
            <div style={{ display:"grid", gap:10 }}>
              <div>
                <div style={{ color:"#64748b", fontSize:10, marginBottom:4 }}>Starting Balance (AUD)</div>
                <input type="number" value={startBalance} onChange={e=>setStartBalance(+e.target.value)} style={{ width:"100%" }} />
              </div>
              <div>
                <div style={{ color:"#64748b", fontSize:10, marginBottom:4 }}>Annual Contributions (AUD)</div>
                <input type="number" value={annualContrib} onChange={e=>setAnnualContrib(+e.target.value)} style={{ width:"100%" }} />
              </div>
            </div>
          </div>

          {/* Add Ticker */}
          <div className="card" style={{ padding:16 }}>
            <div style={{ fontFamily:"Syne,sans-serif", fontSize:13, fontWeight:700, color:"#f1f5f9", marginBottom:12 }}>
              ➕ Add Ticker
            </div>
            <div style={{ display:"flex", gap:8, marginBottom:8 }}>
              <input placeholder="e.g. VAS.AX" value={newTicker} onChange={e=>setNewTicker(e.target.value)}
                onKeyDown={e=>e.key==="Enter" && addTicker()} style={{ flex:1 }} />
              <input type="number" value={newWeight} onChange={e=>setNewWeight(+e.target.value)}
                style={{ width:60 }} placeholder="Wt%" />
            </div>
            <button onClick={addTicker} style={{ width:"100%", background:"#1e3a5f", color:"#60a5fa",
              border:"1px solid #2563eb", borderRadius:6, padding:"8px 0", fontSize:12 }}>
              Add to Portfolio
            </button>
            <div style={{ color:"#475569", fontSize:10, marginTop:8 }}>
              ASX: VAS.AX · US: AAPL · Global: ^GSPC
            </div>
          </div>

          {/* Holdings List */}
          <div className="card" style={{ padding:16, flex:1 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <div style={{ fontFamily:"Syne,sans-serif", fontSize:13, fontWeight:700, color:"#f1f5f9" }}>
                📂 Holdings ({holdings.length})
              </div>
              <div style={{ fontSize:10, color: Math.abs(totalWeight-100)<0.01?"#4ade80":"#fb923c" }}>
                {totalWeight.toFixed(1)}% total
              </div>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {holdings.map(h => (
                <div key={h.ticker} style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:h.color, flexShrink:0 }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:11, color:"#e2e8f0", fontWeight:500 }}>{h.ticker}</div>
                    <div style={{ fontSize:9, color:"#475569", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {h.data?.name || h.name}
                    </div>
                  </div>
                  <StatusBadge status={h.status} />
                  <input type="number" value={h.weight} onChange={e=>updateWeight(h.ticker, e.target.value)}
                    style={{ width:44, textAlign:"center", padding:"4px 6px" }} />
                  <button onClick={()=>removeTicker(h.ticker)}
                    style={{ background:"transparent", border:"none", color:"#475569", fontSize:14, padding:0 }}>×</button>
                </div>
              ))}
            </div>
          </div>

          {/* Fetch & Run */}
          <button onClick={runFetch} disabled={loading}
            style={{ padding:"12px 0", borderRadius:8, border:"none", fontSize:13, fontFamily:"Syne,sans-serif", fontWeight:700,
              background: loading ? "#1e3a5f" : "linear-gradient(135deg,#2563eb,#7c3aed)",
              color: loading ? "#64748b" : "#fff", transition:"all .2s", letterSpacing:0.3 }}>
            {loading ? "⏳ Fetching Data…" : "🚀 Fetch & Run Backtest"}
          </button>

          {backtestRun && !loading && (
            <button onClick={reRunBacktest}
              style={{ padding:"10px 0", borderRadius:8, border:"1px solid #1e3a5f", fontSize:12,
                background:"transparent", color:"#60a5fa" }}>
              ↻ Rerun with Updated Weights
            </button>
          )}

          {/* Fetch Log */}
          {fetchLog.length > 0 && (
            <div className="card" style={{ padding:12, maxHeight:200, overflowY:"auto" }}>
              <div style={{ fontFamily:"Syne,sans-serif", fontSize:11, fontWeight:700, color:"#60a5fa", marginBottom:8 }}>
                Fetch Log
              </div>
              {fetchLog.map((l, i) => (
                <div key={i} style={{ fontSize:10, color:"#94a3b8", lineHeight:1.6 }}>{l}</div>
              ))}
            </div>
          )}
        </div>

        {/* ── RIGHT PANEL ──────────────────────────────────────────────────── */}
        <div style={{ padding:20, overflowY:"auto" }}>

          {!backtestRun && !loading && (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
              height:"60vh", color:"#334155", textAlign:"center", gap:12 }}>
              <div style={{ fontSize:48 }}>📊</div>
              <div style={{ fontFamily:"Syne,sans-serif", fontSize:20, fontWeight:700, color:"#1e3a5f" }}>
                Configure & Fetch to Begin
              </div>
              <div style={{ fontSize:12, maxWidth:400, lineHeight:1.6 }}>
                Add tickers, set weights and initial balance, then click{" "}
                <span style={{ color:"#3b82f6" }}>Fetch & Run Backtest</span> to pull
                live Yahoo Finance data and compute your portfolio's historical performance.
              </div>
            </div>
          )}

          {loading && (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
              height:"60vh", gap:12 }}>
              <div style={{ fontSize:40 }} className="pulse">⚡</div>
              <div style={{ fontFamily:"Syne,sans-serif", fontSize:18, fontWeight:700, color:"#60a5fa" }}>
                Fetching Live Data…
              </div>
              <div style={{ fontSize:12, color:"#475569" }}>
                Pulling monthly price history from Yahoo Finance for each ticker
              </div>
              <div style={{ width:300, background:"#0a1628", borderRadius:6, height:6, overflow:"hidden" }}>
                <div style={{ height:"100%", background:"linear-gradient(90deg,#2563eb,#7c3aed)",
                  width:`${(holdings.filter(h=>h.status==="ok"||h.status==="error").length/holdings.length)*100}%`,
                  transition:"width .3s" }} />
              </div>
              <div style={{ fontSize:11, color:"#64748b" }}>
                {holdings.filter(h=>h.status==="ok").length} / {holdings.length} loaded
              </div>
            </div>
          )}

          {backtestRun && result && !loading && (
            <>
              {/* KPIs */}
              <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:12, marginBottom:20 }}>
                {[
                  { label:"Final Balance",   val: fmtMoney(result.finalBalance),       accent:"#4ade80" },
                  { label:"CAGR",            val: result.cagr ? fmtPct(result.cagr) : "—",
                    accent: result.cagr >= 10 ? "#4ade80" : "#fb923c" },
                  { label:"Max Drawdown",    val: `-${result.maxDD.toFixed(1)}%`,      accent:"#f87171" },
                  { label:"Positive Years",  val: `${result.positiveYears}/${result.years.length}`, accent:"#60a5fa" },
                  { label:"Avg Annual",      val: fmtPct(result.avgReturn),            accent:"#a78bfa" },
                ].map((k,i) => (
                  <div key={i} className="card" style={{ padding:"14px 16px" }}>
                    <div style={{ color:"#475569", fontSize:9, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{k.label}</div>
                    <div style={{ fontSize:18, fontFamily:"Syne,sans-serif", fontWeight:700, color:k.accent }}>{k.val}</div>
                  </div>
                ))}
              </div>

              {/* Tabs */}
              <div style={{ display:"flex", gap:8, marginBottom:16 }}>
                {tabs.map(t => (
                  <button key={t.id} className={`tab-btn${activeTab===t.id?" active":""}`}
                    onClick={()=>setActiveTab(t.id)}>{t.label}</button>
                ))}
              </div>

              {/* ── GROWTH CURVE ──────────────────────────────────────────── */}
              {activeTab==="growth" && (
                <div className="card" style={{ padding:24 }}>
                  <div style={{ fontFamily:"Syne,sans-serif", fontSize:15, fontWeight:700, color:"#f1f5f9", marginBottom:4 }}>
                    Portfolio Value Over Time
                  </div>
                  <div style={{ color:"#475569", fontSize:11, marginBottom:20 }}>
                    {fmtMoney(startBalance)} initial + {fmtMoney(annualContrib)}/yr contributions, annual rebalance
                  </div>
                  <ResponsiveContainer width="100%" height={320}>
                    <LineChart data={result.growthData} margin={{top:5,right:20,left:10,bottom:5}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" />
                      <XAxis dataKey="year" stroke="#475569" tick={{fill:"#64748b",fontSize:11}} />
                      <YAxis stroke="#475569" tick={{fill:"#64748b",fontSize:11}} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} />
                      <Tooltip content={<ChartTooltip />} />
                      <ReferenceLine y={startBalance} stroke="#334155" strokeDasharray="4 4" />
                      <Line type="monotone" dataKey="balance" name="Portfolio Value"
                        stroke="#3b82f6" strokeWidth={2.5} dot={{fill:"#3b82f6",r:3}} />
                    </LineChart>
                  </ResponsiveContainer>

                  {/* 10% benchmark comparison */}
                  <div style={{ marginTop:20, display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12 }}>
                    {(() => {
                      const nYrs = result.years.length;
                      const bench = startBalance * Math.pow(1.10, nYrs) + annualContrib * (Math.pow(1.10,nYrs)-1)/0.10;
                      const diff  = result.finalBalance - bench;
                      return [
                        { label:"10% CAGR Benchmark", val: fmtMoney(bench), color:"#64748b" },
                        { label:"Your Portfolio",      val: fmtMoney(result.finalBalance), color:"#3b82f6" },
                        { label:"vs Benchmark",        val: `${diff>=0?"+":""}${fmtMoney(Math.abs(diff))}`, color: diff>=0?"#4ade80":"#f87171" },
                      ].map((s,i) => (
                        <div key={i} style={{ background:"#050e1c", border:"1px solid #1e3a5f", borderRadius:6, padding:"12px 14px" }}>
                          <div style={{ color:"#64748b", fontSize:10, marginBottom:4 }}>{s.label}</div>
                          <div style={{ color:s.color, fontSize:16, fontFamily:"Syne,sans-serif", fontWeight:700 }}>{s.val}</div>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              )}

              {/* ── ANNUAL RETURNS ────────────────────────────────────────── */}
              {activeTab==="annual" && (
                <div className="card" style={{ padding:24 }}>
                  <div style={{ fontFamily:"Syne,sans-serif", fontSize:15, fontWeight:700, color:"#f1f5f9", marginBottom:4 }}>
                    Weighted Portfolio Annual Returns
                  </div>
                  <div style={{ color:"#475569", fontSize:11, marginBottom:20 }}>
                    Best: <span className="pos">+{result.bestYear.toFixed(1)}%</span>&nbsp;&nbsp;
                    Worst: <span className="neg">{result.worstYear.toFixed(1)}%</span>&nbsp;&nbsp;
                    Average: <span style={{color:"#60a5fa"}}>{fmtPct(result.avgReturn)}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={result.annualData} margin={{top:5,right:20,left:10,bottom:5}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" />
                      <XAxis dataKey="year" stroke="#475569" tick={{fill:"#64748b",fontSize:11}} />
                      <YAxis stroke="#475569" tick={{fill:"#64748b",fontSize:11}} tickFormatter={v=>`${v}%`} />
                      <Tooltip content={<ChartTooltip />} />
                      <ReferenceLine y={0}  stroke="#475569" />
                      <ReferenceLine y={10} stroke="#22c55e" strokeDasharray="4 4"
                        label={{value:"10%",fill:"#22c55e",fontSize:10,position:"right"}} />
                      <Bar dataKey="return" name="Annual Return"
                        fill="#3b82f6" radius={[3,3,0,0]}
                        label={{ position:"top", fill:"#64748b", fontSize:9,
                          formatter: v => v ? `${v>0?"+":""}${v.toFixed(1)}%` : "" }} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* ── PER TICKER ────────────────────────────────────────────── */}
              {activeTab==="tickers" && (
                <div className="card" style={{ padding:0, overflow:"hidden" }}>
                  <div style={{ padding:"16px 20px", borderBottom:"1px solid #1e3a5f" }}>
                    <div style={{ fontFamily:"Syne,sans-serif", fontSize:15, fontWeight:700, color:"#f1f5f9" }}>
                      Per-Ticker Statistics
                    </div>
                    <div style={{ color:"#475569", fontSize:11, marginTop:2 }}>
                      CAGR calculated from inception-date actual returns (monthly adj. close)
                    </div>
                  </div>
                  <div style={{ overflowX:"auto" }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Ticker</th><th>Name</th><th>Status</th><th>Wt%</th>
                          <th>Inception</th><th>Yrs Data</th><th>CAGR</th>
                          <th>Avg/Yr</th><th>Best Yr</th><th>Worst Yr</th><th>Current</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tickerTableRows.map((h,i) => (
                          <tr key={i}>
                            <td style={{ color:h.color, fontWeight:600 }}>{h.ticker}</td>
                            <td style={{ color:"#94a3b8", maxWidth:160, overflow:"hidden", textOverflow:"ellipsis" }}>
                              {h.data?.name || h.name}
                            </td>
                            <td><StatusBadge status={h.status} /></td>
                            <td style={{ color:"#94a3b8" }}>{h.weight}%</td>
                            <td style={{ color:"#64748b" }}>{h.data?.inception || "—"}</td>
                            <td style={{ color:"#64748b" }}>{h.years || "—"}</td>
                            <td className={h.cagr != null ? (parseFloat(h.cagr)>=10?"pos":"") : "dim"}>
                              {h.cagr != null ? `${h.cagr}%` : "—"}
                            </td>
                            <td className={h.avg != null ? (parseFloat(h.avg)>=0?"pos":"neg") : "dim"}>
                              {h.avg != null ? fmtPct(parseFloat(h.avg)) : "—"}
                            </td>
                            <td className="pos">{h.best != null ? `+${h.best}%` : "—"}</td>
                            <td className={h.worst != null ? (parseFloat(h.worst)<0?"neg":"pos") : "dim"}>
                              {h.worst != null ? `${h.worst}%` : "—"}
                            </td>
                            <td style={{ color:"#60a5fa" }}>
                              {h.data?.currentPrice ? `$${h.data.currentPrice.toFixed(2)}` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── FULL YEAR TABLE ───────────────────────────────────────── */}
              {activeTab==="table" && (
                <div className="card" style={{ padding:0, overflow:"hidden" }}>
                  <div style={{ padding:"16px 20px", borderBottom:"1px solid #1e3a5f" }}>
                    <div style={{ fontFamily:"Syne,sans-serif", fontSize:15, fontWeight:700, color:"#f1f5f9" }}>
                      Year-by-Year Annual Returns
                    </div>
                    <div style={{ color:"#475569", fontSize:11, marginTop:2 }}>
                      All returns from real Yahoo Finance adj. close monthly prices. Blank = no data for that year.
                    </div>
                  </div>
                  <div style={{ overflowX:"auto" }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Ticker</th><th>Wt%</th>
                          {allYearsForTable.map(y => <th key={y}>{y}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {holdings.filter(h=>h.status==="ok").map((h,i) => (
                          <tr key={i}>
                            <td style={{ color:h.color, fontWeight:600 }}>{h.ticker}</td>
                            <td style={{ color:"#64748b" }}>{h.weight}%</td>
                            {allYearsForTable.map(yr => {
                              const r = h.data?.annualReturns?.[yr];
                              if (r == null || isNaN(r)) return <td key={yr} className="dim">—</td>;
                              return <td key={yr} className={r>=0?"pos":"neg"}>{r>=0?"+":""}{r.toFixed(1)}%</td>;
                            })}
                          </tr>
                        ))}
                        <tr style={{ borderTop:"2px solid #2563eb" }}>
                          <td style={{ color:"#60a5fa", fontWeight:700 }}>PORTFOLIO</td>
                          <td style={{ color:"#60a5fa" }}>100%</td>
                          {allYearsForTable.map(yr => {
                            const d = result.annualData.find(x=>x.year===yr);
                            if (!d) return <td key={yr} className="dim">—</td>;
                            return <td key={yr} className={d.return>=0?"pos":"neg"} style={{fontWeight:700}}>
                              {d.return>=0?"+":""}{d.return.toFixed(1)}%
                            </td>;
                          })}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div style={{ padding:"10px 20px", borderTop:"1px solid #1e3a5f", color:"#334155", fontSize:10 }}>
                    Source: Yahoo Finance adjusted close prices via corsproxy.io · For personal/research use only · Not financial advice
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
