//NOTE(jimmylee): Centralized configuration for ts-agent-space
//NOTE(jimmylee): All tunable constants in one place.
export const DEFAULT_PORT = 7777;
export const MDNS_SERVICE_TYPE = 'agent-space';
export const MDNS_SERVICE_PROTOCOL = 'tcp';

export const JOIN_TIMEOUT_MS = 5_000;
// Must send join within 5s or get disconnected
export const HEARTBEAT_INTERVAL_MS = 30_000;
// Ping every 30s — agents that don't respond by the next tick are terminated

export const HISTORY_REPLAY_BASE = 200;
// Base history — scales with connected agent count
export const HISTORY_REPLAY_PER_AGENT = 50;
// Additional messages per connected agent beyond 2
export const HISTORY_REPLAY_MAX = 1000;
// Hard ceiling — prevents unbounded memory on history replay

//NOTE(jimmylee): Dynamic history scaling — more agents = more context needed
//NOTE(jimmylee): Formula: base + (agentCount - 2) * perAgent, clamped to [base, max]
//NOTE(jimmylee): 2 agents = 200, 6 agents = 400, 10 agents = 600, 18 agents = 1000 (capped)
export function dynamicHistoryLimit(connectedAgentCount: number): number {
  const extra = Math.max(0, connectedAgentCount - 2) * HISTORY_REPLAY_PER_AGENT;
  return Math.min(HISTORY_REPLAY_BASE + extra, HISTORY_REPLAY_MAX);
}
export const DATA_DIR = 'data';
export const CHAT_LOG_FILE = 'chat.jsonl';

export const RATE_LIMIT_INTERVAL_MS = 3_000;
// Max 1 message per 3s per agent (prevents runaway flooding)

export const CLAIM_TTL_MS = 60_000;
// Claims expire after 60s unless renewed by the owning agent

export const CLAIM_CLEANUP_INTERVAL_MS = 300_000;
// Sweep expired claims every 5 minutes

export const LOG_ROTATION_MAX_BYTES = 50 * 1024 * 1024;
// Rotate chat log at 50MB

export const MAX_PAYLOAD_BYTES = 1_048_576;
// 1MB max WebSocket payload — prevents OOM from oversized messages

export const WORKSPACE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
// Stale workspace states cleaned up after 24 hours

export const SHUTDOWN_DRAIN_MS = 3_000;
// Wait 3 seconds for in-flight operations before closing connections

export const MAX_AGENTS_DISPLAYED = 10;
// Max agent lines in the panel — matches SCENARIOS.md requirement for 10-agent visibility
export const INPUT_BOX_LINES = 5;
// Top border + 3 input lines + bottom border
