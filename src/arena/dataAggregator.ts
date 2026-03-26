// Data Aggregator — Fetches and packages token data for debates
// Combines PumpPortal event data + Bitget Wallet Skills API data
// Standalone version — no SHLL project dependency

import type { TokenDataPack } from './types';
import type { PumpToken } from './pumpTypes';

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
    console.warn(`[DataAggregator] Bitget API ${path} failed:`, err);
    return null;
  }
}

export async function aggregateTokenData(pumpToken: PumpToken): Promise<TokenDataPack> {
  const chain = 'solana';
  const contract = pumpToken.mint;

  const [tokenInfoResult, securityResult, txInfoResult] = await Promise.allSettled([
    bitgetPost<{ list: Array<Record<string, string>> }>(
      '/market/v3/coin/batchGetBaseInfo',
      { list: [{ chain, contract }] }
    ),
    bitgetPost<{ list: Array<Record<string, unknown>> }>(
      '/market/v3/coin/security/audits',
      { list: [{ chain, contract }], source: 'bg' }
    ),
    bitgetPost<Record<string, Record<string, string>>>(
      '/market/v3/coin/getTxInfo',
      { chain, contract }
    ),
  ]);

  const tokenInfo = tokenInfoResult.status === 'fulfilled' && tokenInfoResult.value
    ? (tokenInfoResult.value as { list?: Array<Record<string, string>> })?.list?.[0]
    : null;

  const security = securityResult.status === 'fulfilled' && securityResult.value
    ? (securityResult.value as { list?: Array<Record<string, unknown>> })?.list?.[0]
    : null;

  const txInfo = txInfoResult.status === 'fulfilled' ? txInfoResult.value : null;

  const pack: TokenDataPack = {
    mint: pumpToken.mint,
    name: pumpToken.name,
    symbol: pumpToken.symbol,
    initialBuy: pumpToken.initialBuy,
    marketCapSol: pumpToken.marketCapSol,
    createdAt: pumpToken.timestamp,
  };

  if (tokenInfo || security || txInfo) {
    const tx5m = (txInfo as Record<string, Record<string, string>> | null)?.['5m'];
    const tx1h = (txInfo as Record<string, Record<string, string>> | null)?.['1h'];

    pack.bitget = {
      price: tokenInfo?.price,
      holders: tokenInfo?.holders,
      liquidity: tokenInfo?.liquidity,
      top10HolderPercent: tokenInfo?.top10_holder_percent,
      devRugPercent: tokenInfo?.dev_rug_percent,
      devIssueCoinCount: tokenInfo?.dev_issue_coin_count,
      highRisk: security?.highRisk as boolean | undefined,
      riskCount: security?.riskCount as number | undefined,
      buyTax: security?.buyTax as string | undefined,
      sellTax: security?.sellTax as string | undefined,
      freezeAuth: security?.freezeAuth as boolean | undefined,
      mintAuth: security?.mintAuth as boolean | undefined,
      txInfo: tx5m || tx1h ? {
        buyVolume5m: tx5m?.buyVolume,
        sellVolume5m: tx5m?.sellVolume,
        buyCount5m: tx5m?.buyCount,
        sellCount5m: tx5m?.sellCount,
        buyVolume1h: tx1h?.buyVolume,
        sellVolume1h: tx1h?.sellVolume,
      } : undefined,
    };
  }

  return pack;
}

export async function aggregateFromMint(mint: string): Promise<TokenDataPack> {
  const stub: PumpToken = {
    mint,
    name: 'Unknown',
    symbol: '???',
    uri: '',
    traderPublicKey: '',
    initialBuy: 0,
    marketCapSol: 0,
    timestamp: Date.now(),
  };
  return aggregateTokenData(stub);
}
