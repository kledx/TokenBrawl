import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  ServerMessage, ArenaAgent, Argument,
  ConsensusResult, TokenDataPack, Stance,
} from '../arena/types';
import { X402DocsPanel } from './X402DocsPanel';
import { AgentDocsPanel } from './AgentDocsPanel';

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

const TRANSLATIONS = {
  en: {
    subtitle: "Decentralized AI Consensus Protocol",
    connectedNodes: "Connected Nodes",
    noAgents: "No nodes connected",
    winRate: "Win rate",
    enterMint: "Paste token mint address...",
    execute: "EXECUTE",
    consensus: "Consensus",
    confidence: "STRENGTH",
    topArgs: "Top Arguments",
    awaitingData: "AWAITING_DATA",
    systemIdle: "SYSTEM_IDLE",
    onchainData: "On-Chain Data",
    holders: "Holders",
    liquidity: "Liquidity",
    top10Hold: "Top10 Hold",
    riskLevel: "Risk Level",
    highRisk: "HIGH_RISK",
    lowRisk: "LOW_RISK",
    langToggle: "CN",
    // New i18n keys
    nodesActive: "NODES_ACTIVE:",
    debateHistory: "DEBATE_HISTORY",
    viewingArchived: "◈ VIEWING ARCHIVED:",
    returnToLive: "RETURN TO LIVE",
    devRug: "DEV_RUG",
    confidenceLabel: "STRENGTH:",
    phases: {
      QUICK_SCORE: "QUICK_SCORE",
      ARGUING: "ARGUING",
      REBUTTAL: "REBUTTAL",
      VOTING: "VOTING",
      DONE: "DONE",
      ARCHIVED: "ARCHIVED",
      WAITING: "WAITING",
    },
  },
  zh: {
    subtitle: "去中心化 AI 链上共识网络",
    connectedNodes: "已接入节点 (Nodes)",
    noAgents: "暂无节点接入",
    winRate: "历史胜率",
    enterMint: "输入代币 Mint 目标地址...",
    execute: "执行协议",
    consensus: "全局共识 (Consensus)",
    confidence: "共识强度",
    topArgs: "核心论点 (Top Args)",
    awaitingData: "等待网络情报...",
    systemIdle: "系统空闲中",
    onchainData: "链上数据 (On-Chain)",
    holders: "持币地址数",
    liquidity: "流动性池",
    top10Hold: "前十持仓占比",
    riskLevel: "合约风险评级",
    highRisk: "高风险",
    lowRisk: "低风险",
    langToggle: "EN",
    // New i18n keys
    nodesActive: "活跃节点:",
    debateHistory: "辩论历史",
    viewingArchived: "◈ 历史档案:",
    returnToLive: "返回实时",
    devRug: "Dev归零风险",
    confidenceLabel: "共识强度:",
    phases: {
      QUICK_SCORE: "快速评分",
      ARGUING: "激辩阶段",
      REBUTTAL: "反驳阶段",
      VOTING: "投票中",
      DONE: "已完成",
      ARCHIVED: "历史档案",
      WAITING: "等待中",
    },
  }
};

// ---------------------------------------------------------------------------
// Types for local UI state
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  type: 'system' | 'argument' | 'rebuttal' | 'vote' | 'result' | 'separator';
  agentId?: string;
  persona?: string;
  stance?: Stance;
  content: string;
  confidence?: number;
  timestamp: number;
}

// Map persona keywords to emojis for richer avatars
const PERSONA_EMOJI: Record<string, string> = {
  'alpha bull': '🐂',
  'sigma bear': '🐻',
  'data monk': '📊',
  'bull': '🟢',
  'bear': '🔴',
  'hold': '🟡',
};

const PERSONA_AVATAR: Record<string, string> = {
  'alpha bull': '/agents/alpha_bull.png',
  'sigma bear': '/agents/sigma_bear.png',
  'data monk': '/agents/data_monk.png',
};

function getPersonaEmoji(persona: string): React.ReactNode {
  const key = persona.toLowerCase();
  for (const [k, v] of Object.entries(PERSONA_AVATAR)) {
    if (key.includes(k)) {
      return (
        <div style={{
          width: '100%', height: '100%', 
          backgroundImage: `url(${v})`, backgroundSize: 'cover', backgroundPosition: 'center',
          borderRadius: '4px'
        }} />
      );
    }
  }
  for (const [k, v] of Object.entries(PERSONA_EMOJI)) {
    if (key.includes(k)) return v;
  }
  return '⚡';
}

