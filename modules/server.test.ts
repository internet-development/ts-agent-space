import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket from 'ws';

import { SpaceServer } from '@modules/server.js';
import type { ChatPersistence } from '@modules/persistence.js';
import type { SpaceMessage, JoinMessage, ChatMessage, ClaimMessage, StateMessage, ActionResultMessage, IdentityMessage, ReflectionMessage, WorkspaceStateMessage, PresenceMessage, HistoryResponseMessage, ErrorMessage } from '@common/types.js';
import { RATE_LIMIT_INTERVAL_MS, CLAIM_TTL_MS } from '@common/config.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockPersistence(): ChatPersistence {
  return {
    append: vi.fn(),
    getRecentHistory: vi.fn().mockReturnValue([]),
    getSince: vi.fn().mockReturnValue([]),
  } as unknown as ChatPersistence;
}

function joinMsg(overrides: Partial<JoinMessage> = {}): JoinMessage {
  return {
    type: 'join',
    name: 'TestAgent',
    id: 'agent-001',
    version: '1.0.0',
    ...overrides,
  };
}

//NOTE(jimmylee): Wait for a specific message type from a WebSocket, with timeout
//NOTE(jimmylee): Optional predicate to distinguish between multiple messages of the same type
function waitForMessage<T extends SpaceMessage>(ws: WebSocket, type: string, timeoutMs = 2000, predicate?: (msg: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString()) as SpaceMessage;
      if (msg.type === type) {
        if (predicate && !predicate(msg as T)) return;
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg as T);
      }
    };
    ws.on('message', handler);
  });
}

