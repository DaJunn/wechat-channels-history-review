#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DAEMON = process.env.KIMI_WEBBRIDGE_URL || 'http://127.0.0.1:10086/command';
const DEFAULT_OUT_DIR = path.join(os.homedir(), 'outputs/live-trend-digitized');
const SKILL_DIR = path.dirname(new URL(import.meta.url).pathname);
const DATA_READER_DIR = path.join(os.homedir(), '.agents/skills/wechat-channels-data-reader');

function parseArgs(argv) {
  const args = {
    sessions: '',
    out: '',
    waitMs: 15000,
    pollInterval: 800,
    timeout: 90000,
    dryRun: false,
    skipTrends: false,
    noGmvFilter: false,
    allSessions: false,
    resume: false,
    interSessionMs: 500,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sessions') args.sessions = argv[++i] || '';
    else if (a === '--out') args.out = argv[++i] || '';
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i] || args.waitMs);
    else if (a === '--poll-interval') args.pollInterval = Number(argv[++i] || args.pollInterval);
    else if (a === '--timeout') args.timeout = Number(argv[++i] || args.timeout);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-trends') args.skipTrends = true;
    else if (a === '--no-gmv-filter') args.noGmvFilter = true;
    else if (a === '--all-sessions') args.allSessions = true;
    else if (a === '--resume') args.resume = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: batch_deep_dive.mjs --sessions <sessions.json> [--out dir] [--wait-ms 15000] [--skip-trends] [--resume] [--dry-run]

