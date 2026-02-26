import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ChatPersistence } from '@modules/persistence.js';
import type { ChatLogEntry } from '@common/types.js';

function makeEntry(overrides: Partial<ChatLogEntry> = {}): ChatLogEntry {
  return {
    type: 'chat',
    agentName: 'test-agent',
    agentId: 'agent-001',
    content: 'hello world',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('ChatPersistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('constructor creates the data directory', () => {
    new ChatPersistence(tmpDir);
    const dataDir = path.join(tmpDir, 'data');
    expect(fs.existsSync(dataDir)).toBe(true);
    expect(fs.statSync(dataDir).isDirectory()).toBe(true);
  });

  it('append writes valid JSONL', () => {
    const persistence = new ChatPersistence(tmpDir);
    const entry = makeEntry({ content: 'first message' });
    persistence.append(entry);

    const filePath = path.join(tmpDir, 'data', 'chat.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.content).toBe('first message');
    expect(parsed.type).toBe('chat');
    expect(parsed.agentName).toBe('test-agent');
  });

  it('getRecentHistory returns empty array for non-existent file', () => {
    const persistence = new ChatPersistence(tmpDir);
    const result = persistence.getRecentHistory();
    expect(result).toEqual([]);
  });

  it('getRecentHistory returns all entries when fewer than limit', () => {
    const persistence = new ChatPersistence(tmpDir);
    const entries = [
      makeEntry({ content: 'msg-1', timestamp: '2025-01-01T00:00:01Z' }),
      makeEntry({ content: 'msg-2', timestamp: '2025-01-01T00:00:02Z' }),
      makeEntry({ content: 'msg-3', timestamp: '2025-01-01T00:00:03Z' }),
    ];

    for (const entry of entries) {
      persistence.append(entry);
    }

    const result = persistence.getRecentHistory(10);
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('msg-1');
    expect(result[1].content).toBe('msg-2');
    expect(result[2].content).toBe('msg-3');
  });

  it('getRecentHistory returns only last N entries when more than limit', () => {
    const persistence = new ChatPersistence(tmpDir);

    for (let i = 0; i < 10; i++) {
      persistence.append(makeEntry({ content: `msg-${i}`, timestamp: `2025-01-01T00:00:${String(i).padStart(2, '0')}Z` }));
    }

    const result = persistence.getRecentHistory(3);
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('msg-7');
    expect(result[1].content).toBe('msg-8');
    expect(result[2].content).toBe('msg-9');
  });

  it('getRecentHistory handles large files with 100+ entries', () => {
    const persistence = new ChatPersistence(tmpDir);

    for (let i = 0; i < 150; i++) {
      persistence.append(
        makeEntry({
          content: `message-${String(i).padStart(3, '0')}`,
          timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
        })
      );
    }

    const result = persistence.getRecentHistory(10);
    expect(result).toHaveLength(10);
    // Should be the last 10 entries (140-149)
    expect(result[0].content).toBe('message-140');
    expect(result[9].content).toBe('message-149');
  });

  it('getSince filters entries after the given timestamp', () => {
    const persistence = new ChatPersistence(tmpDir);
    const timestamps = [
      '2025-01-01T00:00:00Z',
      '2025-01-01T01:00:00Z',
      '2025-01-01T02:00:00Z',
      '2025-01-01T03:00:00Z',
      '2025-01-01T04:00:00Z',
    ];

    for (let i = 0; i < timestamps.length; i++) {
      persistence.append(makeEntry({ content: `msg-${i}`, timestamp: timestamps[i] }));
    }

    // Get entries after 02:00:00 — should return msg-3 and msg-4
    const result = persistence.getSince('2025-01-01T02:00:00Z');
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('msg-3');
    expect(result[1].content).toBe('msg-4');
  });

  it('handles empty file gracefully', () => {
    const persistence = new ChatPersistence(tmpDir);
    // Create an empty file
    const filePath = path.join(tmpDir, 'data', 'chat.jsonl');
    fs.writeFileSync(filePath, '', 'utf8');

    const result = persistence.getRecentHistory();
    expect(result).toEqual([]);
  });

  it('handles malformed JSON lines by skipping them', () => {
    const persistence = new ChatPersistence(tmpDir);
    const filePath = path.join(tmpDir, 'data', 'chat.jsonl');

    const validEntry1 = makeEntry({ content: 'valid-1', timestamp: '2025-01-01T00:00:01Z' });
    const validEntry2 = makeEntry({ content: 'valid-2', timestamp: '2025-01-01T00:00:03Z' });

    // Write a mix of valid and malformed lines
    const lines = [
      JSON.stringify(validEntry1),
      '{ this is not valid json',
      '',
      JSON.stringify(validEntry2),
      'another broken line {{{',
    ];
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    const result = persistence.getRecentHistory(100);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('valid-1');
    expect(result[1].content).toBe('valid-2');
  });
});
