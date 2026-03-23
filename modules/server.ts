//NOTE(jimmylee): WebSocket Server Module
//NOTE(jimmylee): Manages agent connections, broadcasts, heartbeat, and lifecycle.

import { WebSocketServer, WebSocket } from 'ws';
import { JOIN_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, RATE_LIMIT_INTERVAL_MS, CLAIM_TTL_MS, CLAIM_CLEANUP_INTERVAL_MS, MAX_PAYLOAD_BYTES, WORKSPACE_STATE_TTL_MS, dynamicHistoryLimit } from '@common/config.js';
import type { SpaceMessage, JoinMessage, ChatMessage, TypingMessage, LeaveMessage, PresenceMessage, HistoryResponseMessage, ErrorMessage, ShutdownMessage, IdentityMessage, ClaimMessage, StateMessage, ActionResultMessage, ReflectionMessage, WorkspaceStateMessage, AgentPresence, IdentitySummary, ChatLogEntry } from '@common/types.js';
import type { ChatPersistence } from '@modules/persistence.js';

interface ConnectedAgent {
  ws: WebSocket;
  name: string;
  id: string;
  version: string;
  joinedAt: string;
  lastSeen: string;
  alive: boolean;
  identity?: IdentitySummary;
  capabilities?: string[]; // From JoinMessage — absent means all capabilities
  lastMessageAt: number; // Rate limiting — epoch ms of last chat message
}

export interface SpaceServerCallbacks {
  onJoin?: (agent: AgentPresence) => void;
  onLeave?: (agent: AgentPresence) => void;
  onChat?: (agentName: string, content: string) => void;
  onTyping?: (agentName: string) => void;
}

export class SpaceServer {
  private wss: WebSocketServer | null = null;
  private agents: Map<WebSocket, ConnectedAgent> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private claimCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private persistence: ChatPersistence;
  private callbacks: SpaceServerCallbacks;
  private hostName: string;
  private hostId: string;
  //NOTE(jimmylee): Track active claims for conflict detection — "action:target" → { name, timestamp }
  private activeClaims: Map<string, { name: string; timestamp: number }> = new Map();
  //NOTE(jimmylee): Track latest agent state for presence enrichment
  private agentStates: Map<string, { state: string; detail?: string }> = new Map();
  //NOTE(jimmylee): Track latest workspace state per workspace key — broadcast to new joiners
  private workspaceStates: Map<string, WorkspaceStateMessage> = new Map();

  constructor(persistence: ChatPersistence, callbacks: SpaceServerCallbacks = {}, hostName: string = 'host') {
    this.persistence = persistence;
    this.callbacks = callbacks;
    this.hostName = hostName;
    this.hostId = 'host-' + Date.now().toString(36);
  }

  //NOTE(jimmylee): Get the actual port the server is listening on (useful when started with port 0)
  get port(): number | null {
    if (!this.wss) return null;
    const addr = this.wss.address();
    if (typeof addr === 'object' && addr) return addr.port;
    return null;
  }

  //NOTE(jimmylee): Start the WebSocket server on the given port
  async start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      //NOTE(jimmylee): Set maxPayload to prevent OOM from oversized messages
      this.wss = new WebSocketServer({ port, maxPayload: MAX_PAYLOAD_BYTES });

      this.wss.on('listening', () => {
        this.startHeartbeat();
        this.startClaimCleanup();
        resolve();
      });

      this.wss.on('error', (err) => {
        reject(err);
      });

