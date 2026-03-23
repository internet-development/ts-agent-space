//NOTE(jimmylee): Chat Persistence Module
//NOTE(jimmylee): Append-only JSONL chat log with history replay.

import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, CHAT_LOG_FILE, HISTORY_REPLAY_BASE, LOG_ROTATION_MAX_BYTES } from '@common/config.js';
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
  //NOTE(jimmylee): Checks file size and rotates if above threshold
  //NOTE(jimmylee): Non-fatal on write failure — server continues without persistence rather than crashing
  append(entry: ChatLogEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this.filePath, line, 'utf8');
      this.maybeRotate();
    } catch (err) {
      //NOTE(jimmylee): Disk full, permission error, or fd exhaustion — log but don't crash the server
      console.error(`[persistence] Append failed: ${String(err)}`);
    }
  }

  //NOTE(jimmylee): Rotate the log file when it exceeds LOG_ROTATION_MAX_BYTES
  //NOTE(jimmylee): Implements numbered rotation: chat.3.jsonl → chat.4.jsonl, ..., chat.1.jsonl → chat.2.jsonl, chat.jsonl → chat.1.jsonl
  //NOTE(jimmylee): Keeps up to MAX_ROTATIONS backups so weeks of history survive
  //NOTE(jimmylee): History replay only reads the tail of the active file, so rotation is transparent to clients
  private static readonly MAX_ROTATIONS = 5;

  private maybeRotate(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stat = fs.statSync(this.filePath);
      if (stat.size <= LOG_ROTATION_MAX_BYTES) return;

      //NOTE(jimmylee): Shift existing rotations up: chat.4 → chat.5, chat.3 → chat.4, etc.
      //NOTE(jimmylee): Oldest rotation beyond MAX_ROTATIONS is overwritten
      for (let i = ChatPersistence.MAX_ROTATIONS - 1; i >= 1; i--) {
        const from = this.filePath.replace(/\.jsonl$/, `.${i}.jsonl`);
        const to = this.filePath.replace(/\.jsonl$/, `.${i + 1}.jsonl`);
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
        }
      }

      //NOTE(jimmylee): Rotate current log to chat.1.jsonl
      const rotatedPath = this.filePath.replace(/\.jsonl$/, '.1.jsonl');
      fs.renameSync(this.filePath, rotatedPath);
    } catch (err) {
      //NOTE(jimmylee): Rotation failure is non-fatal — next append creates a fresh file
      console.error(`[persistence] Log rotation failed: ${String(err)}`);
    }
  }

  //NOTE(jimmylee): Read lines from the tail of a file using reverse chunk-reading
  //NOTE(jimmylee): Handles UTF-8 multi-byte character boundaries by detecting continuation bytes
  //NOTE(jimmylee): at the start of each chunk and carrying them to the next iteration
  private readTailLines(filePath: string, limit: number): string[] {
    if (!fs.existsSync(filePath)) return [];

    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    const fd = fs.openSync(filePath, 'r');
    try {
      const lines: string[] = [];
      const CHUNK_SIZE = 8192;
      let position = stat.size;
      let trailing = '';
      let trailingBytes = Buffer.alloc(0);

      while (position > 0 && lines.length < limit) {
        const readSize = Math.min(CHUNK_SIZE, position);
        position -= readSize;
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, position);

        //NOTE(jimmylee): Combine with any incomplete UTF-8 bytes carried from the previous (rightward) chunk
        const combined = trailingBytes.length > 0 ? Buffer.concat([buf, trailingBytes]) : buf;
        trailingBytes = Buffer.alloc(0);

        //NOTE(jimmylee): Check if the chunk starts mid-UTF-8 character
        //NOTE(jimmylee): UTF-8 continuation bytes start with 0b10xxxxxx (0x80..0xBF)
        //NOTE(jimmylee): If so, carry those bytes to the next iteration (which reads earlier in the file)
        let skipBytes = 0;
        if (position > 0) {
          while (skipBytes < combined.length && (combined[skipBytes] & 0xC0) === 0x80) {
            skipBytes++;
          }
          if (skipBytes > 0) {
            trailingBytes = combined.subarray(0, skipBytes);
          }
        }

        const chunk = combined.subarray(skipBytes).toString('utf8') + trailing;
        const parts = chunk.split('\n');
        trailing = parts[0];
        for (let i = parts.length - 1; i >= 1; i--) {
          if (parts[i]) lines.unshift(parts[i]);
          if (lines.length >= limit) break;
        }
      }

      if (trailing && lines.length < limit) {
        lines.unshift(trailing);
      }

      return lines.slice(-limit);
    } finally {
      fs.closeSync(fd);
    }
  }

  //NOTE(jimmylee): Read the last N entries for history replay
  //NOTE(jimmylee): Uses reverse chunk-reading so we only touch the tail of the file, not the whole thing
  //NOTE(jimmylee): When the active file has fewer entries than limit, reads overflow from the most recent
  //NOTE(jimmylee): rotated file (chat.1.jsonl) to preserve continuity across log rotations
  getRecentHistory(limit: number = HISTORY_REPLAY_BASE): ChatLogEntry[] {
    let lines = this.readTailLines(this.filePath, limit);

    //NOTE(jimmylee): If the active file has fewer lines than requested, fill from the most recent rotation
    //NOTE(jimmylee): This prevents history impoverishment right after a 50MB log rotation
    if (lines.length < limit) {
      const rotatedPath = this.filePath.replace(/\.jsonl$/, '.1.jsonl');
      const remaining = limit - lines.length;
      const overflowLines = this.readTailLines(rotatedPath, remaining);
      if (overflowLines.length > 0) {
        lines = [...overflowLines, ...lines];
      }
    }

    const entries: ChatLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as ChatLogEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  }

  //NOTE(jimmylee): Get entries since a given timestamp, up to limit
  getSince(timestamp: string, limit: number = HISTORY_REPLAY_BASE): ChatLogEntry[] {
    const all = this.getRecentHistory(limit * 2); // Read a wider window
    const since = new Date(timestamp).getTime();
    return all.filter((e) => new Date(e.timestamp).getTime() > since).slice(-limit);
  }
}
