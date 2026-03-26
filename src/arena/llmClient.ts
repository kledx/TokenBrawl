// LLM Client — OpenAI-compatible unified calling layer
// Supports any OpenAI-format API: OpenAI, DeepSeek, Groq, Ollama, etc.
// Configured via environment variables or src/.env file

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { TokenDataPack, Argument, Stance } from './types';

// ---------------------------------------------------------------------------
// Config loading — read from src/.env if env vars not set
// ---------------------------------------------------------------------------

function loadEnvFile(): void {
  try {
    const __dirname = resolve(fileURLToPath(import.meta.url), '..');
    // Try multiple locations: src/.env (one dir up from arena/), project root .env
    const candidates = [
      resolve(__dirname, '..', '.env'),   // src/.env (from src/arena/)
      resolve(__dirname, '.env'),          // src/arena/.env
      resolve(__dirname, '..', '..', '.env'), // project root .env
    ];
    for (const envPath of candidates) {
      try {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim().replace(/\r$/, '');
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx < 0) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
        console.log(`[LLM] Loaded env from: ${envPath}`);
        return;
      } catch {
        // Try next candidate
      }
    }
    console.warn('[LLM] No .env file found in any expected location');
  } catch {
    // Rely on environment variables
  }
}

loadEnvFile();

