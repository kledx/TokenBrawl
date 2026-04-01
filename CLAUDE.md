# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TokenBrawl (package name: `agent-colosseum`) is a decentralized AI agent debate arena for Solana meme coins. Multiple LLM-powered agents connect via WebSocket, debate newly discovered tokens using real-time on-chain data from Bitget Wallet APIs, and produce weighted consensus signals (BULL/BEAR/HOLD). Includes an x402 (HTTP 402) payment protocol for monetized API access on Solana.

## Common Commands

### Development

```bash
npm install                          # Install dependencies
npm run dev                          # Start Vite frontend dev server (port 4000)
npm run arena                        # Start arena WebSocket server (port 3001)
npm run arena:bots                   # Start 3 AI bot agents (connects to arena)
npx tsx src/arena/botAgents.ts ws://localhost:3001  # Start bots with explicit URL
npm run build                        # TypeScript check + Vite production build
```

### Testing

```bash
npx tsx src/arena/x402.test.ts       # Run x402 integration tests
```

There is no test framework (jest/vitest). The single test file (`src/arena/x402.test.ts`) uses a custom assert helper with manual HTTP server setup. Tests run directly via `tsx`.

### Docker (Production)

```bash
docker compose up -d                 # Start all 3 services (arena, web, bots)
```

### Type Checking

```bash
npx tsc -b                           # Run TypeScript compiler (noEmit mode)
```

There is no linter or formatter configured in this project.

## Architecture

### Three-Tier Runtime

```
web (Nginx, port 80)  ──▶  arena (Node.js, port 3001)  ◀──  bots (3 LLM agents)
   Static SPA                 WebSocket + HTTP REST             WebSocket clients
```

- **arena**: Core server (`src/arena/arenaServer.ts`) — raw `http.createServer` (no Express), `ws` WebSocket library, JSON file persistence at `/data/arena-state.json`
- **web**: Nginx serves Vite-built React SPA, proxies `/arena` path to arena service via WebSocket upgrade
- **bots**: Same arena image with different entrypoint, runs 3 AI personas

### Source Layout

- **`src/arena/`** — Backend (Node.js/TypeScript, runs via `tsx`)
  - `arenaServer.ts` — Central hub: WS server, HTTP API routing, token discovery loop, state persistence
  - `debateManager.ts` — Debate state machine (WAITING → QUICK_SCORE → ARGUING → REBUTTAL → VOTING → DONE)
  - `botAgents.ts` — 3 AI agents (ALPHA BULL, SIGMA BEAR, DATA MONK) with LLM-first + rules-engine fallback
  - `llmClient.ts` — OpenAI-compatible LLM abstraction (configurable via env vars)
  - `tokenDiscovery.ts` — Bitget Launchpad API integration with TIER rating (S/A/B/C) filtering
  - `dataAggregator.ts` — Bitget Wallet Skills API for token info, security audits, tx data
  - `priceTracker.ts` — Backtesting engine (checks prices at 5m/15m/1h after consensus)
  - `x402Middleware.ts` + `x402PaymentVerifier.ts` — HTTP 402 payment gating with Solana on-chain verification
  - `types.ts` — Shared type system for agents, debates, and WS messages

- **`src/components/`** — Frontend (React 19, no router, no state library)
  - `ArenaPage.tsx` — Main dashboard with WS client, live chat, consensus panel, history
  - `AgentDocsPanel.tsx` — Agent integration docs (EN/ZH)
  - `X402DocsPanel.tsx` — x402 payment API docs (EN/ZH)

- **`skills/`** — MCP and CLI tools for external agent integration
  - `arena-debate/scripts/arena-mcp-server.js` — MCP Server (for Claude Desktop/Cursor)
  - `arena-debate/scripts/arena-client.js` — CLI WebSocket client for agents
  - `x402-query/scripts/x402-client.js` — CLI x402 payment client

- **`orchestrator/`** — AI development orchestration (not runtime code). Contains protocols and tracked work programs for AI coding agents.

### Key Design Patterns

- **Debate Fast Path**: Quick Score phase (12s) uses only the rules engine. If all agents agree, debate completes instantly with zero LLM calls. Full debate (~87s, 9 LLM calls) only triggers on disagreement.
- **Dual-Mode Bot Architecture**: Each bot tries LLM first (12s timeout), falls back to a deterministic scoring engine that evaluates market cap, holder count, risk flags, and buy/sell pressure.
- **No Database**: All state is JSON file persistence (`/data/arena-state.json`) + in-memory Maps/Sets. Docker volume `arena-data` survives container restarts.
- **HTTP API without Framework**: `arenaServer.ts` uses raw `http.createServer` with manual regex-based URL routing. No Express/Fastify.
- **Frontend State**: All in `useState` within `ArenaPage.tsx`. No Redux/Zustand. State flows from WebSocket messages → React state → render.
- **i18n**: Inline `TRANSLATIONS` objects with `en`/`zh` keys in frontend components. LLM prompts support `ARENA_LLM_LANG=zh`.

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARENA_PORT` | `3001` | Arena server port |
| `ARENA_LLM_BASE_URL` | — | OpenAI-compatible LLM API URL |
| `ARENA_LLM_API_KEY` | — | LLM API key |
| `ARENA_LLM_MODEL` | `gpt-4o-mini` | Model name |
| `ARENA_LLM_LANG` | `en` | Debate language (`en` or `zh`) |
| `X402_PAY_TO` | — | Solana wallet for x402 payments |
| `VITE_ARENA_WS_URL` | `ws://localhost/arena` | Frontend WS URL (build-time) |

### WebSocket Protocol

Defined in `ARENA_PROTOCOL.md`. Key message types:
- Client → Server: `join`, `quick_score`, `argument`, `rebuttal`, `vote`, `request_debate`
- Server → Client: `welcome`, `viewer_state`, `quick_score_phase`, `debate_start`, `debate_result`, phase transitions

### Docker Build

Multi-stage Dockerfile produces two targets:
- `arena` stage — Node 22 Alpine, runs TypeScript via `tsx`
- `web` stage — Nginx 1.27 Alpine, serves Vite build output

`VITE_ARENA_WS_URL` is a build arg embedded at Vite build time.
