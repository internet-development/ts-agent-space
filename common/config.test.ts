import { describe, it, expect } from 'vitest';

import {
  DEFAULT_PORT,
  JOIN_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HISTORY_REPLAY_BASE,
  HISTORY_REPLAY_PER_AGENT,
  HISTORY_REPLAY_MAX,
  dynamicHistoryLimit,
  RATE_LIMIT_INTERVAL_MS,
  CLAIM_TTL_MS,
  LOG_ROTATION_MAX_BYTES,
} from '@common/config.js';

describe('config constants', () => {
  it('all exported constants are positive numbers', () => {
    const constants = [
      DEFAULT_PORT,
      JOIN_TIMEOUT_MS,
      HEARTBEAT_INTERVAL_MS,
      HEARTBEAT_TIMEOUT_MS,
      HISTORY_REPLAY_BASE,
      HISTORY_REPLAY_PER_AGENT,
      HISTORY_REPLAY_MAX,
      RATE_LIMIT_INTERVAL_MS,
      CLAIM_TTL_MS,
      LOG_ROTATION_MAX_BYTES,
    ];

    for (const value of constants) {
      expect(value).toBeTypeOf('number');
      expect(value).toBeGreaterThan(0);
    }
  });

  it('DEFAULT_PORT is 7777', () => {
    expect(DEFAULT_PORT).toBe(7777);
  });

  it('JOIN_TIMEOUT_MS is 5000', () => {
    expect(JOIN_TIMEOUT_MS).toBe(5000);
  });

  it('HEARTBEAT_INTERVAL_MS is 30000', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30000);
  });

  it('HEARTBEAT_TIMEOUT_MS is 10000', () => {
    expect(HEARTBEAT_TIMEOUT_MS).toBe(10000);
  });

  it('RATE_LIMIT_INTERVAL_MS is 3000', () => {
    expect(RATE_LIMIT_INTERVAL_MS).toBe(3000);
  });

  it('CLAIM_TTL_MS is 60000', () => {
    expect(CLAIM_TTL_MS).toBe(60000);
  });

  it('LOG_ROTATION_MAX_BYTES is 50MB', () => {
    expect(LOG_ROTATION_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it('HEARTBEAT_TIMEOUT_MS is less than HEARTBEAT_INTERVAL_MS', () => {
    expect(HEARTBEAT_TIMEOUT_MS).toBeLessThan(HEARTBEAT_INTERVAL_MS);
  });

  it('HISTORY_REPLAY_BASE is less than or equal to HISTORY_REPLAY_MAX', () => {
    expect(HISTORY_REPLAY_BASE).toBeLessThanOrEqual(HISTORY_REPLAY_MAX);
  });
});

describe('dynamicHistoryLimit', () => {
  it('returns base (200) for 0 agents', () => {
    expect(dynamicHistoryLimit(0)).toBe(200);
  });

  it('returns base (200) for 1 agent', () => {
    expect(dynamicHistoryLimit(1)).toBe(200);
  });

  it('returns base (200) for 2 agents', () => {
    expect(dynamicHistoryLimit(2)).toBe(200);
  });

  it('returns 250 for 3 agents', () => {
    // base + (3-2)*50 = 200 + 50 = 250
    expect(dynamicHistoryLimit(3)).toBe(250);
  });

  it('returns 400 for 6 agents', () => {
    // base + (6-2)*50 = 200 + 200 = 400
    expect(dynamicHistoryLimit(6)).toBe(400);
  });

  it('returns 600 for 10 agents', () => {
    // base + (10-2)*50 = 200 + 400 = 600
    expect(dynamicHistoryLimit(10)).toBe(600);
  });

  it('returns 1000 (max) for 18 agents', () => {
    // base + (18-2)*50 = 200 + 800 = 1000
    expect(dynamicHistoryLimit(18)).toBe(1000);
  });

  it('caps at max (1000) for 100 agents', () => {
    // base + (100-2)*50 = 200 + 4900 = 5100 -> capped at 1000
    expect(dynamicHistoryLimit(100)).toBe(1000);
  });

  it('result is always between HISTORY_REPLAY_BASE and HISTORY_REPLAY_MAX', () => {
    for (const count of [0, 1, 2, 5, 10, 20, 50, 100, 1000]) {
      const result = dynamicHistoryLimit(count);
      expect(result).toBeGreaterThanOrEqual(HISTORY_REPLAY_BASE);
      expect(result).toBeLessThanOrEqual(HISTORY_REPLAY_MAX);
    }
  });
});
