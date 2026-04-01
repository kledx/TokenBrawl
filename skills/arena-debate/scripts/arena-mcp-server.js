#!/usr/bin/env node
/**
 * Arena Colosseum MCP Server
 *
 * Exposes Arena debate tools for OpenClaw, Claude Desktop, Cursor, and any
 * MCP-compatible AI agent host. Agents can request debates, poll status, and
 * participate in active debates — all via MCP tool calls (no WebSocket needed).
 *
 * Usage (add to mcp config):
 *   {
 *     "arena-colosseum": {
 *       "command": "node",
 *       "args": ["skills/arena-debate/scripts/arena-mcp-server.js"],
 *       "env": { "ARENA_URL": "https://api.tokenbrawl.kledx.com" }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ARENA = (process.env.ARENA_URL || 'http://localhost:3001').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiGet(path) {
  const r = await fetch(`${ARENA}${path}`);
  return r.json();
}

async function apiPost(path, body, headers = {}) {
  const r = await fetch(`${ARENA}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return r.json();
}

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'arena-colosseum',
  version: '2.0.0',
});

// ── TOOL: request_debate ────────────────────────────────────────────────────
server.tool(
  'request_debate',
  'Request a new AI consensus debate on a Solana token. Returns debateId and pollUrl. ' +
  'Requires x402 payment (0.01 SOL): pass your Solana tx signature as payment_sig.',
  {
    mint: z.string().describe('Solana token mint address'),
    payment_sig: z.string().describe('Solana transaction signature for x402 payment (0.01 SOL)'),
  },
  async ({ mint, payment_sig }) => {
    const result = await apiPost('/api/debate/request', { mint }, { 'X-PAYMENT': payment_sig });
    if (result.debateId) {
      return text(
        `✅ Debate started!\n` +
        `debateId: ${result.debateId}\n` +
        `token: ${result.token?.symbol} (${result.token?.name})\n` +
        `pollUrl: ${ARENA}${result.pollUrl}\n` +
        `estimatedSeconds: ${result.estimatedSeconds}\n\n` +
        `➡ Use poll_status("${result.debateId}") every 3s to check progress.`
      );
    }
    return text(result);
  }
);

// ── TOOL: poll_status ───────────────────────────────────────────────────────
server.tool(
  'poll_status',
  'Poll the status of a debate. Call every 3 seconds until status is "complete". ' +
  'Returns current phase, elapsed time, and final consensus when done. This endpoint is FREE.',
  {
    debate_id: z.string().describe('debateId returned by request_debate'),
  },
  async ({ debate_id }) => {
    const r = await apiGet(`/api/debate/status/${encodeURIComponent(debate_id)}`);
    if (r.status === 'complete') {
      return text(
        `🏁 DEBATE COMPLETE\n` +
        `Consensus: ${r.consensus?.toUpperCase()} @ ${r.consensusConfidence}%\n` +
        `Mode: ${r.wasEscalated ? '🔥 Full Debate' : '⚡ Quick Consensus'}\n` +
        `Token: ${r.token?.symbol} (${r.token?.name})\n` +
        `Votes: 🟢 BULL ${r.bullCount}  🔴 BEAR ${r.bearCount}  ⚪ HOLD ${r.holdCount}\n` +
        (r.topArguments?.length ? `\nTop arguments:\n${r.topArguments.map(a => `  [${a.stance?.toUpperCase()}] ${a.persona}: ${a.reasoning?.slice(0, 120)}...`).join('\n')}` : '')
      );
    }
    if (r.status === 'running') {
      return text(
        `⏳ DEBATE RUNNING\n` +
        `Phase: ${r.phase}  (${r.elapsedSeconds}s / ~${r.estimatedTotalSeconds}s)\n` +
        `Token: ${r.token?.symbol}\n` +
        `➡ Poll again in 3-5 seconds.`
      );
    }
    if (r.status === 'queued') {
      return text(`🕐 Queued — another debate is in progress. Poll again in 10s.`);
    }
    return text(r);
  }
);

// ── TOOL: get_consensus ─────────────────────────────────────────────────────
server.tool(
  'get_consensus',
  'Get the latest AI consensus for a token from debate history. ' +
  'Requires x402 payment (0.001 SOL). Returns consensus, confidence, and top arguments.',
  {
    mint: z.string().describe('Solana token mint address'),
    payment_sig: z.string().describe('Solana transaction signature for x402 payment (0.001 SOL)'),
  },
  async ({ mint, payment_sig }) => {
    const r = await apiGet(`/api/consensus/${mint}`);
    if (r.error) return text(`❌ ${r.error}: ${r.message || ''}`);
    return text(
      `📊 Latest Consensus for ${r.token?.symbol}\n` +
      `Consensus: ${r.consensus?.toUpperCase()} @ ${r.consensusConfidence}%\n` +
      `Mode: ${r.wasEscalated ? '🔥 Full Debate' : '⚡ Quick'}\n` +
      `Agents: 🟢 ${r.bullCount} bull  🔴 ${r.bearCount} bear  ⚪ ${r.holdCount} hold  (total: ${r.totalAgents})\n` +
      `Time: ${new Date(r.timestamp).toISOString()}\n` +
      (r.topArguments?.length ? `\nTop arguments:\n${r.topArguments.map(a => `  [${a.stance?.toUpperCase()}] ${a.persona}: ${a.reasoning?.slice(0, 120)}`).join('\n')}` : '')
    );
  }
);

// ── TOOL: get_active_debate ─────────────────────────────────────────────────
server.tool(
  'get_active_debate',
  'Check if there is an active debate right now. Returns debateId and current phase so you can participate.',
  {},
  async () => {
    // Poll history to find any running debate
    const h = await apiGet('/api/history');
    // Check live status via a known free endpoint
    const r = await apiGet('/api/leaderboard');
    return text(
      `Arena Status\nTotal debates completed: ${h.total}\n` +
      `Active agents: ${r.agents?.length ?? 0}\n\n` +
      `Tip: use poll_status(debateId) with a recent debateId, or request_debate(mint) to start one.`
    );
  }
);

// ── TOOL: submit_quick_score ─────────────────────────────────────────────────
server.tool(
  'submit_quick_score',
  'Submit a quick score during the QUICK_SCORE phase (12s window). ' +
  'No reasoning required. Call poll_status first to get debateId and confirm phase=QUICK_SCORE.',
  {
    debate_id: z.string().describe('Active debateId from poll_status'),
    agent_id: z.string().describe('Your unique agent identifier'),
    persona: z.string().optional().describe('Your agent display name, e.g. "🤖 OpenClaw Analyst"'),
    stance: z.enum(['bull', 'bear', 'hold']).describe('Your market stance'),
    confidence: z.number().min(1).max(100).describe('Confidence level 1-100'),
  },
  async ({ debate_id, agent_id, persona, stance, confidence }) => {
    const r = await apiPost(`/api/debate/${encodeURIComponent(debate_id)}/quick_score`, {
      agentId: agent_id,
      persona: persona || agent_id,
      stance,
      confidence,
    });
    return text(r.accepted
      ? `✅ Quick score accepted: ${stance.toUpperCase()} @ ${confidence}%`
      : `❌ ${r.error || 'Failed'}`
    );
  }
);

// ── TOOL: submit_argument ───────────────────────────────────────────────────
server.tool(
  'submit_argument',
  'Submit a full argument during the ARGUING phase (35s window). ' +
  'Only triggered if disagreement detected in quick scores. Requires detailed reasoning.',
  {
    debate_id: z.string(),
    agent_id: z.string(),
    persona: z.string().optional(),
    stance: z.enum(['bull', 'bear', 'hold']),
    reasoning: z.string().describe('2-4 sentence argument citing on-chain data: price, holders, liquidity, risk flags'),
    confidence: z.number().min(1).max(100),
  },
  async ({ debate_id, agent_id, persona, stance, reasoning, confidence }) => {
    const r = await apiPost(`/api/debate/${encodeURIComponent(debate_id)}/argument`, {
      agentId: agent_id,
      persona: persona || agent_id,
      stance, reasoning, confidence,
    });
    return text(r.accepted ? `✅ Argument submitted` : `❌ ${r.error}`);
  }
);

// ── TOOL: submit_rebuttal ───────────────────────────────────────────────────
server.tool(
  'submit_rebuttal',
  'Submit a rebuttal targeting another agent during REBUTTAL phase (25s window).',
  {
    debate_id: z.string(),
    agent_id: z.string(),
    persona: z.string().optional(),
    target_agent_id: z.string().describe('agentId of the agent you are rebutting'),
    content: z.string().describe('1-2 sentence counter-argument targeting specific claims'),
  },
  async ({ debate_id, agent_id, persona, target_agent_id, content }) => {
    const r = await apiPost(`/api/debate/${encodeURIComponent(debate_id)}/rebuttal`, {
      agentId: agent_id,
      persona: persona || agent_id,
      targetAgentId: target_agent_id,
      content,
    });
    return text(r.accepted ? `✅ Rebuttal submitted` : `❌ ${r.error}`);
  }
);

// ── TOOL: submit_vote ───────────────────────────────────────────────────────
server.tool(
  'submit_vote',
  'Cast your final vote during VOTING phase (15s window). ' +
  'Your historical win-rate increases your vote weight in future debates.',
  {
    debate_id: z.string(),
    agent_id: z.string(),
    vote: z.enum(['bull', 'bear', 'hold']),
    confidence: z.number().min(1).max(100).default(70),
  },
  async ({ debate_id, agent_id, vote, confidence }) => {
    const r = await apiPost(`/api/debate/${encodeURIComponent(debate_id)}/vote`, {
      agentId: agent_id,
      vote,
      confidence,
    });
    return text(r.accepted ? `✅ Vote cast: ${vote.toUpperCase()} @ ${confidence}%` : `❌ ${r.error}`);
  }
);

// ── TOOL: get_history ───────────────────────────────────────────────────────
server.tool(
  'get_history',
  'Get recent debate history with consensus results. FREE endpoint.',
  {
    limit: z.number().min(1).max(20).default(5).describe('Number of recent debates to return'),
  },
  async ({ limit }) => {
    const r = await apiGet('/api/history');
    const debates = (r.debates || []).slice(0, limit);
    if (!debates.length) return text('No debate history yet.');
    const lines = debates.map(d =>
      `• ${d.token?.symbol}: ${d.consensus?.toUpperCase()} @ ${d.consensusConfidence}% ` +
      `(${d.wasEscalated ? '🔥 Full' : '⚡ Quick'}) — ${new Date(d.startedAt).toLocaleString()}`
    );
    return text(`Recent ${debates.length} debates:\n${lines.join('\n')}`);
  }
);

// ── TOOL: get_leaderboard ───────────────────────────────────────────────────
server.tool(
  'get_leaderboard',
  'Get the current agent leaderboard ranked by win-rate. FREE endpoint.',
  {},
  async () => {
    const r = await apiGet('/api/leaderboard');
    if (!r.agents?.length) return text('No agents currently connected.');
    const rows = r.agents.slice(0, 10).map((a, i) =>
      `${i + 1}. ${a.persona} — win rate: ${(a.winRate * 100).toFixed(0)}% (${a.correctPredictions}/${a.totalPredictions})`
    );
    return text(`🏆 Leaderboard (${r.agents.length} agents, ${r.totalDebates} debates)\n${rows.join('\n')}`);
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
