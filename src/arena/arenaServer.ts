// Arena WebSocket Server + HTTP Leaderboard API
// Uses Bitget Token Discovery for curated, quality-filtered debate targets
// x402 Payment Required protocol for paid API endpoints

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import type {
  ArenaAgent, AgentStats, ArenaConfig, ClientMessage, ServerMessage,
  TokenDataPack, Debate,
} from './types';
import { DEFAULT_ARENA_CONFIG } from './types';
import { DebateManager } from './debateManager';
import { aggregateFromMint } from './dataAggregator';
import { TokenDiscoveryEngine } from './tokenDiscovery';
import { PriceTracker } from './priceTracker';
import { x402Gate, getPricingTable } from './x402Middleware.js';

interface ConnectedClient {
  ws: WebSocket;
  agent: ArenaAgent;
  isAlive: boolean;
}

// Tracks HTTP-requested debates so external agents can poll for results
interface DebateStatusEntry {
  debateId: string;
  mint: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  phase: string;
  result?: object;
  startedAt: number;
  completedAt?: number;
}

export class ArenaServer {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private config: ArenaConfig;
  private clients = new Map<string, ConnectedClient>();
  private currentDebate: DebateManager | null = null;
  private debateHistory: Debate[] = [];
  private debateCounter = 0;
  private discovery: TokenDiscoveryEngine | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private agentWeights = new Map<string, number>();
  private pendingTokens: TokenDataPack[] = [];
  private priceTracker = new PriceTracker();
  // HTTP polling: map of debateId → status for external agent polling
  private debateStatusMap = new Map<string, DebateStatusEntry>();

  constructor(config: Partial<ArenaConfig> = {}) {
    this.config = { ...DEFAULT_ARENA_CONFIG, ...config };
  }

