// Arena Colosseum — Message protocol & shared types
// Defines the WebSocket message format between Arena Server, Agents, and Frontend

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

export interface ArenaAgent {
  agentId: string;
  persona: string;        // e.g. "Aggressive Bull", "Cautious Bear", "Data Monk"
  wallet?: string;        // Solana wallet address (optional)
  joinedAt: number;
  stats: AgentStats;
}

export interface AgentStats {
  debatesJoined: number;
  correctPredictions: number;
  totalPredictions: number;
  winRate: number;         // 0-1
}

// ---------------------------------------------------------------------------
// Token data pack (aggregated from Bitget + PumpPortal)
// ---------------------------------------------------------------------------

export interface TokenDataPack {
  // PumpPortal raw data
  mint: string;
  name: string;
  symbol: string;
  initialBuy: number;
  marketCapSol: number;
  createdAt: number;

  // Bitget Wallet Skills data
  bitget?: {
    price?: string;
    holders?: string;
    liquidity?: string;
    top10HolderPercent?: string;
    devRugPercent?: string;
    devIssueCoinCount?: string;
    // Security
    highRisk?: boolean;
    riskCount?: number;
    buyTax?: string;
    sellTax?: string;
    freezeAuth?: boolean;
    mintAuth?: boolean;
    // Transaction stats
    txInfo?: {
      buyVolume5m?: string;
      sellVolume5m?: string;
      buyCount5m?: string;
      sellCount5m?: string;
      buyVolume1h?: string;
      sellVolume1h?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Debate state
// ---------------------------------------------------------------------------

export type DebatePhase = 'WAITING' | 'QUICK_SCORE' | 'ARGUING' | 'REBUTTAL' | 'VOTING' | 'DONE';

export type Stance = 'bull' | 'bear' | 'hold';

export interface Argument {
  agentId: string;
  persona: string;
  stance: Stance;
  reasoning: string;
  confidence: number;      // 0-100
  timestamp: number;
}

/** Quick score — stance + confidence only, no reasoning, used in QUICK_SCORE phase */
export interface QuickScore {
  agentId: string;
  persona: string;
  stance: Stance;
  confidence: number;
}

export interface Rebuttal {
  agentId: string;
  persona: string;
  targetAgentId: string;
  content: string;
  timestamp: number;
}

export interface Vote {
  agentId: string;
  vote: Stance;
  confidence: number;
}

export interface ConsensusResult {
  debateId: string;
  token: { mint: string; name: string; symbol: string };
  bullCount: number;
  bearCount: number;
  holdCount: number;
  bullWeighted: number;
  bearWeighted: number;
  holdWeighted: number;
  consensus: Stance;
  consensusConfidence: number;  // 0-100
  totalAgents: number;
  topArguments: Argument[];
  timestamp: number;
}

export interface Debate {
  debateId: string;
  token: TokenDataPack;
  phase: DebatePhase;
  quickScores: QuickScore[];  // Fast pre-screen scores
  wasEscalated: boolean;       // True if went to full debate on disagreement
  arguments: Argument[];
  rebuttals: Rebuttal[];
  votes: Vote[];
  result?: ConsensusResult;
  startedAt: number;
  phaseDeadline: number;
}

/** Backtesting record — tracks prediction accuracy vs actual price movement */
export interface BacktestRecord {
  debateId: string;
  tokenMint: string;
  tokenSymbol: string;
  consensus: Stance;
  consensusConfidence: number;
  priceAtDebate: number;
  priceAfter5m?: number;
  priceAfter15m?: number;
  priceAfter1h?: number;
  wasCorrect?: boolean;     // null until price checked
  timestamp: number;
}

// ---------------------------------------------------------------------------
// WebSocket messages: Client → Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'join'; agentId: string; persona: string; wallet?: string }
  | { type: 'quick_score'; debateId: string; stance: Stance; confidence: number }
  | { type: 'argument'; debateId: string; stance: Stance; reasoning: string; confidence: number }
  | { type: 'rebuttal'; debateId: string; targetAgentId: string; content: string }
  | { type: 'vote'; debateId: string; vote: Stance; confidence: number }
  | { type: 'request_debate'; mint: string }  // Front-end or agent can request a debate on a specific token

// ---------------------------------------------------------------------------
// WebSocket messages: Server → Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'welcome'; agentId: string; activeDebate?: Debate; agents: ArenaAgent[] }
  | { type: 'agent_joined'; agent: ArenaAgent; totalAgents: number }
  | { type: 'agent_left'; agentId: string; totalAgents: number }
  | { type: 'quick_score_phase'; debateId: string; token: TokenDataPack; deadline: number }
  | { type: 'quick_score_received'; agentId: string; stance: Stance; confidence: number }
  | { type: 'debate_start'; debateId: string; token: TokenDataPack; phase: 'ARGUING'; deadline: number }
  | { type: 'argument_received'; argument: Argument }
  | { type: 'rebuttal_phase'; debateId: string; arguments: Argument[]; deadline: number }
  | { type: 'rebuttal_received'; rebuttal: Rebuttal }
  | { type: 'vote_phase'; debateId: string; deadline: number }
  | { type: 'vote_received'; agentId: string; vote: Stance }
  | { type: 'debate_result'; result: ConsensusResult; wasEscalated: boolean; backtestId?: string }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Arena config
// ---------------------------------------------------------------------------

export interface ArenaConfig {
  port: number;
  quickScoreDurationMs: number;  // Time for quick pre-screen
  argumentDurationMs: number;
  rebuttalDurationMs: number;
  voteDurationMs: number;
  minAgentsToDebate: number;
  autoDebateOnNewToken: boolean;
}

export const DEFAULT_ARENA_CONFIG: ArenaConfig = {
  port: 3001,
  quickScoreDurationMs: 12_000,    // 12s quick score
  argumentDurationMs: 35_000,
  rebuttalDurationMs: 25_000,
  voteDurationMs: 15_000,
  minAgentsToDebate: 2,
  autoDebateOnNewToken: true,
};
