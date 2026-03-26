// x402 Payment Verifier — Solana on-chain payment validation
// Zero external dependencies: uses native fetch + Solana JSON-RPC

// Lazy read — allows env var to be set after module import
function getSolanaRpc(): string {
  return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

// Replay protection — track used transaction signatures (in-memory, resets on restart)
const usedSignatures = new Set<string>();
const MAX_CACHE_SIZE = 10_000;

interface SolanaTransferInfo {
  confirmed: boolean;
  recipient: string;
  lamports: number;
}

/**
 * Verify a Solana SOL transfer via JSON-RPC.
 * Checks: (1) tx confirmed, (2) recipient matches, (3) amount >= expected, (4) not replayed.
 */
export async function verifySolanaPayment(
  txSignature: string,
  expectedPayTo: string,
  expectedLamports: number,
): Promise<{ valid: boolean; reason?: string }> {
  // Replay check — pre-add BEFORE the async RPC call to close the TOCTOU window.
  // Node.js is single-threaded, so has()→add() is atomic at the sync level; the
  // optimistic lock also guards against future multi-process scenarios.
  if (usedSignatures.has(txSignature)) {
    return { valid: false, reason: 'Transaction signature already used (replay)' };
  }
  usedSignatures.add(txSignature); // Optimistic lock

  // Cap memory (trim BEFORE we start async work)
  if (usedSignatures.size > MAX_CACHE_SIZE) {
    const first = usedSignatures.values().next().value;
    if (first && first !== txSignature) usedSignatures.delete(first);
  }

  // Helper: release lock and return failure
  const fail = (reason: string): { valid: false; reason: string } => {
    usedSignatures.delete(txSignature);
    return { valid: false, reason };
  };

  try {
    // 10-second timeout to prevent hanging connections on slow/unresponsive RPCs
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    let resp: Response;
    try {
      resp = await fetch(getSolanaRpc(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            txSignature,
            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
          ],
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      return fail(`Solana RPC error: HTTP ${resp.status}`);
    }

    // Instruction shape shared by top-level and inner instructions
    interface ParsedInstruction {
      programId?: string;
      program?: string;
      parsed?: {
        type?: string;
        info?: {
          destination?: string;
          lamports?: number;
        };
      };
    }

    const json = await resp.json() as {
      result?: {
        meta?: {
          err: unknown;
          innerInstructions?: Array<{
            instructions?: ParsedInstruction[];
          }>;
        };
        transaction?: {
          message?: {
            instructions?: ParsedInstruction[];
          };
        };
      };
      error?: { message?: string };
    };

    if (json.error) {
      return fail(`RPC error: ${json.error.message}`);
    }

    const tx = json.result;

    if (!tx) {
      return fail('Transaction not found (not yet confirmed or invalid)');
    }

    // Check for tx failure
    if (tx.meta?.err) {
      return fail('Transaction failed on-chain');
    }

    // Collect all instructions (top-level + inner) for comprehensive matching
    // Some wallets (Phantom multi-sig, CPI) execute SOL transfers via inner instructions
    const topInstructions = tx.transaction?.message?.instructions || [];
    const innerGroups = tx.meta?.innerInstructions || [];
    const allInstructions = [
      ...topInstructions,
      ...innerGroups.flatMap(g => g.instructions || []),
    ];

    let matchedTransfer: SolanaTransferInfo | null = null;

    for (const ix of allInstructions) {
      if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
        const info = ix.parsed.info;
        if (info?.destination === expectedPayTo) {
          matchedTransfer = {
            confirmed: true,
            recipient: info.destination,
            lamports: info.lamports || 0,
          };
          break;
        }
      }
    }

    if (!matchedTransfer) {
      return fail(`No SOL transfer to ${expectedPayTo} found in transaction`);
    }

    if (matchedTransfer.lamports < expectedLamports) {
      return fail(`Insufficient payment: received ${matchedTransfer.lamports} lamports, expected ${expectedLamports}`);
    }

    // All checks passed — keep the optimistic lock (proof of payment)
    console.log(`[x402] Payment verified: ${txSignature} → ${matchedTransfer.lamports} lamports to ${expectedPayTo}`);
    return { valid: true };
  } catch (err) {
    // Network/timeout errors — release lock so caller can retry
    usedSignatures.delete(txSignature);
    const msg = err instanceof Error ? err.message : String(err);
    const reason = msg.includes('aborted') || msg.includes('abort')
      ? 'RPC timeout: Solana node did not respond within 10 seconds'
      : `Verification error: ${msg}`;
    return { valid: false, reason };
  }
}

/**
 * Convert SOL to lamports (1 SOL = 1e9 lamports)
 */
export function solToLamports(sol: number): number {
  return Math.round(sol * 1_000_000_000);
}