Processes each valid session from a session list JSON:
1. Navigate to dashboardV4 for each session
2. Poll with exponential backoff until runtime store is available
3. Extract overview metrics (store first, innerText fallback)
4. Export minute-level trends (exposure/entry/online/transactions)
5. Run trend analysis (if not --skip-trends)
6. Save per-session results
7. Output cross-session summary`);
      process.exit(0);
    }
  }
  return args;
}

async function command(action, args = {}, session) {
  const res = await fetch(DAEMON, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, raw: text }; }
}

function parseMaybeJson(value) {
  if (!value || typeof value !== 'object') return value;
  // Kimi WebBridge evaluate returns {type, value} - unwrap it
  if ('value' in value && 'type' in value) return parseMaybeJson(value.value);
  if (value.data?.value) return parseMaybeJson(value.data.value);
  return value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Page Store Extraction (reuses export_live_trend_minutes approach) ---

function hasRequiredStore(store) {
  return Boolean(
    store?.selected
    && Array.isArray(store.selected.impressionUv)
    && Array.isArray(store.selected.newWatchUv)
    && Array.isArray(store.selected.onlineWatchUv)
  );
}

async function evaluateTrendStore(name) {
  const code = `(() => {
    const iframe = document.querySelector('iframe[name="statistic"], iframe[src*="statistic"], iframe[src*="dashboardV4"]');
    const w = iframe && iframe.contentWindow ? iframe.contentWindow : window;
    const store = w._store;
    const dashboard = store && store.statisticStore && store.statisticStore.liveDataDashboardV4;
    const traffic = dashboard && dashboard.ecConversionDashboardData && dashboard.ecConversionDashboardData.trendingTraffic;
    const ecTread = dashboard && dashboard.ecConversionDashboardEcData && dashboard.ecConversionDashboardEcData.ecTread;
    const overview = (dashboard && (dashboard.overview || dashboard.ecConversionDashboardData?.overview)) || {};
    const ecData = dashboard && dashboard.ecConversionDashboardData;
    const gmvAnalysis = ecData && ecData.gmvAnalysis;
    const commodityBoard = ecData && ecData.commodityBoard;
    return {
      hasStore: Boolean(store),
      hasFullData: Boolean(store?.statisticStore?.liveDataDashboardV4?.ecConversionDashboardData?.gmvAnalysis),
      meta: {
        liveObjectId: String(dashboard?.liveObjectId || dashboard?.objectId || ''),
        anchorNickname: String(dashboard?.anchorNickname || ''),
        liveDescription: String(dashboard?.liveDescription || ''),
        createTime: String(dashboard?.createTime || ''),
        endTime: String(dashboard?.endTime || ''),
        gmvOverall: gmvAnalysis?.overallGmv != null ? Number(gmvAnalysis.overallGmv) : null,
        totalOrders: gmvAnalysis?.totalOrders != null ? Number(gmvAnalysis.totalOrders) : null,
        commission: gmvAnalysis?.totalCommission != null ? Number(gmvAnalysis.totalCommission) : null,
        refundRate: gmvAnalysis?.refundRate != null ? Number(gmvAnalysis.refundRate) : null,
        totalViewers: overview.cumulativeWatchUv != null ? Number(overview.cumulativeWatchUv) : null,
        peakOnline: gmvAnalysis?.peakOnlineUv != null ? Number(gmvAnalysis.peakOnlineUv) : null,
        avgWatchSec: gmvAnalysis?.avgWatchDuration != null ? Number(gmvAnalysis.avgWatchDuration) : null,
        newFollows: gmvAnalysis?.newFollows != null ? Number(gmvAnalysis.newFollows) : null,
        productBoard: commodityBoard || null,
      },
      overview,
      selected: traffic ? {
        impressionUv: traffic.impressionUv || [],
        newWatchUv: traffic.newWatchUv || [],
        onlineWatchUv: traffic.onlineWatchUv || [],
      } : null,
      ecTread: ecTread ? {
        gmvTread: ecTread.gmvTread || {},
        payPvTread: ecTread.payPvTread || {},
        payUvTread: ecTread.payUvTread || {},
      } : null,
    };
  })()`;
  const resp = await command('evaluate', { code }, name);
  return parseMaybeJson(resp?.data);
}

// Evaluate the iframe body text for overview metrics (commission, refund, products)
async function extractOverviewText(name) {
  const code = `(() => {
    const iframe = document.querySelector('iframe[name="statistic"]');
    if (!iframe) return document.body.innerText || '';
    const doc = iframe.contentDocument;
    return doc?.body?.innerText || document.body.innerText || '';
  })()`;
  const resp = await command('evaluate', { code }, name);
  let text = '';
  if (resp?.data?.value) text = resp.data.value;
  else if (resp?.data?.type === 'string') text = resp.data.value || '';
  else if (typeof resp?.data === 'string') text = resp.data;
  else if (typeof resp?.value === 'string') text = resp.value;
  return String(text || '');
}

function parseOverviewData(bodyText) {
  const data = { commission: null, refundRate: null, orders: null, viewers: null, peakOnline: null, avgWatch: null, follows: null, products: [] };

  const m = bodyText.match(/预估佣金\s*([\d.]+)/);
  if (m) data.commission = parseFloat(m[1]);

  const r = bodyText.match(/退款率\s*([\d.]+)%/);
  if (r) data.refundRate = parseFloat(r[1]);

  const o = bodyText.match(/成交订单数\s*(\d+)/);
  if (o) data.orders = parseInt(o[1], 10);

  const v = bodyText.match(/累计看播人数\s*([\d,.万]+)/);
  if (v) {
    let raw = v[1].replace(/,/g, '');
    if (raw.includes('万')) raw = String(parseFloat(raw.replace('万', '')) * 10000);
    data.viewers = parseInt(raw, 10);
  }

  const po = bodyText.match(/最高在线人数\s*(\d+)/);
  if (po) data.peakOnline = parseInt(po[1], 10);

  const aw = bodyText.match(/人均观看时长\s*(\d+)\s*分\s*(\d+)?\s*秒?/);
  if (aw) data.avgWatch = `${aw[1]}分${aw[2] || '0'}秒`;

  const fu = bodyText.match(/新增关注\s*(\d+)/);
  if (fu) data.follows = parseInt(fu[1], 10);

  // Parse product table
  const prodSection = bodyText.split('商品成交榜')[1]?.split('整体趋势')[0] || '';
  const prodLines = prodSection.split('\n').filter(Boolean);
  const prods = [];
  for (let i = 0; i + 2 < prodLines.length; i += 3) {
    const name = prodLines[i]?.trim();
    const shop = prodLines[i + 1]?.trim();
    const gmvRaw = prodLines[i + 2]?.trim();
    if (name && !name.includes('更多') && gmvRaw?.startsWith('¥')) {
      prods.push({ name: name.substring(0, 60), shop: shop || '', gmv: parseFloat(gmvRaw.replace('¥', '')) || 0 });
    }
  }
  if (prods.length === 0) {
    // Alternative: single product layout
    const lines = bodyText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l === '商品成交榜') {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() && !lines[j].includes('整体趋势')) {
          const name = lines[j]?.trim();
          const priceMatch = lines[j + 1]?.trim()?.match(/^¥?([\d.]+)/);
          if (priceMatch) {
            prods.push({ name: name?.substring(0, 60) || '', shop: '', gmv: parseFloat(priceMatch[1]) || 0 });
            j += 2;
          } else {
            j += 1;
          }
          if (j > i + 30) break;
        }
        break;
      }
    }
  }

  data.products = prods;
  return data;
}

// Minute-level data extraction (reuses export script logic)
const METRICS = { exposure: 'impressionUv', entry: 'newWatchUv', online: 'onlineWatchUv' };
const EC_METRICS = { transaction_amount: 'gmvTread', order_count: 'payPvTread', buyer_count: 'payUvTread' };

function pickMinuteSeries(metricGroups) {
  if (!Array.isArray(metricGroups)) return null;
  return metricGroups.find(group =>
    String(group?.step) === '60' && Array.isArray(group?.data)
  ) || null;
}

function pickKeyedMinuteSeries(metricGroups) {
  if (!metricGroups || typeof metricGroups !== 'object') return null;
  const direct = metricGroups['60'];
  if (direct && Array.isArray(direct.data)) return direct;
  return pickMinuteSeries(Object.values(metricGroups));
}

function metricMap(series) {
  const out = new Map();
  if (!series?.data) return out;
  for (const point of series.data) {
    if (point?.ts === undefined) continue;
    out.set(Number(point.ts), Number(point.value) || 0);
  }
  return out;
}

function collectRows(trendingTraffic, ecTread) {
  const series = {};
  for (const [column, key] of Object.entries(METRICS)) {
    series[column] = pickMinuteSeries(trendingTraffic?.[key]);
  }
  for (const [column, key] of Object.entries(EC_METRICS)) {
    series[column] = pickKeyedMinuteSeries(ecTread?.[key]) || series[column];
  }

  const maps = Object.fromEntries(
    Object.entries(series).map(([column, s]) => [column, metricMap(s)])
  );

  const timestamps = [...new Set(
    Object.values(maps).flatMap(m => [...m.keys()])
  )].sort((a, b) => a - b);

  return timestamps.map(ts => ({
    time: hhmmFromTs(ts),
    ts,
    exposure: maps.exposure.get(ts) ?? '',
    entry: maps.entry.get(ts) ?? '',
    online: maps.online.get(ts) ?? '',
    transaction_amount: maps.transaction_amount?.get(ts) === undefined ? '' : Number((maps.transaction_amount.get(ts) / 100).toFixed(2)),
    order_count: maps.order_count?.get(ts) ?? '',
    buyer_count: maps.buyer_count?.get(ts) ?? '',
  }));
}

function hhmmFromTs(ts) {
  const dtf = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
  return dtf.format(new Date(Number(ts) * 1000));
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(file, rows) {
  const cols = ['time', 'ts', 'exposure', 'entry', 'online', 'transaction_amount', 'order_count', 'buyer_count'];
  const lines = [cols.join(','), ...rows.map(r => cols.map(c => csvEscape(r[c])).join(','))];
  fs.writeFileSync(file, `\ufeff${lines.join('\n')}\n`, 'utf8');
}

function maxRow(rows, col) {
  return rows.reduce((best, r) => {
    if (r[col] === '' || r[col] === null) return best;
    const v = Number(r[col]);
    if (!Number.isFinite(v)) return best;
    return (!best || v > Number(best[col])) ? r : best;
  }, null);
}

// --- Main logic ---

async function processSession(session, idx, total, args, sessionName) {
  const name = sessionName || `batch-dive-${idx}`;
  const objectId = session.objectId;
  const dashboardUrl = `https://channels.weixin.qq.com/platform/statistic/dashboardV4?objetctId=${objectId}&entrance_id=3`;

  console.log(`[${idx}/${total}] ${session.title || ''} ${session.date || ''} ...`);

  try {
    // Navigate: first session opens new tab, subsequent reuse it
    await command('navigate', { url: dashboardUrl, newTab: !args._reuseTab }, name);

    // Poll for store (check first, then exponential backoff)
    const deadline = Date.now() + args.timeout;
    let store = await evaluateTrendStore(name);
    let backoff = Math.max(200, Math.min(args.pollInterval, 400));
    while (!hasRequiredStore(store) && Date.now() < deadline) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 2000);
      store = await evaluateTrendStore(name);
    }

    if (!hasRequiredStore(store)) {
      console.log(`  [WARN] Store not ready after ${args.timeout}ms, extracting what's available`);
    }

    // Extract overview: try store meta first, fall back to innerText regex
    let overview;
    const sm = store?.meta || {};
    if (sm.commission != null) {
      overview = {
        commission: sm.commission,
        refundRate: sm.refundRate,
        orders: sm.totalOrders,
        viewers: sm.totalViewers,
        peakOnline: sm.peakOnline,
        avgWatch: sm.avgWatchSec ? `${Math.floor(sm.avgWatchSec / 60)}分${Math.round(sm.avgWatchSec % 60)}秒` : null,
        follows: sm.newFollows,
        products: [],
        source: 'storeMeta',
      };
    } else {
      const bodyText = await extractOverviewText(name);
      overview = parseOverviewData(bodyText);
      overview.source = 'innerText';
    }

    // Extract trends
    let rows = [];
    let totals = {};
    let peaks = {};
    if (store?.selected && !args.skipTrends) {
      const tt = { ...store.selected };
      const ec = store.ecTread || {};
      rows = collectRows(tt, ec);
      totals = {
        transaction_amount: Number(rows.reduce((s, r) => s + (Number(r.transaction_amount) || 0), 0).toFixed(2)),
        order_count: rows.reduce((s, r) => s + (Number(r.order_count) || 0), 0),
        buyer_count: rows.reduce((s, r) => s + (Number(r.buyer_count) || 0), 0),
      };
      peaks = {
        exposure: maxRow(rows, 'exposure'),
        entry: maxRow(rows, 'entry'),
        online: maxRow(rows, 'online'),
        transaction_amount: maxRow(rows, 'transaction_amount'),
        order_count: maxRow(rows, 'order_count'),
        buyer_count: maxRow(rows, 'buyer_count'),
      };
    }

    // Build channel traffic
    const overviewStore = store?.overview || {};
    const totalWatchPv = Number(overviewStore.cumulativeWatchPv) || 0;
    const heatWatchPv = Number(overviewStore.promotionCumulativeWatchPv) || 0;
    const heatShare = totalWatchPv > 0 ? Number((heatWatchPv / totalWatchPv).toFixed(4)) : 0;

    // Save files
    const outDir = args.out || DEFAULT_OUT_DIR;
    fs.mkdirSync(outDir, { recursive: true });
    const csvFile = path.join(outDir, `live_trend_store_${objectId}.csv`);
    const rawFile = path.join(outDir, `live_trend_store_${objectId}_raw.json`);
    const summaryFile = path.join(outDir, `live_trend_store_${objectId}_summary.json`);

    if (rows.length > 0) {
      writeCsv(csvFile, rows);
    }

    const raw = {
      generatedAt: new Date().toISOString(),
      objectId,
      title: session.title,
      date: session.date,
      duration: session.durationFormatted || session.durationRaw,
      meta: store?.meta || {},
      channelTraffic: {
        totalWatchPv,
        totalWatchUv: Number(overviewStore.cumulativeWatchUv) || 0,
        heatWatchPv,
        heatWatchPvShare: heatShare,
      },
      overview,
      totals,
      peaks,
    };

    fs.writeFileSync(rawFile, JSON.stringify(raw, null, 2), 'utf8');
    fs.writeFileSync(summaryFile, JSON.stringify({ ...raw, rows, counts: { rows: rows.length } }, null, 2), 'utf8');

    // Run trend analysis if we have trends
    if (rows.length >= 10 && !args.skipTrends) {
      try {
        const analyzerPath = path.join(DATA_READER_DIR, 'scripts/analyze_live_trend_minutes.py');
        if (fs.existsSync(analyzerPath)) {
          const result = spawnSync('python3', [analyzerPath, csvFile, '--raw', rawFile], {
            encoding: 'utf8', timeout: 30000,
          });
          if (result.stdout) console.log(`  [Trend] ${result.stdout.split('\n')[0]?.substring(0, 120) || ''}`);
        }
      } catch (e) {
        console.log(`  [WARN] Trend analysis failed: ${e.message}`);
      }
    }

    // No close_session here — tab is reused by caller

    console.log(`  OK | GMV=¥${totals.transaction_amount || 0} | orders=${totals.order_count || 0} | commission=¥${overview.commission || '?'} | refund=${overview.refundRate || '?'}%`);

    return { ...session, ...raw, rows, csvFile, rawFile };
  } catch (err) {
    console.log(`  [ERR] ${err.message}`);
    // Don't close session — tab is reused, caller handles cleanup
    return { ...session, error: err.message };
  }
}

