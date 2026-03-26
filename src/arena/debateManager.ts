// Debate Manager — State machine for a single debate round
// Lifecycle: WAITING → QUICK_SCORE → (unanimous? DONE : ARGUING → REBUTTAL → VOTING → DONE)
// Quick Score: agents submit stance+confidence only. If all agree → instant consensus (~12s).
// Disagreement → escalate to full 3-phase debate (~75s).

import type {
  Debate, DebatePhase, Argument, QuickScore, Rebuttal, Vote,
  ConsensusResult, TokenDataPack, Stance, ArenaConfig,
} from './types';

type PhaseChangeCallback = (debate: Debate) => void;

export class DebateManager {
  private debate: Debate;
  private config: ArenaConfig;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private onPhaseChange: PhaseChangeCallback;
  private agentWeights: Map<string, number>;

  constructor(
    debateId: string,
    token: TokenDataPack,
    config: ArenaConfig,
    agentWeights: Map<string, number>,
    onPhaseChange: PhaseChangeCallback,
  ) {
    this.config = config;
    this.agentWeights = agentWeights;
    this.onPhaseChange = onPhaseChange;
    this.debate = {
      debateId,
      token,
      phase: 'WAITING',
      quickScores: [],
      wasEscalated: false,
      arguments: [],
      rebuttals: [],
      votes: [],
      startedAt: Date.now(),
      phaseDeadline: 0,
    };
  }

  // --- Public API ---

  /** Start the debate: move to QUICK_SCORE phase */
  start(): Debate {
    this.transitionTo('QUICK_SCORE', this.config.quickScoreDurationMs);
    return this.debate;
  }

  /** Agent submits a quick score (QUICK_SCORE phase) */
  addQuickScore(score: QuickScore): boolean {
    if (this.debate.phase !== 'QUICK_SCORE') return false;
    if (this.debate.quickScores.some(s => s.agentId === score.agentId)) return false;
    this.debate.quickScores.push(score);
    return true;
  }

  /** Agent submits an argument (ARGUING phase) */
  addArgument(arg: Argument): boolean {
    if (this.debate.phase !== 'ARGUING') return false;
    if (this.debate.arguments.some(a => a.agentId === arg.agentId)) return false;
    this.debate.arguments.push(arg);
    return true;
  }

  /** Agent submits a rebuttal */
  addRebuttal(rebuttal: Rebuttal): boolean {
    if (this.debate.phase !== 'REBUTTAL') return false;
    this.debate.rebuttals.push(rebuttal);
    return true;
  }

  /** Agent submits a vote */
  addVote(vote: Vote): boolean {
    if (this.debate.phase !== 'VOTING') return false;
    if (this.debate.votes.some(v => v.agentId === vote.agentId)) return false;
    this.debate.votes.push(vote);
    return true;
  }

  /** Get current debate state */
  getState(): Debate {
    return { ...this.debate };
  }