      this.wss.on('connection', (ws) => {
        this.handleConnection(ws);
      });
    });
  }

  //NOTE(jimmylee): Broadcast shutdown message WITHOUT closing connections
  //NOTE(jimmylee): Allows agents to finish in-flight work during the drain period
  broadcastShutdown(): void {
    const shutdownMsg: ShutdownMessage = {
      type: 'shutdown',
      reason: 'Server shutting down',
      timestamp: new Date().toISOString(),
    };
    this.broadcast(shutdownMsg);
  }

  //NOTE(jimmylee): Stop the server and clean up
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.claimCleanupTimer) {
      clearInterval(this.claimCleanupTimer);
      this.claimCleanupTimer = null;
    }

    //NOTE(jimmylee): Close all agent connections (shutdown already broadcast via broadcastShutdown)
    for (const [ws, agent] of this.agents) {
      try {
        ws.close(1001, 'Server shutting down');
      } catch {
        // Ignore close errors
      }
    }
    this.agents.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  //NOTE(jimmylee): Get list of currently connected agents
  getConnectedAgents(): AgentPresence[] {
    const agents: AgentPresence[] = [];
    for (const agent of this.agents.values()) {
      agents.push({
        name: agent.name,
        id: agent.id,
        version: agent.version,
        joinedAt: agent.joinedAt,
        lastSeen: agent.lastSeen,
        identity: agent.identity,
        capabilities: agent.capabilities,
      });
    }
    return agents;
  }

  //NOTE(jimmylee): Parse @mentions from host message content
  //NOTE(jimmylee): Matches @AgentName against connected agent names (case-insensitive)
  private parseAddressed(content: string): string[] {
    const addressed: string[] = [];
    const agentNames = new Set<string>();
    for (const agent of this.agents.values()) {
      agentNames.add(agent.name.toLowerCase());
    }
    //NOTE(jimmylee): Match @Name patterns and bare agent names in the message
    const mentionPattern = /@(\w+)/g;
    let match;
    while ((match = mentionPattern.exec(content)) !== null) {
      const mentioned = match[1].toLowerCase();
      if (agentNames.has(mentioned)) {
        //NOTE(jimmylee): Find the canonical-cased name
        for (const agent of this.agents.values()) {
          if (agent.name.toLowerCase() === mentioned) {
            addressed.push(agent.name);
            break;
          }
        }
      }
    }
    //NOTE(jimmylee): Also match bare agent names (no @ prefix) for natural addressing
    //NOTE(jimmylee): Uses word boundary regex to prevent substring false positives (e.g. "Bob" matching "bobsled")
    for (const agent of this.agents.values()) {
      if (!addressed.includes(agent.name)) {
        const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const bareNamePattern = new RegExp('\\b' + escaped + '\\b', 'i');
        if (bareNamePattern.test(content)) {
          addressed.push(agent.name);
        }
      }
    }
    return addressed;
  }

  //NOTE(jimmylee): Broadcast a chat message from the host (owner input)
  broadcastFromHost(content: string): void {
    if (content.length > 100_000) {
      console.error(`[host] Message truncated from ${content.length} to 100000 chars`);
      content = content.slice(0, 100_000);
    }
    const now = new Date().toISOString();
    const addressed = this.parseAddressed(content);
    const chatMsg: ChatMessage = {
      type: 'chat',
      name: this.hostName,
      id: this.hostId,
      content,
      timestamp: now,
      ...(addressed.length > 0 ? { addressed } : {}),
    };

    //NOTE(jimmylee): Persist the host message
    this.persistence.append({
      timestamp: now,
      agentName: this.hostName,
      agentId: this.hostId,
      type: 'chat',
      content,
    });

    //NOTE(jimmylee): Broadcast to all connected agents
    this.broadcast(chatMsg);
  }

  //NOTE(jimmylee): Handle a new WebSocket connection
  private handleConnection(ws: WebSocket): void {
    //NOTE(jimmylee): Must send join within JOIN_TIMEOUT_MS or get disconnected
    const joinTimeout = setTimeout(() => {
      if (!this.agents.has(ws)) {
        const errorMsg: ErrorMessage = { type: 'error', message: 'Join timeout: must send join message within 5 seconds' };
        ws.send(JSON.stringify(errorMsg));
        ws.close(4001, 'Join timeout');
      }
    }, JOIN_TIMEOUT_MS);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as SpaceMessage;
        this.handleMessage(ws, msg, joinTimeout);
      } catch {
        const errorMsg: ErrorMessage = { type: 'error', message: 'Invalid JSON' };
        ws.send(JSON.stringify(errorMsg));
      }
    });

    ws.on('close', () => {
      clearTimeout(joinTimeout);
      this.handleDisconnect(ws);
    });

    ws.on('error', (err) => {
      //NOTE(jimmylee): Log the error for production debugging — connection failures, protocol violations, etc.
      //NOTE(jimmylee): Don't call handleDisconnect here — the 'close' event always fires after 'error'
      //NOTE(jimmylee): and will handle cleanup. Calling it twice would be a no-op but is wasteful.
      const agent = this.agents.get(ws);
      const agentLabel = agent ? agent.name : 'unknown';
      try {
        console.error(`[ws error] agent=${agentLabel} error=${String(err)}`);
      } catch {}
      clearTimeout(joinTimeout);
    });

    ws.on('pong', () => {
      const agent = this.agents.get(ws);
      if (agent) {
        agent.alive = true;
        agent.lastSeen = new Date().toISOString();
      }
    });
  }

  //NOTE(jimmylee): Handle incoming messages
  private handleMessage(ws: WebSocket, msg: SpaceMessage, joinTimeout: ReturnType<typeof setTimeout>): void {
    switch (msg.type) {
      case 'join':
        clearTimeout(joinTimeout);
        this.handleJoin(ws, msg);
        break;

      case 'chat':
        this.handleChat(ws, msg);
        break;

      case 'typing':
        this.handleTyping(ws, msg);
        break;

      case 'identity':
        this.handleIdentity(ws, msg);
        break;

      case 'claim':
        this.handleClaim(ws, msg);
        break;

      case 'state':
        this.handleState(ws, msg);
        break;

      case 'action_result':
        this.handleActionResult(ws, msg);
        break;

      case 'reflection':
        this.handleReflection(ws, msg);
        break;

      case 'workspace_state':
        this.handleWorkspaceState(ws, msg);
        break;

      default:
        // Ignore unknown message types from client
        break;
    }
  }

  //NOTE(jimmylee): Handle agent join
  private handleJoin(ws: WebSocket, msg: JoinMessage): void {
    const now = new Date().toISOString();

    //NOTE(jimmylee): Validate required join fields — reject malformed joins before registering
    //NOTE(jimmylee): Length bounds prevent memory exhaustion from oversized fields stored in presence
    if (!msg.name || typeof msg.name !== 'string' || msg.name.trim().length === 0 || msg.name.length > 100 ||
        !msg.id || typeof msg.id !== 'string' || msg.id.trim().length === 0 || msg.id.length > 100 ||
        !msg.version || typeof msg.version !== 'string' || msg.version.length > 50) {
      const errorMsg: ErrorMessage = {
        type: 'error',
        message: 'Invalid join: name (1-100 chars), id (1-100 chars), and version (1-50 chars) are required',
      };
      ws.send(JSON.stringify(errorMsg));
      ws.close(4003, 'Invalid join message');
      return;
    }

    //NOTE(jimmylee): Check if already registered (reconnect case)
    if (this.agents.has(ws)) return;

    //NOTE(jimmylee): Dedup by agent name — if an agent with the same name already exists,
    //NOTE(jimmylee): run full disconnect cleanup before registering the new one
    for (const [existingWs, existingAgent] of this.agents) {
      if (existingAgent.name === msg.name) {
        //NOTE(jimmylee): Full cleanup: broadcast leave, clean up claims/states, persist event
        this.handleDisconnect(existingWs);
        try {
          existingWs.close(4002, 'Replaced by new connection');
        } catch {
          // Ignore close errors on stale socket
        }
        break;
      }
    }

    const agent: ConnectedAgent = {
      ws,
      name: msg.name,
      id: msg.id,
      version: msg.version,
      joinedAt: now,
      lastSeen: now,
      alive: true,
      capabilities: Array.isArray(msg.capabilities) ? msg.capabilities.filter((c: unknown) => typeof c === 'string') : undefined,
      lastMessageAt: 0,
    };

    this.agents.set(ws, agent);

    //NOTE(jimmylee): Persist join event
    this.persistence.append({
      timestamp: now,
      agentName: msg.name,
      agentId: msg.id,
      type: 'join',
      content: '',
    });

    //NOTE(jimmylee): Broadcast normalized join to all (including the new agent)
    //NOTE(jimmylee): Construct a clean message from validated fields — prevents extra client fields from leaking
    const joinBroadcast: JoinMessage = {
      type: 'join',
      name: msg.name,
      id: msg.id,
      version: msg.version,
      ...(agent.capabilities ? { capabilities: agent.capabilities } : {}),
    };
    this.broadcast(joinBroadcast);

    //NOTE(jimmylee): Send presence list to the new agent
    //NOTE(jimmylee): Wrapped in try/catch — agent may disconnect between join and these sends
    const presenceMsg: PresenceMessage = {
      type: 'presence',
      agents: this.getConnectedAgents(),
    };
    try {
      ws.send(JSON.stringify(presenceMsg));
    } catch {
      //NOTE(jimmylee): Agent disconnected between join and presence send — close event will clean up
      return;
    }

    //NOTE(jimmylee): Send history to the new agent — limit scales with connected agent count
    //NOTE(jimmylee): More agents = more context needed to understand the conversation
    const historyLimit = dynamicHistoryLimit(this.agents.size);
    const history = this.persistence.getRecentHistory(historyLimit);
    const historyMsg: HistoryResponseMessage = {
      type: 'history_response',
      entries: history,
    };
    try {
      ws.send(JSON.stringify(historyMsg));
    } catch {
      //NOTE(jimmylee): Agent disconnected between join and history send — close event will clean up
    }

    //NOTE(jimmylee): Send cached workspace states to the new agent so it has full context
    for (const [, wsState] of this.workspaceStates) {
      try {
        ws.send(JSON.stringify(wsState));
      } catch {
        //NOTE(jimmylee): Agent disconnected — close event will clean up
        break;
      }
    }

    //NOTE(jimmylee): Notify callbacks
    this.callbacks.onJoin?.({
      name: agent.name,
      id: agent.id,
      version: agent.version,
      joinedAt: agent.joinedAt,
      lastSeen: agent.lastSeen,
    });

    //NOTE(jimmylee): Broadcast updated presence to all
    this.broadcastPresence();
  }

  //NOTE(jimmylee): Handle chat message
  private handleChat(ws: WebSocket, msg: ChatMessage): void {
    const agent = this.agents.get(ws);
    if (!agent) {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Must join before sending chat' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    //NOTE(jimmylee): Server-side message validation — reject malformed chat before broadcasting
    //NOTE(jimmylee): Prevents any single agent's bugs from broadcasting undefined/empty to all peers
    if (!msg.content || typeof msg.content !== 'string' || msg.content.trim().length === 0) {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Invalid chat: content must be a non-empty string' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    //NOTE(jimmylee): Reject oversized messages to prevent memory exhaustion during broadcast/persist
    if (msg.content.length > 100_000) {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Invalid chat: content exceeds 100KB limit' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    //NOTE(jimmylee): Rate limiting — max 1 message per RATE_LIMIT_INTERVAL_MS per agent
    const nowMs = Date.now();
    if (nowMs - agent.lastMessageAt < RATE_LIMIT_INTERVAL_MS) {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Rate limited — wait before sending another message' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }
    agent.lastMessageAt = nowMs;

    const now = new Date(nowMs).toISOString();
    agent.lastSeen = now;
    agent.alive = true;

    //NOTE(jimmylee): Normalize the message with server timestamp
    //NOTE(jimmylee): Relay threadId transparently — server doesn't interpret it, agents partition context
    const chatMsg: ChatMessage = {
      type: 'chat',
      name: agent.name,
      id: agent.id,
      content: msg.content,
      timestamp: now,
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
    };

    //NOTE(jimmylee): Persist
    this.persistence.append({
      timestamp: now,
      agentName: agent.name,
      agentId: agent.id,
      type: 'chat',
      content: msg.content,
    });

    //NOTE(jimmylee): Broadcast to all agents
    this.broadcast(chatMsg);

    //NOTE(jimmylee): Notify callbacks
    this.callbacks.onChat?.(agent.name, msg.content);
  }

  //NOTE(jimmylee): Handle typing indicator — broadcast to all, no persistence
  private handleTyping(ws: WebSocket, msg: TypingMessage): void {
    const agent = this.agents.get(ws);
    if (!agent) return;

    const typingMsg: TypingMessage = {
      type: 'typing',
      name: agent.name,
      id: agent.id,
      timestamp: new Date().toISOString(),
    };

    this.broadcast(typingMsg);
    this.callbacks.onTyping?.(agent.name);
  }

  //NOTE(jimmylee): Handle identity broadcast — store and rebroadcast to all agents
  private handleIdentity(ws: WebSocket, msg: IdentityMessage): void {
    const agent = this.agents.get(ws);
    if (!agent) return;

    //NOTE(jimmylee): Validate identity summary — reject malformed data before storing and broadcasting
    if (!msg.summary || typeof msg.summary !== 'object') {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Invalid identity: summary must be an object' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    //NOTE(jimmylee): Store the identity summary on the connected agent
    agent.identity = msg.summary;
    agent.lastSeen = new Date().toISOString();
    agent.alive = true;

    //NOTE(jimmylee): Normalize with server-side agent info
    const identityMsg: IdentityMessage = {
      type: 'identity',
      name: agent.name,
      id: agent.id,
      summary: msg.summary,
      timestamp: new Date().toISOString(),
    };

    //NOTE(jimmylee): Persist identity events alongside chat
    this.persistence.append({
      timestamp: identityMsg.timestamp,
      agentName: agent.name,
      agentId: agent.id,
      type: 'identity',
      content: JSON.stringify(msg.summary),
    });

    //NOTE(jimmylee): Broadcast to all agents so they learn about each other
    this.broadcast(identityMsg);

    //NOTE(jimmylee): Broadcast updated presence (now includes identity)
    this.broadcastPresence();
  }

  //NOTE(jimmylee): Handle action claim — broadcast to all so other agents stand down
  //NOTE(jimmylee): Includes conflict detection, field validation, and persistence
  private handleClaim(ws: WebSocket, msg: ClaimMessage): void {
    const agent = this.agents.get(ws);
    if (!agent) return;

    //NOTE(jimmylee): Server-side claim validation — reject malformed claims before tracking
    //NOTE(jimmylee): Prevents corrupted claim state from bad agent-side code (defense-in-depth)
    if (!msg.action || typeof msg.action !== 'string' || msg.action.trim().length === 0 ||
        !msg.target || typeof msg.target !== 'string' || msg.target.trim().length === 0) {
      const errorMsg: ErrorMessage = {
        type: 'error',
        message: `Invalid claim: action and target must be non-empty strings (got action=${JSON.stringify(msg.action)}, target=${JSON.stringify(msg.target)})`,
      };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    agent.lastSeen = new Date().toISOString();
    agent.alive = true;
    const now = Date.now();
    const claimKey = `${msg.action}:${msg.target}`;

    //NOTE(jimmylee): Claim renewal — if the same agent re-sends a claim, refresh TTL silently
    //NOTE(jimmylee): This allows long-running fulfillments to keep their claim alive beyond the 60s window
    const existing = this.activeClaims.get(claimKey);
    if (existing && existing.name === agent.name) {
      //NOTE(jimmylee): Same agent re-claiming — refresh TTL, no broadcast needed
      existing.timestamp = now;
      return;
    }

    //NOTE(jimmylee): Lazy eviction — if existing claim has expired, delete it before conflict check
    //NOTE(jimmylee): Prevents expired entries from accumulating between 5-minute cleanup sweeps
    if (existing && now - existing.timestamp >= CLAIM_TTL_MS) {
      this.activeClaims.delete(claimKey);
    } else if (existing && existing.name !== agent.name) {
      //NOTE(jimmylee): Conflict detection — another agent already claimed this action:target within TTL
      //NOTE(jimmylee): Return immediately so the conflicting claim is NOT tracked or broadcast
      const errorMsg: ErrorMessage = {
        type: 'error',
        message: `Claim conflict — ${existing.name} and ${agent.name} both claimed ${msg.target}. ${existing.name} claimed first.`,
      };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    //NOTE(jimmylee): Track the new claim
    this.activeClaims.set(claimKey, { name: agent.name, timestamp: now });

    //NOTE(jimmylee): Normalize with server-side agent info
    const claimMsg: ClaimMessage = {
      type: 'claim',
      name: agent.name,
      id: agent.id,
      action: msg.action,
      target: msg.target,
      timestamp: new Date(now).toISOString(),
    };

    //NOTE(jimmylee): Persist claim events alongside chat
    this.persistence.append({
      timestamp: claimMsg.timestamp,
      agentName: agent.name,
      agentId: agent.id,
      type: 'claim',
      content: `${msg.action}:${msg.target}`,
    });

    //NOTE(jimmylee): Broadcast claim to all agents
    this.broadcast(claimMsg);
  }

  //NOTE(jimmylee): Handle state broadcast — store latest state and broadcast to peers
  private handleState(ws: WebSocket, msg: StateMessage): void {
    const agent = this.agents.get(ws);
    if (!agent) return;

    //NOTE(jimmylee): Validate state field — must be one of the allowed operational states
    const validStates = new Set(['idle', 'thinking', 'acting', 'blocked']);
    if (!msg.state || typeof msg.state !== 'string' || !validStates.has(msg.state)) {
      const errorMsg: ErrorMessage = { type: 'error', message: `Invalid state: must be one of idle, thinking, acting, blocked (got ${JSON.stringify(msg.state)})` };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    agent.lastSeen = new Date().toISOString();
    agent.alive = true;

    //NOTE(jimmylee): Store latest state for this agent
    //NOTE(jimmylee): Truncate detail to prevent oversized state messages from accumulating in memory
    const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, 1000) : msg.detail;
    this.agentStates.set(agent.name, { state: msg.state, detail });

    //NOTE(jimmylee): Normalize with server-side agent info
    const stateMsg: StateMessage = {
      type: 'state',
      name: agent.name,
      id: agent.id,
      state: msg.state,
      detail,
      timestamp: new Date().toISOString(),
    };

    //NOTE(jimmylee): Persist state changes
    this.persistence.append({
      timestamp: stateMsg.timestamp,
      agentName: agent.name,
      agentId: agent.id,
      type: 'state',
      content: msg.detail ? `${msg.state}: ${msg.detail}` : msg.state,
    });

    //NOTE(jimmylee): Broadcast to all agents
    this.broadcast(stateMsg);
  }

  //NOTE(jimmylee): Handle action result — broadcast structured outcome and clean up claim
  private handleActionResult(ws: WebSocket, msg: ActionResultMessage): void {
    const agent = this.agents.get(ws);
    if (!agent) return;

    //NOTE(jimmylee): Validate action result fields — reject malformed results before broadcasting
    if (!msg.action || typeof msg.action !== 'string' || msg.action.trim().length === 0 ||
        !msg.target || typeof msg.target !== 'string' || msg.target.trim().length === 0 ||
        typeof msg.success !== 'boolean') {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Invalid action_result: action, target (non-empty strings) and success (boolean) are required' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    agent.lastSeen = new Date().toISOString();
    agent.alive = true;

    //NOTE(jimmylee): Clean up the corresponding active claim
    const claimKey = `${msg.action}:${msg.target}`;
    this.activeClaims.delete(claimKey);

    //NOTE(jimmylee): Normalize with server-side agent info
    const resultMsg: ActionResultMessage = {
      type: 'action_result',
      name: agent.name,
      id: agent.id,
      action: msg.action,
      target: msg.target,
      success: msg.success,
      link: typeof msg.link === 'string' ? msg.link : undefined,
      error: typeof msg.error === 'string' ? msg.error : undefined,
      timestamp: new Date().toISOString(),
    };

    //NOTE(jimmylee): Persist action results
    this.persistence.append({
      timestamp: resultMsg.timestamp,
      agentName: agent.name,
      agentId: agent.id,
      type: 'action_result',
      content: JSON.stringify({ action: msg.action, target: msg.target, success: msg.success, link: msg.link, error: msg.error }),
    });

    //NOTE(jimmylee): Broadcast to all agents
    this.broadcast(resultMsg);
  }

  //NOTE(jimmylee): Handle reflection broadcast — agents share what they learned after SELF.md evolution
  private handleReflection(ws: WebSocket, msg: ReflectionMessage): void {
    const agent = this.agents.get(ws);
    if (!agent) return;

    //NOTE(jimmylee): Validate reflection summary — must be a non-empty string, capped at 5000 chars
    if (!msg.summary || typeof msg.summary !== 'string' || msg.summary.trim().length === 0) {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Invalid reflection: summary must be a non-empty string' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    agent.lastSeen = new Date().toISOString();
    agent.alive = true;

    //NOTE(jimmylee): Truncate reflection summary to prevent oversized broadcasts
    const summary = msg.summary.slice(0, 5000);

    //NOTE(jimmylee): Normalize with server-side agent info
    const reflectionMsg: ReflectionMessage = {
      type: 'reflection',
      name: agent.name,
      id: agent.id,
      summary,
      timestamp: new Date().toISOString(),
    };

    //NOTE(jimmylee): Persist reflection events
    this.persistence.append({
      timestamp: reflectionMsg.timestamp,
      agentName: agent.name,
      agentId: agent.id,
      type: 'reflection',
      content: msg.summary,
    });

    //NOTE(jimmylee): Broadcast to all agents — peers see growth happening
    this.broadcast(reflectionMsg);
  }

  //NOTE(jimmylee): Handle workspace state broadcast — agents share collaborative progress
  private handleWorkspaceState(ws: WebSocket, msg: WorkspaceStateMessage): void {
    const agent = this.agents.get(ws);
    if (!agent) return;

    //NOTE(jimmylee): Validate workspace state fields — reject malformed data before storing and broadcasting
    if (!msg.workspace || typeof msg.workspace !== 'string' || msg.workspace.trim().length === 0 ||
        typeof msg.totalTasks !== 'number' || typeof msg.completedTasks !== 'number') {
      const errorMsg: ErrorMessage = { type: 'error', message: 'Invalid workspace_state: workspace (non-empty string), totalTasks and completedTasks (numbers) are required' };
      ws.send(JSON.stringify(errorMsg));
      return;
    }

    agent.lastSeen = new Date().toISOString();
    agent.alive = true;

    //NOTE(jimmylee): Normalize with server-side agent info — coerce optional numeric fields
    const stateMsg: WorkspaceStateMessage = {
      type: 'workspace_state',
      name: agent.name,
      id: agent.id,
      workspace: msg.workspace,
      planNumber: typeof msg.planNumber === 'number' ? msg.planNumber : 0,
      totalTasks: msg.totalTasks,
      completedTasks: msg.completedTasks,
      blockedTasks: typeof msg.blockedTasks === 'number' ? msg.blockedTasks : 0,
      inProgressTasks: typeof msg.inProgressTasks === 'number' ? msg.inProgressTasks : 0,
      timestamp: new Date().toISOString(),
    };

    //NOTE(jimmylee): Store latest state per workspace — new joiners can request it
    this.workspaceStates.set(msg.workspace, stateMsg);

    //NOTE(jimmylee): Persist workspace state changes
    this.persistence.append({
      timestamp: stateMsg.timestamp,
      agentName: agent.name,
      agentId: agent.id,
      type: 'workspace_state',
      content: JSON.stringify({ workspace: msg.workspace, plan: msg.planNumber, total: msg.totalTasks, completed: msg.completedTasks, blocked: msg.blockedTasks, inProgress: msg.inProgressTasks }),
    });

    //NOTE(jimmylee): Broadcast to all agents
    this.broadcast(stateMsg);
  }

  //NOTE(jimmylee): Handle agent disconnect
  private handleDisconnect(ws: WebSocket): void {
    const agent = this.agents.get(ws);
    if (!agent) return;

    const now = new Date().toISOString();

    //NOTE(jimmylee): Persist leave event
    this.persistence.append({
      timestamp: now,
      agentName: agent.name,
      agentId: agent.id,
      type: 'leave',
      content: '',
    });

    //NOTE(jimmylee): Broadcast leave to remaining agents
    const leaveMsg: LeaveMessage = {
      type: 'leave',
      name: agent.name,
      id: agent.id,
      timestamp: now,
    };
    this.agents.delete(ws);
    this.broadcast(leaveMsg);

    //NOTE(jimmylee): Notify callbacks
    this.callbacks.onLeave?.({
      name: agent.name,
      id: agent.id,
      version: agent.version,
      joinedAt: agent.joinedAt,
      lastSeen: now,
    });

    //NOTE(jimmylee): Clean up agent state tracking to prevent memory growth
    this.agentStates.delete(agent.name);

    //NOTE(jimmylee): Clean up workspace states owned by this agent
    for (const [key, state] of this.workspaceStates) {
      if (state.name === agent.name) {
        this.workspaceStates.delete(key);
      }
    }

    //NOTE(jimmylee): Clean up active claims owned by this agent
    //NOTE(jimmylee): Prevents departed agent's claims from blocking others for up to 60s
    for (const [key, claim] of this.activeClaims) {
      if (claim.name === agent.name) {
        this.activeClaims.delete(key);
      }
    }

    //NOTE(jimmylee): Broadcast updated presence to all
    this.broadcastPresence();
  }

  //NOTE(jimmylee): Broadcast a message to all connected agents
  //NOTE(jimmylee): Wraps each send in try-catch so one bad socket doesn't kill delivery to remaining agents
  private broadcast(msg: SpaceMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of this.agents) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch (err) {
          //NOTE(jimmylee): Socket send failed — skip this agent, 'close' event will handle cleanup
          const agent = this.agents.get(ws);
          console.error(`[broadcast] Send failed for agent=${agent?.name ?? 'unknown'}: ${String(err)}`);
        }
      }
    }
  }

  //NOTE(jimmylee): Broadcast updated presence to all agents
  private broadcastPresence(): void {
    const presenceMsg: PresenceMessage = {
      type: 'presence',
      agents: this.getConnectedAgents(),
    };
    this.broadcast(presenceMsg);
  }

  //NOTE(jimmylee): Heartbeat: ping every HEARTBEAT_INTERVAL_MS, disconnect if no pong by the next tick
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      //NOTE(jimmylee): Collect dead agents first, then disconnect after iteration
      //NOTE(jimmylee): Calling handleDisconnect during iteration modifies the Map which is unsafe
      const dead: WebSocket[] = [];
      for (const [ws, agent] of this.agents) {
        if (!agent.alive) {
          dead.push(ws);
        } else {
          agent.alive = false;
          ws.ping();
        }
      }
      for (const ws of dead) {
        ws.terminate();
        this.handleDisconnect(ws);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  //NOTE(jimmylee): Periodic sweep of expired claims and stale workspace states
  private startClaimCleanup(): void {
    this.claimCleanupTimer = setInterval(() => {
      const now = Date.now();
      //NOTE(jimmylee): Clean up expired claims
      for (const [key, claim] of this.activeClaims) {
        if (now - claim.timestamp > CLAIM_TTL_MS) {
          this.activeClaims.delete(key);
        }
      }
      //NOTE(jimmylee): Clean up stale workspace states (older than WORKSPACE_STATE_TTL_MS)
      for (const [key, state] of this.workspaceStates) {
        if (now - new Date(state.timestamp).getTime() > WORKSPACE_STATE_TTL_MS) {
          this.workspaceStates.delete(key);
        }
      }
    }, CLAIM_CLEANUP_INTERVAL_MS);
  }
}
