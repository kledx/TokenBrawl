// Bot Agents — LLM-powered AI personalities with rules engine fallback
// Each bot calls LLM for argument/rebuttal/vote, falls back to scoring engine if LLM fails
// Usage: npx tsx src/arena/botAgents.ts [arenaUrl]

import WebSocket from 'ws';
import type { ClientMessage, ServerMessage, TokenDataPack, Argument, Stance } from './types';
import {
  generateArgument as llmArgument,
  generateRebuttal as llmRebuttal,
  generateVote as llmVote,
  llmIsConfigured,
} from './llmClient';

// ---------------------------------------------------------------------------
// Agent personalities
// ---------------------------------------------------------------------------

interface BotPersona {
  agentId: string;
  persona: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  biasStrength: number;
  prompt: string;
}

const PERSONAS: BotPersona[] = [
  {
    agentId: 'alpha-bull',
    persona: 'ALPHA BULL',
    bias: 'bullish',
    biasStrength: 0.3,
    prompt: 'Aggressive meme coin trader who looks for moonshot potential but respects hard red flags.',
  },
  {
    agentId: 'sigma-bear',
    persona: 'SIGMA BEAR',
    bias: 'bearish',
    biasStrength: 0.3,
    prompt: 'Cautious analyst who protects capital but acknowledges when data is genuinely strong.',
  },
  {
    agentId: 'data-monk',
    persona: 'DATA MONK',
    bias: 'neutral',
    biasStrength: 0,
    prompt: 'Pure data analyst. No emotions, only numbers. Follows wherever the metrics lead.',
  },
];

// ---------------------------------------------------------------------------
// Fallback scoring engine (used when LLM is unavailable)
// ---------------------------------------------------------------------------

interface TokenScore {
  raw: number;
  factors: ScoreFactor[];
}

interface ScoreFactor {
  name: string;
  impact: number;
  detail: string;
}

function scoreToken(token: TokenDataPack): TokenScore {
  const factors: ScoreFactor[] = [];
  let raw = 0;
  const b = token.bitget;

  if (token.marketCapSol > 0) {
    if (token.marketCapSol >= 100) {
      factors.push({ name: 'mcap', impact: 15, detail: `Strong market cap: ${token.marketCapSol.toFixed(1)} SOL` });
      raw += 15;
    } else if (token.marketCapSol >= 30) {
      factors.push({ name: 'mcap', impact: 5, detail: `Moderate market cap: ${token.marketCapSol.toFixed(1)} SOL` });
      raw += 5;
    } else {
      factors.push({ name: 'mcap', impact: -10, detail: `Low market cap: ${token.marketCapSol.toFixed(1)} SOL — micro-cap risk` });
      raw -= 10;
    }
  }

  if (b?.highRisk) { factors.push({ name: 'risk', impact: -40, detail: 'HIGH RISK flagged' }); raw -= 40; }
  if (b?.freezeAuth) { factors.push({ name: 'freeze', impact: -25, detail: 'Freeze authority enabled' }); raw -= 25; }
  if (b?.mintAuth) { factors.push({ name: 'mint', impact: -25, detail: 'Mint authority active' }); raw -= 25; }

  if (b?.top10HolderPercent) {
    const pct = parseFloat(b.top10HolderPercent);
    if (pct > 70) { factors.push({ name: 'concentration', impact: -30, detail: `Top 10 own ${pct.toFixed(0)}%` }); raw -= 30; }
    else if (pct > 50) { factors.push({ name: 'concentration', impact: -15, detail: `Top 10 own ${pct.toFixed(0)}%` }); raw -= 15; }
    else if (pct < 30) { factors.push({ name: 'distribution', impact: 15, detail: `Top 10 hold ${pct.toFixed(0)}%` }); raw += 15; }
  }

  if (b?.holders) {
    const h = parseInt(b.holders, 10);
    if (h >= 500) { factors.push({ name: 'holders', impact: 20, detail: `${h} holders` }); raw += 20; }
    else if (h >= 100) { factors.push({ name: 'holders', impact: 10, detail: `${h} holders` }); raw += 10; }
    else { factors.push({ name: 'holders', impact: -5, detail: `Only ${h} holders` }); raw -= 5; }
  }

  if (b?.txInfo) {
    const buyVol = parseFloat(b.txInfo.buyVolume5m || '0');
    const sellVol = parseFloat(b.txInfo.sellVolume5m || '0');
    const total = buyVol + sellVol;
    if (total > 0) {
      const buyRatio = buyVol / total;
      if (buyRatio > 0.65) { factors.push({ name: 'pressure', impact: 20, detail: `${(buyRatio * 100).toFixed(0)}% buy pressure` }); raw += 20; }
      else if (buyRatio < 0.35) { factors.push({ name: 'pressure', impact: -20, detail: `${((1 - buyRatio) * 100).toFixed(0)}% sell pressure` }); raw -= 20; }
    }
  }

  raw = Math.max(-100, Math.min(100, raw));
  return { raw, factors };
}

