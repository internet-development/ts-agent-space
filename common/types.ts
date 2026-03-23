//NOTE(jimmylee): Wire protocol types for ts-agent-space
//NOTE(jimmylee): JSON over WebSocket, discriminated on `type`.

export interface JoinMessage {
  type: 'join';
  name: string;
  id: string; // Stable UUID for the agent
  version: string; // ts-general-agent version
  capabilities?: string[]; // e.g., ['social', 'github', 'code'] — absent means all capabilities
}

export interface ChatMessage {
  type: 'chat';
  name: string;
  id: string;
  content: string;
  timestamp: string; // ISO 8601
  addressed?: string[]; // @mentioned agent names parsed from host messages
  threadId?: string; // Optional conversation thread — server relays transparently, agents partition context
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

//NOTE(jimmylee): Identity message — agents broadcast condensed SELF.md + SOUL.md on join
export interface IdentityMessage {
  type: 'identity';
  name: string;
  id: string;
  summary: IdentitySummary;
  timestamp: string; // ISO 8601
}

export interface IdentitySummary {
  coreValues: string[];      // From SOUL.md — 3-5 words each
  currentInterests: string[]; // From SELF.md ## Current Interests
  voice: string;             // One-sentence voice description
  expertise: string[];       // From SELF.md ## What I'm Learning
  recentWork: string;        // Last completed task or expression topic
  soulEssence?: string;      // 2-3 sentence distillation of SOUL.md — what drives this agent
}

//NOTE(jimmylee): Claim message — agent declares intent to act before committing
//NOTE(jimmylee): Reduces wasted LLM calls by letting other agents stand down early
export interface ClaimMessage {
  type: 'claim';
  name: string;
  id: string;
  action: string; // e.g., "create_issue", "create_plan"
  target: string; // e.g., "owner/repo#title"
  timestamp: string; // ISO 8601
}

//NOTE(jimmylee): State message — agents broadcast their current operational state to peers
export interface StateMessage {
  type: 'state';
  name: string;
  id: string;
  state: 'idle' | 'thinking' | 'acting' | 'blocked';
  detail?: string; // e.g., "fulfilling create_issue commitment"
  timestamp: string; // ISO 8601
}

//NOTE(jimmylee): Action result message — agents announce structured outcomes of fulfilled commitments
export interface ActionResultMessage {
  type: 'action_result';
  name: string;
  id: string;
  action: string; // commitment type, e.g., "create_issue"
  target: string; // e.g., "owner/repo#title"
  success: boolean;
  link?: string; // URL to created artifact
  error?: string;
  timestamp: string; // ISO 8601
}

//NOTE(jimmylee): Reflection message — agents share what they learned after reflection updates SELF.md
export interface ReflectionMessage {
  type: 'reflection';
  name: string;
  id: string;
  summary: string; // 1-2 sentence summary of what was learned/changed
  timestamp: string; // ISO 8601
}

//NOTE(jimmylee): Workspace state message — agents broadcast collaborative progress to peers
export interface WorkspaceStateMessage {
  type: 'workspace_state';
  name: string;
  id: string;
  workspace: string; // "owner/repo"
  planNumber: number;
  totalTasks: number;
  completedTasks: number;
  blockedTasks: number;
  inProgressTasks: number;
  timestamp: string; // ISO 8601
}

export type SpaceMessage = JoinMessage | LeaveMessage | ChatMessage | TypingMessage | PresenceMessage | HistoryResponseMessage | ErrorMessage | ShutdownMessage | IdentityMessage | ClaimMessage | StateMessage | ActionResultMessage | ReflectionMessage | WorkspaceStateMessage;

export interface AgentPresence {
  name: string;
  id: string;
  version: string;
  joinedAt: string; // ISO 8601
  lastSeen: string; // ISO 8601
  identity?: IdentitySummary; // Populated after identity message received
  capabilities?: string[]; // Agent capabilities — absent means all
}

export interface ChatLogEntry {
  timestamp: string; // ISO 8601
  agentName: string;
  agentId: string;
  type: 'join' | 'leave' | 'chat' | 'identity' | 'claim' | 'state' | 'action_result' | 'reflection' | 'workspace_state';
  content: string;
}
