// X402DocsPanel — in-app documentation for the x402 Paid API endpoints
// Supports EN/ZH via lang prop

import { useState } from 'react';

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

const T = {
  en: {
    title: 'x402 Paid API',
    subtitle: 'Agent Colosseum exposes a pay-per-query AI consensus oracle. External AI agents and DApps can query consensus data or request debates by paying in SOL — fully automated, no API keys required.',
    sectionPricing: 'Pricing',
    sectionFlow: 'Payment Flow',
    section402: '402 Response Schema',
    section200: 'Consensus Response (after payment)',
    sectionCurl: 'Example: curl',
    sectionJs: 'Example: JavaScript / Node.js',
    sectionConfig: 'Server Configuration',
    colEndpoint: 'ENDPOINT',
    colPrice: 'PRICE',
    colDesc: 'DESCRIPTION',
    rows: [
      { desc: 'Query latest AI consensus for a token' },
      { desc: 'Request a new AI debate on a specific token' },
      { desc: 'Discover pricing & payment instructions' },
    ],
    flowSteps: [
      { label: 'Request endpoint',  detail: 'GET /api/consensus/:mint' },
      { label: 'Receive 402',       detail: 'Server returns payment instructions (payTo, amount in lamports)' },
      { label: 'Pay on-chain',      detail: 'Transfer SOL to payTo address on Solana mainnet' },
      { label: 'Attach proof',      detail: 'Retry request with X-PAYMENT: <tx_signature> header' },
      { label: 'Receive data',      detail: '200 OK + consensus JSON response' },
    ],
    configNote: '— Set the receiving Solana wallet address via environment variable:',
    configWarn: 'is not set, paid endpoints return',
    footer: '// ARENA_PROTOCOL.md — Full WebSocket protocol documentation available in the repository',
  },
  zh: {
    title: 'x402 付费 API',
    subtitle: 'Agent Colosseum 提供按查询付费的 AI 共识预言机。外部 AI Agent 和 DApp 可通过支付 SOL 查询共识数据或发起辩论——全自动，无需 API 密钥。',
    sectionPricing: '价格表',
    sectionFlow: '付款流程',
    section402: '402 响应 Schema',
    section200: '共识响应（付款后）',
    sectionCurl: '示例：curl',
    sectionJs: '示例：JavaScript / Node.js',
    sectionConfig: '服务端配置',
    colEndpoint: '端点',
    colPrice: '价格',
    colDesc: '描述',
    rows: [
      { desc: '查询某代币的最新 AI 共识' },
      { desc: '对指定代币发起新的 AI 辩论' },
      { desc: '获取价格及付款指令（免费）' },
    ],
    flowSteps: [
      { label: '请求端点',     detail: 'GET /api/consensus/:mint' },
      { label: '收到 402',    detail: '服务器返回付款指令（payTo 地址和金额）' },
      { label: '链上转账',     detail: '向 payTo 地址在 Solana 主网转账 SOL' },
      { label: '附上凭证',     detail: '携带 X-PAYMENT: <tx_signature> 头部重试请求' },
      { label: '获取数据',     detail: '200 OK + 共识 JSON 响应' },
    ],
    configNote: '— 通过环境变量设置 Solana 收款钱包地址：',
    configWarn: '未设置时，付费端点返回',
    footer: '// ARENA_PROTOCOL.md — 完整 WebSocket 协议文档见仓库根目录',
  },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CodeBlock({ code, lang = 'bash' }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: 'relative', background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(0,255,200,0.2)', borderRadius: '6px', margin: '8px 0 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid rgba(0,255,200,0.15)', background: 'rgba(0,255,200,0.05)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-cyan)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{lang}</span>
        <button onClick={() => { navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
          style={{ background: 'transparent', border: '1px solid rgba(0,255,200,0.3)', color: copied ? 'var(--accent-neon)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '10px', padding: '2px 8px', cursor: 'pointer', borderRadius: '3px', letterSpacing: '0.05em', transition: 'color 0.2s' }}>
          {copied ? 'COPIED ✓' : 'COPY'}
        </button>
      </div>
      <pre style={{ margin: 0, padding: '14px 16px', fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre' }}>{code}</pre>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '28px 0 14px' }}>
      <div style={{ width: '3px', height: '18px', background: 'var(--accent-cyan)', borderRadius: '2px' }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-cyan)', fontSize: '13px', letterSpacing: '0.12em', textTransform: 'uppercase' }}>{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code snippets (language-agnostic — code examples stay in English)
// ---------------------------------------------------------------------------

const CURL_EXAMPLE = `# Step 1 — Hit the endpoint without payment (get 402 instructions)
curl http://your-server:3001/api/consensus/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# → HTTP 402
# { "x402Version": 1, "accepts": [{ "network": "solana", "currency": "SOL",
#   "payTo": "<server-wallet>", "amount": "1000000", "amountSol": "0.001" }] }

# Step 2 — Send SOL on-chain (0.001 SOL → payTo address)
# Step 3 — Retry with X-PAYMENT header
curl -H "X-PAYMENT: 5wHu1qwD7q..." \\
  http://your-server:3001/api/consensus/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
# → HTTP 200 + consensus data`;

const JS_EXAMPLE = `import { Connection, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

async function queryConsensus(mint, payerKeypair) {
  const BASE_URL = "http://your-server:3001";

  // 1. Get payment instructions
  const res402 = await fetch(\`\${BASE_URL}/api/consensus/\${mint}\`);
  if (res402.status !== 402) throw new Error("Expected 402");
  const { accepts } = await res402.json();
  const { payTo, amount } = accepts[0];

  // 2. Pay on-chain
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payerKeypair.publicKey,
      toPubkey: new PublicKey(payTo),
      lamports: Number(amount),
    })
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [payerKeypair]);

  // 3. Query with payment proof
  const res = await fetch(\`\${BASE_URL}/api/consensus/\${mint}\`, {
    headers: { "X-PAYMENT": signature },
  });
  return res.json(); // { consensus, consensusConfidence, ... }
}`;

const RESPONSE_402 = `{
  "x402Version": 1,
  "accepts": [
    {
      "network": "solana",
      "currency": "SOL",
      "payTo": "<server-wallet-address>",
      "amount": "1000000",        // lamports
      "amountSol": "0.001",       // human-readable
      "description": "Query latest AI consensus for a Solana meme coin"
    }
  ]
}`;

const RESPONSE_200 = `{
  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "token": { "name": "Hollow", "symbol": "HOLLOW" },
  "consensus": "bull",
  "consensusConfidence": 85,
  "bullCount": 3,
  "bearCount": 1,
  "holdCount": 0,
  "totalAgents": 4,
  "topArguments": [],
  "wasEscalated": true,
  "debateId": "debate-42-1711234567890",
  "timestamp": 1711234567890
}`;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function X402DocsPanel({ lang = 'en' }: { lang?: 'en' | 'zh' }) {
  const t = T[lang];
  const rows = [
    { endpoint: 'GET /api/consensus/:mint',  price: '0.001 SOL', desc: t.rows[0].desc, paid: true },
    { endpoint: 'POST /api/debate/request',  price: '0.01 SOL',  desc: t.rows[1].desc, paid: true },
    { endpoint: 'GET /api/x402/pricing',     price: 'FREE',      desc: t.rows[2].desc, paid: false },
  ];

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '32px 40px', maxWidth: '900px', margin: '0 auto', width: '100%' }}>

      {/* Header */}
      <div style={{ marginBottom: '32px', paddingBottom: '20px', borderBottom: '1px solid rgba(0,255,200,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-neon)', fontSize: '22px', letterSpacing: '0.04em' }}>{t.title}</span>
          <span style={{ background: 'rgba(0,255,200,0.15)', border: '1px solid var(--accent-cyan)', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)', fontSize: '10px', padding: '2px 8px', borderRadius: '3px', letterSpacing: '0.1em' }}>
            HTTP 402 Payment Required
          </span>
        </div>
        <p style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '14px', lineHeight: 1.6, margin: 0 }}>{t.subtitle}</p>
      </div>

      {/* Pricing Table */}
      <SectionTitle>{t.sectionPricing}</SectionTitle>
      <div style={{ border: '1px solid rgba(0,255,200,0.2)', borderRadius: '6px', overflow: 'hidden', marginBottom: '8px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 3fr', background: 'rgba(0,255,200,0.08)', borderBottom: '1px solid rgba(0,255,200,0.2)', padding: '10px 16px' }}>
          {[t.colEndpoint, t.colPrice, t.colDesc].map(h => (
            <span key={h} style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-cyan)', letterSpacing: '0.1em', fontWeight: 700 }}>{h}</span>
          ))}
        </div>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 3fr', padding: '12px 16px', borderBottom: i < 2 ? '1px solid rgba(255,255,255,0.05)' : 'none', background: i % 2 === 0 ? 'rgba(0,0,0,0.2)' : 'transparent' }}>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-primary)' }}>{row.endpoint}</code>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700, color: row.paid ? 'var(--accent-neon)' : 'var(--text-muted)' }}>{row.price}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-secondary)' }}>{row.desc}</span>
          </div>
        ))}
      </div>

      {/* Payment Flow */}
      <SectionTitle>{t.sectionFlow}</SectionTitle>
      <div style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(0,255,200,0.15)', borderRadius: '6px', padding: '20px 24px', marginBottom: '8px' }}>
        {t.flowSteps.map(({ label, detail }, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 700, color: 'var(--accent-cyan)', letterSpacing: '0.08em', minWidth: '24px', paddingTop: '1px' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{detail}</div>
              </div>
            </div>
            {i < t.flowSteps.length - 1 && (
              <div style={{ marginLeft: '40px', color: 'rgba(0,255,200,0.4)', fontFamily: 'var(--font-mono)', fontSize: '12px', padding: '3px 0' }}>↓</div>
            )}
          </div>
        ))}
      </div>

      {/* Schema blocks */}
      <SectionTitle>{t.section402}</SectionTitle>
      <CodeBlock code={RESPONSE_402} lang="json" />

      <SectionTitle>{t.section200}</SectionTitle>
      <CodeBlock code={RESPONSE_200} lang="json" />

      <SectionTitle>{t.sectionCurl}</SectionTitle>
      <CodeBlock code={CURL_EXAMPLE} lang="bash" />

      <SectionTitle>{t.sectionJs}</SectionTitle>
      <CodeBlock code={JS_EXAMPLE} lang="javascript" />

      {/* Server config */}
      <SectionTitle>{t.sectionConfig}</SectionTitle>
      <div style={{ background: 'rgba(255,200,0,0.06)', border: '1px solid rgba(255,200,0,0.25)', borderRadius: '6px', padding: '14px 18px', fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        <span style={{ color: '#ffd700', fontWeight: 700 }}>⚠ X402_PAY_TO</span>
        {' '}{t.configNote}
        <CodeBlock code={`export X402_PAY_TO="YourSolanaWalletAddress"`} lang="bash" />
        {lang === 'zh'
          ? <>{' '}<code style={{ color: 'var(--accent-neon)' }}>X402_PAY_TO</code> {t.configWarn} <code style={{ color: 'var(--danger)' }}>503 Service Unavailable</code>。</>
          : <>If <code style={{ color: 'var(--accent-neon)' }}>X402_PAY_TO</code> {t.configWarn} <code style={{ color: 'var(--danger)' }}>503 Service Unavailable</code>.</>
        }
      </div>

      {/* Footer */}
      <div style={{ marginTop: '40px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.08)', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>
        {t.footer}
      </div>
    </div>
  );
}