function computeCompanyRevenue(commission, refundRate, mcnShare = 40) {
  if (!commission) return null;
  return Number((commission * (mcnShare / 100) * (1 - (refundRate || 0) / 100)).toFixed(2));
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.sessions) {
    console.error('ERROR: --sessions <file.json> is required');
    process.exit(1);
  }

  const sessionsData = JSON.parse(fs.readFileSync(args.sessions, 'utf8'));
  const allSessions = sessionsData.sessions || sessionsData;
  
  // Filter valid sessions
  const valid = args.allSessions
    ? allSessions.filter(s => s.objectId)
    : args.noGmvFilter
    ? allSessions.filter(s => (s.viewers || 0) >= 100)
    : allSessions.filter(s => (s.viewers || 0) >= 100 && (s.gmv || 0) > 0);

  if (valid.length === 0) {
    const filterDesc = args.allSessions ? 'all sessions with objectId' : args.noGmvFilter ? 'viewers >= 100' : 'viewers >= 100 AND GMV > 0';
    console.error(`No valid sessions found (${filterDesc})`);
    console.log(`Total sessions in file: ${allSessions.length}`);
    process.exit(1);
  }

  console.log(`Processing ${valid.length} valid sessions (of ${allSessions.length} total, filter: ${args.allSessions ? 'all sessions' : args.noGmvFilter ? 'viewers>=100' : 'viewers>=100 and GMV>0'})...`);

  // Filter out already-processed sessions (--resume)
  const outDir = args.out || DEFAULT_OUT_DIR;
  const toProcess = args.resume
    ? valid.filter(s => !fs.existsSync(path.join(outDir, `live_trend_store_${s.objectId}.csv`)))
    : valid;
  const skipped = valid.length - toProcess.length;
  if (skipped > 0) console.log(`Resume mode: ${skipped} sessions already have output files, skipping.`);

  if (toProcess.length === 0) {
    console.log(`All ${valid.length} sessions already processed. Nothing to do.`);
    return;
  }

  if (args.dryRun) {
    console.log('[DRY RUN] Would process:');
    toProcess.forEach((s, i) => console.log(`  ${i + 1}. ${s.title} ${s.date} | objectId=${s.objectId} | GMV=¥${s.gmv}`));
    return;
  }

  const name = 'batch-dive';
  let reuseTab = false;

  const results = [];
  for (let i = 0; i < toProcess.length; i++) {
    args._reuseTab = reuseTab;
    const session = 'batch-dive'; // single session, reuse tab
    const result = await processSession(toProcess[i], i + 1, toProcess.length, args, session);
    results.push(result);
    reuseTab = true; // after first, reuse the same tab

    // Incrementally save partial summary after each session
    const partial = buildSummary(results, outDir);
    fs.writeFileSync(path.join(outDir, 'cross_session_summary.json'), JSON.stringify(partial, null, 2), 'utf8');

    if (i < toProcess.length - 1) await sleep(args.interSessionMs);
  }

  // close the single session
  await command('close_session', {}, name).catch(() => {});