//NOTE(jimmylee): Collect all messages received within a time window
function collectMessages(ws: WebSocket, durationMs = 200): Promise<SpaceMessage[]> {
  return new Promise((resolve) => {
    const messages: SpaceMessage[] = [];
    const handler = (data: WebSocket.Data) => {
      messages.push(JSON.parse(data.toString()) as SpaceMessage);
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(messages);
    }, durationMs);
  });
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function joinAndWait(ws: WebSocket, msg: JoinMessage): Promise<{ presence: PresenceMessage; history: HistoryResponseMessage }> {
  const presencePromise = waitForMessage<PresenceMessage>(ws, 'presence');
  const historyPromise = waitForMessage<HistoryResponseMessage>(ws, 'history_response');
  ws.send(JSON.stringify(msg));
  const [presence, history] = await Promise.all([presencePromise, historyPromise]);
  return { presence, history };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SpaceServer', () => {
  let server: SpaceServer;
  let persistence: ChatPersistence;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    persistence = mockPersistence();
    server = new SpaceServer(persistence);
    //NOTE(jimmylee): Use port 0 to let the OS assign a free port — prevents EADDRINUSE collisions
    await server.start(0);
    port = server.port!;
  });

  afterEach(() => {
    for (const ws of clients) {
      try { ws.close(); } catch {}
    }
    clients.length = 0;
    server.stop();
  });

  async function connect(): Promise<WebSocket> {
    const ws = await connectClient(port);
    clients.push(ws);
    return ws;
  }

  // ─── Join Lifecycle ─────────────────────────────────────────────────────

  describe('join lifecycle', () => {
    it('accepts a valid join and returns presence + history', async () => {
      const ws = await connect();
      const { presence, history } = await joinAndWait(ws, joinMsg());

      expect(presence.type).toBe('presence');
      expect(presence.agents).toHaveLength(1);
      expect(presence.agents[0].name).toBe('TestAgent');
      expect(presence.agents[0].id).toBe('agent-001');
      expect(presence.agents[0].version).toBe('1.0.0');

      expect(history.type).toBe('history_response');
      expect(history.entries).toEqual([]);
    });

    it('rejects join with empty name', async () => {
      const ws = await connect();
      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify(joinMsg({ name: '' })));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid join');
    });

    it('rejects join with empty id', async () => {
      const ws = await connect();
      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify(joinMsg({ id: '' })));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid join');
    });

    it('rejects join with empty version', async () => {
      const ws = await connect();
      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify(joinMsg({ version: '' })));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid join');
    });

    it('rejects join with name exceeding 100 chars', async () => {
      const ws = await connect();
      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify(joinMsg({ name: 'A'.repeat(101) })));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid join');
    });

    it('rejects join with id exceeding 100 chars', async () => {
      const ws = await connect();
      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify(joinMsg({ id: 'x'.repeat(101) })));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid join');
    });

    it('rejects join with version exceeding 50 chars', async () => {
      const ws = await connect();
      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify(joinMsg({ version: '9'.repeat(51) })));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid join');
    });

    it('includes capabilities in presence when provided', async () => {
      const ws = await connect();
      const { presence } = await joinAndWait(ws, joinMsg({ capabilities: ['social', 'github'] }));
      expect(presence.agents[0].capabilities).toEqual(['social', 'github']);
    });

    it('replaces stale connection when same agent name reconnects', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Agent1', id: 'id-1' }));

      const ws2 = await connect();
      const { presence } = await joinAndWait(ws2, joinMsg({ name: 'Agent1', id: 'id-2' }));

      //NOTE(jimmylee): Should only have one agent with the new id
      expect(presence.agents).toHaveLength(1);
      expect(presence.agents[0].id).toBe('id-2');
    });

    it('persists join event', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());
      expect(persistence.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'join', agentName: 'TestAgent', agentId: 'agent-001' })
      );
    });

    it('fires onJoin callback', async () => {
      const onJoin = vi.fn();
      server.stop();
      server = new SpaceServer(persistence, { onJoin });
      await server.start(0);
      port = server.port!;

      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      //NOTE(jimmylee): Allow callback to fire
      await new Promise((r) => setTimeout(r, 50));
      expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ name: 'TestAgent' }));
    });
  });

  // ─── Chat ───────────────────────────────────────────────────────────────

  describe('chat', () => {
    it('broadcasts valid chat messages', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      const chatPromise = waitForMessage<ChatMessage>(ws1, 'chat');
      ws2.send(JSON.stringify({ type: 'chat', name: 'Bob', id: 'b1', content: 'Hello everyone', timestamp: new Date().toISOString() }));
      const chat = await chatPromise;

      expect(chat.name).toBe('Bob');
      expect(chat.content).toBe('Hello everyone');
    });

    it('rejects chat before join', async () => {
      const ws = await connect();
      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify({ type: 'chat', name: 'Ghost', id: 'g1', content: 'Boo', timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Must join');
    });

    it('rejects empty chat content', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());
      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify({ type: 'chat', name: 'TestAgent', id: 'agent-001', content: '', timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid chat');
    });

    it('rate limits rapid messages', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      //NOTE(jimmylee): First message should succeed
      ws.send(JSON.stringify({ type: 'chat', name: 'TestAgent', id: 'agent-001', content: 'msg-1', timestamp: new Date().toISOString() }));
      const chat = await waitForMessage<ChatMessage>(ws, 'chat');
      expect(chat.content).toBe('msg-1');

      //NOTE(jimmylee): Immediate second message should be rate limited
      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify({ type: 'chat', name: 'TestAgent', id: 'agent-001', content: 'msg-2', timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Rate limited');
    });

    it('relays threadId transparently', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      const chatPromise = waitForMessage<ChatMessage>(ws1, 'chat');
      ws2.send(JSON.stringify({ type: 'chat', name: 'Bob', id: 'b1', content: 'threaded msg', timestamp: new Date().toISOString(), threadId: 'thread-42' }));
      const chat = await chatPromise;

      expect(chat.threadId).toBe('thread-42');
    });

    it('persists chat messages', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      ws.send(JSON.stringify({ type: 'chat', name: 'TestAgent', id: 'agent-001', content: 'persisted msg', timestamp: new Date().toISOString() }));
      await waitForMessage<ChatMessage>(ws, 'chat');

      expect(persistence.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'chat', content: 'persisted msg' })
      );
    });
  });

  // ─── Claims ─────────────────────────────────────────────────────────────

  describe('claims', () => {
    it('accepts and broadcasts a valid claim', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      const claimPromise = waitForMessage<ClaimMessage>(ws1, 'claim');
      ws2.send(JSON.stringify({ type: 'claim', name: 'Bob', id: 'b1', action: 'create_issue', target: 'owner/repo#title', timestamp: new Date().toISOString() }));
      const claim = await claimPromise;

      expect(claim.name).toBe('Bob');
      expect(claim.action).toBe('create_issue');
      expect(claim.target).toBe('owner/repo#title');
    });

    it('rejects claim with empty action', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify({ type: 'claim', name: 'TestAgent', id: 'agent-001', action: '', target: 'something', timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid claim');
    });

    it('rejects claim with empty target', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify({ type: 'claim', name: 'TestAgent', id: 'agent-001', action: 'create_issue', target: '', timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid claim');
    });

    it('allows same agent to renew claim silently (TTL refresh)', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg({ name: 'Alice', id: 'a1' }));

      //NOTE(jimmylee): First claim
      ws.send(JSON.stringify({ type: 'claim', name: 'Alice', id: 'a1', action: 'create_issue', target: 'owner/repo#1', timestamp: new Date().toISOString() }));
      await waitForMessage<ClaimMessage>(ws, 'claim');

      //NOTE(jimmylee): Renewal — same agent, same action:target — should NOT broadcast
      const messages = collectMessages(ws, 200);
      ws.send(JSON.stringify({ type: 'claim', name: 'Alice', id: 'a1', action: 'create_issue', target: 'owner/repo#1', timestamp: new Date().toISOString() }));
      const collected = await messages;

      //NOTE(jimmylee): No claim or error message should be broadcast for a renewal
      const claimOrError = collected.filter(m => m.type === 'claim' || m.type === 'error');
      expect(claimOrError).toHaveLength(0);
    });

    it('detects claim conflict from different agent', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      //NOTE(jimmylee): Alice claims first
      ws1.send(JSON.stringify({ type: 'claim', name: 'Alice', id: 'a1', action: 'create_issue', target: 'owner/repo#1', timestamp: new Date().toISOString() }));
      await waitForMessage<ClaimMessage>(ws2, 'claim');

      //NOTE(jimmylee): Bob tries to claim the same thing
      const errorPromise = waitForMessage<ErrorMessage>(ws2, 'error');
      ws2.send(JSON.stringify({ type: 'claim', name: 'Bob', id: 'b1', action: 'create_issue', target: 'owner/repo#1', timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Claim conflict');
      expect(error.message).toContain('Alice');
    });

    it('persists claim events', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      ws.send(JSON.stringify({ type: 'claim', name: 'TestAgent', id: 'agent-001', action: 'create_issue', target: 'owner/repo#test', timestamp: new Date().toISOString() }));
      await waitForMessage<ClaimMessage>(ws, 'claim');

      expect(persistence.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'claim', content: 'create_issue:owner/repo#test' })
      );
    });
  });

  // ─── Action Results ─────────────────────────────────────────────────────

  describe('action results', () => {
    it('broadcasts action result and cleans up claim', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      //NOTE(jimmylee): Alice claims
      ws1.send(JSON.stringify({ type: 'claim', name: 'Alice', id: 'a1', action: 'create_issue', target: 'owner/repo#1', timestamp: new Date().toISOString() }));
      await waitForMessage<ClaimMessage>(ws2, 'claim');

      //NOTE(jimmylee): Alice reports result
      const resultPromise = waitForMessage<ActionResultMessage>(ws2, 'action_result');
      ws1.send(JSON.stringify({ type: 'action_result', name: 'Alice', id: 'a1', action: 'create_issue', target: 'owner/repo#1', success: true, link: 'https://github.com/owner/repo/issues/1', timestamp: new Date().toISOString() }));
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.link).toBe('https://github.com/owner/repo/issues/1');

      //NOTE(jimmylee): After action result, another agent should be able to claim the same action:target
      ws2.send(JSON.stringify({ type: 'claim', name: 'Bob', id: 'b1', action: 'create_issue', target: 'owner/repo#1', timestamp: new Date().toISOString() }));
      const newClaim = await waitForMessage<ClaimMessage>(ws1, 'claim');
      expect(newClaim.name).toBe('Bob');
    });
  });

  // ─── Identity ───────────────────────────────────────────────────────────

  describe('identity', () => {
    it('stores identity and includes in presence', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      const summary = {
        coreValues: ['curiosity', 'care'],
        currentInterests: ['design systems'],
        voice: 'Thoughtful and direct',
        expertise: ['TypeScript'],
        recentWork: 'Space server tests',
      };

      //NOTE(jimmylee): Use predicate to wait for presence that actually contains the identity
      const presencePromise = waitForMessage<PresenceMessage>(ws, 'presence', 2000, (msg) => {
        const agent = msg.agents.find(a => a.name === 'TestAgent');
        return !!agent?.identity;
      });
      ws.send(JSON.stringify({ type: 'identity', name: 'TestAgent', id: 'agent-001', summary, timestamp: new Date().toISOString() }));
      const presence = await presencePromise;

      const agent = presence.agents.find(a => a.name === 'TestAgent');
      expect(agent?.identity).toEqual(summary);
    });
  });

  // ─── State Messages ─────────────────────────────────────────────────────

  describe('state messages', () => {
    it('broadcasts state changes', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      const statePromise = waitForMessage<StateMessage>(ws1, 'state');
      ws2.send(JSON.stringify({ type: 'state', name: 'Bob', id: 'b1', state: 'thinking', detail: 'processing claim', timestamp: new Date().toISOString() }));
      const state = await statePromise;

      expect(state.name).toBe('Bob');
      expect(state.state).toBe('thinking');
      expect(state.detail).toBe('processing claim');
    });
  });

  // ─── Reflection ─────────────────────────────────────────────────────────

  describe('reflection', () => {
    it('broadcasts reflection messages', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      const reflectionPromise = waitForMessage<ReflectionMessage>(ws1, 'reflection');
      ws2.send(JSON.stringify({ type: 'reflection', name: 'Bob', id: 'b1', summary: 'Learned about design systems today', timestamp: new Date().toISOString() }));
      const reflection = await reflectionPromise;

      expect(reflection.name).toBe('Bob');
      expect(reflection.summary).toBe('Learned about design systems today');
    });

    it('persists reflection events', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      ws.send(JSON.stringify({ type: 'reflection', name: 'TestAgent', id: 'agent-001', summary: 'Growth reflection', timestamp: new Date().toISOString() }));
      await waitForMessage<ReflectionMessage>(ws, 'reflection');

      expect(persistence.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'reflection', content: 'Growth reflection' })
      );
    });
  });

  // ─── Workspace State ────────────────────────────────────────────────────

  describe('workspace state', () => {
    it('broadcasts workspace state messages', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      const wsStatePromise = waitForMessage<WorkspaceStateMessage>(ws1, 'workspace_state');
      ws2.send(JSON.stringify({
        type: 'workspace_state',
        name: 'Bob',
        id: 'b1',
        workspace: 'owner/repo',
        planNumber: 1,
        totalTasks: 5,
        completedTasks: 2,
        blockedTasks: 0,
        inProgressTasks: 1,
        timestamp: new Date().toISOString(),
      }));
      const wsState = await wsStatePromise;

      expect(wsState.workspace).toBe('owner/repo');
      expect(wsState.totalTasks).toBe(5);
      expect(wsState.completedTasks).toBe(2);
    });
  });

  // ─── Disconnect Cleanup ─────────────────────────────────────────────────

  describe('disconnect cleanup', () => {
    it('broadcasts leave and updates presence on disconnect', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      //NOTE(jimmylee): Drain any pending presence messages from Bob's join before listening
      await new Promise((r) => setTimeout(r, 50));

      //NOTE(jimmylee): Listen for Bob's leave and updated presence (1 agent remaining)
      const leavePromise = waitForMessage<SpaceMessage>(ws1, 'leave');
      const presencePromise = waitForMessage<PresenceMessage>(ws1, 'presence', 2000, (msg) => {
        return msg.agents.length === 1;
      });

      ws2.close();
      const leave = await leavePromise;
      expect(leave.type).toBe('leave');

      const presence = await presencePromise;
      expect(presence.agents).toHaveLength(1);
      expect(presence.agents[0].name).toBe('Alice');
    });

    it('persists leave event', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      ws.close();
      await new Promise((r) => setTimeout(r, 100));

      expect(persistence.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'leave', agentName: 'TestAgent' })
      );
    });

    it('fires onLeave callback', async () => {
      const onLeave = vi.fn();
      server.stop();
      server = new SpaceServer(persistence, { onLeave });
      await server.start(0);
      port = server.port!;

      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(onLeave).toHaveBeenCalledWith(expect.objectContaining({ name: 'TestAgent' }));
    });

    it('removes agent from connected agents list after disconnect', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());
      expect(server.getConnectedAgents()).toHaveLength(1);

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(server.getConnectedAgents()).toHaveLength(0);
    });
  });

  // ─── Host Messages ─────────────────────────────────────────────────────

  describe('host messages', () => {
    it('broadcasts host messages to all agents', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      const chatPromise = waitForMessage<ChatMessage>(ws, 'chat');
      server.broadcastFromHost('Hello from the host');
      const chat = await chatPromise;

      expect(chat.name).toBe('host');
      expect(chat.content).toBe('Hello from the host');
    });

    it('parses @mentions in host messages', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg({ name: 'Marvin' }));

      const chatPromise = waitForMessage<ChatMessage>(ws, 'chat');
      server.broadcastFromHost('@Marvin what do you think?');
      const chat = await chatPromise;

      expect(chat.addressed).toContain('Marvin');
    });

    it('bare name matching uses word boundaries (no false positives)', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg({ name: 'Bob' }));

      //NOTE(jimmylee): "bobsled" contains "bob" as substring but should NOT match
      const chatPromise = waitForMessage<ChatMessage>(ws, 'chat');
      server.broadcastFromHost('I went bobsledding yesterday');
      const chat = await chatPromise;

      //NOTE(jimmylee): addressed is either undefined or an array that doesn't include Bob
      expect(chat.addressed ?? []).not.toContain('Bob');
    });

    it('bare name matching finds whole-word agent names', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg({ name: 'Marvin' }));

      const chatPromise = waitForMessage<ChatMessage>(ws, 'chat');
      server.broadcastFromHost('Hey Marvin, what do you think?');
      const chat = await chatPromise;

      expect(chat.addressed).toContain('Marvin');
    });

    it('persists host messages', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      server.broadcastFromHost('host message');
      await waitForMessage<ChatMessage>(ws, 'chat');

      expect(persistence.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'chat', agentName: 'host', content: 'host message' })
      );
    });
  });

  // ─── Multiple Agents ────────────────────────────────────────────────────

  describe('multiple agents', () => {
    it('tracks multiple connected agents', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      const ws3 = await connect();
      await joinAndWait(ws3, joinMsg({ name: 'Charlie', id: 'c1' }));

      const agents = server.getConnectedAgents();
      expect(agents).toHaveLength(3);
      expect(agents.map(a => a.name).sort()).toEqual(['Alice', 'Bob', 'Charlie']);
    });

    it('broadcasts presence updates to all agents on join', async () => {
      const ws1 = await connect();
      await joinAndWait(ws1, joinMsg({ name: 'Alice', id: 'a1' }));

      //NOTE(jimmylee): Drain any pending presence messages from Alice's own join
      await new Promise((r) => setTimeout(r, 100));

      //NOTE(jimmylee): Wait for a presence message with 2 agents (from Bob's join)
      const presencePromise = new Promise<PresenceMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout waiting for 2-agent presence')), 2000);
        const handler = (data: WebSocket.Data) => {
          const msg = JSON.parse(data.toString()) as SpaceMessage;
          if (msg.type === 'presence' && (msg as PresenceMessage).agents.length === 2) {
            clearTimeout(timer);
            ws1.removeListener('message', handler);
            resolve(msg as PresenceMessage);
          }
        };
        ws1.on('message', handler);
      });

      const ws2 = await connect();
      await joinAndWait(ws2, joinMsg({ name: 'Bob', id: 'b1' }));

      const presence = await presencePromise;
      expect(presence.agents).toHaveLength(2);
    });
  });

  // ─── Message Validation ──────────────────────────────────────────────

  describe('message validation', () => {
    it('rejects identity with non-object summary', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify({ type: 'identity', name: 'TestAgent', id: 'agent-001', summary: 'not-an-object', timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid identity');
    });

    it('rejects state with invalid state value', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify({ type: 'state', name: 'TestAgent', id: 'agent-001', state: 'flying', timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid state');
    });

    it('accepts valid state message', async () => {
      const ws = await connect();
      const ws2 = await connect();
      await joinAndWait(ws, joinMsg());
      await joinAndWait(ws2, joinMsg({ name: 'Agent2', id: 'agent-002' }));

      const statePromise = waitForMessage<StateMessage>(ws2, 'state');
      ws.send(JSON.stringify({ type: 'state', name: 'TestAgent', id: 'agent-001', state: 'thinking', timestamp: new Date().toISOString() }));
      const state = await statePromise;
      expect(state.state).toBe('thinking');
    });

    it('rejects action_result with missing fields', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify({ type: 'action_result', name: 'TestAgent', id: 'agent-001', action: '', target: 'repo', success: true, timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid action_result');
    });

    it('rejects reflection with empty summary', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify({ type: 'reflection', name: 'TestAgent', id: 'agent-001', summary: '', timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid reflection');
    });

    it('rejects workspace_state with missing workspace', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send(JSON.stringify({ type: 'workspace_state', name: 'TestAgent', id: 'agent-001', workspace: '', totalTasks: 5, completedTasks: 2, timestamp: new Date().toISOString() }));
      const error = await errorPromise;
      expect(error.message).toContain('Invalid workspace_state');
    });
  });

  // ─── Shutdown ───────────────────────────────────────────────────────

  describe('broadcastShutdown', () => {
    it('sends shutdown message without closing connections', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      const shutdownPromise = waitForMessage<SpaceMessage>(ws, 'shutdown');
      server.broadcastShutdown();
      const shutdownMsg = await shutdownPromise;
      expect(shutdownMsg.type).toBe('shutdown');

      //NOTE(jimmylee): Connection should still be open after broadcastShutdown (not stop)
      expect(server.getConnectedAgents()).toHaveLength(1);
    });
  });

  // ─── Invalid JSON ──────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns error for invalid JSON', async () => {
      const ws = await connect();
      const errorPromise = waitForMessage<ErrorMessage>(ws, 'error');
      ws.send('not-valid-json{{{');
      const error = await errorPromise;
      expect(error.message).toContain('Invalid JSON');
    });

    it('ignores unknown message types', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());

      //NOTE(jimmylee): Send unknown type — should not crash or return error
      const messages = collectMessages(ws, 200);
      ws.send(JSON.stringify({ type: 'unknown_type', data: 'test' }));
      const collected = await messages;

      const errors = collected.filter(m => m.type === 'error');
      expect(errors).toHaveLength(0);
    });
  });

  // ─── Server Lifecycle ──────────────────────────────────────────────────

  describe('server lifecycle', () => {
    it('getConnectedAgents returns empty array before any joins', () => {
      expect(server.getConnectedAgents()).toEqual([]);
    });

    it('stop clears all agents', async () => {
      const ws = await connect();
      await joinAndWait(ws, joinMsg());
      expect(server.getConnectedAgents()).toHaveLength(1);

      server.stop();
      expect(server.getConnectedAgents()).toEqual([]);
    });
  });
});
