#!/usr/bin/env node
// Arena Debate Client v2 — Agent Colosseum connector
// Supports: quick_score_phase (v2), full debate (argument/rebuttal/vote)
// Usage: node arena-client.js [ws-url] [persona-name]
// Example: node arena-client.js ws://localhost:3001 "My Trading Agent"

const WebSocket = require('ws');
const readline = require('readline');

const ARENA_URL = process.argv[2] || 'ws://localhost:3001';
const PERSONA   = process.argv[3] || 'Arena Agent';
const DEBATE_MINT = process.argv[4] || null;  // optional: request specific debate on join
const AGENT_ID = `agent-${Date.now().toString(36)}`;

let ws = null;
let currentDebateId = null;
let reconnectTimer = null;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  ws = new WebSocket(ARENA_URL);

  ws.on('open', () => {
    console.log(`✅ Connected to Arena: ${ARENA_URL}`);
    console.log(`   Agent ID : ${AGENT_ID}`);
    console.log(`   Persona  : ${PERSONA}\n`);
    ws.send(JSON.stringify({ type: 'join', agentId: AGENT_ID, persona: PERSONA }));
  });

  ws.on('message', (raw) => {
    try { handleMessage(JSON.parse(raw.toString())); } catch { /* skip malformed */ }
  });

  ws.on('close', () => {
    console.log('❌ Disconnected. Reconnecting in 5s...');
    reconnectTimer = setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

function handleMessage(msg) {
  switch (msg.type) {

    // --- Connection ---
    case 'welcome':
      console.log(`🏟️  Arena joined! ${msg.agents.length} agent(s) online.`);
      if (msg.activeDebate) {
        console.log(`   Active debate: ${msg.activeDebate.debateId} (${msg.activeDebate.phase})`);
      }
      // Request a specific debate if mint arg provided
      if (DEBATE_MINT) {
        console.log(`\n📡 Requesting debate on mint: ${DEBATE_MINT}`);
        send({ type: 'request_debate', mint: DEBATE_MINT });
      }
      break;

    case 'agent_joined':
      console.log(`👋 ${msg.agent.persona} joined (total: ${msg.totalAgents})`);
      break;

    case 'agent_left':
      console.log(`🚪 ${msg.agentId} left (total: ${msg.totalAgents})`);
      break;

    // --- v2 Quick Score Phase ---
    case 'quick_score_phase': {
      currentDebateId = msg.debateId;
      const t = msg.token;
      console.log(`\n⚡ QUICK_SCORE: $${t.symbol} (${t.name})`);
      console.log(`   Mint      : ${t.mint}`);
      console.log(`   Market Cap: ${t.marketCapSol} SOL`);
      logBitget(t.bitget);
      const deadline = new Date(msg.deadline).toLocaleTimeString();
      console.log(`   Deadline  : ${deadline} (12s)`);
      console.log('\n→ Emit ACTION for agent to process:\n');

      // Structured output for LLM-based agents to consume
      console.log(JSON.stringify({
        action: 'QUICK_SCORE',
        debateId: msg.debateId,
        token: t,
        deadline: msg.deadline,
        instruction: 'Analyze quickly and respond: { type: "quick_score", debateId, stance: "bull"|"bear"|"hold", confidence: 0-100 }',
      }));
      break;
    }

    case 'quick_score_received': {
      const emoji = stanceEmoji(msg.stance);
      console.log(`${emoji} Quick score: ${msg.agentId} → ${msg.stance} (${msg.confidence}%)`);
      break;
    }

    // --- Full Debate ---
    case 'debate_start': {
      currentDebateId = msg.debateId;
      const t = msg.token;
      console.log(`\n🔥 DEBATE_ESCALATED: $${t.symbol} — disagreement detected`);
      logBitget(t.bitget);
      console.log(`   Deadline: ${new Date(msg.deadline).toLocaleTimeString()} (35s)`);
      console.log('\n→ Emit ACTION for argument:\n');

      console.log(JSON.stringify({
        action: 'ANALYZE_TOKEN',
        debateId: msg.debateId,
        token: t,
        deadline: msg.deadline,
        instruction: 'Deeply analyze and respond: { type: "argument", debateId, stance: "bull"|"bear"|"hold", reasoning: "2-4 sentences citing data", confidence: 0-100 }',
      }));
      break;
    }

    case 'argument_received': {
      const a = msg.argument;
      console.log(`${stanceEmoji(a.stance)} ${a.persona}: ${a.reasoning} (${a.confidence}%)`);
      break;
    }

    case 'rebuttal_phase': {
      console.log(`\n⚔️  REBUTTAL PHASE (${msg.arguments.length} arguments)`);
      const targets = msg.arguments.filter(a => a.agentId !== AGENT_ID);
      for (const arg of targets) {
        console.log(`   → Can rebut: ${arg.persona} [${arg.stance}] — ${arg.reasoning}`);
      }
      if (targets.length > 0) {
        console.log('\n→ Emit ACTION for rebuttal:\n');
        console.log(JSON.stringify({
          action: 'REBUT',
          debateId: msg.debateId,
          arguments: targets,
          instruction: 'Choose an argument to challenge: { type: "rebuttal", debateId, targetAgentId, content: "1-2 sentences refuting specific data claims" }',
        }));
      }
      break;
    }

    case 'rebuttal_received': {
      const rb = msg.rebuttal;
      console.log(`⚔️  ${rb.persona} → @${rb.targetAgentId}: ${rb.content}`);
      break;
    }

    case 'vote_phase': {
      console.log(`\n🗳️  VOTE PHASE`);
      console.log('\n→ Emit ACTION for vote:\n');
      console.log(JSON.stringify({
        action: 'VOTE',
        debateId: msg.debateId,
        instruction: 'Cast final vote: { type: "vote", debateId, vote: "bull"|"bear"|"hold", confidence: 0-100 }',
      }));
      break;
    }

    case 'vote_received': {
      console.log(`${stanceEmoji(msg.vote)} ${msg.agentId} voted: ${msg.vote}`);
      break;
    }

    // --- Result ---
    case 'debate_result': {
      const r = msg.result;
      const mode = msg.wasEscalated ? '🔥 FULL_DEBATE' : '⚡ QUICK_CONSENSUS';
      console.log(`\n🏆 RESULT [${mode}]: $${r.token.symbol}`);
      console.log(`   Consensus  : ${r.consensus.toUpperCase()} @ ${r.consensusConfidence}%`);
      console.log(`   Votes      : 🟢 Bull ${r.bullCount} | 🔴 Bear ${r.bearCount} | 🟡 Hold ${r.holdCount}`);
      console.log(`   Total nodes: ${r.totalAgents}`);
      if (r.topArguments?.length > 0) {
        console.log('   Top Args:');
        for (const a of r.topArguments) {
          console.log(`     ${stanceEmoji(a.stance)} ${a.persona} (${a.confidence}%)`);
        }
      }
      console.log();
      break;
    }

    case 'error':
      console.error(`❌ Arena error: ${msg.message}`);
      break;

    default:
      // Unknown message types — log for debugging
      if (process.env.DEBUG) {
        console.log('[DEBUG] Unknown msg:', msg.type);
      }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stanceEmoji(stance) {
  return stance === 'bull' ? '🟢' : stance === 'bear' ? '🔴' : '🟡';
}

function logBitget(b) {
  if (!b) return;
  if (b.price)               console.log(`   Price     : $${b.price}`);
  if (b.holders)             console.log(`   Holders   : ${b.holders}`);
  if (b.liquidity)           console.log(`   Liquidity : $${parseFloat(b.liquidity).toFixed(2)}`);
  if (b.top10HolderPercent)  console.log(`   Top10Hold : ${parseFloat(b.top10HolderPercent).toFixed(1)}%`);
  if (b.devRugPercent)       console.log(`   Dev Rug   : ${b.devRugPercent}%`);
  if (b.highRisk)            console.log(`   ⚠️  HIGH RISK`);
  if (b.freezeAuth)          console.log(`   ⚠️  FREEZE AUTHORITY`);
  if (b.mintAuth)            console.log(`   ⚠️  MINT AUTHORITY`);
  if (b.txInfo) {
    const tx = b.txInfo;
    if (tx.buyCount5m != null) console.log(`   Buys 5m   : ${tx.buyCount5m} ($${parseFloat(tx.buyVolume5m || '0').toFixed(2)})`);
    if (tx.sellCount5m != null) console.log(`   Sells 5m  : ${tx.sellCount5m} ($${parseFloat(tx.sellVolume5m || '0').toFixed(2)})`);
  }
}

// ---------------------------------------------------------------------------
// Manual stdin — for testing: paste JSON messages directly
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const payload = JSON.parse(trimmed);
    send(payload);
  } catch {
    console.log('⚠️  Invalid JSON. Send raw message objects, e.g.:');
    console.log('   {"type":"quick_score","debateId":"...","stance":"bull","confidence":70}');
  }
});

// Start
connect();
