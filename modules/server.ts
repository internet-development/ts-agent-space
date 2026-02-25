//NOTE(jimmylee): WebSocket Server Module
//NOTE(jimmylee): Manages agent connections, broadcasts, heartbeat, and lifecycle.

import { WebSocketServer, WebSocket } from 'ws';
import { JOIN_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from '@common/config.js';
import type { SpaceMessage, JoinMessage, ChatMessage, TypingMessage, LeaveMessage, PresenceMessage, HistoryResponseMessage, ErrorMessage, ShutdownMessage, AgentPresence, ChatLogEntry } from '@common/types.js';
import type { ChatPersistence } from '@modules/persistence.js';

interface ConnectedAgent {
  ws: WebSocket;
  name: string;
  id: string;
  version: string;
  joinedAt: string;
  lastSeen: string;
  alive: boolean;
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
  private persistence: ChatPersistence;
  private callbacks: SpaceServerCallbacks;
  private hostName: string;
  private hostId: string;

  constructor(persistence: ChatPersistence, callbacks: SpaceServerCallbacks = {}, hostName: string = 'host') {
    this.persistence = persistence;
    this.callbacks = callbacks;
    this.hostName = hostName;
    this.hostId = 'host-' + Date.now().toString(36);
  }

  //NOTE(jimmylee): Start the WebSocket server on the given port
  async start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port });

      this.wss.on('listening', () => {
        this.startHeartbeat();
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

  //NOTE(jimmylee): Stop the server and clean up
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    //NOTE(jimmylee): Broadcast shutdown to all agents before closing
    const shutdownMsg: ShutdownMessage = {
      type: 'shutdown',
      reason: 'Server shutting down',
      timestamp: new Date().toISOString(),
    };
    this.broadcast(shutdownMsg);

    //NOTE(jimmylee): Close all agent connections
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
      });
    }
    return agents;
  }

  //NOTE(jimmylee): Broadcast a chat message from the host (owner input)
  broadcastFromHost(content: string): void {
    const now = new Date().toISOString();
    const chatMsg: ChatMessage = {
      type: 'chat',
      name: this.hostName,
      id: this.hostId,
      content,
      timestamp: now,
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

    ws.on('error', () => {
      clearTimeout(joinTimeout);
      this.handleDisconnect(ws);
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

      default:
        // Ignore unknown message types from client
        break;
    }
  }

  //NOTE(jimmylee): Handle agent join
  private handleJoin(ws: WebSocket, msg: JoinMessage): void {
    const now = new Date().toISOString();

    //NOTE(jimmylee): Check if already registered (reconnect case)
    if (this.agents.has(ws)) return;

    //NOTE(jimmylee): Dedup by agent name — if an agent with the same name already exists,
    //NOTE(jimmylee): close the stale connection before registering the new one
    for (const [existingWs, existingAgent] of this.agents) {
      if (existingAgent.name === msg.name) {
        this.agents.delete(existingWs);
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

    //NOTE(jimmylee): Broadcast join to all (including the new agent)
    this.broadcast(msg);

    //NOTE(jimmylee): Send presence list to the new agent
    const presenceMsg: PresenceMessage = {
      type: 'presence',
      agents: this.getConnectedAgents(),
    };
    ws.send(JSON.stringify(presenceMsg));

    //NOTE(jimmylee): Send history to the new agent
    const history = this.persistence.getRecentHistory();
    const historyMsg: HistoryResponseMessage = {
      type: 'history_response',
      entries: history,
    };
    ws.send(JSON.stringify(historyMsg));

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

    const now = new Date().toISOString();
    agent.lastSeen = now;

    //NOTE(jimmylee): Normalize the message with server timestamp
    const chatMsg: ChatMessage = {
      type: 'chat',
      name: agent.name,
      id: agent.id,
      content: msg.content,
      timestamp: now,
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

    //NOTE(jimmylee): Broadcast updated presence to all
    this.broadcastPresence();
  }

  //NOTE(jimmylee): Broadcast a message to all connected agents
  private broadcast(msg: SpaceMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of this.agents) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
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

  //NOTE(jimmylee): Heartbeat: ping every HEARTBEAT_INTERVAL_MS, disconnect if no pong within HEARTBEAT_TIMEOUT_MS
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [ws, agent] of this.agents) {
        if (!agent.alive) {
          //NOTE(jimmylee): No pong received since last ping — disconnect
          ws.terminate();
          this.handleDisconnect(ws);
          continue;
        }
        agent.alive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}
