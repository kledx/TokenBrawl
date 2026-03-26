#!/usr/bin/env node
// x402 Oracle Query Client — Agent Colosseum
// Pays SOL on-chain and fetches AI consensus data via x402 protocol
//
// Usage:
//   node x402-client.js pricing  <arena-url>
//   node x402-client.js consensus <arena-url> <mint> <keypair.json>
//   node x402-client.js debate    <arena-url> <mint> <keypair.json>
//
// keypair.json: Solana keypair as byte array, e.g. from `solana-keygen new`

const https = require('https');
const http = require('http');
const fs = require('fs');

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

async function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = options.body || null;
    const headers = options.headers || {};
    if (body) headers['Content-Length'] = String(Buffer.byteLength(body));

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ----------------------------------------------------------------
// Commands
// ----------------------------------------------------------------

async function cmdPricing(arenaUrl) {
  console.log(`\n📋 Fetching pricing from ${arenaUrl}/api/x402/pricing ...\n`);
  const res = await httpFetch(`${arenaUrl}/api/x402/pricing`);
  if (res.status === 200) {
    console.log('Pricing Table:');
    for (const [endpoint, info] of Object.entries(res.body)) {
      console.log(`  ${endpoint.padEnd(25)} → ${info.priceSol} SOL — ${info.description}`);
    }
  } else {
    console.log('Response:', res.status, JSON.stringify(res.body, null, 2));
  }
}

async function cmdConsensus(arenaUrl, mint, keypairPath) {
  const endpoint = `${arenaUrl}/api/consensus/${mint}`;
  await x402Flow(endpoint, 'GET', null, keypairPath);
}

async function cmdDebate(arenaUrl, mint, keypairPath) {
  const endpoint = `${arenaUrl}/api/debate/request`;
  const body = JSON.stringify({ mint });
  await x402Flow(endpoint, 'POST', body, keypairPath);
}

async function x402Flow(endpoint, method, body, keypairPath) {
  // Step 1: Request without payment
  console.log(`\n[1/3] Requesting ${method} ${endpoint}`);
  const res402 = await httpFetch(endpoint, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body,
  });

  if (res402.status !== 402) {
    console.log(`ℹ️  Got ${res402.status} (not 402):`, JSON.stringify(res402.body, null, 2));
    return;
  }

  const payment = res402.body;
  const accept = payment.accepts?.[0];
  if (!accept) {
    console.error('❌ No payment instructions in 402 response');
    return;
  }

  const { payTo, amount, amountSol, description } = accept;
  console.log(`\n[2/3] Payment required:`);
  console.log(`      Description : ${description}`);
  console.log(`      Pay to      : ${payTo}`);
  console.log(`      Amount      : ${amountSol} SOL (${amount} lamports)`);

  // Step 2: Load keypair & pay on-chain
  if (!keypairPath || !fs.existsSync(keypairPath)) {
    console.log('\n⚠️  No keypair provided. To complete payment, run:');
    console.log(`   solana transfer ${payTo} ${amountSol} --url mainnet-beta`);
    console.log('   Then retry with X-PAYMENT: <signature>');
    return;
  }

  const keypairBytes = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
  console.log('\n🔑 Signing transaction...');

  // Build and send minimal SOL transfer (Number for web3.js v1 compatibility)
  const signature = await sendSolTransfer(keypairBytes, payTo, Number(amount));
  if (!signature) return;

  console.log(`   Tx signature: ${signature}`);

  // Step 3: Retry with payment proof
  console.log('\n[3/3] Fetching data with payment proof...');
  const resData = await httpFetch(endpoint, {
    method,
    headers: {
      'X-PAYMENT': signature,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });

  if (resData.status === 200) {
    console.log('\n✅ Consensus data:\n');
    console.log(JSON.stringify(resData.body, null, 2));
  } else {
    console.error(`❌ Error ${resData.status}:`, JSON.stringify(resData.body, null, 2));
  }
}

// Minimal SOL transfer — requires @solana/web3.js in PATH
// Falls back to printing instructions if unavailable
async function sendSolTransfer(keypairBytes, toAddress, lamports) {
  try {
    const { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey } = require('@solana/web3.js');
    const payer = Keypair.fromSecretKey(new Uint8Array(keypairBytes));
    const connection = new Connection(SOLANA_RPC, 'confirmed');
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey(toAddress),
        lamports,           // Number (web3.js v1 compatible)
      })
    );
    return await sendAndConfirmTransaction(connection, tx, [payer]);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.log('\n⚠️  @solana/web3.js not installed. Install it with:');
      console.log('   npm install @solana/web3.js');
      console.log('\nOr manually send the transfer and run:');
      console.log(`   curl -H "X-PAYMENT: <signature>" <endpoint>`);
    } else {
      console.error('❌ Transfer failed:', e.message);
    }
    return null;
  }
}

// ----------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------

const [,, cmd, arenaUrl, ...rest] = process.argv;

const help = `
x402 Oracle Query Client
Usage:
  node x402-client.js pricing   <arena-url>
  node x402-client.js consensus <arena-url> <mint> [keypair.json]
  node x402-client.js debate    <arena-url> <mint> [keypair.json]

Environment:
  SOLANA_RPC_URL  Solana RPC endpoint (default: mainnet-beta)

Examples:
  node x402-client.js pricing http://localhost:3001
  node x402-client.js consensus http://localhost:3001 EPjFWdd5... my-wallet.json
`;

(async () => {
  switch (cmd) {
    case 'pricing':
      await cmdPricing(arenaUrl);
      break;
    case 'consensus':
      await cmdConsensus(arenaUrl, rest[0], rest[1]);
      break;
    case 'debate':
      await cmdDebate(arenaUrl, rest[0], rest[1]);
      break;
    default:
      console.log(help);
  }
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
