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
  //NOTE(jimmylee): Uses reverse chunk-reading so we only touch the tail of the file, not the whole thing
  getRecentHistory(limit: number = HISTORY_REPLAY_LIMIT): ChatLogEntry[] {
    if (!fs.existsSync(this.filePath)) return [];

    const stat = fs.statSync(this.filePath);
    if (stat.size === 0) return [];

    const fd = fs.openSync(this.filePath, 'r');
    try {
      const lines: string[] = [];
      const CHUNK_SIZE = 8192;
      let position = stat.size;
      let trailing = '';

      //NOTE(jimmylee): Read backwards in chunks until we have enough lines
      while (position > 0 && lines.length < limit) {
        const readSize = Math.min(CHUNK_SIZE, position);
        position -= readSize;
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, position);
        const chunk = buf.toString('utf8') + trailing;
        const parts = chunk.split('\n');
        //NOTE(jimmylee): First element is partial (or empty if chunk starts at line boundary)
        trailing = parts[0];
        //NOTE(jimmylee): Remaining parts are complete lines — prepend in reverse order
        for (let i = parts.length - 1; i >= 1; i--) {
          if (parts[i]) lines.unshift(parts[i]);
          if (lines.length >= limit) break;
        }
      }

      //NOTE(jimmylee): Include any remaining trailing content as the first line
      if (trailing && lines.length < limit) {
        lines.unshift(trailing);
      }

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
    } finally {
      fs.closeSync(fd);
    }
  }

  //NOTE(jimmylee): Get entries since a given timestamp, up to limit
  getSince(timestamp: string, limit: number = HISTORY_REPLAY_LIMIT): ChatLogEntry[] {
    const all = this.getRecentHistory(limit * 2); // Read a wider window
    const since = new Date(timestamp).getTime();
    return all.filter((e) => new Date(e.timestamp).getTime() > since).slice(-limit);
  }
}