// Cross-session summary
  const summary = buildSummary(results, outDir);

  console.log(`\n=== DONE ===`);
  console.log(`Sessions processed: ${summary.processed} OK / ${summary.failed} failed`);
  console.log(`Total GMV: ¥${summary.totalGMV} | Orders: ${summary.totalOrders} | Company Revenue: ¥${summary.totalCompanyRevenue || '?'}`);
  console.log(`Summary saved: ${path.join(outDir, 'cross_session_summary.json')}`);
}

function buildSummary(results, outDir) {
  results.forEach(r => {
    r.companyRevenue = computeCompanyRevenue(r.overview?.commission, r.overview?.refundRate);
  });
  return {
    generatedAt: new Date().toISOString(),
    processed: results.filter(r => !r.error).length,
    failed: results.filter(r => r.error).length,
    totalGMV: Number(results.reduce((s, r) => s + (r.totals?.transaction_amount || 0), 0).toFixed(2)),
    totalOrders: results.reduce((s, r) => s + (r.totals?.order_count || 0), 0),
    totalCompanyRevenue: Number(results.reduce((s, r) => s + (r.companyRevenue || 0), 0).toFixed(2)),
    sessions: results.map(r => ({
      objectId: r.objectId,
      title: r.title,
      date: r.date,
      duration: r.duration,
      meta: r.meta,
      channelTraffic: r.channelTraffic,
      overview: r.overview,
      totals: r.totals,
      peaks: r.peaks,
      companyRevenue: r.companyRevenue,
      error: r.error,
    })),
  };
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
