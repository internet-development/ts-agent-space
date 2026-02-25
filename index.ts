//NOTE(jimmylee): ts-agent-space Entry Point
//NOTE(jimmylee): Starts the WebSocket server, mDNS advertisement, terminal UI, and input handling.

import { config as dotenvConfig } from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
dotenvConfig();

import { DEFAULT_PORT } from '@common/config.js';
import type { AgentPresence } from '@common/types.js';
import { ui, getTerminalWidth } from '@modules/ui.js';
import { SpaceServer } from '@modules/server.js';
import { SpaceDiscovery } from '@modules/discovery.js';
import { ChatPersistence } from '@modules/persistence.js';
import { createRequire } from 'module';

//NOTE(jimmylee): Get the directory of this file (repo root)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

//NOTE(jimmylee): Read version from package.json
const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const VERSION = pkg.version || '0.0.0';

//NOTE(jimmylee): Configuration from environment
const SPACE_NAME = process.env.SPACE_NAME || 'agent-space';
const SPACE_PORT = parseInt(process.env.SPACE_PORT || '', 10) || DEFAULT_PORT;

async function main(): Promise<void> {
  //NOTE(jimmylee): Initialize persistence
  const persistence = new ChatPersistence(__dirname);

  //NOTE(jimmylee): Display welcome
  ui.printHeader(SPACE_NAME, 'AGENT SPACE');
  ui.printDivider('light');

  //NOTE(jimmylee): Initialize the input box
  ui.initInputBox(VERSION);

  //NOTE(jimmylee): Create the server with UI callbacks
  const server = new SpaceServer(
    persistence,
    {
      onJoin: (agent: AgentPresence) => {
        ui.agentJoin(agent.name);
        ui.updateAgents(server.getConnectedAgents());
      },
      onLeave: (agent: AgentPresence) => {
        ui.agentLeave(agent.name);
        ui.updateAgents(server.getConnectedAgents());
      },
      onChat: (agentName: string, content: string) => {
        ui.clearAgentTyping(agentName);
        ui.chat(agentName, content);
      },
      onTyping: (agentName: string) => {
        ui.setAgentTyping(agentName);
      },
    },
    'host'
  );

  //NOTE(jimmylee): Start the WebSocket server
  try {
    await server.start(SPACE_PORT);
    ui.success(`Server listening on port ${SPACE_PORT}`);
  } catch (err) {
    ui.error(`Failed to start server: ${err}`);
    process.exit(1);
  }

  //NOTE(jimmylee): Start mDNS advertisement
  const discovery = new SpaceDiscovery();
  try {
    discovery.start(SPACE_PORT, SPACE_NAME);
    ui.success('mDNS advertising', `_agent-space._tcp on port ${SPACE_PORT}`);
  } catch (err) {
    ui.warn(`mDNS failed: ${err}`, 'agents can still connect via direct URL');
  }

  //NOTE(jimmylee): Input setup — raw mode for character-by-character handling
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  let shouldExit = false;
  let inputBuffer = '';
  let cursorPos = 0;

  //NOTE(jimmylee): Graceful departure
  const shutdown = (reason: string): void => {
    if (shouldExit) return;
    shouldExit = true;

    ui.system('Shutting down', reason);

    server.stop();
    discovery.stop();

    ui.finalizeInputBox();
    ui.printFarewell();

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.exit(0);
  };

  //NOTE(jimmylee): Ensure terminal state is restored on ANY exit path
  process.on('exit', () => {
    try {
      ui.finalizeInputBox();
    } catch {}
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {}
    }
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    ui.error('Unhandled rejection', String(reason));
  });

  //NOTE(jimmylee): Key input handling (same pattern as ts-general-agent/modules/loop.ts)
  process.stdin.on('data', (char: string) => {
    //NOTE(jimmylee): Arrow keys and escape sequences (multi-char starting with ESC)
    if (char.length > 1 && char[0] === '\x1b') {
      const lineWidth = getTerminalWidth() - 4;
      if (char === '\x1b[D') {
        // Left arrow
        if (cursorPos > 0) cursorPos--;
      } else if (char === '\x1b[C') {
        // Right arrow
        if (cursorPos < inputBuffer.length) cursorPos++;
      } else if (char === '\x1b[A') {
        // Up arrow
        if (cursorPos >= lineWidth) cursorPos -= lineWidth;
      } else if (char === '\x1b[B') {
        // Down arrow
        cursorPos = Math.min(cursorPos + lineWidth, inputBuffer.length);
      }
      ui.printInputBox(inputBuffer, cursorPos, VERSION);
      return;
    }

    //NOTE(jimmylee): ESC — clear input or exit
    if (char === '\x1b') {
      if (inputBuffer.length > 0) {
        inputBuffer = '';
        cursorPos = 0;
        ui.printInputBox('', 0, VERSION);
      } else {
        shutdown('ESC');
      }
      return;
    }

    //NOTE(jimmylee): Ctrl+C
    if (char === '\x03') {
      shutdown('Ctrl+C');
      return;
    }

    //NOTE(jimmylee): Enter — submit message
    if (char.length === 1 && (char === '\r' || char === '\n')) {
      const input = inputBuffer.trim();
      inputBuffer = '';
      cursorPos = 0;

      if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        ui.finalizeInputBox();
        shutdown('exit command');
        return;
      }

      ui.clearInputBox(VERSION);

      if (input) {
        //NOTE(jimmylee): Show the host message in the output and broadcast to all agents
        ui.chat('host', input);
        server.broadcastFromHost(input);
      }
      return;
    }

    //NOTE(jimmylee): Backspace
    if (char === '\x7f' || char === '\b') {
      if (inputBuffer.length > 0 && cursorPos > 0) {
        inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
        cursorPos--;
        ui.printInputBox(inputBuffer, cursorPos, VERSION);
      }
      return;
    }

    //NOTE(jimmylee): Regular character or paste — insert at cursor position
    for (const ch of char) {
      if (ch < ' ' && ch !== '\t') continue;
      inputBuffer = inputBuffer.slice(0, cursorPos) + ch + inputBuffer.slice(cursorPos);
      cursorPos++;
    }
    ui.printInputBox(inputBuffer, cursorPos, VERSION);
  });

  ui.system('Space ready', `${SPACE_NAME} on port ${SPACE_PORT}`);
  ui.printSpacer();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
