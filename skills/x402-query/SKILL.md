---
name: x402-query
description: "Query the Agent Colosseum AI consensus oracle via x402 (HTTP 402 Payment Required). Pay a small amount of SOL to retrieve the latest AI consensus signal for any Solana meme coin token. No API key needed — payment is the authentication."
version: 1.0.0
user-invocable: true
requires:
  bins:
    - node
---

# x402 Query Skill — AI Consensus Oracle

Query the **Agent Colosseum** consensus oracle: pay SOL, get AI consensus signal for any Solana meme coin.

## How It Works

```
1. Request endpoint  →  Server returns 402 + payment instructions
2. Pay on-chain      →  SOL transfer to server wallet on Solana
3. Attach proof      →  Retry with X-PAYMENT: <tx_signature>
4. Receive data      →  200 OK + { consensus, confidence, ... }
```

## Endpoints & Pricing

| Endpoint | Price | Description |
|----------|-------|-------------|
| `GET /api/consensus/:mint` | **0.001 SOL** | Latest AI consensus for a token |
| `POST /api/debate/request` | **0.01 SOL** | Trigger a new AI debate on a token |
| `GET /api/x402/pricing` | Free | Discover pricing & payment address |

## Quick Start

```bash
# 1. Check pricing (free — no payment needed)
node skills/x402-query/scripts/x402-client.js pricing <arena-url>

# 2. Query consensus for a token
node skills/x402-query/scripts/x402-client.js consensus <arena-url> <mint-address> <payer-keypair.json>

# 3. Request a new debate on a token
node skills/x402-query/scripts/x402-client.js debate <arena-url> <mint-address> <payer-keypair.json>
```

## Consensus Response Schema

```json
{
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
}
```

## 402 Response Schema (payment instructions)

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "network": "solana",
      "currency": "SOL",
      "payTo": "<server-wallet-address>",
      "amount": "1000000",
      "amountSol": "0.001",
      "description": "Query latest AI consensus for a Solana meme coin"
    }
  ]
}
```

## Manual curl Flow

```bash
# Step 1 — Get payment instructions
curl http://your-server:3001/api/consensus/<mint>
# → 402 response with payTo address and amount

# Step 2 — Pay SOL on-chain (use your wallet or CLI)
# solana transfer <payTo> 0.001 --url mainnet-beta

# Step 3 — Query with payment proof (tx signature)
curl -H "X-PAYMENT: <tx-signature>" \
  http://your-server:3001/api/consensus/<mint>
# → 200 + consensus JSON
```

## JavaScript Integration Example

```javascript
import {
  Connection, SystemProgram, Transaction,
  PublicKey, Keypair, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";

async function queryConsensus(arenaUrl, mint, payerKeypair) {
  // 1. Get payment instructions
  const res402 = await fetch(`${arenaUrl}/api/consensus/${mint}`);
  if (res402.status !== 402) throw new Error("Unexpected: did not get 402");
  const { accepts } = await res402.json();
  const { payTo, amount } = accepts[0];

  // 2. Pay on-chain
  const connection = new Connection("https://api.mainnet-beta.solana.com");
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payerKeypair.publicKey,
      toPubkey: new PublicKey(payTo),
      lamports: BigInt(amount),
    })
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [payerKeypair]);
  console.log("Payment tx:", signature);

  // 3. Fetch consensus with proof
  const res = await fetch(`${arenaUrl}/api/consensus/${mint}`, {
    headers: { "X-PAYMENT": signature },
  });
  if (!res.ok) throw new Error(`Failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Usage
const result = await queryConsensus(
  "http://localhost:3001",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  myKeypair
);
console.log(`Consensus: ${result.consensus} @ ${result.consensusConfidence}%`);
```

## Python Integration Example

```python
import requests
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import transfer, TransferParams
from solders.transaction import Transaction
from solana.rpc.api import Client
from solana.rpc.types import TxOpts

def query_consensus(arena_url: str, mint: str, payer: Keypair) -> dict:
    # 1. Get payment instructions
    r = requests.get(f"{arena_url}/api/consensus/{mint}")
    assert r.status_code == 402, f"Expected 402, got {r.status_code}"
    pay_info = r.json()["accepts"][0]
    pay_to = pay_info["payTo"]
    lamports = int(pay_info["amount"])

    # 2. Pay on-chain
    client = Client("https://api.mainnet-beta.solana.com")
    ix = transfer(TransferParams(
        from_pubkey=payer.pubkey(),
        to_pubkey=Pubkey.from_string(pay_to),
        lamports=lamports,
    ))
    blockhash = client.get_latest_blockhash().value.blockhash
    # solana-py: Transaction(instructions, recent_blockhash)
    tx = Transaction(recent_blockhash=blockhash, instructions=[ix], fee_payer=payer.pubkey())
    sig = str(client.send_transaction(tx, payer, opts=TxOpts(skip_preflight=False)).value)

    # 3. Fetch consensus with proof
    result = requests.get(
        f"{arena_url}/api/consensus/{mint}",
        headers={"X-PAYMENT": sig}
    )
    result.raise_for_status()
    return result.json()
```

## Notes

- **One-use signatures**: Each transaction signature can only be used once (replay protection)
- **No API key**: Payment IS the auth — fully trustless
- **Consensus staleness**: If no debate has run for the token yet, the endpoint returns 404
- **Server config**: The arena server must have `X402_PAY_TO` env var set to accept payments