function fallbackStance(score: TokenScore, persona: BotPersona, token: TokenDataPack): {
  stance: Stance; confidence: number; reasoning: string;
} {
  let adjusted = score.raw;
  if (persona.bias === 'bullish') adjusted += persona.biasStrength * 30;
  else if (persona.bias === 'bearish') adjusted -= persona.biasStrength * 30;
  adjusted = Math.max(-100, Math.min(100, adjusted));

  const stance: Stance = adjusted > 15 ? 'bull' : adjusted < -15 ? 'bear' : 'hold';
  const confidence = Math.min(95, Math.max(5, Math.round(Math.abs(adjusted))));
  const sorted = [...score.factors].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const reasoning = sorted.slice(0, 3).map(f => f.detail).join('. ') + '.';
  return { stance, confidence, reasoning };
}

function fallbackRebuttal(persona: BotPersona, target: Argument, score: TokenScore): string {
  const counter = score.factors
    .filter(f => (target.stance === 'bull' ? f.impact < 0 : f.impact > 0))
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))[0];

  if (counter) {
    return `@${target.persona}: You're overlooking — ${counter.detail.toLowerCase()}. My data tells a different story.`;
  }
  return `@${target.persona}: Your ${target.stance} thesis at ${target.confidence}% confidence doesn't align with my analysis.`;
}

// ---------------------------------------------------------------------------
// Bot Agent client — LLM-first with fallback
// ---------------------------------------------------------------------------

class BotAgent {
  private ws: WebSocket | null = null;
  private persona: BotPersona;
  private arenaUrl: string;
  private lastScore: TokenScore | null = null;
  private lastToken: TokenDataPack | null = null;
  private debateArguments: Argument[] = [];

  constructor(persona: BotPersona, arenaUrl: string) {
    this.persona = persona;
    this.arenaUrl = arenaUrl;
  }

