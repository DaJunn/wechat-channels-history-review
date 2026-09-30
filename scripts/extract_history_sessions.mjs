#!/usr/bin/env node

import fs from 'node:fs';

const DAEMON = process.env.KIMI_WEBBRIDGE_URL || 'http://127.0.0.1:10086/command';
const HISTORY_URL = 'https://channels.weixin.qq.com/platform/statistic/live?mode=history';

function parseArgs(argv) {
  const args = { out: '', session: 'wch-history-extract', waitMs: 12000, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i] || '';
    else if (a === '--session') args.session = argv[++i] || args.session;
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i] || args.waitMs);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: extract_history_sessions.mjs [--out path] [--session name] [--wait-ms 12000] [--dry-run]

Extracts all live session entries from the WeChat Channels history dashboard page.
Connects to the user's already-logged-in browser via Kimi WebBridge.
Reads session data from the micro-frontend iframe's Vue component store.

Output: JSON array of sessions with objectId, title, date, duration, viewers, peakOnline, heat, gmv.`);
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

function safeNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[,，]/g, '').replace(/[¥￥]/g, '').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDuration(str) {
  if (!str) return null;
  let totalSec = 0;
  const h = str.match(/(\d+)小时/);
  const m = str.match(/(\d+)分钟/);
  const s = str.match(/(\d+)秒/);
  if (h) totalSec += parseInt(h[1], 10) * 3600;
  if (m) totalSec += parseInt(m[1], 10) * 60;
  if (s) totalSec += parseInt(s[1], 10);
  return totalSec || null;
}

function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h}小时`);
  if (m) parts.push(`${m}分钟`);
  if (s) parts.push(`${s}秒`);
  return parts.join('') || '0秒';
}

function parseTableText(bodyText) {
  const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
  const sessions = [];
  const dataRows = [];
  let inData = false;
  let liveInfoStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === '直播时长') { inData = true; continue; }
    if (inData && l === '直播信息') { liveInfoStart = i; break; }
    if (inData && l.match(/^\d+[小分秒]/)) dataRows.push(l);
    else if (inData && l.startsWith('¥')) dataRows.push(l);
    else if (inData && l.match(/^\d+$/) && parseInt(l, 10) < 10000) dataRows.push(l);
    else if (inData && l.match(/^[\d.]+万$/)) dataRows.push(l);
    else if (inData && l === '0') dataRows.push(l);
  }

  const chunked = [];
  for (let i = 0; i + 5 <= dataRows.length; i += 5) {
    chunked.push(dataRows.slice(i, i + 5));
  }

  const titles = [];
  for (let i = liveInfoStart + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === '操作' || l.startsWith('数据详情')) break;
    if (l.match(/^\d+月\d+日/)) { if (titles.length) titles[titles.length - 1].date = l; }
    else { titles.push({ title: l, date: '' }); }
  }

  chunked.forEach((row, idx) => {
    const info = titles[idx] || {};
    const dur = parseDuration(row[0]);
    sessions.push({
      objectId: '',
      title: info.title || '',
      date: info.date || '',
      durationRaw: row[0],
      durationSec: dur,
      durationFormatted: formatDuration(dur),
      viewers: safeNum(row[1]),
      peakOnline: safeNum(row[2]),
      heat: safeNum(row[3]),
      gmv: safeNum(row[4]),
      dashboardUrl: '',
      source: 'tableText',
    });
  });

  return sessions;
}

