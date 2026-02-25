//NOTE(jimmylee): Centralized configuration for ts-agent-space
//NOTE(jimmylee): All tunable constants in one place.
export const DEFAULT_PORT = 7777;
export const MDNS_SERVICE_TYPE = 'agent-space';
export const MDNS_SERVICE_PROTOCOL = 'tcp';

export const JOIN_TIMEOUT_MS = 5_000;
// Must send join within 5s or get disconnected
export const HEARTBEAT_INTERVAL_MS = 30_000;
// Ping every 30s
export const HEARTBEAT_TIMEOUT_MS = 10_000;
// Disconnect if no pong within 10s

export const HISTORY_REPLAY_LIMIT = 200;
// Last 200 messages on connect
export const DATA_DIR = 'data';
export const CHAT_LOG_FILE = 'chat.jsonl';

export const MAX_AGENTS_DISPLAYED = 6;
// Max agent lines in the panel
export const INPUT_BOX_LINES = 5;
// Top border + 3 input lines + bottom border
