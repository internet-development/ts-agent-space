//NOTE(jimmylee): Wire protocol types for ts-agent-space
//NOTE(jimmylee): JSON over WebSocket, discriminated on `type`.

export interface JoinMessage {
  type: 'join';
  name: string;
  id: string; // Stable UUID for the agent
  version: string; // ts-general-agent version
}

export interface ChatMessage {
  type: 'chat';
  name: string;
  id: string;
  content: string;
  timestamp: string; // ISO 8601
}

export interface TypingMessage {
  type: 'typing';
  name: string;
  id: string;
  timestamp: string; // ISO 8601
}

export interface LeaveMessage {
  type: 'leave';
  name: string;
  id: string;
  timestamp: string;
}

export interface PresenceMessage {
  type: 'presence';
  agents: AgentPresence[];
}

export interface HistoryResponseMessage {
  type: 'history_response';
  entries: ChatLogEntry[];
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface ShutdownMessage {
  type: 'shutdown';
  reason: string;
  timestamp: string; // ISO 8601
}

export type SpaceMessage = JoinMessage | LeaveMessage | ChatMessage | TypingMessage | PresenceMessage | HistoryResponseMessage | ErrorMessage | ShutdownMessage;

export interface AgentPresence {
  name: string;
  id: string;
  version: string;
  joinedAt: string; // ISO 8601
  lastSeen: string; // ISO 8601
}

export interface ChatLogEntry {
  timestamp: string; // ISO 8601
  agentName: string;
  agentId: string;
  type: 'join' | 'leave' | 'chat';
  content: string;
}
