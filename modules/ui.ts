//NOTE(jimmylee): Terminal UI Module
//NOTE(jimmylee): Uses scroll regions to anchor input box at bottom.
//NOTE(jimmylee): Output scrolls in upper region, input stays fixed below.
//NOTE(jimmylee): Adapted from ts-general-agent/modules/ui.ts for chatroom use.

import type { AgentPresence } from '@common/types.js';
import { MAX_AGENTS_DISPLAYED, INPUT_BOX_LINES } from '@common/config.js';

//NOTE(jimmylee): Ansi Escape Codes
export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  clearLine: '\x1b[2K',
  clearScreen: '\x1b[2J',
  saveCursor: '\x1b[s',
  restoreCursor: '\x1b[u',
};

//NOTE(jimmylee): Cursor and screen control
const CSI = {
  moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,
  moveUp: (n: number) => `\x1b[${n}A`,
  moveDown: (n: number) => `\x1b[${n}B`,
  moveToColumn: (col: number) => `\x1b[${col}G`,
  setScrollRegion: (top: number, bottom: number) => `\x1b[${top};${bottom}r`,
  resetScrollRegion: () => '\x1b[r',
  clearToEnd: '\x1b[J',
  clearLine: '\x1b[2K',
};

//NOTE(jimmylee): Symbols
export const SYM = {
  bullet: '•',
  diamond: '◆',
  square: '■',
  circle: '●',
  ring: '○',
  star: '★',
  heart: '♥',
  heartEmpty: '♡',
  arrowRight: '▸',
  pointer: '›',
  check: '✓',
  cross: '✗',
  ellipsis: '…',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

export const BOX = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  dTopLeft: '╔',
  dTopRight: '╗',
  dBottomLeft: '╚',
  dBottomRight: '╝',
  dHorizontal: '═',
  dVertical: '║',
  light: '░',
};

//NOTE(jimmylee): Utilities
export function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

export function getTerminalHeight(): number {
  return process.stdout.rows || 24;
}

export function timestamp(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

export function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= maxWidth) {
      lines.push(paragraph);
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > maxWidth) {
      let breakPoint = remaining.lastIndexOf(' ', maxWidth);
      if (breakPoint === -1 || breakPoint < maxWidth * 0.3) breakPoint = maxWidth;
      lines.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }
    if (remaining) lines.push(remaining);
  }
  return lines;
}

// ─── Agent Colors and Symbols ────────────────────────────────────────────────

const AGENT_COLORS = [ANSI.cyan, ANSI.green, ANSI.yellow, ANSI.magenta, ANSI.brightBlue, ANSI.brightCyan, ANSI.brightGreen, ANSI.brightMagenta];

const AGENT_SYMBOLS = [
  SYM.circle, // ●
  SYM.diamond, // ◆
  SYM.star, // ★
  SYM.heart, // ♥
  SYM.square, // ■
  SYM.bullet, // •
  SYM.ring, // ○
];

