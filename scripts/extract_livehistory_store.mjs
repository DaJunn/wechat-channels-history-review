#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const DAEMON = process.env.KIMI_WEBBRIDGE_URL || 'http://127.0.0.1:10086/command';

function parseArgs(argv) {
  const args = { out: '', session: 'fast-extract', totalPages: 0, pageSize: 0, waitMs: 8000 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i] || '';
    else if (a === '--session') args.session = argv[++i] || 'fast-extract';
    else if (a === '--pages') args.totalPages = Number(argv[++i] || 0);
    else if (a === '--page-size') args.pageSize = Number(argv[++i] || 0);
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i] || 8000);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: extract_livehistory_store.mjs --out path [--pages N] [--session name] [--wait-ms 8000]

Uses the Vue store's loadLiveHistory() promise + changePage() to rapidly extract ALL session data.
Much faster than UI-based pagination - no DOM parsing, no fixed waits, just async store calls.`);
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
  const parsed = await res.json().catch(() => ({}));
  // navigate responses have data directly, evaluate responses have data.value
  const data = parsed?.data;
  if (data && 'value' in data) return data.value;
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeGmv(v) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1000) return n / 100; // GMV might be in cents
  return n;
}

function extractRecord(r) {
  const durationSec = Number(r.liveStats_duration) || 0;
  const viewers = Number(r.liveStats_audience) || 0;
  const h = Math.floor(durationSec / 3600);
  const m = Math.floor((durationSec % 3600) / 60);
  const s = durationSec % 60;
  const durStr = [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join('') || '0s';

  return {
    objectId: r.liveObjectId || '',
    title: r.description || '',
    createTime: r.createTime ? new Date(r.createTime * 1000).toISOString().substring(0, 16) : '',
    durationSec,
    durationFormatted: durStr,
    viewers,
    peakOnline: Number(r.maxOnlineCount) || 0,
    heat: Number(r.hotQuota) || 0,
    gmv: normalizeGmv(r.payedGmv),
    orders: Number(r.payedNum) || 0,
    buyers: Number(r.payedUserUv) || 0,
    newFollows: Number(r.liveStats_follows) || 0,
    comments: Number(r.liveStats_comments) || 0,
    likes: Number(r.liveStats_cheers) || 0,
    hasShopping: Boolean(r.shoppingExisted),
    dashboardUrl: `https://channels.weixin.qq.com/platform/statistic/dashboardV4?objetctId=${r.liveObjectId || ''}&entrance_id=3`,
  };
}

async function getStoreMeta(session) {
  const code = `(()=>{
    const iframe=document.querySelector('iframe[name="statistic"]');
    if(!iframe) return {err:'noIframe',pageTitle:document.title};
    const win=iframe.contentWindow;
    const lh=win._store?.statisticStore?.liveHistory;
    if(!lh) return {err:'noLiveHistory',pageTitle:document.title};
    return {
      hasStore: true,
      totalCount: lh.totalCount,
      currentPage: lh.currentPage,
      pageSize: lh.pageSize,
      totalDuration: lh.totalDuration,
      hasLoadFn: typeof lh.loadLiveHistory === 'function',
      hasChangePage: typeof lh.changePage === 'function',
      sampleKeys: lh.history?.length ? Object.keys(lh.history[0]) : [],
    };
  })()`;
  return await cmd('evaluate', { code }, session);
}

async function extractPage(session, pageNum) {
  const code = `(async ()=>{
    const iframe=document.querySelector('iframe[name="statistic"]');
    const lh=iframe.contentWindow._store.statisticStore.liveHistory;
    lh.changePage(${pageNum});
    await lh.loadLiveHistory();
    const records = (lh.history || []).map(r => ({
      liveObjectId: r.liveObjectId,
      description: r.description,
      createTime: r.createTime,
      maxOnlineCount: r.maxOnlineCount,
      hotQuota: r.hotQuota,
      payedGmv: r.payedGmv,
      payedNum: r.payedNum,
      payedUserUv: r.payedUserUv,
      forwardCount: r.forwardCount,
      shoppingExisted: r.shoppingExisted,
      liveStats_audience: r.liveStats?.totalAudienceCount,
      liveStats_duration: r.liveStats?.liveDurationInSeconds,
      liveStats_follows: r.liveStats?.newFollowCount,
      liveStats_comments: r.liveStats?.totalCommentCount,
      liveStats_cheers: r.liveStats?.totalCheerCount,
    }));
    return {page: ${pageNum}, records, historyLen: records.length, currentPage: lh.currentPage};
  })()`;
  const data = await cmd('evaluate', { code }, session);
  return data || { page: pageNum, records: [], historyLen: 0, currentPage: 0 };
}

async function main() {
  const args = parseArgs(process.argv);

  // Navigate to history page
  const navResp = await fetch(DAEMON, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'navigate', args: { url: 'https://channels.weixin.qq.com/platform/statistic/live?mode=history', newTab: true }, session: args.session }),
  });
  const nav = await navResp.json().catch(() => ({}));
  if (!nav?.data?.success) { console.error('Navigation failed:', JSON.stringify(nav)); process.exit(1); }

  console.log('Waiting for initial page load...');
  await sleep(args.waitMs);

  // Get store metadata
  const meta = await getStoreMeta(args.session);
  if (!meta?.hasStore) { console.error('Store not available:', JSON.stringify(meta)); process.exit(1); }

  const totalPages = args.totalPages || Math.ceil(meta.totalCount / meta.pageSize);
  console.log(`Store: ${meta.totalCount} total, ${meta.pageSize}/page, ${totalPages} pages`);

  // Extract all pages
  const allSessions = [];
  for (let p = 1; p <= totalPages; p++) {
    const pageData = await extractPage(args.session, p);
    const records = pageData.records || [];
    const sessions = records.map(extractRecord);
    allSessions.push(...sessions);

    const first = sessions[0] || {};
    const last = sessions[sessions.length - 1] || {};
    console.log(`Page ${p}/${totalPages}: ${sessions.length} sessions | ${first.title} ${first.createTime} ~ ${last.title} ${last.createTime}`);
  }

  // Close session
  await cmd('close_session', {}, args.session).catch(() => {});

  // Deduplicate
  const seen = new Set();
  const unique = allSessions.filter(s => { if (!s.objectId || seen.has(s.objectId)) return false; seen.add(s.objectId); return true; });
  const valid = unique.filter(s => s.viewers >= 100 && s.gmv > 0);

  console.log(`\nDone: ${unique.length} total, ${valid.length} valid (GMV>0)`);

  const out = {
    generatedAt: new Date().toISOString(),
    totalPages,
    total: unique.length,
    valid: valid.length,
    totalGMV: unique.reduce((s, r) => s + r.gmv, 0),
    totalOrders: unique.reduce((s, r) => s + r.orders, 0),
    sessions: unique,
  };

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(out, null, 2), 'utf-8');
    console.log(`Saved to: ${args.out}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch(err => { console.error(err.stack); process.exit(1); });