// ---------------------------------------------------------------------------
// ArenaPage Component
// ---------------------------------------------------------------------------

export function ArenaPage() {
  const [view, setView] = useState<'arena' | 'api' | 'agent'>('arena');
  const [connected, setConnected] = useState(false);
  const [agents, setAgents] = useState<ArenaAgent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentToken, setCurrentToken] = useState<TokenDataPack | null>(null);
  const [phase, setPhase] = useState<string>('WAITING');
  const [deadline, setDeadline] = useState<number>(0);
  const [result, setResult] = useState<ConsensusResult | null>(null);
  const [mintInput, setMintInput] = useState('');
  const [lang, setLang] = useState<'en' | 'zh'>('en');
  const [debateHistory, setDebateHistory] = useState<Array<{
    token: { symbol: string; name: string; marketCapSol?: number; bitget?: any; mint?: string; };
    consensus: string;
    confidence: number;
    totalAgents: number;
    wasEscalated: boolean;
    timestamp: number;
    chatLog: ChatMessage[];
    fullResult?: ConsensusResult;
  }>>([]);
  const [selectedHistoryIdx, setSelectedHistoryIdx] = useState<number | null>(null);

  const t = TRANSLATIONS[lang];

  const wsRef = useRef<WebSocket | null>(null);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const msgIdRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);

  const arenaUrl = import.meta.env?.VITE_ARENA_WS_URL || 'ws://localhost:3001';

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp'>) => {
    const id = `msg-${++msgIdRef.current}`;
    const fullMsg: ChatMessage = { ...msg, id, timestamp: Date.now() } as ChatMessage;
    setMessages(prev => {
      const next = [...prev, fullMsg];
      messagesRef.current = next;
      return next;
    });
  }, []);

  // Connect to Arena as observer
  // Use a ref-based approach to prevent StrictMode duplicate connections
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (cancelled) return;

      // Close any previous connection before creating a new one
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      ws = new WebSocket(arenaUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws?.close(); return; }
        setConnected(true);
        // Join as observer (frontend viewer)
        ws!.send(JSON.stringify({
          type: 'join',
          agentId: `viewer-${Date.now().toString(36)}`,
          persona: '[OBSERVER_NODE]',
        }));
        addMessage({ type: 'system', content: '[SYS] CONNECTION_ESTABLISHED: SECURE_CHANNEL_OPEN' });
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg: ServerMessage = JSON.parse(event.data);
          handleServerMessage(msg);
        } catch {
          // skip
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        // Connection state shown via LIVE/OFFLINE pill — no need to flood the chat feed
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        // onclose will handle reconnect
      };
    };

    const handleServerMessage = (msg: ServerMessage) => {
      switch (msg.type) {
        // Initial state snapshot sent on every new connection (before join handshake)
        case 'viewer_state' as any: {
          const vs = msg as any;
          setAgents(vs.agents ?? []);
          if (Array.isArray(vs.debateHistory) && vs.debateHistory.length > 0) {
            const restored = [...vs.debateHistory]
              .reverse()
              .filter((d: any) => d.result)
              .map((d: any) => {
                // Rebuild chatLog from persisted server-side Debate object
                const log: ChatMessage[] = [];
                let seq = 0;
                const mk = (type: ChatMessage['type'], extra: Partial<ChatMessage>, ts?: number): ChatMessage => ({
                  id: `hist-${d.debateId}-${seq++}`,
                  timestamp: ts ?? d.startedAt ?? Date.now(),
                  content: '',
                  type,
                  ...extra,
                });

                // Quick scores
                for (const qs of (d.quickScores ?? [])) {
                  const label = qs.stance === 'bull' ? '🟢 BULL' : qs.stance === 'bear' ? '🔴 BEAR' : '⚪ HOLD';
                  log.push(mk('argument', { agentId: qs.agentId, stance: qs.stance, content: `⚡ Quick Score: ${label} @ ${qs.confidence}%`, confidence: qs.confidence }));
                }

                // Arguments (ARGUING phase)
                if ((d.arguments ?? []).length > 0) {
                  log.push(mk('system', { content: '[EVENT] 🔥 DEBATE_ESCALATED — full argument phase' }));
                  for (const a of d.arguments) {
                    log.push(mk('argument', { agentId: a.agentId, persona: a.persona, stance: a.stance, content: a.reasoning, confidence: a.confidence }));
                  }
                }

                // Rebuttals
                if ((d.rebuttals ?? []).length > 0) {
                  log.push(mk('system', { content: '[PHASE_SHIFT] REBUTTAL_SEQUENCE_ENGAGED' }));
                  for (const r of d.rebuttals) {
                    log.push(mk('rebuttal', { agentId: r.agentId, persona: r.persona, content: `→ @${r.targetAgentId}: ${r.content}` }));
                  }
                }

                // Votes
                if ((d.votes ?? []).length > 0) {
                  log.push(mk('system', { content: '[PHASE_SHIFT] VOTING_SEQUENCE_ENGAGED' }));
                  for (const v of d.votes) {
                    const prefix = v.vote === 'bull' ? '[BULL]' : v.vote === 'bear' ? '[BEAR]' : '[HOLD]';
                    log.push(mk('vote', { agentId: v.agentId, stance: v.vote, content: `${prefix} Node <${v.agentId}> cast vote: ${v.vote.toUpperCase()}` }));
                  }
                }

                // Result
                const modeTag = d.wasEscalated ? '🔥 FULL_DEBATE' : '⚡ QUICK_CONSENSUS';
                log.push(mk('result', { content: `[RESULT] ${modeTag}: ${d.result.consensus.toUpperCase()} | CONFIDENCE: ${d.result.consensusConfidence}% | NODES: ${d.result.totalAgents}` }));

                return {
                  token: {
                    symbol: d.token?.symbol ?? d.result?.token?.symbol ?? '?',
                    name: d.token?.name ?? d.result?.token?.name ?? '',
                    marketCapSol: d.token?.marketCapSol,
                    bitget: d.token?.bitget,
                    mint: d.token?.mint ?? d.result?.token?.mint,
                  },
                  consensus: d.result.consensus,
                  confidence: d.result.consensusConfidence,
                  totalAgents: d.result.totalAgents,
                  wasEscalated: d.wasEscalated ?? false,
                  timestamp: d.startedAt ?? Date.now(),
                  chatLog: log,
                  fullResult: d.result,
                };
              });
            setDebateHistory(restored);
            // Auto-select the most recent debate if no active debate is running,
            // so the main dashboard shows data immediately on page load/refresh
            if (!vs.activeDebate || vs.activeDebate.phase === 'DONE' || vs.activeDebate.phase === 'WAITING') {
              setSelectedHistoryIdx(0);
            }
          }
          break;
        }



        case 'welcome':
          setAgents(msg.agents);
          break;


        case 'agent_joined':
          setAgents(prev => [...prev.filter(a => a.agentId !== msg.agent.agentId), msg.agent]);
          addMessage({
            type: 'system',
            content: `[NODE_JOIN] ${msg.agent.persona} entered the pool. (ACTIVE_NODES: ${msg.totalAgents})`,
          });
          break;

        case 'agent_left':
          setAgents(prev => prev.filter(a => a.agentId !== msg.agentId));
          addMessage({
            type: 'system',
            content: `[NODE_LEAVE] ${msg.agentId} disconnected. (ACTIVE_NODES: ${msg.totalAgents})`,
          });
          break;

        case 'quick_score_phase':
          setCurrentToken(msg.token);
          setPhase('QUICK_SCORE');
          setDeadline(msg.deadline);
          setResult(null);
          // New live debate starting — exit history mode and show live feed
          setSelectedHistoryIdx(null);
          setMessages([]);
          messagesRef.current = [];
          
          addMessage({
            type: 'system',
            content: `[EVENT] QUICK_SCAN: $${msg.token.symbol} (${msg.token.name}) | MCAP: ${msg.token.marketCapSol.toFixed(1)} SOL`,
          });
          break;


        case 'quick_score_received': {
          const qsStance = msg.stance === 'bull' ? '🟢 BULL' : msg.stance === 'bear' ? '🔴 BEAR' : '⚪ HOLD';
          addMessage({
            type: 'argument',
            agentId: msg.agentId,
            stance: msg.stance,
            content: `⚡ Quick Score: ${qsStance} @ ${msg.confidence}%`,
            confidence: msg.confidence,
          });
          break;
        }

        case 'debate_start':
          setCurrentToken(msg.token);
          setPhase('ARGUING');
          setDeadline(msg.deadline);
          // Only clear if this is NOT an escalation (escalation keeps quick score messages)
          if (!result) {
            setResult(null);
          }
          addMessage({
            type: 'system',
            content: `[EVENT] 🔥 DEBATE_ESCALATED: $${msg.token.symbol} — disagreement detected, full argument phase`,
          });
          break;

        case 'argument_received':
          addMessage({
            type: 'argument',
            agentId: msg.argument.agentId,
            persona: msg.argument.persona,
            stance: msg.argument.stance,
            content: msg.argument.reasoning,
            confidence: msg.argument.confidence,
          });
          break;

        case 'rebuttal_phase':
          setPhase('REBUTTAL');
          setDeadline(msg.deadline);
          addMessage({ type: 'system', content: `[PHASE_SHIFT] REBUTTAL_SEQUENCE_ENGAGED` });
          break;

        case 'rebuttal_received':
          addMessage({
            type: 'rebuttal',
            agentId: msg.rebuttal.agentId,
            persona: msg.rebuttal.persona,
            content: `→ @${msg.rebuttal.targetAgentId}: ${msg.rebuttal.content}`,
          });
          break;

        case 'vote_phase':
          setPhase('VOTING');
          setDeadline(msg.deadline);
          addMessage({ type: 'system', content: '[PHASE_SHIFT] VOTING_SEQUENCE_ENGAGED' });
          break;

        case 'vote_received': {
          const stancePrefix = msg.vote === 'bull' ? '[BULL]' : msg.vote === 'bear' ? '[BEAR]' : '[HOLD]';
          addMessage({
            type: 'vote',
            agentId: msg.agentId,
            stance: msg.vote,
            content: `${stancePrefix} Node <${msg.agentId}> cast vote: ${msg.vote.toUpperCase()}`,
          });
          break;
        }

        case 'debate_result': {
          setPhase('DONE');
          setResult(msg.result);
          const modeTag = (msg as any).wasEscalated ? '🔥 FULL_DEBATE' : '⚡ QUICK_CONSENSUS';
          addMessage({
            type: 'result',
            content: `[RESULT] ${modeTag}: ${msg.result.consensus.toUpperCase()} | CONFIDENCE: ${msg.result.consensusConfidence}% | NODES: ${msg.result.totalAgents}`,
          });
          // Accumulate history with full chat log
          // Use ref for latest messages to avoid React batching race condition
          setDebateHistory(prev => [{
            token: {
              symbol: msg.result.token.symbol,
              name: msg.result.token.name,
              mint: msg.result.token.mint,
            },
            consensus: msg.result.consensus,
            confidence: msg.result.consensusConfidence,
            totalAgents: msg.result.totalAgents,
            wasEscalated: !!(msg as any).wasEscalated,
            timestamp: Date.now(),
            chatLog: [...messagesRef.current],
            fullResult: msg.result,
          }, ...prev].slice(0, 30));
          break;
        }
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null; // prevent reconnect on intentional close
        ws.close();
      }
      wsRef.current = null;
    };
  }, [arenaUrl, addMessage]);

  // Auto-scroll chat without shifting viewport
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Request debate on specific mint
  const requestDebate = () => {
    if (mintInput.trim() && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'request_debate', mint: mintInput.trim() }));
      addMessage({ type: 'system', content: `[TX] DEBATE_REQUEST_SENT_TO_MEMPOOL: ${mintInput.trim().slice(0, 12)}...` });
      setMintInput('');
    }
  };

  // Countdown timer
  const [timeLeft, setTimeLeft] = useState(0);
  useEffect(() => {
    if (!deadline) return;
    const interval = setInterval(() => {
      const left = Math.max(0, deadline - Date.now());
      setTimeLeft(left);
      if (left === 0) clearInterval(interval);
    }, 100);
    return () => clearInterval(interval);
  }, [deadline]);

  // History Mode resolution
  const isHistoryMode = selectedHistoryIdx !== null && debateHistory[selectedHistoryIdx] !== undefined;
  const historyItem = isHistoryMode ? debateHistory[selectedHistoryIdx] : null;

  const displayToken = isHistoryMode ? historyItem!.token : currentToken;
  const displayPhase = isHistoryMode ? 'ARCHIVED' : phase;
  const displayTimeLeft = isHistoryMode ? 0 : timeLeft;
  const displayMessages = isHistoryMode ? historyItem!.chatLog : messages;
  const displayResult = isHistoryMode ? historyItem!.fullResult : result;

  return (
    <div className="arena-dashboard">
      <div className="arena-watermark">AC.NET // GLOBAL_CONSENSUS_PROTOCOL_V2.1</div>

      {/* Decorative Left Sidebar */}
      <div className="arena-sidebar">
        <div className="arena-sidebar__line"></div>
        <div className="arena-sidebar__text">
          <span>SYS.CTRL // CORE_ACTIVE</span>
          <span>NET: MAINNET-BETA</span>
          <span style={{ color: 'rgba(0,255,200,0.4)', fontSize: '9px' }}>DATA: BITGET_WALLET</span>
        </div>
      </div>

      <div className="arena-page">
      {/* Header */}
      <div className="arena-header">
        <div className="arena-header__left" style={{ alignItems: 'center' }}>
          <div className="arena-header__logo" style={{
            width: '56px', height: '56px', 
            backgroundImage: 'url(/tokenbrawl_logo.png)', 
            backgroundSize: 'contain', 
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat', 
            marginRight: '16px',
            borderRadius: '12px',
            border: '1px solid rgba(255,255,255,0.15)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
          }}></div>
          <div>
            <h1 className="arena-header__title">TERMINAL // TokenBrawl</h1>
            <p className="arena-header__subtitle">{t.subtitle}</p>
          </div>
        </div>
        <div className="arena-header__right">
          {/* View toggle: ARENA / AGENT / API */}
          <div style={{ display: 'flex', gap: '4px', marginRight: '16px' }}>
            {(['arena', 'agent', 'api'] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  background: view === v ? 'rgba(0,255,200,0.15)' : 'transparent',
                  border: `1px solid ${view === v ? 'var(--accent-cyan)' : 'rgba(255,255,255,0.2)'}`,
                  color: view === v ? 'var(--accent-cyan)' : 'var(--text-muted)',
                  fontFamily: 'var(--font-mono)', fontSize: '10px',
                  padding: '4px 10px', cursor: 'pointer', borderRadius: '3px',
                  letterSpacing: '0.08em', transition: 'all 0.15s',
                }}
              >
                {v.toUpperCase()}
              </button>
            ))}
          </div>
          {/* Social links */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginRight: '12px' }}>
            {/* X / Twitter */}
            <a
              href="https://x.com/0xkled"
              target="_blank"
              rel="noopener noreferrer"
              title="@0xkled on X"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '28px', height: '28px', borderRadius: '4px',
                border: '1px solid rgba(255,255,255,0.15)', color: 'var(--text-muted)',
                textDecoration: 'none', transition: 'all 0.15s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--accent-cyan)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent-cyan)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.15)'; }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.261 5.632 5.903-5.632Zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
            </a>
            {/* GitHub */}
            <a
              href="https://github.com/kledx/TokenBrawl"
              target="_blank"
              rel="noopener noreferrer"
              title="TokenBrawl on GitHub"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '28px', height: '28px', borderRadius: '4px',
                border: '1px solid rgba(255,255,255,0.15)', color: 'var(--text-muted)',
                textDecoration: 'none', transition: 'all 0.15s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--accent-cyan)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent-cyan)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.15)'; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
              </svg>
            </a>
          </div>
          <button 
            onClick={() => setLang(l => l === 'en' ? 'zh' : 'en')}
            style={{
              background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', 
              color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '10px',
              padding: '4px 8px', cursor: 'pointer', marginRight: '16px'
            }}
          >
            {t.langToggle}
          </button>

          <span className={`status-pill ${connected ? 'status-pill--live' : 'status-pill--offline'}`}>
            <span className="status-dot"></span>
            {connected ? 'LIVE' : 'OFFLINE'}
          </span>
          <span className="status-pill">
            {t.nodesActive} {agents.filter(a => !a.agentId.startsWith('viewer-')).length}
          </span>
        </div>
      </div>

      {view === 'api' && <X402DocsPanel lang={lang} />}
      {view === 'agent' && <AgentDocsPanel lang={lang} />}

      <div className="arena-body" style={{ display: (view === 'api' || view === 'agent') ? 'none' : undefined }}>
        {/* Left: Agents panel */}
        <div className="arena-agents">
          <div className="section-card__header">
            <span className="section-card__title">{t.connectedNodes}</span>
          </div>
          <div className="arena-agents__list">
            {agents
              .filter(a => !a.agentId.startsWith('viewer-') && !a.persona.startsWith('[OBSERVER'))
              .map(agent => (
              <div key={agent.agentId} className="arena-agent-card">
                <div className="arena-agent-card__avatar">
                  {getPersonaEmoji(agent.persona)}
                </div>
                <div className="arena-agent-card__info">
                  <div className="arena-agent-card__name">{agent.persona.replace(/[🟢🔴📊]/g, '').trim()}</div>
                  <div className="arena-agent-card__meta">
                    {t.winRate}: {(agent.stats.winRate * 100).toFixed(0)}%
                  </div>
                </div>
              </div>
            ))}
            {agents.filter(a => !a.agentId.startsWith('viewer-') && !a.persona.startsWith('[OBSERVER')).length === 0 && (
              <div className="arena-agents__empty">{t.noAgents}</div>
            )}
          </div>

          {/* Debate request */}
          <div className="arena-debate-request">
            <input
              className="arena-mint-input"
              placeholder={t.enterMint}
              value={mintInput}
              onChange={e => setMintInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && requestDebate()}
            />
            <button className="btn btn--primary btn--sm" onClick={requestDebate} style={{textTransform:'uppercase', letterSpacing:'0.05em'}}>
              {t.execute}
            </button>
          </div>
        </div>

        {/* Center: Chat stream */}
        <div className="arena-chat">
          {isHistoryMode && (
            <div style={{
              background: 'rgba(0, 255, 200, 0.1)', borderBottom: '1px solid var(--accent-cyan)',
              padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <span style={{color: 'var(--accent-neon)', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em'}}>
                {t.viewingArchived} ${displayToken?.symbol} ◈
              </span>
              <button 
                className="btn btn--primary btn--sm" 
                onClick={() => setSelectedHistoryIdx(null)}
                style={{background: 'var(--accent-cyan)', color: '#000', border: 'none'}}
              >
                {t.returnToLive}
              </button>
            </div>
          )}

          {/* Token info bar */}
          {displayToken && (
            <div className="arena-token-bar">
              <div className="arena-token-bar__info">
                <span className="arena-token-bar__symbol">${displayToken.symbol}</span>
                <span className="arena-token-bar__name">{displayToken.name}</span>
                <span className="arena-token-bar__mcap">{displayToken.marketCapSol?.toFixed(1) || '0'} SOL</span>
                {displayToken.mint && (
                  <a
                    href={`https://solscan.io/token/${displayToken.mint}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={displayToken.mint}
                    style={{
                      fontFamily: 'var(--font-mono)', fontSize: '11px',
                      color: 'var(--text-muted)', textDecoration: 'none',
                      letterSpacing: '0.04em', cursor: 'pointer',
                      borderBottom: '1px dashed rgba(255,255,255,0.2)',
                      transition: 'color 0.15s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent-cyan)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                  >
                    {displayToken.mint.slice(0, 6)}…{displayToken.mint.slice(-4)}↗
                  </a>
                )}
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: '10px',
                  color: 'rgba(0,255,200,0.5)', letterSpacing: '0.06em',
                  padding: '1px 6px', borderRadius: '3px',
                  border: '1px solid rgba(0,255,200,0.15)',
                  background: 'rgba(0,255,200,0.05)',
                  whiteSpace: 'nowrap',
                }}>
                  via Bitget Wallet
                </span>
              </div>
              <div className="arena-token-bar__phase">
                <span className={`arena-phase-badge arena-phase-badge--${displayPhase.toLowerCase()}`}>
                  {t.phases[displayPhase as keyof typeof t.phases] ?? displayPhase}
                </span>
                {displayTimeLeft > 0 && (
                  <span className="arena-timer">{(displayTimeLeft / 1000).toFixed(0)}s</span>
                )}
              </div>
            </div>
          )}


          {/* Messages */}
          <div className="arena-chat__messages" ref={chatContainerRef}>
            {displayMessages.map(msg => {
              const time = new Date(msg.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' });
              return (
              <div key={msg.id} className={`arena-msg arena-msg--${msg.type} animate-fade-in`}>
                {msg.type === 'system' ? (
                  <div className="arena-msg__system">[{time}] {msg.content}</div>
                ) : msg.type === 'argument' ? (
                  <div className="arena-msg__argument">
                    <div className="arena-msg__header">
                      <span className={`arena-stance arena-stance--${msg.stance}`}>
                        {msg.stance === 'bull' ? 'BULL' : msg.stance === 'bear' ? 'BEAR' : 'HOLD'}
                      </span>
                      <span className="arena-msg__persona">{msg.persona}</span>
                      <span className="arena-msg__confidence">{t.confidenceLabel} {msg.confidence}%</span>
                      <span style={{marginLeft: '8px', fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)'}}>{time}</span>
                    </div>
                    <div className="arena-msg__content">{msg.content}</div>
                  </div>
                ) : msg.type === 'rebuttal' ? (
                  <div className="arena-msg__rebuttal">
                    <div style={{display: 'flex', gap: '8px', alignItems:'center'}}>
                      <span className="arena-msg__persona">{msg.persona}</span>
                      <span style={{fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)'}}>{time}</span>
                    </div>
                    <span className="arena-msg__content">{msg.content}</span>
                  </div>
                ) : msg.type === 'result' ? (
                  <div className="arena-msg__result">[{time}] {msg.content}</div>
                ) : msg.type === 'separator' ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '10px 0', margin: '4px 0',
                  }}>
                    <div style={{ flex: 1, height: '1px', background: 'linear-gradient(90deg, transparent, var(--accent-cyan), transparent)' }} />
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--accent-cyan)',
                      letterSpacing: '0.1em', whiteSpace: 'nowrap', textTransform: 'uppercase',
                    }}>
                      ◈ ROUND: {msg.content} ◈
                    </span>
                    <div style={{ flex: 1, height: '1px', background: 'linear-gradient(90deg, transparent, var(--accent-cyan), transparent)' }} />
                  </div>
                ) : (
                  <div className="arena-msg__vote">[{time}] {msg.content}</div>
                )}
              </div>
            )})}
          </div>
        </div>

        {/* Right: Consensus panel */}
        <div className="arena-consensus">
          <div className="section-card__header">
            <span className="section-card__title">{t.consensus}</span>
          </div>
          {displayResult ? (
              <div className="arena-consensus__result">
              <div className={`arena-consensus__verdict arena-consensus__verdict--${displayResult.consensus}`}>
                <span style={{letterSpacing: '0.1em'}}>[{displayResult.consensus.toUpperCase()}]</span>
              </div>
              <div className="arena-consensus__confidence">
                {displayResult.consensusConfidence}% {t.confidence}
              </div>
              <div className="arena-consensus__token-info">
                <span className="arena-consensus__token-symbol">${displayResult.token.symbol}</span>
                <span className="arena-consensus__token-name">{displayResult.token.name}</span>
              </div>
              <div className="arena-consensus__votes">
                <div className="arena-vote-bar">
                  <div className="arena-vote-bar__fill arena-vote-bar__fill--bull"
                    style={{ width: `${displayResult.totalAgents > 0 ? (displayResult.bullCount / displayResult.totalAgents) * 100 : 0}%` }} />
                  <div className="arena-vote-bar__fill arena-vote-bar__fill--bear"
                    style={{ width: `${displayResult.totalAgents > 0 ? (displayResult.bearCount / displayResult.totalAgents) * 100 : 0}%` }} />
                  <div className="arena-vote-bar__fill arena-vote-bar__fill--hold"
                    style={{ width: `${displayResult.totalAgents > 0 ? (displayResult.holdCount / displayResult.totalAgents) * 100 : 0}%` }} />
                </div>
                <div className="arena-vote-legend">
                  <span>BULL: {displayResult.bullCount}</span>
                  <span>BEAR: {displayResult.bearCount}</span>
                  <span>HOLD: {displayResult.holdCount}</span>
                </div>
              </div>
              {displayResult.topArguments.length > 0 && (
                <div className="arena-consensus__top">
                  <div className="section-card__title" style={{ marginBottom: '8px' }}>{t.topArgs}</div>
                  {displayResult.topArguments.map((arg, i) => (
                    <div key={i} className="arena-top-arg">
                      <span className={`arena-stance arena-stance--${arg.stance}`}>
                        {arg.stance === 'bull' ? 'BULL' : arg.stance === 'bear' ? 'BEAR' : 'HOLD'}
                      </span>
                      <span className="arena-top-arg__persona">{arg.persona}</span>
                      <span className="arena-top-arg__confidence">{arg.confidence}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="arena-consensus__empty">
              <div className="loader-pulse" style={{fontFamily: 'var(--font-mono)', letterSpacing: '0.1em'}}>{t.awaitingData}</div>
              <p style={{fontFamily: 'var(--font-mono)', fontSize: '14px', color: 'var(--text-muted)'}}>{t.systemIdle}</p>
            </div>
          )}

          {/* Bitget data summary */}
          {displayToken?.bitget && (
            <div className="arena-data-summary">
              <div className="section-card__header">
                <span className="section-card__title">{t.onchainData}</span>
                <a
                  href="https://web3.bitget.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                    fontFamily: 'var(--font-mono)', fontSize: '10px',
                    color: 'var(--text-muted)', textDecoration: 'none',
                    letterSpacing: '0.06em', transition: 'color 0.15s',
                    padding: '2px 8px', borderRadius: '3px',
                    border: '1px solid rgba(255,255,255,0.1)',
                    background: 'rgba(0,255,200,0.03)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = '#00FFC8'; e.currentTarget.style.borderColor = 'rgba(0,255,200,0.3)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                  </svg>
                  Powered by Bitget Wallet
                </a>
              </div>
              <div className="arena-data-grid">
                {displayToken.bitget.holders && (
                  <div className="arena-data-item">
                    <span className="arena-data-item__label">{t.holders}</span>
                    <span className="arena-data-item__value">{displayToken.bitget.holders}</span>
                  </div>
                )}
                {displayToken.bitget.liquidity && (
                  <div className="arena-data-item">
                    <span className="arena-data-item__label">{t.liquidity}</span>
                    <span className="arena-data-item__value">${parseFloat(displayToken.bitget.liquidity).toFixed(3)}</span>
                  </div>
                )}
                {displayToken.bitget.top10HolderPercent && (
                  <div className="arena-data-item">
                    <span className="arena-data-item__label">{t.top10Hold}</span>
                    <span className="arena-data-item__value">{parseFloat(displayToken.bitget.top10HolderPercent).toFixed(3)}%</span>
                  </div>
                )}
                {displayToken.bitget.devRugPercent != null && (
                  <div className="arena-data-item">
                    <span className="arena-data-item__label">{t.devRug}</span>
                    <span className={`arena-data-item__value ${parseFloat(displayToken.bitget.devRugPercent) > 50 ? 'arena-data-item__value--danger' : 'arena-data-item__value--safe'}`}>
                      {parseFloat(displayToken.bitget.devRugPercent).toFixed(1)}%
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Debate History */}
          {debateHistory.length > 0 && (
            <div className="arena-data-summary">
              <div className="section-card__header">
                <span className="section-card__title">{t.debateHistory} ({debateHistory.length})</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '300px', overflowY: 'auto' }}>
                {debateHistory.map((h, i) => {
                  const time = new Date(h.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
                  const consensusColor = h.consensus === 'bull' ? 'var(--accent-neon)'
                    : h.consensus === 'bear' ? 'var(--danger)' : 'var(--text-muted)';
                  const isExpanded = selectedHistoryIdx === i;
                  return (
                    <div key={i}>
                      <div
                        onClick={() => setSelectedHistoryIdx(isExpanded ? null : i)}
                        style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '6px 8px', background: isExpanded ? 'rgba(0,255,200,0.15)' : 'rgba(0,0,0,0.3)', borderRadius: '4px',
                          fontFamily: 'var(--font-mono)', fontSize: '13px', cursor: 'pointer',
                          borderLeft: isExpanded ? '3px solid var(--accent-cyan)' : '2px solid transparent',
                          transition: 'all 0.2s',
                        }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                          <span style={{ fontSize: '11px' }}>{h.wasEscalated ? '\uD83D\uDD25' : '\u26A1'}</span>
                          <span style={{ color: 'var(--text-primary)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            ${h.token.symbol}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                          <span style={{ color: consensusColor, fontWeight: 700, fontSize: '12px' }}>
                            {h.consensus.toUpperCase()}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                            {h.confidence}%
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                            {time}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Decorative Bottom Ticker */}
      <div className="arena-ticker">
        <div className="arena-ticker__scroll">
          <span>// GLOBAL_CONSENSUS_PROTOCOL_V2.1</span>
          <span>// TOTAL_NODES_ONLINE: {agents.length}</span>
          <span>// LATEST_BLOCK_HEARTBEAT: {Date.now().toString(16).toUpperCase()}</span>
          <span>// SYSTEM_INTEGRITY: OPTIMAL</span>
          <span>// DATA_SOURCE: BITGET_WALLET_API</span>
          <span>// TOKEN_DISCOVERY: BITGET_LAUNCHPAD</span>
          <span>// SECURE_CHANNEL_ENCRYPTION_ENABLED</span>
          <span>// GLOBAL_CONSENSUS_PROTOCOL_V2.1</span>
          <span>// TOTAL_NODES_ONLINE: {agents.length}</span>
          <span>// LATEST_BLOCK_HEARTBEAT: {Date.now().toString(16).toUpperCase()}</span>
          <span>// SYSTEM_INTEGRITY: OPTIMAL</span>
          <span>// DATA_SOURCE: BITGET_WALLET_API</span>
          <span>// TOKEN_DISCOVERY: BITGET_LAUNCHPAD</span>
          <span>// SECURE_CHANNEL_ENCRYPTION_ENABLED</span>
        </div>
      </div>
      </div>
    </div>
  );
}