const LLM_BASE_URL = (process.env.ARENA_LLM_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
const LLM_API_KEY = process.env.ARENA_LLM_API_KEY || '';
const LLM_MODEL = process.env.ARENA_LLM_MODEL || 'gpt-4o-mini';
const LLM_TIMEOUT_MS = 12_000;

const isConfigured = !!LLM_API_KEY;

if (isConfigured) {
  console.log(`[LLM] Configured: ${LLM_BASE_URL} / model: ${LLM_MODEL}`);
} else {
  console.warn('[LLM] No API key found — will use fallback rules engine');
}

// ---------------------------------------------------------------------------
// Core API call
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chatCompletion(messages: ChatMessage[], temperature = 0.7): Promise<string | null> {
  if (!isConfigured) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    // Determine if URL already contains /v1 path or similar
    const baseUrl = LLM_BASE_URL.endsWith('/v1')
      ? LLM_BASE_URL
      : `${LLM_BASE_URL}/v1`;

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        temperature,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown');
      console.error(`[LLM] API error ${resp.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      console.warn(`[LLM] Timeout after ${LLM_TIMEOUT_MS}ms — falling back`);
    } else {
      console.error(`[LLM] Call failed:`, msg);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Token data summary for prompt context
// ---------------------------------------------------------------------------

function buildTokenContext(token: TokenDataPack): string {
  const lines: string[] = [];
  lines.push(`Token: $${token.symbol} (${token.name})`);
  lines.push(`Market Cap: ${token.marketCapSol.toFixed(1)} SOL`);
  lines.push(`Mint: ${token.mint}`);

  const b = token.bitget;
  if (b) {
    if (b.holders) lines.push(`Holders: ${b.holders}`);
    if (b.liquidity) lines.push(`Liquidity: $${b.liquidity}`);
    if (b.price) lines.push(`Price: $${b.price}`);
    if (b.top10HolderPercent) lines.push(`Top 10 Holder Concentration: ${b.top10HolderPercent}%`);
    if (b.highRisk) lines.push('⚠️ HIGH RISK flagged by security audit');
    if (b.freezeAuth) lines.push('⚠️ Freeze Authority ENABLED');
    if (b.mintAuth) lines.push('⚠️ Mint Authority ACTIVE');
    if (b.devRugPercent) lines.push(`Dev Rug History: ${b.devRugPercent}%`);
    if (b.buyTax) lines.push(`Buy Tax: ${b.buyTax}%`);
    if (b.sellTax) lines.push(`Sell Tax: ${b.sellTax}%`);
    if (b.txInfo) {
      const tx = b.txInfo;
      if (tx.buyVolume5m) lines.push(`5m Buy Volume: ${tx.buyVolume5m}`);
      if (tx.sellVolume5m) lines.push(`5m Sell Volume: ${tx.sellVolume5m}`);
      if (tx.buyCount5m) lines.push(`5m Buy Count: ${tx.buyCount5m}`);
      if (tx.sellCount5m) lines.push(`5m Sell Count: ${tx.sellCount5m}`);
    }
  } else {
    lines.push('(On-chain data unavailable — Bitget API unreachable)');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API: generateArgument
// ---------------------------------------------------------------------------

export interface LLMArgumentResult {
  stance: Stance;
  confidence: number;
  reasoning: string;
}

export async function generateArgument(
  personaPrompt: string,
  personaName: string,
  token: TokenDataPack,
): Promise<LLMArgumentResult | null> {
  const tokenCtx = buildTokenContext(token);

  const raw = await chatCompletion([
    {
      role: 'system',
      content: `You are ${personaName}, an AI agent in a meme coin debate arena on Solana.

Your personality: ${personaPrompt}

You must analyze the token data provided and form an opinion. Respond in JSON:
{"stance": "bull" | "bear" | "hold", "confidence": 0-95, "reasoning": "2-3 sentences explaining your position based on the data"}

Rules:
- Base your stance on ACTUAL DATA provided, not assumptions
- If high-risk flags exist (freeze auth, mint auth, high risk), these are serious red flags
- Confidence should reflect how strong the data supports your position
- Keep reasoning concise and data-driven (2-3 sentences max)
- You MUST respond with valid JSON only`,
    },
    {
      role: 'user',
      content: `Analyze this token:\n\n${tokenCtx}`,
    },
  ]);

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return {
      stance: (['bull', 'bear', 'hold'].includes(parsed.stance) ? parsed.stance : 'hold') as Stance,
      confidence: Math.max(0, Math.min(95, Math.round(Number(parsed.confidence) || 50))),
      reasoning: String(parsed.reasoning || 'Analysis inconclusive.'),
    };
  } catch {
    console.warn('[LLM] Failed to parse argument response:', raw?.slice(0, 200));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API: generateRebuttal
// ---------------------------------------------------------------------------

export async function generateRebuttal(
  personaPrompt: string,
  personaName: string,
  target: Argument,
  token: TokenDataPack,
): Promise<string | null> {
  const tokenCtx = buildTokenContext(token);

  const raw = await chatCompletion([
    {
      role: 'system',
      content: `You are ${personaName}, an AI agent in a meme coin debate arena.

Your personality: ${personaPrompt}

You are in the REBUTTAL phase. You must respond to another agent's argument. Respond in JSON:
{"rebuttal": "Your 1-2 sentence rebuttal addressing their specific points"}

Rules:
- Directly address their reasoning, don't just repeat your position
- Reference specific data points that counter their argument
- Be concise (1-2 sentences)
- You MUST respond with valid JSON only`,
    },
    {
      role: 'user',
      content: `Token data:\n${tokenCtx}\n\nArgument to rebut:\nAgent: ${target.persona}\nStance: ${target.stance.toUpperCase()}\nConfidence: ${target.confidence}%\nReasoning: "${target.reasoning}"`,
    },
  ], 0.8);

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return String(parsed.rebuttal || null);
  } catch {
    console.warn('[LLM] Failed to parse rebuttal response');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API: generateVote
// ---------------------------------------------------------------------------

export interface LLMVoteResult {
  vote: Stance;
  confidence: number;
}

export async function generateVote(
  personaPrompt: string,
  personaName: string,
  allArguments: Argument[],
  token: TokenDataPack,
): Promise<LLMVoteResult | null> {
  const tokenCtx = buildTokenContext(token);

  const argsSummary = allArguments.map(a =>
    `- ${a.persona} (${a.stance.toUpperCase()}, ${a.confidence}%): "${a.reasoning}"`
  ).join('\n');

  const raw = await chatCompletion([
    {
      role: 'system',
      content: `You are ${personaName}, an AI agent casting your final vote after hearing all debate arguments.

Your personality: ${personaPrompt}

You have heard all arguments. Now you must vote. You CAN change your mind if another agent made a more compelling case. Respond in JSON:
{"vote": "bull" | "bear" | "hold", "confidence": 0-95}

Rules:
- Consider ALL arguments, not just your own bias
- If an opponent presented strong data-backed evidence, you SHOULD change your vote
- Confidence should reflect how certain you are after hearing all sides
- You MUST respond with valid JSON only`,
    },
    {
      role: 'user',
      content: `Token data:\n${tokenCtx}\n\nAll debate arguments:\n${argsSummary}\n\nCast your vote:`,
    },
  ], 0.6);

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return {
      vote: (['bull', 'bear', 'hold'].includes(parsed.vote) ? parsed.vote : 'hold') as Stance,
      confidence: Math.max(0, Math.min(95, Math.round(Number(parsed.confidence) || 50))),
    };
  } catch {
    console.warn('[LLM] Failed to parse vote response');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Export config check
// ---------------------------------------------------------------------------

export { isConfigured as llmIsConfigured };
