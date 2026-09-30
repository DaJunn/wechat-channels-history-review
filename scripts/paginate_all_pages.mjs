#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const DAEMON = process.env.KIMI_WEBBRIDGE_URL || 'http://127.0.0.1:10086/command';
const HISTORY_URL = 'https://channels.weixin.qq.com/platform/statistic/live?mode=history';

function parseArgs(argv) {
  const args = { out: '', session: 'paginate-all', waitMs: 10000, pageWait: 3500, totalPages: 15, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i] || '';
    else if (a === '--session') args.session = argv[++i] || args.session;
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i] || 10000);
    else if (a === '--page-wait') args.pageWait = Number(argv[++i] || 3500);
    else if (a === '--pages') args.totalPages = Number(argv[++i] || 15);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: paginate_all_pages.mjs [--out path] [--pages 15] [--dry-run]
Extracts ALL live sessions from WeChat Channels history page by paginating through every page.`);
      process.exit(0);
    }
  }
  return args;
}

async function cmd(action, args = {}, session) {
  const res = await fetch(DAEMON, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session }),
  });
  return await res.json().catch(() => ({ ok: false }));
}

function safeNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[,，]/g, '').replace(/[¥￥]/g, '').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseduration(str) {
  if (!str) return null;
  let total = 0;
  const h = str.match(/([\d.]+)小/);
  const m = str.match(/([\d.]+)分/);
  const s = str.match(/([\d.]+)秒/);
  if (h) total += Math.round(parseFloat(h[1]) * 3600);
  if (m) total += Math.round(parseFloat(m[1]) * 60);
  if (s) total += Math.round(parseFloat(s[1]));
  return total || null;
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

async function extractPageData(sessionName) {
  const code = `(()=>{
    const iframe=document.querySelector('iframe[name="statistic"]');
    if(!iframe) return {pageBody:document.body.innerText||'',vueRecords:[]};
    const doc=iframe.contentDocument;
    const bodyText=doc.body.innerText||'';
    const tds=doc.querySelectorAll('td');
    const seen=new Set();
    const vueRecords=[];
    tds.forEach(td=>{
      const vm=td.__vue__;
      if(!vm||!vm.record||!vm.record.key) return;
      const k=vm.record.key;
      if(seen.has(k)) return;
      seen.add(k);
      vueRecords.push({key:k,desc:(vm.record.info?.desc||'').substring(0,80)});
    });
    return {bodyText,vueRecords};
  })()`;
  const resp = await cmd('evaluate', { code }, sessionName);
  return resp?.data?.value || { bodyText: '', vueRecords: [] };
}

function parseTable(bodyText, vueRecords) {
  const lines = bodyText.split('\n').map(l => l.replace(/\t/g, '').trim()).filter(Boolean);
  const hIdx = lines.findIndex(l => l === '成交金额');
  const iIdx = lines.findIndex(l => l === '直播信息');
  if (hIdx === -1 || iIdx === -1) return [];

  const dataLines = lines.slice(hIdx + 1, iIdx).filter(l => l !== '数据详情');
  const chunks = [];
  for (let i = 0; i + 5 <= dataLines.length; i += 5) chunks.push(dataLines.slice(i, i + 5));

  const infoLines = lines.slice(iIdx + 1);
  const titles = [];
  let cur = '';
  for (const l of infoLines) {
    if (l === '操作' || l === '数据详情') break;
    if (l === '直播信息') continue;
    if (/^\d{2}月\d{2}日/.test(l)) {
      if (cur) titles.push({ title: cur, date: l });
      cur = '';
    } else if (l.length > 1 && !/^\d/.test(l) && !/上.?.?页|下.?.?页|跳转/.test(l) && !/^\.{2,}$/.test(l)) {
      cur = l;
    }
  }

  const sessions = [];
  chunks.forEach((row, idx) => {
    const info = titles[idx] || {};
    const dur = parseduration(row[0]);
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

  if (vueRecords?.length) {
    sessions.forEach((s, i) => {
      const vr = vueRecords[i];
      if (vr) {
        s.objectId = vr.key;
        if (!s.title) s.title = vr.desc;
        s.dashboardUrl = `https://channels.weixin.qq.com/platform/statistic/dashboardV4?objetctId=${vr.key}&entrance_id=3`;
        s.source = 'merged';
      }
    });
  }

  return sessions.filter(s => s.durationSec !== null);
}

async function clickNext(sessionName) {
  const code = `(()=>{
    const iframe=document.querySelector('iframe[name="statistic"]');
    if(!iframe) return 'noIframe';
    const all=iframe.contentDocument.querySelectorAll('a,button,span,li');
    const btn=Array.from(all).find(el=>el.textContent.trim()==='下一页');
    if(btn){btn.click();return 'clicked';}
    return 'notFound';
  })()`;
  const resp = await cmd('evaluate', { code }, sessionName);
  return resp?.data?.value || 'unknown';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv);
  if (args.dryRun) { console.log(`[DRY RUN] Would paginate ${args.totalPages} pages`); return; }

  // Navigate
  const nav = await cmd('navigate', { url: HISTORY_URL, newTab: true }, args.session);
  if (!nav?.data?.success) { console.error('Navigation failed'); process.exit(1); }
  console.log(`Page loaded. Waiting ${args.waitMs}ms...`);
  await sleep(args.waitMs);

  const allSessions = [];
  for (let p = 1; p <= args.totalPages; p++) {
    console.log(`--- Page ${p}/${args.totalPages} ---`);
    const data = await extractPageData(args.session);
    const sessions = parseTable(data.bodyText || '', data.vueRecords || []);
    console.log(`  ${sessions.length} sessions`);

    if (sessions.length > 0) {
      const first = sessions[0], last = sessions[sessions.length - 1];
      console.log(`  ${first.title} ${first.date} ~ ${last.title} ${last.date}`);
    }

    allSessions.push(...sessions);

    if (p < args.totalPages) {
      const r = await clickNext(args.session);
      console.log(`  Next: ${r}`);
      await sleep(args.pageWait);
    }
  }

  await cmd('close_session', {}, args.session).catch(() => {});

  // Deduplicate
  const seen = new Set();
  const unique = allSessions.filter(s => { if (!s.objectId || seen.has(s.objectId)) return false; seen.add(s.objectId); return true; });
  const valid = unique.filter(s => (s.viewers || 0) >= 100 && (s.gmv || 0) > 0);

  const out = { generatedAt: new Date().toISOString(), totalPages: args.totalPages, total: unique.length, valid: valid.length, sessions: unique };

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(out, null, 2), 'utf-8');
    console.log(`\nDone: ${unique.length} total, ${valid.length} valid → ${args.out}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch(err => { console.error(err.stack); process.exit(1); });