//NOTE(jimmylee): Stable hash from agent name -> index
function nameHash(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

//NOTE(jimmylee): Terminal Ui with anchored input box
export class TerminalUI {
  private thinkingMessage = '';
  private inputBoxEnabled = false;
  private inputBoxHeight = 7; //NOTE(jimmylee): Minimum: 1 separator + 1 top border + 3 input lines + 1 bottom border + 0 agent lines (but minimum 7)
  private currentVersion = '0.0.0';
  private currentInputText = '';
  private currentCursorPos = 0;
  private connectedAgents: AgentPresence[] = [];
  private resizeHandler: (() => void) | null = null;
  private typingAgents: Map<string, ReturnType<typeof setTimeout>> = new Map();

  //NOTE(jimmylee): Strip ANSI escape codes to get visible character count
  private visibleLength(str: string): number {
    return str.replace(/\x1b\[[0-9;]*m/g, '').length;
  }

  //NOTE(jimmylee): Wrap text in double-line vertical borders (║ content ║)
  //NOTE(jimmylee): Long lines will overflow past the right border — that's acceptable
  private addBorder(text: string): string {
    const width = getTerminalWidth();
    const innerWidth = width - 2; //NOTE(jimmylee): ║ + content(width-2) + ║
    const visLen = this.visibleLength(text);
    if (visLen > innerWidth) {
      return `${ANSI.white}${BOX.dVertical}${ANSI.reset}${text}`;
    }
    const padding = innerWidth - visLen;
    return `${ANSI.white}${BOX.dVertical}${ANSI.reset}${text}${' '.repeat(padding)}${ANSI.white}${BOX.dVertical}${ANSI.reset}`;
  }

  //NOTE(jimmylee): Write to the output area (scroll region)
  private writeOutput(text: string): void {
    if (this.inputBoxEnabled) {
      //NOTE(jimmylee): Save cursor, move to scroll region, write, restore
      process.stdout.write(ANSI.saveCursor);
      const height = getTerminalHeight();
      const scrollBottom = height - this.inputBoxHeight;
      //NOTE(jimmylee): Move to bottom of scroll region
      process.stdout.write(CSI.moveTo(scrollBottom, 1));
      process.stdout.write('\n' + this.addBorder(text));
      //NOTE(jimmylee): Restore and redraw input box
      this.redrawInputBox();
    } else {
      process.stdout.write(text + '\n');
    }
  }

  //NOTE(jimmylee): Simple log with timestamp and category
  private log(icon: string, color: string, label: string, message: string, detail?: string): void {
    const ts = `${ANSI.dim}${timestamp()}${ANSI.reset}`;
    const ico = `${color}${icon}${ANSI.reset}`;
    const lbl = `${color}${label.padEnd(6)}${ANSI.reset}`;
    const msg = `${ANSI.white}${message}${ANSI.reset}`;
    const det = detail ? `  ${ANSI.dim}${detail}${ANSI.reset}` : '';
    this.writeOutput(`  ${ts}  ${ico} ${lbl} ${msg}${det}`);
  }

  info(message: string, detail?: string): void {
    this.log(SYM.ring, ANSI.white, 'info', message, detail);
  }

  success(message: string, detail?: string): void {
    this.log(SYM.check, ANSI.white, 'done', message, detail);
  }

  warn(message: string, detail?: string): void {
    this.log(SYM.diamond, ANSI.white, 'warn', message, detail);
  }

  error(message: string, detail?: string): void {
    this.log(SYM.cross, ANSI.red, 'error', message, detail);
  }

  action(message: string, detail?: string): void {
    this.log(SYM.arrowRight, ANSI.white, 'act', message, detail);
  }

  think(message: string, detail?: string): void {
    this.log(SYM.bullet, ANSI.white, 'think', message, detail);
  }

  social(message: string, detail?: string): void {
    this.log(SYM.heart, ANSI.white, 'social', message, detail);
  }

  memory(message: string, detail?: string): void {
    this.log(SYM.star, ANSI.white, 'mem', message, detail);
  }

  system(message: string, detail?: string): void {
    this.log(SYM.square, ANSI.gray, 'sys', message, detail);
  }

  reflect(message: string, detail?: string): void {
    this.log(SYM.diamond, ANSI.white, 'refl', message, detail);
  }

  contemplate(message: string, detail?: string): void {
    this.log(SYM.ring, ANSI.white, 'mind', message, detail);
  }

  queue(message: string, detail?: string): void {
    this.log(SYM.pointer, ANSI.white, 'queue', message, detail);
  }

  //NOTE(jimmylee): Spinner - just prints a message, no animation that interferes
  startSpinner(message: string): void {
    this.thinkingMessage = message;
    const ts = `${ANSI.dim}${timestamp()}${ANSI.reset}`;
    this.writeOutput(`  ${ts}  ${ANSI.white}${SYM.spinner[0]}${ANSI.reset} ${ANSI.dim}${message}${ANSI.reset}`);
  }

  updateSpinner(message: string): void {
    this.thinkingMessage = message;
  }

  stopSpinner(finalMessage?: string, success = true): void {
    if (finalMessage) {
      if (success) {
        this.success(finalMessage);
      } else {
        this.error(finalMessage);
      }
    }
    this.thinkingMessage = '';
  }

  isSpinnerActive(): boolean {
    return this.thinkingMessage !== '';
  }

  // ─── Agent-specific methods ──────────────────────────────────────────────

  //NOTE(jimmylee): Get stable color for an agent name
  getAgentColor(agentName: string): string {
    return AGENT_COLORS[nameHash(agentName) % AGENT_COLORS.length];
  }

  //NOTE(jimmylee): Get stable symbol for an agent name
  getAgentSymbol(agentName: string): string {
    return AGENT_SYMBOLS[nameHash(agentName) % AGENT_SYMBOLS.length];
  }

  //NOTE(jimmylee): Mark an agent as currently typing (auto-clears after 10s)
  setAgentTyping(name: string): void {
    //NOTE(jimmylee): Clear any existing timeout for this agent
    const existing = this.typingAgents.get(name);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(() => {
      this.typingAgents.delete(name);
      if (this.inputBoxEnabled) this.redrawInputBox();
    }, 10_000);

    this.typingAgents.set(name, timeout);
    if (this.inputBoxEnabled) this.redrawInputBox();
  }

  //NOTE(jimmylee): Clear typing indicator for an agent (e.g. when they send a chat message)
  clearAgentTyping(name: string): void {
    const existing = this.typingAgents.get(name);
    if (existing) {
      clearTimeout(existing);
      this.typingAgents.delete(name);
      if (this.inputBoxEnabled) this.redrawInputBox();
    }
  }

  //NOTE(jimmylee): Render a chat message in the agent's color
  chat(agentName: string, message: string): void {
    const ts = `${ANSI.dim}${timestamp()}${ANSI.reset}`;
    const color = this.getAgentColor(agentName);
    const sym = this.getAgentSymbol(agentName);
    const name = `${color}${ANSI.bold}${agentName}${ANSI.reset}`;
    this.writeOutput(`  ${ts}  ${color}${sym}${ANSI.reset} ${name}   ${ANSI.white}${message}${ANSI.reset}`);
  }

  //NOTE(jimmylee): Log an agent joining the space
  agentJoin(agentName: string): void {
    const color = this.getAgentColor(agentName);
    const sym = this.getAgentSymbol(agentName);
    const ts = `${ANSI.dim}${timestamp()}${ANSI.reset}`;
    this.writeOutput(`  ${ts}  ${color}${sym}${ANSI.reset} ${color}${ANSI.bold}${agentName}${ANSI.reset} ${ANSI.dim}joined the space${ANSI.reset}`);
  }

  //NOTE(jimmylee): Log an agent leaving the space
  agentLeave(agentName: string): void {
    const color = this.getAgentColor(agentName);
    const sym = this.getAgentSymbol(agentName);
    const ts = `${ANSI.dim}${timestamp()}${ANSI.reset}`;
    this.writeOutput(`  ${ts}  ${color}${sym}${ANSI.reset} ${color}${ANSI.bold}${agentName}${ANSI.reset} ${ANSI.dim}left the space${ANSI.reset}`);
  }

  //NOTE(jimmylee): Update connected agents and recalculate input box height
  updateAgents(agents: AgentPresence[]): void {
    this.connectedAgents = agents;
    //NOTE(jimmylee): Recalculate input box height: min(agentCount, MAX) + 1 separator + INPUT_BOX_LINES
    const agentLines = Math.min(agents.length, MAX_AGENTS_DISPLAYED);
    const newHeight = agentLines + 1 + INPUT_BOX_LINES; // agents + separator + input box
    const minHeight = 1 + INPUT_BOX_LINES + 1; // at least 1 agent line placeholder + separator + input box
    this.inputBoxHeight = Math.max(newHeight, minHeight);

    if (this.inputBoxEnabled) {
      //NOTE(jimmylee): Update scroll region for new height
      const height = getTerminalHeight();
      const scrollBottom = height - this.inputBoxHeight;
      process.stdout.write(CSI.setScrollRegion(1, scrollBottom));
      this.redrawInputBox();
    }
  }

  //NOTE(jimmylee): Format a single agent line for the panel
  private formatAgentLine(agent: AgentPresence): string {
    const width = getTerminalWidth();
    const innerWidth = width - 4; //NOTE(jimmylee): Borders + padding
    const color = this.getAgentColor(agent.name);
    const sym = this.getAgentSymbol(agent.name);
    const ver = `v${agent.version}`;
    const isTyping = this.typingAgents.has(agent.name);
    const typingTag = isTyping ? `  ${ANSI.dim}(thinking...)${ANSI.reset}` : '';
    const typingVisLen = isTyping ? 14 : 0; //NOTE(jimmylee): "  (thinking...)" = 14 visible chars

    //NOTE(jimmylee): Calculate padding between name (+typing tag) and version
    //NOTE(jimmylee): "  ● name" = 2 + 1 + 1 + name.length visible chars
    const leftLen = 2 + 1 + 1 + agent.name.length + typingVisLen;
    const rightLen = ver.length;
    const gap = Math.max(2, innerWidth - leftLen - rightLen);

    return `  ${color}${sym}${ANSI.reset} ${color}${ANSI.bold}${agent.name}${ANSI.reset}${typingTag}${' '.repeat(gap)}${ANSI.dim}${ver}${ANSI.reset}`;
  }

  //NOTE(jimmylee): Header
  printHeader(name: string, subtitle?: string): void {
    const width = getTerminalWidth();
    const innerWidth = width - 2;

    this.writeOutput('');
    this.writeOutput(`${ANSI.white}${BOX.dTopLeft}${BOX.dHorizontal.repeat(innerWidth)}${BOX.dTopRight}${ANSI.reset}`);
    this.writeOutput(`${ANSI.white}${BOX.dVertical}${ANSI.reset}${' '.repeat(innerWidth)}${ANSI.white}${BOX.dVertical}${ANSI.reset}`);

    const title = `\u00AB ${name} \u00BB`;
    const padding = Math.floor((innerWidth - title.length) / 2);
    this.writeOutput(`${ANSI.white}${BOX.dVertical}${ANSI.reset}${' '.repeat(padding)}${ANSI.bold}${ANSI.white}${title}${ANSI.reset}${' '.repeat(innerWidth - padding - title.length)}${ANSI.white}${BOX.dVertical}${ANSI.reset}`);

    if (subtitle) {
      const subPadding = Math.floor((innerWidth - subtitle.length) / 2);
      this.writeOutput(`${ANSI.white}${BOX.dVertical}${ANSI.reset}${' '.repeat(subPadding)}${ANSI.dim}${subtitle}${ANSI.reset}${' '.repeat(innerWidth - subPadding - subtitle.length)}${ANSI.white}${BOX.dVertical}${ANSI.reset}`);
    }

    this.writeOutput(`${ANSI.white}${BOX.dVertical}${ANSI.reset}${' '.repeat(innerWidth)}${ANSI.white}${BOX.dVertical}${ANSI.reset}`);
    this.writeOutput(`${ANSI.white}${BOX.dBottomLeft}${BOX.dHorizontal.repeat(innerWidth)}${BOX.dBottomRight}${ANSI.reset}`);
    this.writeOutput('');
  }

  printDivider(style: 'light' | 'heavy' | 'double' | 'shade' = 'light'): void {
    const width = getTerminalWidth();
    const char = style === 'shade' ? BOX.light : style === 'double' ? BOX.dHorizontal : BOX.horizontal;
    this.writeOutput(`${ANSI.dim}${char.repeat(width)}${ANSI.reset}`);
  }

  printSpacer(): void {
    this.writeOutput('');
  }

  //NOTE(jimmylee): Response box for bordered text
  printResponse(text: string): void {
    const width = getTerminalWidth();
    const effectiveWidth = this.inputBoxEnabled ? width - 2 : width;
    const innerWidth = Math.min(effectiveWidth - 6, 76);

    this.writeOutput('');
    this.writeOutput(`  ${ANSI.dim}${BOX.topLeft}${BOX.horizontal.repeat(innerWidth + 2)}${BOX.topRight}${ANSI.reset}`);

    const lines = wrapText(text, innerWidth);
    for (const line of lines) {
      const padded = line + ' '.repeat(Math.max(0, innerWidth - line.length));
      this.writeOutput(`  ${ANSI.dim}${BOX.vertical}${ANSI.reset} ${padded} ${ANSI.dim}${BOX.vertical}${ANSI.reset}`);
    }

    this.writeOutput(`  ${ANSI.dim}${BOX.bottomLeft}${BOX.horizontal.repeat(innerWidth + 2)}${BOX.bottomRight}${ANSI.reset}`);
    this.writeOutput('');
  }

  //NOTE(jimmylee): Queue display
  printQueue(items: Array<{ action: string; priority: string }>): void {
    if (items.length === 0) return;
    this.writeOutput('');
    this.writeOutput(`  ${ANSI.white}${SYM.star} Planned Actions${ANSI.reset}`);
    for (const item of items.slice(0, 8)) {
      const style = item.priority === 'high' ? ANSI.red : item.priority === 'low' ? ANSI.dim : ANSI.white;
      this.writeOutput(`  ${style}${SYM.pointer} ${item.action}${ANSI.reset}`);
    }
    if (items.length > 8) {
      this.writeOutput(`  ${ANSI.dim}+${items.length - 8} more${ANSI.reset}`);
    }
  }

  printFarewell(): void {
    this.writeOutput('');
    this.writeOutput(`${ANSI.white}${BOX.dHorizontal.repeat(getTerminalWidth())}${ANSI.reset}`);
    this.writeOutput(`${ANSI.white} The space is quiet now ${ANSI.reset}`);
    this.writeOutput(`${ANSI.white}${BOX.dHorizontal.repeat(getTerminalWidth())}${ANSI.reset}`);
    this.writeOutput('');
  }

  printSection(title: string): void {
    const width = getTerminalWidth();
    const line = BOX.horizontal.repeat(3);
    const remaining = width - title.length - 8;
    this.writeOutput('');
    this.writeOutput(`${ANSI.dim}${line}${ANSI.reset}${ANSI.white} ${title} ${ANSI.reset}${ANSI.dim}${BOX.horizontal.repeat(Math.max(0, remaining))}${ANSI.reset}`);
    this.writeOutput('');
  }

  printToolStart(toolName: string): void {
    const name = toolName.replace(/_/g, ' ');
    this.writeOutput(`  ${ANSI.dim}${timestamp()}${ANSI.reset}  ${ANSI.white}${SYM.arrowRight}${ANSI.reset} ${ANSI.dim}executing${ANSI.reset} ${ANSI.white}${name}${ANSI.reset}`);
  }

  printToolResult(toolName: string, success: boolean, detail?: string): void {
    const icon = success ? `${ANSI.white}${SYM.check}` : `${ANSI.red}${SYM.cross}`;
    const name = toolName.replace(/_/g, ' ');
    const det = detail ? `  ${ANSI.dim}${detail}${ANSI.reset}` : '';
    this.writeOutput(`  ${ANSI.dim}${timestamp()}${ANSI.reset}  ${icon}${ANSI.reset} ${ANSI.dim}${name}${ANSI.reset}${det}`);
  }

  //NOTE(jimmylee): Input handling
  clearInputLine(): void {
    process.stdout.write('\r' + ANSI.clearLine);
  }

  //NOTE(jimmylee): Anchored Input Box using scroll regions

  //NOTE(jimmylee): Setup scroll region and draw initial input box
  initInputBox(version: string = '0.0.0'): void {
    this.currentVersion = version;
    this.currentInputText = '';
    this.currentCursorPos = 0;

    const height = getTerminalHeight();
    const scrollBottom = height - this.inputBoxHeight;

    //NOTE(jimmylee): Clear screen and set up scroll region
    process.stdout.write(CSI.moveTo(1, 1));

    //NOTE(jimmylee): Set scroll region (top of screen to above input box)
    process.stdout.write(CSI.setScrollRegion(1, scrollBottom));

    //NOTE(jimmylee): Move cursor to top of scroll region
    process.stdout.write(CSI.moveTo(1, 1));

    this.inputBoxEnabled = true;

    //NOTE(jimmylee): Draw the input box at the bottom
    this.redrawInputBox();

    //NOTE(jimmylee): Draw top border of output frame (╔═══╗) into scroll region
    const width = getTerminalWidth();
    process.stdout.write(ANSI.saveCursor);
    process.stdout.write(CSI.moveTo(scrollBottom, 1));
    process.stdout.write('\n' + `${ANSI.white}${BOX.dTopLeft}${BOX.dHorizontal.repeat(width - 2)}${BOX.dTopRight}${ANSI.reset}`);
    this.redrawInputBox();

    //NOTE(jimmylee): Handle terminal resize — remove old handler to prevent listener leak
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler);
    }
    this.resizeHandler = () => {
      if (this.inputBoxEnabled) {
        const newHeight = getTerminalHeight();
        const newScrollBottom = newHeight - this.inputBoxHeight;
        process.stdout.write(CSI.setScrollRegion(1, newScrollBottom));
        this.redrawInputBox();
      }
    };
    process.stdout.on('resize', this.resizeHandler);
  }

  //NOTE(jimmylee): Redraw the input box at fixed bottom position (full width)
  private redrawInputBox(): void {
    if (!this.inputBoxEnabled) return;

    const height = getTerminalHeight();
    const width = getTerminalWidth();
    const innerWidth = width - 4; //NOTE(jimmylee): Account for borders and padding (│ + space + space + │)

    //NOTE(jimmylee): Save cursor position in scroll region
    process.stdout.write(ANSI.saveCursor);

    //NOTE(jimmylee): Draw at fixed bottom position (outside scroll region)
    const boxStartRow = height - this.inputBoxHeight + 1;
    let currentRow = boxStartRow;

    //NOTE(jimmylee): Draw connected agent lines
    const agentsToShow = this.connectedAgents.slice(0, MAX_AGENTS_DISPLAYED);
    if (agentsToShow.length > 0) {
      for (const agent of agentsToShow) {
        process.stdout.write(CSI.moveTo(currentRow, 1));
        process.stdout.write(CSI.clearLine + this.addBorder(this.formatAgentLine(agent)));
        currentRow++;
      }
    } else {
      //NOTE(jimmylee): Show placeholder when no agents connected
      process.stdout.write(CSI.moveTo(currentRow, 1));
      process.stdout.write(CSI.clearLine + this.addBorder(`  ${ANSI.dim}${SYM.ring} Waiting for agents...${ANSI.reset}`));
      currentRow++;
    }

    //NOTE(jimmylee): Separator line — matches header's double-border style
    process.stdout.write(CSI.moveTo(currentRow, 1));
    process.stdout.write(CSI.clearLine + `${ANSI.white}${BOX.dBottomLeft}${BOX.dHorizontal.repeat(width - 2)}${BOX.dBottomRight}${ANSI.reset}`);
    currentRow++;

    //NOTE(jimmylee): Build the input box lines
    const statusTag = '[SPACE HOST]';
    const statusColor = ANSI.cyan;
    const hotkeys = `[ESC] CLEAR  [CTRL+C] QUIT  [ENTER] SEND`;
    const topPadding = Math.max(0, width - statusTag.length - hotkeys.length - 8);
    const topLine = `${ANSI.white}${BOX.topLeft}${BOX.horizontal}${ANSI.reset} ${statusColor}${statusTag}${ANSI.reset}  ${hotkeys} ${ANSI.white}${BOX.horizontal.repeat(topPadding + 1)}${BOX.topRight}${ANSI.reset}`;

    const displayText = this.currentInputText || '';

    //NOTE(jimmylee): Hard-wrap text for predictable cursor positioning
    const textLines: string[] = [];
    if (displayText.length === 0) {
      textLines.push('');
    } else {
      for (let i = 0; i < displayText.length; i += innerWidth) {
        textLines.push(displayText.slice(i, i + innerWidth));
      }
    }

    //NOTE(jimmylee): Calculate cursor position (trivial with hard-wrap)
    const cursorLineIndex = innerWidth > 0 ? Math.floor(this.currentCursorPos / innerWidth) : 0;
    const cursorColIndex = innerWidth > 0 ? this.currentCursorPos % innerWidth : 0;

    //NOTE(jimmylee): Determine scroll window (keep cursor visible within 3 lines)
    const VISIBLE_LINES = 3;
    let displayStartLine = 0;
    if (cursorLineIndex >= VISIBLE_LINES) {
      displayStartLine = cursorLineIndex - (VISIBLE_LINES - 1);
    }

    const ver = `v${this.currentVersion}`;
    const hasOverflow = textLines.length > displayStartLine + VISIBLE_LINES;
    const scrollIndicator = hasOverflow ? ' ...' : '';
    const bottomPadding = Math.max(0, width - ver.length - scrollIndicator.length - 5);
    const bottomLine = `${BOX.bottomLeft}${BOX.horizontal.repeat(bottomPadding)}${scrollIndicator} ${ver} ${BOX.horizontal}${BOX.bottomRight}`;

    //NOTE(jimmylee): Draw input box — top border
    process.stdout.write(CSI.moveTo(currentRow, 1));
    process.stdout.write(CSI.clearLine + topLine);
    currentRow++;

    //NOTE(jimmylee): Render 3 input lines
    for (let i = 0; i < VISIBLE_LINES; i++) {
      const lineIdx = displayStartLine + i;
      const lineContent = (textLines[lineIdx] || '').padEnd(innerWidth);
      process.stdout.write(CSI.moveTo(currentRow, 1));
      process.stdout.write(CSI.clearLine + `${ANSI.white}${BOX.vertical}${ANSI.reset} ${ANSI.white}${lineContent}${ANSI.reset} ${ANSI.white}${BOX.vertical}${ANSI.reset}`);
      currentRow++;
    }

    //NOTE(jimmylee): Bottom border
    process.stdout.write(CSI.moveTo(currentRow, 1));
    process.stdout.write(CSI.clearLine + `${ANSI.white}${bottomLine}${ANSI.reset}`);

    //NOTE(jimmylee): Position cursor on the correct visible row
    const cursorVisibleRow = cursorLineIndex - displayStartLine;
    const inputLineRow = currentRow - VISIBLE_LINES + cursorVisibleRow;
    const cursorCol = Math.min(cursorColIndex, innerWidth) + 3; //NOTE(jimmylee): +3 for "│ " prefix
    process.stdout.write(CSI.moveTo(inputLineRow, Math.max(3, cursorCol)));
  }

  //NOTE(jimmylee): Update input box content
  printInputBox(text: string, cursorPos: number, version: string = '0.0.0'): void {
    this.currentInputText = text;
    this.currentCursorPos = cursorPos;
    this.currentVersion = version;
    this.redrawInputBox();
  }

  //NOTE(jimmylee): Clear input and redraw
  clearInputBox(version: string = '0.0.0'): void {
    this.printInputBox('', 0, version);
  }

  //NOTE(jimmylee): Disable input box and restore normal scrolling
  finalizeInputBox(): void {
    if (!this.inputBoxEnabled) return;

    //NOTE(jimmylee): Reset scroll region to full screen
    process.stdout.write(CSI.resetScrollRegion());

    //NOTE(jimmylee): Move to bottom and clear input box area
    const height = getTerminalHeight();
    process.stdout.write(CSI.moveTo(height - this.inputBoxHeight + 1, 1));
    for (let i = 0; i < this.inputBoxHeight; i++) {
      process.stdout.write(CSI.clearLine + '\n');
    }

    //NOTE(jimmylee): Move back up
    process.stdout.write(CSI.moveTo(height - this.inputBoxHeight + 1, 1));

    this.inputBoxEnabled = false;
    this.currentInputText = '';
    this.currentCursorPos = 0;
  }
}

export const ui = new TerminalUI();