  start(): void {
    // Create HTTP server for REST API
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));

    // Attach WebSocket server to HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.heartbeatInterval = setInterval(() => {
      this.clients.forEach((client, agentId) => {
        if (!client.isAlive) {
          console.log(`[Arena] Agent ${agentId} timed out`);
          client.ws.terminate();
          this.removeClient(agentId);
          return;
        }
        client.isAlive = false;
        client.ws.ping();
      });
    }, 30_000);

    if (this.config.autoDebateOnNewToken) {
      this.startDiscovery();
    }

    this.httpServer.listen(this.config.port, () => {
      console.log(`[Arena] Server listening on port ${this.config.port} (WebSocket + HTTP API)`);
    });
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.discovery?.stop();
    this.discovery = null;
    this.priceTracker.destroy();
    this.currentDebate?.destroy();
    this.wss?.close();
    this.httpServer?.close();
    console.log('[Arena] Server stopped');
  }

  // ---------------------------------------------------------------------------
  // HTTP API — Leaderboard & Backtesting
  // ---------------------------------------------------------------------------

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PAYMENT');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    const url = req.url || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route to async handler (x402 endpoints need await)
    this.routeHttp(req, res, url).catch(err => {
      console.error('[Arena] HTTP handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  }

  private async routeHttp(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    // -----------------------------------------------------------------------
    // FREE endpoints
    // -----------------------------------------------------------------------

    // GET /api/leaderboard
    if (url === '/api/leaderboard') {
      const agents = Array.from(this.clients.values())
        .map(c => c.agent)
        .sort((a, b) => b.stats.winRate - a.stats.winRate);

      res.writeHead(200);
      res.end(JSON.stringify({
        agents: agents.map(a => ({
          agentId: a.agentId,
          persona: a.persona,
          debatesJoined: a.stats.debatesJoined,
          winRate: a.stats.winRate,
          correctPredictions: a.stats.correctPredictions,
          totalPredictions: a.stats.totalPredictions,
        })),
        totalDebates: this.debateCounter,
        updatedAt: Date.now(),
      }));
      return;
    }

    // GET /api/agent/:agentId
    const agentMatch = url.match(/^\/api\/agent\/(.+)$/);
    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);
      const client = this.clients.get(agentId);
      if (!client) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }

      // Calculate rank
      const allAgents = Array.from(this.clients.values())
        .map(c => c.agent)
        .sort((a, b) => b.stats.winRate - a.stats.winRate);
      const rank = allAgents.findIndex(a => a.agentId === agentId) + 1;

      res.writeHead(200);
      res.end(JSON.stringify({
        agentId: client.agent.agentId,
        persona: client.agent.persona,
        stats: client.agent.stats,
        rank,
        totalAgents: this.clients.size,
      }));
      return;
    }

    // GET /api/backtest
    if (url === '/api/backtest') {
      const stats = this.priceTracker.getStats();
      const records = this.priceTracker.getRecords();

      res.writeHead(200);
      res.end(JSON.stringify({
        ...stats,
        records: records.slice(-20),  // Last 20
      }));
      return;
    }

    // GET /api/history
    if (url === '/api/history') {
      const history = this.debateHistory
        .filter(d => d.result)
        .map(d => ({
          debateId: d.debateId,
          token: { mint: d.token.mint, name: d.token.name, symbol: d.token.symbol },
          consensus: d.result!.consensus,
          consensusConfidence: d.result!.consensusConfidence,
          bullCount: d.result!.bullCount,
          bearCount: d.result!.bearCount,
          holdCount: d.result!.holdCount,
          totalAgents: d.result!.totalAgents,
          wasEscalated: d.wasEscalated,
          startedAt: d.startedAt,
          topArguments: d.result!.topArguments?.slice(0, 2) ?? [],
        }))
        .reverse();  // newest first

      res.writeHead(200);
      res.end(JSON.stringify({ debates: history, total: history.length }));
      return;
    }

    // GET /api/debate/status/:debateId — poll debate result (free)
    const debateStatusMatch = url.match(/^\/api\/debate\/status\/([^/?]+)$/);
    if (debateStatusMatch && req.method === 'GET') {
      const debateId = decodeURIComponent(debateStatusMatch[1]);
      const entry = this.debateStatusMap.get(debateId);

      // Also check live debate
      const live = this.currentDebate?.getState();
      if (!entry && (!live || live.debateId !== debateId)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Debate not found', debateId }));
        return;
      }

      if (live && live.debateId === debateId && (!entry || entry.status === 'running')) {
        // Still running — return live phase info
        const elapsedMs = Date.now() - live.startedAt;
        const estimatedTotal = live.wasEscalated === false ? 15_000 : 90_000;
        res.writeHead(200);
        res.end(JSON.stringify({
          debateId,
          status: 'running',
          phase: live.phase,
          elapsedSeconds: Math.floor(elapsedMs / 1000),
          estimatedTotalSeconds: Math.floor(estimatedTotal / 1000),
          mint: live.token.mint,
          token: { symbol: live.token.symbol, name: live.token.name },
          message: 'Debate in progress — poll again in 3s',
        }));
        return;
      }

      if (entry) {
        if (entry.status === 'complete') {
          res.writeHead(200);
          res.end(JSON.stringify({
            debateId,
            status: 'complete',
            phase: 'DONE',
            mint: entry.mint,
            ...entry.result,
            startedAt: entry.startedAt,
            completedAt: entry.completedAt,
          }));
        } else if (entry.status === 'queued') {
          res.writeHead(200);
          res.end(JSON.stringify({
            debateId,
            status: 'queued',
            phase: 'WAITING',
            mint: entry.mint,
            message: 'Debate is queued — a current debate is in progress',
          }));
        } else {
          res.writeHead(200);
          res.end(JSON.stringify({ debateId, status: entry.status, phase: entry.phase, mint: entry.mint }));
        }
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Debate not found', debateId }));
      return;
    }

    // -------------------------------------------------------------------------
    // HTTP Participation endpoints — free, agentId in body, no WebSocket needed
    // Enables OpenClaw / MCP agents to participate without a persistent connection
    // -------------------------------------------------------------------------

    // POST /api/debate/:debateId/quick_score
    const qsMatch = url.match(/^\/api\/debate\/([^/]+)\/quick_score$/);
    if (qsMatch && req.method === 'POST') {
      const debateId = decodeURIComponent(qsMatch[1]);
      const body = await this.readBody(req);
      let agentId: string, persona: string, stance: string, confidence: number;
      try {
        const p = JSON.parse(body);
        agentId = p.agentId; persona = p.persona || p.agentId;
        stance = p.stance; confidence = Number(p.confidence);
        if (!agentId || !stance || !['bull','bear','hold'].includes(stance)) throw new Error();
      } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Expected: { agentId, stance, confidence, persona? }' })); return;
      }
      if (!this.currentDebate || this.currentDebate.getState().phase !== 'QUICK_SCORE') {
        res.writeHead(409); res.end(JSON.stringify({ error: 'No active quick_score phase', currentPhase: this.currentDebate?.getState().phase ?? 'NONE' })); return;
      }
      if (this.currentDebate.getState().debateId !== debateId) {
        res.writeHead(409); res.end(JSON.stringify({ error: 'debateId mismatch', activeDebateId: this.currentDebate.getState().debateId })); return;
      }
      const ok = this.currentDebate.addQuickScore({ agentId, persona, stance: stance as 'bull'|'bear'|'hold', confidence });
      if (ok) this.broadcast({ type: 'quick_score_received', agentId, stance: stance as 'bull'|'bear'|'hold', confidence });
      res.writeHead(ok ? 200 : 409);
      res.end(JSON.stringify(ok ? { accepted: true, agentId, stance, confidence } : { error: 'Quick score already submitted or phase ended' }));
      return;
    }

    // POST /api/debate/:debateId/argument
    const argMatch = url.match(/^\/api\/debate\/([^/]+)\/argument$/);
    if (argMatch && req.method === 'POST') {
      const debateId = decodeURIComponent(argMatch[1]);
      const body = await this.readBody(req);
      let agentId: string, persona: string, stance: string, reasoning: string, confidence: number;
      try {
        const p = JSON.parse(body);
        agentId = p.agentId; persona = p.persona || p.agentId;
        stance = p.stance; reasoning = p.reasoning; confidence = Number(p.confidence);
        if (!agentId || !stance || !reasoning) throw new Error();
      } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Expected: { agentId, stance, reasoning, confidence, persona? }' })); return;
      }
      if (!this.currentDebate || this.currentDebate.getState().phase !== 'ARGUING') {
        res.writeHead(409); res.end(JSON.stringify({ error: 'No active arguing phase', currentPhase: this.currentDebate?.getState().phase ?? 'NONE' })); return;
      }
      if (this.currentDebate.getState().debateId !== debateId) {
        res.writeHead(409); res.end(JSON.stringify({ error: 'debateId mismatch' })); return;
      }
      const argument = { agentId, persona, stance: stance as 'bull'|'bear'|'hold', reasoning, confidence, timestamp: Date.now() };
      const ok = this.currentDebate.addArgument(argument);
      if (ok) this.broadcast({ type: 'argument_received', argument });
      res.writeHead(ok ? 200 : 409);
      res.end(JSON.stringify(ok ? { accepted: true } : { error: 'Argument already submitted or phase ended' }));
      return;
    }

    // POST /api/debate/:debateId/rebuttal
    const rebMatch = url.match(/^\/api\/debate\/([^/]+)\/rebuttal$/);
    if (rebMatch && req.method === 'POST') {
      const debateId = decodeURIComponent(rebMatch[1]);
      const body = await this.readBody(req);
      let agentId: string, persona: string, targetAgentId: string, content: string;
      try {
        const p = JSON.parse(body);
        agentId = p.agentId; persona = p.persona || p.agentId;
        targetAgentId = p.targetAgentId; content = p.content;
        if (!agentId || !targetAgentId || !content) throw new Error();
      } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Expected: { agentId, targetAgentId, content, persona? }' })); return;
      }
      if (!this.currentDebate || this.currentDebate.getState().phase !== 'REBUTTAL') {
        res.writeHead(409); res.end(JSON.stringify({ error: 'No active rebuttal phase' })); return;
      }
      if (this.currentDebate.getState().debateId !== debateId) {
        res.writeHead(409); res.end(JSON.stringify({ error: 'debateId mismatch' })); return;
      }
      const rebuttal = { agentId, persona, targetAgentId, content, timestamp: Date.now() };
      const ok = this.currentDebate.addRebuttal(rebuttal);
      if (ok) this.broadcast({ type: 'rebuttal_received', rebuttal });
      res.writeHead(ok ? 200 : 409);
      res.end(JSON.stringify(ok ? { accepted: true } : { error: 'Rebuttal already submitted or phase ended' }));
      return;
    }

    // POST /api/debate/:debateId/vote
    const voteMatch = url.match(/^\/api\/debate\/([^/]+)\/vote$/);
    if (voteMatch && req.method === 'POST') {
      const debateId = decodeURIComponent(voteMatch[1]);
      const body = await this.readBody(req);
      let agentId: string, vote: string, confidence: number;
      try {
        const p = JSON.parse(body);
        agentId = p.agentId; vote = p.vote; confidence = Number(p.confidence ?? 70);
        if (!agentId || !['bull','bear','hold'].includes(vote)) throw new Error();
      } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Expected: { agentId, vote: bull|bear|hold, confidence }' })); return;
      }
      if (!this.currentDebate || this.currentDebate.getState().phase !== 'VOTING') {
        res.writeHead(409); res.end(JSON.stringify({ error: 'No active voting phase' })); return;
      }
      if (this.currentDebate.getState().debateId !== debateId) {
        res.writeHead(409); res.end(JSON.stringify({ error: 'debateId mismatch' })); return;
      }
      const voteObj = { agentId, vote: vote as 'bull'|'bear'|'hold', confidence };
      const ok = this.currentDebate.addVote(voteObj);
      if (ok) this.broadcast({ type: 'vote_received', agentId, vote: vote as 'bull'|'bear'|'hold' });
      res.writeHead(ok ? 200 : 409);
      res.end(JSON.stringify(ok ? { accepted: true } : { error: 'Vote already submitted or phase ended' }));
      return;
    }

    // GET /api/x402/pricing — free endpoint for discoverability
    if (url === '/api/x402/pricing') {

      const pricing = getPricingTable();
      res.writeHead(200);
      res.end(JSON.stringify({
        protocol: 'x402',
        version: 1,
        description: 'Agent Colosseum AI Consensus Oracle — pay-per-query via Solana',
        endpoints: {
          'GET /api/consensus/:mint': {
            ...pricing['consensus'],
            example: 'GET /api/consensus/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          },
          'POST /api/debate/request': {
            ...pricing['debate_request'],
            example: 'POST /api/debate/request {"mint":"..."}',
          },
        },
        paymentHeader: 'X-PAYMENT: <solana_tx_signature>',
        freeEndpoints: ['/api/leaderboard', '/api/history', '/api/backtest', '/api/x402/pricing', '/api/debate/status/:debateId'],
      }));
      return;
    }

    // -----------------------------------------------------------------------
    // PAID endpoints (x402 gated)
    // -----------------------------------------------------------------------

    // GET /api/consensus/:mint — query latest AI consensus for a token
    const consensusMatch = url.match(/^\/api\/consensus\/([A-Za-z0-9]+)$/);
    if (consensusMatch && req.method === 'GET') {
      const allowed = await x402Gate(req, res, 'consensus');
      if (!allowed) return;  // 402 or 403 already sent

      const mint = consensusMatch[1];
      const debate = this.debateHistory
        .filter(d => d.result && d.token.mint === mint)
        .pop();  // Latest debate for this mint

      if (!debate || !debate.result) {
        res.writeHead(404);
        res.end(JSON.stringify({
          error: 'No consensus found',
          mint,
          message: 'No AI debate has been conducted for this token yet.',
        }));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify({
        mint,
        token: { name: debate.token.name, symbol: debate.token.symbol },
        consensus: debate.result.consensus,
        consensusConfidence: debate.result.consensusConfidence,
        bullCount: debate.result.bullCount,
        bearCount: debate.result.bearCount,
        holdCount: debate.result.holdCount,
        totalAgents: debate.result.totalAgents,
        topArguments: debate.result.topArguments?.slice(0, 3) ?? [],
        wasEscalated: debate.wasEscalated,
        debateId: debate.debateId,
        timestamp: debate.result.timestamp,
      }));
      return;
    }

    // POST /api/debate/request — request a new debate on a specific token (x402 paid)
    if (url === '/api/debate/request' && req.method === 'POST') {
      const allowed = await x402Gate(req, res, 'debate_request');
      if (!allowed) return;

      // Read request body
      const body = await this.readBody(req);
      let mint: string;
      try {
        const parsed = JSON.parse(body);
        mint = parsed.mint;
        if (!mint || typeof mint !== 'string') throw new Error('Missing mint');
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid request body. Expected JSON: {"mint": "<token_mint_address>"}' }));
        return;
      }

      // Pre-generate a debateId so external agent can start polling immediately
      const preDebateId = `debate-http-${Date.now()}-${mint.slice(0, 8)}`;

      // If another debate is in progress, queue this request
      if (this.currentDebate && this.currentDebate.getState().phase !== 'DONE') {
        const entry: DebateStatusEntry = {
          debateId: preDebateId, mint, status: 'queued', phase: 'WAITING', startedAt: Date.now(),
        };
        this.debateStatusMap.set(preDebateId, entry);
        // Queue the mint for after current debate finishes
        try {
          const dataPack = await aggregateFromMint(mint);
          this.pendingTokens.push(dataPack);
        } catch { /* ignore fetch errors for queuing */ }
        res.writeHead(202);
        res.end(JSON.stringify({
          status: 'queued',
          debateId: preDebateId,
          mint,
          message: 'Another debate is in progress. Your request is queued.',
          pollUrl: `/api/debate/status/${preDebateId}`,
          estimatedSeconds: 90,
        }));
        return;
      }

      // Trigger debate immediately
      try {
        const dataPack = await aggregateFromMint(mint);
        // Register in status map before startDebate so polling works immediately
        const entry: DebateStatusEntry = {
          debateId: preDebateId, mint, status: 'running', phase: 'QUICK_SCORE', startedAt: Date.now(),
        };
        this.debateStatusMap.set(preDebateId, entry);
        await this.startDebate(dataPack);
        // Update debateId in map to match the one created by startDebate
        const actualDebateId = this.currentDebate?.getState().debateId ?? preDebateId;
        if (actualDebateId !== preDebateId) {
          this.debateStatusMap.set(actualDebateId, { ...entry, debateId: actualDebateId });
          this.debateStatusMap.delete(preDebateId);
        }
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'started',
          debateId: actualDebateId,
          mint,
          token: { name: dataPack.name, symbol: dataPack.symbol },
          pollUrl: `/api/debate/status/${actualDebateId}`,
          estimatedSeconds: 90,
          message: 'Debate started. Poll pollUrl every 3s for status and result.',
        }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({
          error: 'Failed to start debate',
          reason: (err as Error).message,
        }));
      }
      return;
    }

    // 404 for everything else
    res.writeHead(404);
    res.end(JSON.stringify({
      error: 'Not found',
      endpoints: {
        free: ['/api/leaderboard', '/api/agent/:agentId', '/api/backtest', '/api/history', '/api/x402/pricing', '/api/debate/status/:debateId'],
        paid: ['GET /api/consensus/:mint', 'POST /api/debate/request'],
      },
    }));
  }

  /** Read HTTP request body as string (capped at 64KB to prevent abuse) */
  private readBody(req: IncomingMessage, maxBytes = 65_536): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          settled = true;
          req.destroy();
          reject(new Error(`Request body too large (>${maxBytes} bytes)`));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(Buffer.concat(chunks).toString('utf-8'));
        }
      });
      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    let agentId: string | null = null;

    // Send initial state snapshot to new viewer connections immediately on connect.
    // This ensures browser viewers see current agents and debate state even if they
    // connected after bots had already joined (avoiding stale NODES_ACTIVE: 0).
    const agentList = Array.from(this.clients.values()).map(c => c.agent);
    this.sendTo(ws, {
      type: 'viewer_state',
      agents: agentList,
      totalAgents: this.clients.size,
      activeDebate: this.currentDebate?.getState() ?? null,
    } as unknown as ServerMessage);

    ws.on('pong', () => {
      if (agentId && this.clients.has(agentId)) {
        this.clients.get(agentId)!.isAlive = true;
      }
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString());
        if (msg.type === 'join') {
          agentId = msg.agentId;
          this.handleJoin(ws, msg);
        } else if (agentId) {
          this.handleMessage(agentId, msg);
        }
      } catch {
        this.sendTo(ws, { type: 'error', message: 'Invalid message format' });
      }
    });

    ws.on('close', () => {
      if (agentId) this.removeClient(agentId);
    });

    ws.on('error', (err) => {
      console.error(`[Arena] Client error:`, err.message);
    });
  }

  private handleJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: 'join' }>): void {
    const { agentId, persona, wallet } = msg;

    if (this.clients.has(agentId)) {
      this.sendTo(ws, { type: 'error', message: `Agent ID "${agentId}" already connected` });
      return;
    }

    const stats: AgentStats = {
      debatesJoined: 0, correctPredictions: 0, totalPredictions: 0, winRate: 0.5,
    };

    const agent: ArenaAgent = { agentId, persona, wallet, joinedAt: Date.now(), stats };
    this.clients.set(agentId, { ws, agent, isAlive: true });
    if (!this.agentWeights.has(agentId)) this.agentWeights.set(agentId, 0.5);

    console.log(`[Arena] Agent joined: ${agentId} (${persona}) — total: ${this.clients.size}`);

    const agentList = Array.from(this.clients.values()).map(c => c.agent);
    this.sendTo(ws, {
      type: 'welcome', agentId,
      activeDebate: this.currentDebate?.getState(),
      agents: agentList,
    });

    this.broadcast({ type: 'agent_joined', agent, totalAgents: this.clients.size }, agentId);
  }

  private removeClient(agentId: string): void {
    this.clients.delete(agentId);
    this.broadcast({ type: 'agent_left', agentId, totalAgents: this.clients.size });
    console.log(`[Arena] Agent left: ${agentId} — total: ${this.clients.size}`);
  }

  private handleMessage(agentId: string, msg: ClientMessage): void {
    switch (msg.type) {
      case 'quick_score': this.handleQuickScore(agentId, msg); break;
      case 'argument': this.handleArgument(agentId, msg); break;
      case 'rebuttal': this.handleRebuttal(agentId, msg); break;
      case 'vote': this.handleVote(agentId, msg); break;
      case 'request_debate': this.handleDebateRequest(msg.mint); break;
    }
  }

  private handleQuickScore(agentId: string, msg: Extract<ClientMessage, { type: 'quick_score' }>): void {
    if (!this.currentDebate) return;
    const client = this.clients.get(agentId);
    if (!client) return;
    const score = { agentId, persona: client.agent.persona, stance: msg.stance, confidence: msg.confidence };
    if (this.currentDebate.addQuickScore(score)) {
      this.broadcast({ type: 'quick_score_received', agentId, stance: msg.stance, confidence: msg.confidence });
    }
  }

  private handleArgument(agentId: string, msg: Extract<ClientMessage, { type: 'argument' }>): void {
    if (!this.currentDebate) return;
    const client = this.clients.get(agentId);
    if (!client) return;
    const argument = {
      agentId, persona: client.agent.persona,
      stance: msg.stance, reasoning: msg.reasoning,
      confidence: msg.confidence, timestamp: Date.now(),
    };
    if (this.currentDebate.addArgument(argument)) {
      this.broadcast({ type: 'argument_received', argument });
    }
  }

  private handleRebuttal(agentId: string, msg: Extract<ClientMessage, { type: 'rebuttal' }>): void {
    if (!this.currentDebate) return;
    const client = this.clients.get(agentId);
    if (!client) return;
    const rebuttal = {
      agentId, persona: client.agent.persona,
      targetAgentId: msg.targetAgentId, content: msg.content, timestamp: Date.now(),
    };
    if (this.currentDebate.addRebuttal(rebuttal)) {
      this.broadcast({ type: 'rebuttal_received', rebuttal });
    }
  }

  private handleVote(agentId: string, msg: Extract<ClientMessage, { type: 'vote' }>): void {
    if (!this.currentDebate) return;
    const vote = { agentId, vote: msg.vote, confidence: msg.confidence };
    if (this.currentDebate.addVote(vote)) {
      this.broadcast({ type: 'vote_received', agentId, vote: msg.vote });
    }
  }

  async startDebate(token: TokenDataPack): Promise<void> {
    if (this.currentDebate && this.currentDebate.getState().phase !== 'DONE') {
      console.log('[Arena] Debate already in progress, skipping');
      return;
    }
    if (this.clients.size < this.config.minAgentsToDebate) {
      console.log(`[Arena] Not enough agents (${this.clients.size}/${this.config.minAgentsToDebate})`);
      return;
    }

    this.debateCounter++;
    const debateId = `debate-${this.debateCounter}-${Date.now()}`;

    this.currentDebate = new DebateManager(
      debateId, token, this.config, this.agentWeights,
      (debate) => this.onDebatePhaseChange(debate),
    );

    const debate = this.currentDebate.start();
    console.log(`[Arena] Debate started: ${debateId} — ${token.symbol} (${token.name}) → QUICK_SCORE phase`);

    // Send quick_score_phase instead of debate_start — agents will score first
    this.broadcast({
      type: 'quick_score_phase', debateId, token, deadline: debate.phaseDeadline,
    });
  }

  private onDebatePhaseChange(debate: Debate): void {
    switch (debate.phase) {
      case 'ARGUING':
        // Escalated from QUICK_SCORE — notify agents of full debate
        this.broadcast({
          type: 'debate_start', debateId: debate.debateId, token: debate.token,
          phase: 'ARGUING', deadline: debate.phaseDeadline,
        });
        break;
      case 'REBUTTAL':
        this.broadcast({ type: 'rebuttal_phase', debateId: debate.debateId, arguments: debate.arguments, deadline: debate.phaseDeadline });
        break;
      case 'VOTING':
        this.broadcast({ type: 'vote_phase', debateId: debate.debateId, deadline: debate.phaseDeadline });
        break;
      case 'DONE':
        if (debate.result) {
          this.broadcast({ type: 'debate_result', result: debate.result, wasEscalated: debate.wasEscalated });
          this.debateHistory.push(debate);
          if (this.debateHistory.length > 50) this.debateHistory.shift();

          this.updateAgentStats(debate);

          const modeStr = debate.wasEscalated ? '🔥 FULL DEBATE' : '⚡ QUICK';
          console.log(`[Arena] ${modeStr} ended: ${debate.result.consensus.toUpperCase()} (${debate.result.consensusConfidence}%)`);

          // Update HTTP polling status map so external agents get the result
          if (this.debateStatusMap.has(debate.debateId)) {
            this.debateStatusMap.set(debate.debateId, {
              ...this.debateStatusMap.get(debate.debateId)!,
              status: 'complete',
              phase: 'DONE',
              completedAt: Date.now(),
              result: {
                consensus: debate.result.consensus,
                consensusConfidence: debate.result.consensusConfidence,
                bullCount: debate.result.bullCount,
                bearCount: debate.result.bearCount,
                holdCount: debate.result.holdCount,
                totalAgents: debate.result.totalAgents,
                wasEscalated: debate.wasEscalated,
                topArguments: debate.result.topArguments?.slice(0, 3) ?? [],
                token: { symbol: debate.token.symbol, name: debate.token.name },
                timestamp: debate.result.timestamp,
              },
            });
          }

          // Track price for backtesting
          const price = parseFloat(debate.token.bitget?.price || '0');
          if (price > 0) {
            this.priceTracker.track(
              debate.debateId, debate.token.mint, debate.token.symbol,
              debate.result.consensus, debate.result.consensusConfidence, price,
            );
          }

          // Drain queue
          if (this.pendingTokens.length > 0) {
            const next = this.pendingTokens.shift()!;
            console.log(`[Arena] Queue drain: starting $${next.symbol} (remaining: ${this.pendingTokens.length})`);
            setTimeout(() => this.startDebate(next), 5_000);
          }
        }
        break;
    }
  }

  /** Track agent accuracy: did their vote match the consensus? */
  private updateAgentStats(debate: Debate): void {
    if (!debate.result) return;
    const consensus = debate.result.consensus;

    for (const vote of debate.votes) {
      const client = this.clients.get(vote.agentId);
      if (!client) continue;

      client.agent.stats.debatesJoined++;
      client.agent.stats.totalPredictions++;
      if (vote.vote === consensus) {
        client.agent.stats.correctPredictions++;
      }
      client.agent.stats.winRate = client.agent.stats.totalPredictions > 0
        ? client.agent.stats.correctPredictions / client.agent.stats.totalPredictions
        : 0.5;

      // Update consensus weight for future debates
      this.agentWeights.set(vote.agentId, client.agent.stats.winRate);

      console.log(`[Arena] ${vote.agentId} win rate → ${(client.agent.stats.winRate * 100).toFixed(0)}% (${client.agent.stats.correctPredictions}/${client.agent.stats.totalPredictions})`);
    }
  }

  private async handleDebateRequest(mint: string): Promise<void> {
    try {
      const dataPack = await aggregateFromMint(mint);
      await this.startDebate(dataPack);
    } catch (err) {
      console.error('[Arena] Failed to start debate from request:', err);
    }
  }

  private startDiscovery(): void {
    // Poll interval: wait for current debate to finish (~75s) + buffer
    this.discovery = new TokenDiscoveryEngine(
      (token) => this.onTokenDiscovered(token),
      90_000,  // Poll every 90 seconds
    );
    this.discovery.start();
  }

  private async onTokenDiscovered(token: TokenDataPack): Promise<void> {
    // If a debate is in progress, queue for later
    if (this.currentDebate && this.currentDebate.getState().phase !== 'DONE') {
      if (this.pendingTokens.length < 5) {
        this.pendingTokens.push(token);
        console.log(`[Arena] Queued: $${token.symbol} (debate in progress, queue: ${this.pendingTokens.length})`);
      }
      return;
    }
    await this.startDebate(token);
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, excludeAgentId?: string): void {
    const payload = JSON.stringify(msg);
    this.clients.forEach((client, agentId) => {
      if (agentId !== excludeAgentId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    });
  }

  get agentCount(): number { return this.clients.size; }
  get activeDebate(): Debate | null { return this.currentDebate?.getState() ?? null; }
  get history(): Debate[] { return this.debateHistory; }
  getConnectedAgents(): ArenaAgent[] { return Array.from(this.clients.values()).map(c => c.agent); }
}
