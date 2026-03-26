// Token Discovery — Bitget Wallet Skills API powered
// Replaces PumpPortal random feed with curated, quality-filtered token selection
// Uses launchpad-tokens scanner + rankings + security checks

import type { TokenDataPack } from './types';

// ---------------------------------------------------------------------------
// Bitget API client (shared with dataAggregator)
// ---------------------------------------------------------------------------

// Bitget Agent API — correct base URL from official wallet skill
const BITGET_BASE = 'https://copenapi.bgwapi.io';

async function makeSign(method: string, path: string, bodyStr: string, ts: string): Promise<string> {
  const message = method + path + bodyStr + ts;
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function bitgetPost<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const ts = String(Date.now());
    const bodyStr = JSON.stringify(body);
    const sign = await makeSign('POST', path, bodyStr, ts);

    const resp = await fetch(BITGET_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'channel': 'toc_agent',
        'brand': 'toc_agent',
        'clientversion': '10.0.0',
        'language': 'en',
        'token': 'toc_agent',
        'X-SIGN': sign,
        'X-TIMESTAMP': ts,
      },
      body: bodyStr,
    });

    if (!resp.ok) return null;
    const result = await resp.json();
    return result?.data ?? null;
  } catch (err) {
    console.warn(`[Discovery] Bitget API ${path} failed:`, (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TIER rating system — from Bitget Wallet Skill docs
// ---------------------------------------------------------------------------

type Tier = 'S' | 'A' | 'B' | 'C';

interface LaunchpadToken {
  chain: string;
  contract: string;
  symbol: string;
  name: string;
  holders: string;
  liquidity: string;
  price: string;
  market_cap: string;
  platform: string;
  progress: string;
  turnover: string;
  top10_holder_percent: string;
  insider_holder_percent: string;
  sniper_holder_percent: string;
  dev_holder_percent: string;
  dev_rug_percent: string;
  dev_rug_coin_count: string;
  dev_issue_coin_count: string;
  lock_lp_percent: string;
  icon: string;
  issue_date: string;
  twitter: string;
  website: string;
  telegram: string;
}

function rateTier(token: LaunchpadToken): Tier {
  const mc = parseFloat(token.market_cap || '0');
  const lp = parseFloat(token.liquidity || '0');
  const h = parseInt(token.holders || '0', 10);

  if (mc > 1_000_000 && lp > 100_000 && h > 5000) return 'S';
  if (mc > 100_000 && lp > 20_000 && h > 1000) return 'A';
  if (mc > 10_000 && lp > 5_000 && h > 100) return 'B';
  return 'C';
}

function hasSafetyRedFlags(token: LaunchpadToken): boolean {
  const devRug = parseFloat(token.dev_rug_percent || '0');
  const sniperPct = parseFloat(token.sniper_holder_percent || '0');
  const top10 = parseFloat(token.top10_holder_percent || '0');
  // Red flags: dev has 20%+ rug history, sniper 10%+, top10 holds 60%+
  return devRug > 20 || sniperPct > 10 || top10 > 60;
}

// ---------------------------------------------------------------------------
// Token discovery strategies
// ---------------------------------------------------------------------------

interface DiscoveryResult {
  tokens: LaunchpadToken[];
  strategy: string;
}

/** Strategy 1: High-quality launched tokens with good liquidity */
async function discoverLaunched(): Promise<DiscoveryResult> {
  const data = await bitgetPost<{ list: LaunchpadToken[] }>(
    '/market/v3/launchpad/tokens',
    {
      chain: 'sol',
      stage: 2,          // Launched
      lpMin: 5000,       // Minimum $5K liquidity
      holderMin: 50,     // At least 50 holders
      limit: 20,
      sort: 'market_cap',
      sortOrder: 'desc',
    }
  );
  return { tokens: data?.list ?? [], strategy: 'launched-quality' };
}

/** Strategy 2: About-to-launch tokens on bonding curve */
async function discoverLaunching(): Promise<DiscoveryResult> {
  const data = await bitgetPost<{ list: LaunchpadToken[] }>(
    '/market/v3/launchpad/tokens',
    {
      chain: 'sol',
      platforms: 'pump.fun',
      stage: 1,           // Launching (progress 0.5~1.0)
      progressMin: 0.7,   // Almost ready to launch
      holderMin: 100,
      lpMin: 3000,
      limit: 15,
    }
  );
  return { tokens: data?.list ?? [], strategy: 'launching-pumpfun' };
}

/** Strategy 3: Rankings — topGainers or Hotpicks */
async function discoverRankings(rankType: 'topGainers' | 'Hotpicks' = 'Hotpicks'): Promise<DiscoveryResult> {
  const data = await bitgetPost<{ list: LaunchpadToken[] }>(
    '/market/v3/topRank/detail',
    {
      chain: 'sol',
      name: rankType,
      limit: 15,
    }
  );
  return { tokens: data?.list ?? [], strategy: `rankings-${rankType}` };
}

// ---------------------------------------------------------------------------
// Main discovery loop — rotates strategies and filters quality
// ---------------------------------------------------------------------------

interface DiscoveredToken {
  token: LaunchpadToken;
  tier: Tier;
  strategy: string;
}

// Track debated mints to avoid repeats
const debatedMints = new Set<string>();

type DiscoveryCallback = (token: TokenDataPack) => void;

export class TokenDiscoveryEngine {
  private interval: ReturnType<typeof setInterval> | null = null;
  private minTier: Tier = 'B';    // Only debate TIER-B and above
  private pollIntervalMs: number;
  private onTokenFound: DiscoveryCallback;
  private consecutiveFails = 0;

  constructor(onTokenFound: DiscoveryCallback, pollIntervalMs = 90_000) {
    this.onTokenFound = onTokenFound;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    console.log(`[Discovery] Starting token discovery (poll every ${this.pollIntervalMs / 1000}s, min tier: ${this.minTier})`);
    // Run immediately on start
    this.poll();
    this.interval = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log('[Discovery] Stopped');
  }

  private async poll(): Promise<void> {
    // Try ALL strategies in sequence — first one to yield a qualified token wins
    const strategies = [discoverLaunched, discoverLaunching, discoverRankings];
    let found = false;

    for (const strategyFn of strategies) {
      if (found) break;

      try {
        const result = await strategyFn();
        if (result.tokens.length === 0) {
          console.log(`[Discovery] Strategy: ${result.strategy} → 0 tokens`);
          continue;
        }

        console.log(`[Discovery] Strategy: ${result.strategy} → ${result.tokens.length} tokens found`);

        // Filter: quality + safety + not-debated-before
        const candidates: DiscoveredToken[] = [];
        for (const t of result.tokens) {
          if (debatedMints.has(t.contract)) continue;
          if (hasSafetyRedFlags(t)) continue;
          const tier = rateTier(t);
          if (this.tierRank(tier) >= this.tierRank(this.minTier)) {
            candidates.push({ token: t, tier, strategy: result.strategy });
          }
        }

        if (candidates.length === 0) {
          console.log(`[Discovery] ${result.strategy}: all filtered out by TIER/safety/dedup`);
          continue;
        }

        // Sort by tier then market cap, pick best
        candidates.sort((a, b) => {
          const tierDiff = this.tierRank(b.tier) - this.tierRank(a.tier);
          if (tierDiff !== 0) return tierDiff;
          return parseFloat(b.token.market_cap || '0') - parseFloat(a.token.market_cap || '0');
        });

        const best = candidates[0];
        debatedMints.add(best.token.contract);
        // Cap memory
        if (debatedMints.size > 200) {
          const first = debatedMints.values().next().value;
          if (first) debatedMints.delete(first);
        }

        console.log(`[Discovery] 🎯 Selected: $${best.token.symbol} (${best.token.name}) — TIER-${best.tier} | MC: $${best.token.market_cap} | Strategy: ${best.strategy}`);

        this.consecutiveFails = 0;
        found = true;
        const dataPack = this.toDataPack(best);
        this.onTokenFound(dataPack);
      } catch (err) {
        console.warn(`[Discovery] Strategy error:`, (err as Error).message);
      }
    }

    if (!found) {
      this.consecutiveFails++;
      console.log(`[Discovery] No tokens found this cycle (consecutive fails: ${this.consecutiveFails})`);

      // Re-poll sooner if API is flaky
      if (this.consecutiveFails >= 2 && this.consecutiveFails <= 5) {
        console.log(`[Discovery] Retrying in 30s due to API failures...`);
        setTimeout(() => this.poll(), 30_000);
      }
    }
  }

  private tierRank(tier: Tier): number {
    return { S: 4, A: 3, B: 2, C: 1 }[tier];
  }

  private toDataPack(discovered: DiscoveredToken): TokenDataPack {
    const t = discovered.token;
    const mcUsd = parseFloat(t.market_cap || '0');
    // Rough SOL conversion (estimate if no price, use ~$150/SOL)
    const solPrice = 150;
    const mcSol = mcUsd / solPrice;

    // Decode HTML entities from API responses (e.g. &amp; → &)
    const decode = (s: string) => s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    return {
      mint: t.contract,
      name: decode(t.name),
      symbol: decode(t.symbol),
      initialBuy: 0,
      marketCapSol: mcSol,
      createdAt: t.issue_date ? new Date(t.issue_date).getTime() : Date.now(),
      bitget: {
        price: t.price,
        holders: t.holders,
        liquidity: t.liquidity,
        top10HolderPercent: t.top10_holder_percent,
        devRugPercent: t.dev_rug_percent,
        devIssueCoinCount: t.dev_issue_coin_count,
        // txInfo will be fetched separately by dataAggregator enrichment
      },
    };
  }
}
