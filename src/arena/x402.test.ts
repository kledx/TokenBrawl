// x402 Integration Test — run with: npx tsx src/arena/x402.test.ts
// Tests the x402 middleware and payment gating without needing a real Solana wallet

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { x402Gate, getPricingTable, type X402PaymentRequired } from './x402Middleware.js';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}`);
    failed++;
  }
}

async function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  body: string;
  headers: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => body += c.toString());
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          body,
          headers: res.headers as Record<string, string>,
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function httpPost(port: number, path: string, data: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => body += c.toString());
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Mini test server — simulates x402 gated endpoints
// ---------------------------------------------------------------------------

function createTestServer(payTo: string | undefined): ReturnType<typeof createServer> {
  // Set env for middleware
  if (payTo) {
    process.env.X402_PAY_TO = payTo;
  } else {
    delete process.env.X402_PAY_TO;
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url || '/';

    // Free endpoint
    if (url === '/api/leaderboard') {
      res.writeHead(200);
      res.end(JSON.stringify({ agents: [], totalDebates: 0 }));
      return;
    }

    // Paid endpoint — consensus
    if (url.startsWith('/api/consensus/')) {
      const allowed = await x402Gate(req, res, 'consensus');
      if (!allowed) return;
      res.writeHead(200);
      res.end(JSON.stringify({ consensus: 'bull', confidence: 85 }));
      return;
    }

    // Paid endpoint — debate request
    if (url === '/api/debate/request' && req.method === 'POST') {
      const allowed = await x402Gate(req, res, 'debate_request');
      if (!allowed) return;
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'debate_started' }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests(): Promise<void> {
  const TEST_WALLET = 'FakeTestWa11etAddressForTesting123456789012345';
  const port = 19402;

  console.log('\n🧪 x402 Integration Tests\n');

  // =========================================================================
  // TEST 1: Free endpoint returns 200 (not gated)
  // =========================================================================
  console.log('Test 1: Free endpoint not gated');
  const server1 = createTestServer(TEST_WALLET);
  await new Promise<void>(r => server1.listen(port, r));

  const res1 = await httpGet(port, '/api/leaderboard');
  assert(res1.status === 200, 'Free endpoint returns 200');

  server1.close();
  await new Promise(r => setTimeout(r, 100));

  // =========================================================================
  // TEST 2: Paid endpoint returns 402 without X-PAYMENT header
  // =========================================================================
  console.log('\nTest 2: Paid endpoint returns 402 without payment');
  const server2 = createTestServer(TEST_WALLET);
  await new Promise<void>(r => server2.listen(port, r));

  const res2 = await httpGet(port, '/api/consensus/SomeMintAddress');
  assert(res2.status === 402, 'Returns 402 Payment Required');

  const body2: X402PaymentRequired = JSON.parse(res2.body);
  assert(body2.x402Version === 1, 'x402Version is 1');
  assert(body2.accepts.length === 1, 'Has one payment option');
  assert(body2.accepts[0].network === 'solana', 'Network is solana');
  assert(body2.accepts[0].payTo === TEST_WALLET, 'payTo matches configured wallet');
  assert(body2.accepts[0].amount === '1000000', 'Amount is 1000000 lamports (0.001 SOL)');

  server2.close();
  await new Promise(r => setTimeout(r, 100));

  // =========================================================================
  // TEST 3: Paid endpoint returns 403 with invalid signature
  // =========================================================================
  console.log('\nTest 3: Invalid payment signature returns 403');
  const server3 = createTestServer(TEST_WALLET);
  await new Promise<void>(r => server3.listen(port, r));

  const res3 = await httpGet(port, '/api/consensus/SomeMintAddress', {
    'X-PAYMENT': 'invalid-short-sig',
  });
  assert(res3.status === 403, 'Returns 403 for short/invalid signature');

  server3.close();
  await new Promise(r => setTimeout(r, 100));

  // =========================================================================
  // TEST 4: POST /api/debate/request returns 402
  // =========================================================================
  console.log('\nTest 4: POST debate/request returns 402');
  const server4 = createTestServer(TEST_WALLET);
  await new Promise<void>(r => server4.listen(port, r));

  const res4 = await httpPost(port, '/api/debate/request', '{"mint":"xxx"}');
  assert(res4.status === 402, 'POST debate request returns 402');

  const body4: X402PaymentRequired = JSON.parse(res4.body);
  assert(body4.accepts[0].amount === '10000000', 'Debate request costs 10000000 lamports (0.01 SOL)');

  server4.close();
  await new Promise(r => setTimeout(r, 100));

  // =========================================================================
  // TEST 5: No X402_PAY_TO configured returns 503
  // =========================================================================
  console.log('\nTest 5: No wallet configured returns 503');
  const server5 = createTestServer(undefined);
  await new Promise<void>(r => server5.listen(port, r));

  const res5 = await httpGet(port, '/api/consensus/SomeMintAddress');
  assert(res5.status === 503, 'Returns 503 when no wallet configured');

  server5.close();
  await new Promise(r => setTimeout(r, 100));

  // =========================================================================
  // TEST 6: Pricing table structure
  // =========================================================================
  console.log('\nTest 6: Pricing table');
  const pricing = getPricingTable();
  assert('consensus' in pricing, 'Has consensus pricing');
  assert('debate_request' in pricing, 'Has debate_request pricing');
  assert(pricing.consensus.priceSol === 0.001, 'Consensus price is 0.001 SOL');
  assert(pricing.debate_request.priceSol === 0.01, 'Debate request price is 0.01 SOL');

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('✅ All tests passed!\n');
  }
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