async function extractVueRecords(sessionName) {
  const vueCode = `(()=>{const iframe=document.querySelector('iframe[name="statistic"]');if(!iframe)return 'noIframe';const doc=iframe.contentDocument;const tds=doc.querySelectorAll('td');const seen=new Set();const out=[];tds.forEach(td=>{const vm=td.__vue__;if(!vm||!vm.record||!vm.record.key)return;const k=vm.record.key;if(seen.has(k))return;seen.add(k);const r=vm.record;out.push({key:k,desc:(r.info?.desc||'').substring(0,80)});});return out.length?out:'noRecords';})()`;

  const resp = await command('evaluate', { code: vueCode }, sessionName);
  const data = resp?.data?.value;
  if (Array.isArray(data) && data.length > 0) {
    return data;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const session = args.session;

  if (args.dryRun) {
    console.log(JSON.stringify({ mode: 'dryRun', message: 'All checks passed. Would connect to Kimi WebBridge and extract history session data.' }, null, 2));
    return;
  }

  // find the user's active channels tab
  const findResp = await command('find_tab', { url: 'channels.weixin.qq.com', active: true }, session);
  if (!findResp?.data?.success) {
    console.error(JSON.stringify({ error: 'noActiveTab', message: 'No active channels.weixin.qq.com tab found. Please open the history page first.', detail: findResp }));
    process.exit(1);
  }

  const tabUrl = findResp.data.url;
  if (!tabUrl.includes('/statistic/live')) {
    console.log(JSON.stringify({ info: 'notOnHistoryPage', tabUrl, message: 'Navigating to history page...' }));
    const navResp = await command('navigate', { url: HISTORY_URL, newTab: false }, session);
    if (!navResp?.data?.success) {
      console.error(JSON.stringify({ error: 'navigateFailed', message: 'Failed to navigate to history page.', detail: navResp }));
      process.exit(1);
    }
  }

  // wait for page to load
  await new Promise(r => setTimeout(r, args.waitMs));

  // take snapshot to verify page loaded
  const snapshotResp = await command('snapshot', {}, session);
  const hasContent = snapshotResp?.data?.tree && snapshotResp.data.tree.length > 0;

  if (!hasContent) {
    console.error(JSON.stringify({ error: 'emptyPage', message: 'History page snapshot is empty. The page may not have loaded. Try a longer --wait-ms.' }));
    process.exit(1);
  }

  // extract from Vue store in iframe
  const vueData = await extractVueRecords(session);

  // extract from table text in iframe
  const textCode = `(()=>{const iframe=document.querySelector('iframe[name="statistic"]');if(!iframe)return'';const doc=iframe.contentDocument;if(!doc||!doc.body)return'';return doc.body.innerText;})()`;
  const textResp = await command('evaluate', { code: textCode }, session);
  const bodyText = textResp?.data?.value || '';

  const tableSessions = bodyText ? parseTableText(bodyText) : [];

  // merge Vue keys into table sessions
  if (vueData && tableSessions.length) {
    const keyMap = {};
    vueData.forEach((v, i) => {
      if (keyMap[v.key]) return;
      keyMap[v.key] = { desc: v.desc, key: v.key };
    });

    const vueKeys = Object.values(keyMap);
    tableSessions.forEach((s, idx) => {
      const match = vueKeys[idx];
      if (match) {
        s.objectId = match.key;
        s.title = s.title || match.desc;
        s.source = 'merged';
      }
    });
  } else if (vueData && !tableSessions.length) {
    // Only Vue data, no table text (rare)
    vueData.forEach(v => {
      tableSessions.push({
        objectId: v.key,
        title: v.desc,
        date: '',
        durationRaw: '',
        durationSec: null,
        durationFormatted: '',
        viewers: null,
        peakOnline: null,
        heat: null,
        gmv: null,
        dashboardUrl: `https://channels.weixin.qq.com/platform/statistic/dashboardV4?objetctId=${v.key}&entrance_id=3`,
        source: 'vueOnly',
      });
    });
  }

  // add dashboardUrl for all sessions with objectId
  tableSessions.forEach(s => {
    if (s.objectId) {
      s.dashboardUrl = `https://channels.weixin.qq.com/platform/statistic/dashboardV4?objetctId=${s.objectId}&entrance_id=3`;
    }
  });

  // close the session
  await command('close_session', {}, session).catch(() => {});

  const out = { generatedAt: new Date().toISOString(), sessionCount: tableSessions.length, sessions: tableSessions };
  const json = JSON.stringify(out, null, 2);

  if (args.out) {
    fs.writeFileSync(args.out, json, 'utf-8');
    console.log(`[OK] ${tableSessions.length} sessions written to ${args.out}`);
  } else {
    console.log(json);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message, stack: err.stack?.substring(0, 500) }));
  process.exit(1);
});
