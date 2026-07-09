/**
 * Real-time migration watcher using Solana Tracker Datastream WebSocket.
 *
 * Subscribes to "graduated" (pump.fun migrations) + "graduating".
 * On events:
 *  - Logs details (mint, twitter, mcap, liquidity, risk, curve etc.)
 *  - Enriches asynchronously with REST (ST holders + GMGN)
 *  - If Twitter handle present: prints `npm run analyze -- <handle>`
 *
 * Usage:
 *   npm run watch-migrations
 *
 * WS URL: wss://datastream.solanatracker.io/{KEY}
 * (Datastream access typically requires Premium+ plan)
 *
 * Raw protocol (per docs):
 *   send { "type": "join", "room": "graduated" }
 *   receive { "type": "message", "room": "graduated", "data": { token, pools, risk, ... } }
 */

import WebSocket from 'ws';
import { SolanaTrackerProvider } from '../src/lib/providers/solanatracker';
import { GmgnProvider } from '../src/lib/providers/gmgn';
import { PriceProvider } from '../src/lib/providers/price';

const ST_KEY = process.env.SOLANATRACKER_API_KEY;
const GMGN_KEY = process.env.GMGN_API_KEY;

if (!ST_KEY) {
  console.error('Set SOLANATRACKER_API_KEY (must support Datastream)');
  process.exit(1);
}

const st = new SolanaTrackerProvider(ST_KEY);
const gmgn = new GmgnProvider(GMGN_KEY);
const priceP = new PriceProvider();

const WS_URL = `wss://datastream.solanatracker.io/${ST_KEY}`;

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function enrich(mint: string, symbol?: string) {
  (async () => {
    try {
      const [holders, gm, p] = await Promise.all([
        st.tokenHolders(mint).catch(() => null),
        gmgn.tokenInfo(mint).catch(() => null),
        priceP.tokenOverview(mint).catch(() => null),
      ]);
      const h = holders?.total ?? gm?.holderCount;
      if (h) console.log(`   holders: ${h.toLocaleString()}`);
      if (gm?.riskScore != null || gm?.smartMoneyCount != null) {
        console.log(`   gmgn: risk=${gm.riskScore ?? '—'} sm=${gm.smartMoneyCount ?? '—'}`);
      }
      if (p?.marketCapUsd) {
        console.log(`   mcap (dex): $${(p.marketCapUsd / 1000).toFixed(0)}k`);
      }
    } catch {}
  })();
}

function handleMessage(raw: string) {
  try {
    const msg = JSON.parse(raw);
    if (msg.type !== 'message') return;

    const room = msg.room;
    const data = msg.data || {};
    const token = data.token || {};
    const pool = (data.pools || [])[0] || {};
    const mint = token.mint;
    if (!mint) return;

    const tw = (token.strictSocials?.twitter || token.twitter || '').replace(/.*\//, '').replace(/^@/, '');
    const mcap = pool.marketCap?.usd || pool.marketCap?.quote;
    const liq = pool.liquidity?.usd;
    const curve = pool.curvePercentage;

    console.log(`\n🎓 [${room}] ${token.symbol || '?'}  ${new Date().toISOString().slice(11,19)}`);
    console.log(`   mint: ${mint}`);
    if (tw) console.log(`   twitter: @${tw}`);
    if (mcap) console.log(`   mcap: $${(mcap / 1000).toFixed(1)}k`);
    if (liq) console.log(`   liq:  $${(liq / 1000).toFixed(1)}k`);
    if (curve != null) console.log(`   curve: ${curve}%`);
    if (data.risk?.score != null) console.log(`   risk: ${data.risk.score}`);
    if (tw) console.log(`   → npm run analyze -- ${tw}`);

    enrich(mint, token.symbol);
  } catch (e) {
    // ignore bad frames
  }
}

function connect() {
  if (ws) {
    try { ws.close(); } catch {}
  }

  console.log(`🔌 Connecting to Datastream (${WS_URL.replace(ST_KEY ?? '', '***')}) ...`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('✅ Connected');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    // Subscribe to the rooms we care about
    ws!.send(JSON.stringify({ type: 'join', room: 'graduated' }));
    ws!.send(JSON.stringify({ type: 'join', room: 'graduating' }));
    // ws!.send(JSON.stringify({ type: 'join', room: 'latest' })); // optional
  });

  ws.on('message', (data: Buffer) => {
    handleMessage(data.toString());
  });

  ws.on('close', (code: number) => {
    console.log(`⚠️  WS closed (${code}). Reconnecting in 5s...`);
    scheduleReconnect();
  });

  ws.on('error', (err: any) => {
    console.error('WS error:', err?.message || err);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    connect();
  }, 5000);
}

console.log('🚀 Solana Tracker Migration Watcher (WS)');
console.log('   Subscribing to graduated + graduating rooms');
console.log('   Key prefix:', ST_KEY.slice(0, 8) + '...');
connect();

process.on('SIGINT', () => {
  console.log('\n👋 Stopping watcher');
  if (ws) ws.close();
  process.exit(0);
});