  connect(): void {
    this.ws = new WebSocket(this.arenaUrl);

    this.ws.on('open', () => {
      console.log(`[Bot:${this.persona.agentId}] Connected`);
      this.send({ type: 'join', agentId: this.persona.agentId, persona: this.persona.persona });
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg: ServerMessage = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch { /* skip */ }
    });

    this.ws.on('close', () => {
      console.log(`[Bot:${this.persona.agentId}] Disconnected, reconnecting in 3s...`);
      setTimeout(() => this.connect(), 3000);
    });

    this.ws.on('error', (err) => {
      console.error(`[Bot:${this.persona.agentId}] Error:`, err.message);
    });
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'quick_score_phase':
        this.onQuickScore(msg.debateId, msg.token);
        break;
      case 'debate_start':
        this.onDebateStart(msg.debateId, msg.token);
        break;
      case 'argument_received':
        this.debateArguments.push(msg.argument);
        break;
      case 'rebuttal_phase':
        this.onRebuttalPhase(msg.debateId, msg.arguments);
        break;
      case 'vote_phase':
        this.onVotePhase(msg.debateId);
        break;
      case 'debate_result': {
        const mode = (msg as any).wasEscalated ? '🔥' : '⚡';
        console.log(`[Bot:${this.persona.agentId}] ${mode} Result: ${msg.result.consensus.toUpperCase()} (${msg.result.consensusConfidence}%)`);
        break;
      }
    }
  }

  // --- QUICK_SCORE phase: fast stance + confidence, no reasoning ---
  private async onQuickScore(debateId: string, token: TokenDataPack): Promise<void> {
    this.lastToken = token;
    this.lastScore = scoreToken(token);
    this.debateArguments = [];

    // Quick delay (shorter than full argument)
    await this.sleep(500 + Math.random() * 1500);

    // Use rules engine for speed (LLM too slow for quick score)
    const fb = fallbackStance(this.lastScore, this.persona, token);
    console.log(`[Bot:${this.persona.agentId}] ⚡ Quick: ${fb.stance.toUpperCase()} @ ${fb.confidence}%`);

    this.send({ type: 'quick_score', debateId, stance: fb.stance, confidence: fb.confidence });
  }

  // --- ARGUING phase: LLM first, fallback to scoring engine ---
  private async onDebateStart(debateId: string, token: TokenDataPack): Promise<void> {
    console.log(`[Bot:${this.persona.agentId}] Analyzing ${token.symbol}...`);
    this.debateArguments = [];
    this.lastToken = token;
    this.lastScore = scoreToken(token);

    const delay = 1500 + Math.random() * 3000;
    await this.sleep(delay);

    // Try LLM first
    const llmResult = await llmArgument(this.persona.prompt, this.persona.persona, token);

    let stance: Stance;
    let confidence: number;
    let reasoning: string;

    if (llmResult) {
      stance = llmResult.stance;
      confidence = llmResult.confidence;
      reasoning = llmResult.reasoning;
      console.log(`[Bot:${this.persona.agentId}] 🧠 LLM: ${stance.toUpperCase()} @ ${confidence}%`);
    } else {
      // Fallback to rules engine
      const fb = fallbackStance(this.lastScore, this.persona, token);
      stance = fb.stance;
      confidence = fb.confidence;
      reasoning = fb.reasoning;
      console.log(`[Bot:${this.persona.agentId}] ⚙️ Fallback: ${stance.toUpperCase()} @ ${confidence}%`);
    }

    this.send({ type: 'argument', debateId, stance, reasoning, confidence });
  }

  // --- REBUTTAL phase: LLM first, fallback to template ---
  private async onRebuttalPhase(debateId: string, args: Argument[]): Promise<void> {
    if (!this.lastScore || !this.lastToken) return;

    const myStance = fallbackStance(this.lastScore, this.persona, this.lastToken).stance;
    const opponents = args
      .filter(a => a.agentId !== this.persona.agentId && a.stance !== myStance)
      .sort((a, b) => b.confidence - a.confidence);

    const target = opponents[0];
    if (!target) return;

    await this.sleep(1000 + Math.random() * 2500);

    // Try LLM first
    const llmResult = await llmRebuttal(this.persona.prompt, this.persona.persona, target, this.lastToken);

    const content = llmResult
      ? `@${target.persona}: ${llmResult}`
      : fallbackRebuttal(this.persona, target, this.lastScore);

    this.send({ type: 'rebuttal', debateId, targetAgentId: target.agentId, content });
  }

  // --- VOTING phase: LLM first, fallback to debate-influenced logic ---
  private async onVotePhase(debateId: string): Promise<void> {
    if (!this.lastScore || !this.lastToken) {
      const fb: Stance = this.persona.bias === 'bullish' ? 'bull' : this.persona.bias === 'bearish' ? 'bear' : 'hold';
      this.send({ type: 'vote', debateId, vote: fb, confidence: 30 });
      return;
    }

    await this.sleep(500 + Math.random() * 1500);

    // Try LLM first
    const llmResult = await llmVote(
      this.persona.prompt, this.persona.persona,
      this.debateArguments, this.lastToken,
    );

    if (llmResult) {
      console.log(`[Bot:${this.persona.agentId}] 🧠 LLM vote: ${llmResult.vote.toUpperCase()}`);
      this.send({ type: 'vote', debateId, vote: llmResult.vote, confidence: llmResult.confidence });
      return;
    }

    // Fallback: debate-influenced voting
    const myAnalysis = fallbackStance(this.lastScore, this.persona, this.lastToken);
    let finalVote = myAnalysis.stance;
    let finalConf = myAnalysis.confidence;

    const otherArgs = this.debateArguments.filter(a => a.agentId !== this.persona.agentId);
    const strongOpposing = otherArgs.filter(a => a.stance !== myAnalysis.stance && a.confidence > myAnalysis.confidence + 15);
    if (strongOpposing.length > 0 && Math.random() < Math.min(0.6, strongOpposing.length * 0.25)) {
      const strongest = strongOpposing.sort((a, b) => b.confidence - a.confidence)[0];
      finalVote = strongest.stance;
      finalConf = Math.max(10, Math.round(finalConf * 0.5));
      console.log(`[Bot:${this.persona.agentId}] 🔄 Fallback flip → ${finalVote}`);
    }

    this.send({ type: 'vote', debateId, vote: finalVote, confidence: finalConf });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const arenaUrl = process.argv[2] || 'ws://localhost:3001';
console.log(`\n🤖 Starting ${PERSONAS.length} bot agents → ${arenaUrl}`);
console.log(`🧠 LLM: ${llmIsConfigured ? 'ENABLED' : 'DISABLED (fallback mode)'}\n`);

for (const persona of PERSONAS) {
  const bot = new BotAgent(persona, arenaUrl);
  setTimeout(() => bot.connect(), Math.random() * 2000);
}
