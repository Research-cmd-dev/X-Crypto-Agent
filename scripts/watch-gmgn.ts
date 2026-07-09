/**
 * GMGN WebSocket real-time watcher.
 *
 * Connects to GMGN's WS for live signals (new tokens, smart money trades, etc.).
 * This complements the Solana Tracker migration watcher.
 *
 * Usage:
 *   GMGN_API_KEY=gmgn_... npm run watch-gmgn
 *
 * Note: GMGN WS protocol is lightly documented; this uses observed patterns from community clients.
 * Auth via ?api_key= or header. Subscribes to new_pools / token_launch / smart money channels.
 * On interesting events (e.g. smart money activity or new launch with socials), it enriches
 * using the existing GMGN + ST providers and can suggest full analysis.
 */

import WebSocket from 'ws';
import { GmgnProvider } from '../src/lib/providers/gmgn';
import { SolanaTrackerProvider } from '../src/lib/providers/solanatracker';
import { PriceProvider } from '../src/lib/providers/price';

const GMGN_KEY = process.env.GMGN_API_KEY;
const ST_KEY = process.env.SOLANATRACKER_API_KEY; // optional for extra enrichment

if (!GMGN_KEY) {
  console.error('GMGN_API_KEY is required');
  process.exit(1);
}

const gmgn = new GmgnProvider(GMGN_KEY);
const st = ST_KEY ? new SolanaTrackerProvider(ST_KEY) : null;
const price = new PriceProvider();

const WS_URL = `wss://gmgn.ai/ws?api_key=${GMGN_KEY}`;

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function connect() {
  console.log(`🔌 Connecting to GMGN WS...`);
  ws = new WebSocket(WS_URL, {
    headers: {
      'User-Agent': 'X-Crypto-Agent/1.0',
      'x-api-key': GMGN_KEY,
    },
  });

  ws.on('open', () => {
    console.log('✅ GMGN WS connected');
    if (reconnectTimer) clearTimeout(reconnectTimer);

    // Subscribe to key channels for new gems / smart money
    // Try multiple formats for compatibility
    const subs = [
      { method: 'subscribe', params: ['new_pools'] },
      { method: 'subscribe', params: ['token_launch'] },
      { type: 'subscribe', channel: 'new_pools' },
      { type: 'join', room: 'new_tokens' },
      // Smart money / wallet activity if supported
      { method: 'subscribe', params: ['smart_money_trades'] },
    ];
    subs.forEach((s) => {
      try { ws!.send(JSON.stringify(s)); } catch {}
    });
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      handleGmgnMessage(msg);
    } catch (e) {
      // Some messages may be binary or non-JSON; log raw briefly
      const raw = data.toString();
      if (raw.length < 200) console.log('[GMGN raw]', raw);
    }
  });

  ws.on('close', (code: number) => {
    console.log(`⚠️ GMGN WS closed (${code})`);
    scheduleReconnect();
  });

  ws.on('error', (err: Error) => {
    console.error('GMGN WS error:', err.message || err);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    console.log('🔄 Reconnecting GMGN WS...');
    connect();
  }, 5000);
}

async function handleGmgnMessage(msg: any) {
  const type = msg.type || msg.event || msg.method || 'data';

  // New pool / token launch (primary interest for the swarm)
  if (type.includes('new') || type.includes('launch') || type.includes('pool')) {
    const token = msg.token || msg.data?.token || msg;
    const mint = token.address || token.mint || token.ca || msg.ca;
    const symbol = token.symbol || token.s || '?';
    const mc = token.market_cap || token.mc || msg.mc;

    console.log(`\n🚀 [GMGN New/Launch] ${symbol} ${mint ? `(${mint.slice(0,6)}...)` : ''}`);
    if (mc) console.log(`   mcap: $${(Number(mc)/1e3).toFixed(0)}k`);
    if (token.twitter || token.socials) console.log(`   socials:`, token.twitter || token.socials);

    if (mint) {
      // Enrich with our providers (GMGN + optional ST)
      try {
        const [g, holders, p] = await Promise.all([
          gmgn.tokenInfo(mint),
          st ? st.tokenHolders(mint) : Promise.resolve(null),
          price.tokenOverview(mint).catch(() => null),
        ]);
        if (g) {
          console.log(`   GMGN: holders=${g.holderCount ?? '?'}, risk=${g.riskScore ?? '?'}, sm=${g.smartMoneyCount ?? '?'}`);
        }
        if (holders?.total) console.log(`   ST holders: ${holders.total}`);
        if (p?.marketCapUsd) console.log(`   Price mcap: $${(p.marketCapUsd/1e3).toFixed(0)}k`);
      } catch (e) {}

      // Suggest full analysis if it looks promising
      if (token.twitter) {
        const handle = String(token.twitter).replace(/.*\//, '').replace(/^@/, '');
        console.log(`   → Consider: npm run analyze -- ${handle}`);
      }
    }
  }

  // Smart money / wallet trades
  if (type.includes('trade') || type.includes('wallet') || type.includes('smart')) {
    console.log(`\n💰 [GMGN SmartMoney/Trade]`, JSON.stringify(msg).slice(0, 250));
  }

  // Other interesting updates
  if (type.includes('update') || type.includes('stat')) {
    // console.log('[GMGN update]', type); // can be noisy
  }
}

console.log('🚀 GMGN WebSocket watcher starting');
console.log('   Using GMGN key prefix:', GMGN_KEY.slice(0, 10) + '...');
connect();

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down GMGN watcher');
  if (ws) ws.close();
  process.exit(0);
});
