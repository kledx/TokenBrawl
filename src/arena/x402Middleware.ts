// x402 Middleware — HTTP 402 Payment Required protocol for Agent Colosseum
// Intercepts paid API endpoints, returns 402 with payment instructions or verifies payment

import type { IncomingMessage, ServerResponse } from 'http';
import { verifySolanaPayment, solToLamports } from './x402PaymentVerifier.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface X402PaymentRequired {
  x402Version: 1;
  accepts: Array<{
    network: 'solana';
    currency: 'SOL';
    payTo: string;
    amount: string;        // Lamports as string
    amountSol: string;     // Human-readable SOL amount
    description: string;
  }>;
}

export interface X402EndpointConfig {
  /** Price in SOL */
  priceSol: number;
  /** Human-readable description */
  description: string;
}

// ---------------------------------------------------------------------------
// Pricing table
// ---------------------------------------------------------------------------

const PRICING: Record<string, X402EndpointConfig> = {
  'consensus': {
    priceSol: 0.001,
    description: 'Query latest AI consensus for a Solana meme coin',
  },
  'debate_request': {
    priceSol: 0.01,
    description: 'Request a new AI agent debate on a specific token',
  },
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Check x402 payment for a paid endpoint.
 * Returns `true` if the request should proceed (payment verified or not required).
 * Returns `false` if the response was already sent (402 or 403).
 */
export async function x402Gate(
  req: IncomingMessage,
  res: ServerResponse,
  endpointKey: string,
): Promise<boolean> {
  const payTo = process.env.X402_PAY_TO;

  // If no pay-to address configured, disable x402 (service unavailable for paid features)
  if (!payTo) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'x402 payment not configured',
      message: 'Server has no receiving wallet configured. Set X402_PAY_TO environment variable.',
    }));
    return false;
  }

  const config = PRICING[endpointKey];
  if (!config) {
    // No pricing config = free endpoint, allow through
    return true;
  }

  const rawPaymentHeader = req.headers['x-payment'];
  // Node.js may return string[] if the header is sent multiple times; take first value
  const paymentHeader = Array.isArray(rawPaymentHeader) ? rawPaymentHeader[0] : rawPaymentHeader;

  // No payment header → return 402 with payment instructions
  if (!paymentHeader) {
    const paymentRequired: X402PaymentRequired = {
      x402Version: 1,
      accepts: [{
        network: 'solana',
        currency: 'SOL',
        payTo,
        amount: String(solToLamports(config.priceSol)),
        amountSol: String(config.priceSol),
        description: config.description,
      }],
    };

    res.writeHead(402, {
      'Content-Type': 'application/json',
      'X-402-Version': '1',
    });
    res.end(JSON.stringify(paymentRequired));
    return false;
  }

  // Has payment header → verify on-chain
  const txSignature = paymentHeader.trim();
  if (!txSignature || txSignature.length < 32) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid X-PAYMENT header: expected a Solana transaction signature' }));
    return false;
  }

  const expectedLamports = solToLamports(config.priceSol);
  const result = await verifySolanaPayment(txSignature, payTo, expectedLamports);

  if (!result.valid) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Payment verification failed',
      reason: result.reason,
    }));
    return false;
  }

  // Payment verified — proceed
  return true;
}

/**
 * Get pricing info for documentation/display purposes.
 */
export function getPricingTable(): Record<string, X402EndpointConfig> {
  return { ...PRICING };
}
