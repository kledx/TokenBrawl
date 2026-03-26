// Price Tracker — Backtesting consensus accuracy
// After each debate consensus, tracks the token price at intervals (5m, 15m, 1h)
// Determines if the consensus prediction was correct

import type { BacktestRecord, Stance } from './types';

// ---------------------------------------------------------------------------
// Bitget price lookup
// ---------------------------------------------------------------------------

const BITGET_BASE = 'https://copenapi.bgwapi.io';

async function makeSign(method: string, path: string, bodyStr: string, ts: string): Promise<string> {
  const message = method + path + bodyStr + ts;
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getTokenPrice(chain: string, contract: string): Promise<number | null> {
  try {
    const ts = String(Date.now());
    const path = '/market/v3/coin/batchGetBaseInfo';
    const body = { chain, contractList: [contract] };
    const bodyStr = JSON.stringify(body);
    const sign = await makeSign('POST', path, bodyStr, ts);

    const resp = await fetch(BITGET_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'channel': 'toc_agent', 'brand': 'toc_agent',
        'clientversion': '10.0.0', 'language': 'en', 'token': 'toc_agent',
        'X-SIGN': sign, 'X-TIMESTAMP': ts,
      },
      body: bodyStr,
    });

    if (!resp.ok) return null;
    const result = await resp.json();
    const info = result?.data?.[0];
    return info?.price ? parseFloat(info.price) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backtest Engine
// ---------------------------------------------------------------------------

export class PriceTracker {
  private records: BacktestRecord[] = [];
  private pendingChecks: Map<string, ReturnType<typeof setTimeout>[]> = new Map();

  /** Register a new consensus result for tracking */
  track(debateId: string, tokenMint: string, tokenSymbol: string,
        consensus: Stance, consensusConfidence: number, currentPrice: number): void {

    const record: BacktestRecord = {
      debateId,
      tokenMint,
      tokenSymbol,
      consensus,
      consensusConfidence,
      priceAtDebate: currentPrice,
      timestamp: Date.now(),
    };

    this.records.push(record);
    // Cap at 100 records
    if (this.records.length > 100) this.records.shift();

    console.log(`[Backtest] Tracking $${tokenSymbol}: ${consensus.toUpperCase()} @ ${consensusConfidence}% | price: $${currentPrice.toFixed(8)}`);

    // Schedule price checks at 5m, 15m, 1h
    const timers: ReturnType<typeof setTimeout>[] = [];

    timers.push(setTimeout(() => this.checkPrice(debateId, tokenMint, '5m'), 5 * 60 * 1000));
    timers.push(setTimeout(() => this.checkPrice(debateId, tokenMint, '15m'), 15 * 60 * 1000));
    timers.push(setTimeout(() => this.checkPrice(debateId, tokenMint, '1h'), 60 * 60 * 1000));

    this.pendingChecks.set(debateId, timers);
  }

  /** Get all backtest records */
  getRecords(): BacktestRecord[] {
    return [...this.records];
  }

  /** Get accuracy stats */
  getStats(): { total: number; checked: number; correct: number; accuracy: number } {
    const checked = this.records.filter(r => r.wasCorrect !== undefined);
    const correct = checked.filter(r => r.wasCorrect === true);
    return {
      total: this.records.length,
      checked: checked.length,
      correct: correct.length,
      accuracy: checked.length > 0 ? Math.round((correct.length / checked.length) * 100) : 0,
    };
  }

  /** Clean up all timers */
  destroy(): void {
    for (const timers of this.pendingChecks.values()) {
      timers.forEach(t => clearTimeout(t));
    }
    this.pendingChecks.clear();
  }

  private async checkPrice(debateId: string, tokenMint: string, interval: '5m' | '15m' | '1h'): Promise<void> {
    const record = this.records.find(r => r.debateId === debateId);
    if (!record) return;

    const price = await getTokenPrice('sol', tokenMint);
    if (price === null) {
      console.log(`[Backtest] ${record.tokenSymbol} @ ${interval}: price fetch failed`);
      return;
    }

    // Store price
    switch (interval) {
      case '5m': record.priceAfter5m = price; break;
      case '15m': record.priceAfter15m = price; break;
      case '1h': record.priceAfter1h = price; break;
    }

    // Determine correctness (use latest available price)
    const latestPrice = record.priceAfter1h ?? record.priceAfter15m ?? record.priceAfter5m;
    if (latestPrice !== undefined && record.priceAtDebate > 0) {
      const priceChange = (latestPrice - record.priceAtDebate) / record.priceAtDebate;
      const pctStr = (priceChange * 100).toFixed(2);

      // BULL correct if price went up >2%, BEAR correct if price went down >2%
      // HOLD correct if price moved less than 5% either way
      if (record.consensus === 'bull') {
        record.wasCorrect = priceChange > 0.02;
      } else if (record.consensus === 'bear') {
        record.wasCorrect = priceChange < -0.02;
      } else {
        record.wasCorrect = Math.abs(priceChange) < 0.05;
      }

      const emoji = record.wasCorrect ? '✅' : '❌';
      console.log(`[Backtest] ${emoji} $${record.tokenSymbol} @ ${interval}: ${record.consensus.toUpperCase()} prediction ${record.wasCorrect ? 'CORRECT' : 'WRONG'} (${pctStr}%)`);

      // Log overall accuracy
      const stats = this.getStats();
      if (stats.checked > 0) {
        console.log(`[Backtest] Overall accuracy: ${stats.accuracy}% (${stats.correct}/${stats.checked} correct)`);
      }
    }
  }
}
