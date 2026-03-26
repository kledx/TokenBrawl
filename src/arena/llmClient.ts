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
const LLM_LANG = (process.env.ARENA_LLM_LANG || 'en').toLowerCase();
const LLM_TIMEOUT_MS = 12_000;

const isConfigured = !!LLM_API_KEY;

// Language instruction injected into every system prompt
const LANG_INSTRUCTION = LLM_LANG === 'zh'
  ? '\n\n重要：所有输出内容（reasoning、rebuttal 字段）必须使用简体中文。JSON 的键名保持英文，只有值中的文字内容使用中文。'
  : '';

if (isConfigured) {
  console.log(`[LLM] Configured: ${LLM_BASE_URL} / model: ${LLM_MODEL} / lang: ${LLM_LANG}`);
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

  // Build persona-specific analytical lens to force divergent reasoning
  const personaLens = (() => {
    const name = personaName.toUpperCase();
    if (name.includes('BULL')) return `
YOUR ANALYTICAL LENS (strictly follow this):
- Always lead with momentum and upside potential. Hunt for early-entry signals.
- Treat low market-cap as an OPPORTUNITY, not a warning.
- Dismiss or downplay risk flags unless they are absolute deal-breakers (e.g., active rug evidence).
- Your natural stance is BULL. Only go BEAR if there is overwhelming evidence of active fraud.
- Writing style: excited, punchy, confident. Use phrases like "early signal", "asymmetric bet", "smart money moves here".`;
    if (name.includes('BEAR') || name.includes('SIGMA')) return `
YOUR ANALYTICAL LENS (strictly follow this):
- Always lead with risk identification. Treat EVERY metric as a potential red flag.
- Low liquidity = exit trap. High holder concentration = dump risk. Missing data = hide-the-ball.
- Your natural stance is BEAR. Only go BULL if metrics are exceptional across ALL dimensions.
- Never let positive spin override structural risk. The market always finds the weak point.
- Writing style: skeptical, precise, cold. Use phrases like "liquidity trap", "distribution risk", "statistically underdeveloped".`;
    // DATA MONK — neutral but picks a DIFFERENT metric from what Bull/Bear typically cite
    return `
YOUR ANALYTICAL LENS (strictly follow this):
- Focus ONLY on quantitative chain metrics. No narrative, no hype, no fear.
- Pick the 1-2 metrics that are most statistically significant and build your entire argument on those.
- Deliberately avoid the obvious metrics others will mention. Find the overlooked signal.
- You have NO bias. Let the numbers dictate your stance. HOLD only when data is genuinely ambiguous.
- Writing style: dry, clinical, precise. Use phrases like "the data indicates", "statistically", "the coefficient suggests".`;
  })();

  const raw = await chatCompletion([
    {
      role: 'system',
      content: `You are ${personaName}, an AI agent in a meme coin debate arena on Solana.

Core personality: ${personaPrompt}
${personaLens}

Respond in JSON:
{"stance": "bull" | "bear" | "hold", "confidence": 0-95, "reasoning": "2-3 sentences in YOUR distinct voice, from YOUR analytical angle"}

Critical rules:
- Do NOT sound like a generic analyst. Your voice and focus must be completely distinct.
- Do NOT hedge needlessly. Pick a side, commit to it.
- HOLD is a last resort, only if the data is genuinely split 50/50.
- You MUST respond with valid JSON only${LANG_INSTRUCTION}`,
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

Core personality: ${personaPrompt}

You are in the REBUTTAL phase. Respond in JSON:
{"rebuttal": "1-2 sentences directly attacking the opponent's specific argument"}

Critical rules:
- Attack a specific claim they made — quote or paraphrase it then tear it apart
- Bring at least ONE data point or logical angle they did NOT mention
- Do NOT repeat what you said in your own argument. This must be NEW reasoning.
- Be sharp and adversarial. You are trying to WIN this debate.
- Never concede your core stance. You may acknowledge a narrow point but immediately pivot back.
- You MUST respond with valid JSON only${LANG_INSTRUCTION}`,
    },
    {
      role: 'user',
      content: `Token data:\n${tokenCtx}\n\nOpponent's argument to rebut:\nAgent: ${target.persona}\nStance: ${target.stance.toUpperCase()}\nConfidence: ${target.confidence}%\nReasoning: "${target.reasoning}"`,
    },
  ], 0.9);

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
      content: `You are ${personaName}, casting your final vote in a meme coin debate.

Core personality: ${personaPrompt}

You have heard all arguments. Respond in JSON:
{"vote": "bull" | "bear" | "hold", "confidence": 0-95}

Critical rules:
- You are deeply opinionated. Do NOT default to HOLD just because there was debate.
- Only switch your original stance if the opponent made an OVERWHELMINGLY superior argument backed by data you cannot refute.
- ALPHA BULL personality: strong prior toward bull — needs extraordinary evidence to vote bear.
- SIGMA BEAR personality: strong prior toward bear — needs extraordinary evidence to vote bull.
- DATA MONK personality: purely data-driven, will commit to bull or bear if any metric clearly dominates.
- Confidence below 40% is almost never appropriate — commit to your reading.
- You MUST respond with valid JSON only${LANG_INSTRUCTION}`,
    },
    {
      role: 'user',
      content: `Token data:\n${tokenCtx}\n\nAll debate arguments:\n${argsSummary}\n\nCast your final vote:`,
    },
  ], 0.7);

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
