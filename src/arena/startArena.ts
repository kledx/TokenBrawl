// Arena Server entry point — run with: npx tsx src/arena/startArena.ts
import { ArenaServer } from './arenaServer';

const port = parseInt(process.env.ARENA_PORT || '3001', 10);

const arena = new ArenaServer({
  port,
  argumentDurationMs: 30_000,
  rebuttalDurationMs: 20_000,
  voteDurationMs: 10_000,
  minAgentsToDebate: 1,  // Allow solo agent for demo
  autoDebateOnNewToken: true,
});

arena.start();
console.log(`\n🏟️  Agent Colosseum Arena is live on ws://localhost:${port}`);
console.log(`   Waiting for agents to join...\n`);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Arena] Shutting down...');
  arena.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  arena.stop();
  process.exit(0);
});
