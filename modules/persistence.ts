//NOTE(jimmylee): Chat Persistence Module
//NOTE(jimmylee): Append-only JSONL chat log with history replay.

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, CHAT_LOG_FILE, HISTORY_REPLAY_LIMIT } from '@common/config.js';
import type { ChatLogEntry } from '@common/types.js';

export class ChatPersistence {
  private filePath: string;

  constructor(baseDir: string) {
    const dataDir = path.join(baseDir, DATA_DIR);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.filePath = path.join(dataDir, CHAT_LOG_FILE);
  }

  //NOTE(jimmylee): Append a single entry to the JSONL log
  append(entry: ChatLogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.filePath, line, 'utf8');
  }

  //NOTE(jimmylee): Read the last N entries for history replay
  getRecentHistory(limit: number = HISTORY_REPLAY_LIMIT): ChatLogEntry[] {
    if (!fs.existsSync(this.filePath)) return [];

    const content = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!content) return [];

    const lines = content.split('\n');
    const recent = lines.slice(-limit);

    const entries: ChatLogEntry[] = [];
    for (const line of recent) {
      try {
        entries.push(JSON.parse(line) as ChatLogEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  }

  //NOTE(jimmylee): Get entries since a given timestamp, up to limit
  getSince(timestamp: string, limit: number = HISTORY_REPLAY_LIMIT): ChatLogEntry[] {
    const all = this.getRecentHistory(limit * 2); // Read a wider window
    const since = new Date(timestamp).getTime();
    return all.filter((e) => new Date(e.timestamp).getTime() > since).slice(-limit);
  }
}