  /** Clean up timers */
  destroy(): void {
    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }
  }

  // --- Phase transitions ---

  private transitionTo(phase: DebatePhase, durationMs?: number): void {
    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = null;
    }

    this.debate.phase = phase;
    this.debate.phaseDeadline = durationMs ? Date.now() + durationMs : 0;

    // Auto-advance on timeout
    if (durationMs && phase !== 'DONE') {
      this.phaseTimer = setTimeout(() => this.autoAdvance(), durationMs);
    }

    this.onPhaseChange(this.debate);
  }

  private autoAdvance(): void {
    switch (this.debate.phase) {
      case 'QUICK_SCORE':
        this.resolveQuickScore();
        break;
      case 'ARGUING':
        this.transitionTo('REBUTTAL', this.config.rebuttalDurationMs);
        break;
      case 'REBUTTAL':
        this.transitionTo('VOTING', this.config.voteDurationMs);
        break;
      case 'VOTING':
        this.finalize();
        break;
    }
  }

  /** Force advance to next phase */
  forceAdvance(): void {
    this.autoAdvance();
  }

  // --- Quick Score resolution ---

  private resolveQuickScore(): void {
    const scores = this.debate.quickScores;

    if (scores.length === 0) {
      // No scores at all — end with no result
      this.debate.result = this.calculateConsensusFromScores();
      this.transitionTo('DONE');
      return;
    }

    // Check if unanimous (all same stance)
    const stances = new Set(scores.map(s => s.stance));
    const isUnanimous = stances.size === 1;

    if (isUnanimous) {
      // All agree → instant consensus, no full debate needed
      console.log(`[Debate] ⚡ Quick consensus: ${scores[0].stance.toUpperCase()} (unanimous, ${scores.length} agents)`);
      this.debate.wasEscalated = false;
      this.debate.result = this.calculateConsensusFromScores();
      this.transitionTo('DONE');
    } else {
      // Disagreement → escalate to full debate
      const breakdown = `BULL:${scores.filter(s => s.stance === 'bull').length} BEAR:${scores.filter(s => s.stance === 'bear').length} HOLD:${scores.filter(s => s.stance === 'hold').length}`;
      console.log(`[Debate] 🔥 Disagreement detected (${breakdown}) → escalating to full debate`);
      this.debate.wasEscalated = true;
      this.transitionTo('ARGUING', this.config.argumentDurationMs);
    }
  }

  /** Calculate consensus from quick scores (when unanimous) */
  private calculateConsensusFromScores(): ConsensusResult {
    const scores = this.debate.quickScores;
    const counts = { bull: 0, bear: 0, hold: 0 };
    let totalConf = 0;

    for (const s of scores) {
      counts[s.stance]++;
      totalConf += s.confidence;
    }

    const avgConf = scores.length > 0 ? Math.round(totalConf / scores.length) : 0;
    let consensus: Stance = 'hold';
    if (counts.bull > counts.bear && counts.bull > counts.hold) consensus = 'bull';
    else if (counts.bear > counts.bull && counts.bear > counts.hold) consensus = 'bear';

    return {
      debateId: this.debate.debateId,
      token: {
        mint: this.debate.token.mint,
        name: this.debate.token.name,
        symbol: this.debate.token.symbol,
      },
      bullCount: counts.bull,
      bearCount: counts.bear,
      holdCount: counts.hold,
      bullWeighted: 0,
      bearWeighted: 0,
      holdWeighted: 0,
      consensus,
      consensusConfidence: avgConf,
      totalAgents: scores.length,
      topArguments: [],
      timestamp: Date.now(),
    };
  }

  // --- Full debate consensus calculation ---

  private finalize(): void {
    const result = this.calculateConsensus();
    this.debate.result = result;
    this.transitionTo('DONE');
  }

  private calculateConsensus(): ConsensusResult {
    const votes = this.debate.votes;
    const counts = { bull: 0, bear: 0, hold: 0 };
    const weighted = { bull: 0, bear: 0, hold: 0 };

    for (const v of votes) {
      counts[v.vote]++;
      const agentWeight = this.agentWeights.get(v.agentId) ?? 0.5;
      weighted[v.vote] += agentWeight * (v.confidence / 100);
    }

    const totalWeighted = weighted.bull + weighted.bear + weighted.hold;
    let consensus: Stance = 'hold';
    if (weighted.bull > weighted.bear && weighted.bull > weighted.hold) consensus = 'bull';
    else if (weighted.bear > weighted.bull && weighted.bear > weighted.hold) consensus = 'bear';

    const consensusWeight = weighted[consensus];
    const consensusConfidence = totalWeighted > 0
      ? Math.round((consensusWeight / totalWeighted) * 100)
      : 0;

    const topArguments = [...this.debate.arguments]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);

    return {
      debateId: this.debate.debateId,
      token: {
        mint: this.debate.token.mint,
        name: this.debate.token.name,
        symbol: this.debate.token.symbol,
      },
      bullCount: counts.bull,
      bearCount: counts.bear,
      holdCount: counts.hold,
      bullWeighted: Math.round(weighted.bull * 100) / 100,
      bearWeighted: Math.round(weighted.bear * 100) / 100,
      holdWeighted: Math.round(weighted.hold * 100) / 100,
      consensus,
      consensusConfidence,
      totalAgents: votes.length,
      topArguments,
      timestamp: Date.now(),
    };
  }
}
