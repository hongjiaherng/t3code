export const PTY_TURN_OUTPUT_MAX_CHARS = 250_000;
export const PTY_DELTA_MAX_CHARS = 8_000;
export const PTY_TRUNCATION_MARKER = "\n[T3 truncated PTY output]";
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 40;

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsiEscapes(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

interface TerminalScreen {
  readonly cols: number;
  readonly rows: number;
  lines: string[][];
  row: number;
  col: number;
  savedRow: number;
  savedCol: number;
}

function makeScreen(cols = DEFAULT_TERMINAL_COLS, rows = DEFAULT_TERMINAL_ROWS): TerminalScreen {
  return {
    cols,
    rows,
    lines: Array.from({ length: rows }, () => []),
    row: 0,
    col: 0,
    savedRow: 0,
    savedCol: 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clearLine(screen: TerminalScreen, mode: number): void {
  const line = screen.lines[screen.row];
  if (!line) return;
  if (mode === 1) {
    for (let col = 0; col <= screen.col; col += 1) line[col] = "";
    return;
  }
  if (mode === 2) {
    screen.lines[screen.row] = [];
    return;
  }
  for (let col = screen.col; col < screen.cols; col += 1) line[col] = "";
}

function clearScreen(screen: TerminalScreen, mode: number): void {
  if (mode === 2 || mode === 3) {
    screen.lines = Array.from({ length: screen.rows }, () => []);
    screen.row = 0;
    screen.col = 0;
    return;
  }
  if (mode === 1) {
    for (let row = 0; row < screen.row; row += 1) screen.lines[row] = [];
    clearLine(screen, 1);
    return;
  }
  clearLine(screen, 0);
  for (let row = screen.row + 1; row < screen.rows; row += 1) screen.lines[row] = [];
}

function lineFeed(screen: TerminalScreen): void {
  if (screen.row >= screen.rows - 1) {
    screen.lines.shift();
    screen.lines.push([]);
    return;
  }
  screen.row += 1;
}

function writeText(screen: TerminalScreen, text: string): void {
  for (const char of text) {
    if (char === "\r") {
      screen.col = 0;
      continue;
    }
    if (char === "\n") {
      lineFeed(screen);
      continue;
    }
    if (char === "\b") {
      screen.col = Math.max(0, screen.col - 1);
      continue;
    }
    if (char < " " || char === "\u007f") {
      continue;
    }

    const line = screen.lines[screen.row];
    if (!line) continue;
    line[screen.col] = char;
    screen.col += 1;
    if (screen.col >= screen.cols) {
      screen.col = 0;
      lineFeed(screen);
    }
  }
}

function firstCsiParam(params: string): number {
  const normalized = params.replace(/[?>=]/g, "");
  const first = normalized.split(";")[0];
  const parsed = Number.parseInt(first || "1", 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

function handleCsi(screen: TerminalScreen, params: string, command: string): void {
  const amount = firstCsiParam(params);
  switch (command) {
    case "A":
      screen.row = clamp(screen.row - amount, 0, screen.rows - 1);
      break;
    case "B":
      screen.row = clamp(screen.row + amount, 0, screen.rows - 1);
      break;
    case "C":
      screen.col = clamp(screen.col + amount, 0, screen.cols - 1);
      break;
    case "D":
      screen.col = clamp(screen.col - amount, 0, screen.cols - 1);
      break;
    case "G":
      screen.col = clamp(amount - 1, 0, screen.cols - 1);
      break;
    case "H":
    case "f": {
      const parts = params
        .replace(/[?>=]/g, "")
        .split(";")
        .map((part) => Number.parseInt(part || "1", 10));
      screen.row = clamp((parts[0] ?? 1) - 1, 0, screen.rows - 1);
      screen.col = clamp((parts[1] ?? 1) - 1, 0, screen.cols - 1);
      break;
    }
    case "J":
      clearScreen(screen, amount === 1 || amount === 2 || amount === 3 ? amount : 0);
      break;
    case "K":
      clearLine(screen, amount === 1 || amount === 2 ? amount : 0);
      break;
    case "s":
      screen.savedRow = screen.row;
      screen.savedCol = screen.col;
      break;
    case "u":
      screen.row = screen.savedRow;
      screen.col = screen.savedCol;
      break;
    default:
      break;
  }
}

function readEscapeSequence(value: string, index: number): { readonly nextIndex: number } {
  const next = value[index + 1];
  if (!next) return { nextIndex: value.length };

  if (next === "]") {
    const bellIndex = value.indexOf("\u0007", index + 2);
    const stIndex = value.indexOf("\u001b\\", index + 2);
    const end =
      bellIndex === -1 ? stIndex : stIndex === -1 ? bellIndex : Math.min(bellIndex, stIndex);
    return { nextIndex: end === -1 ? value.length : end + (value[end] === "\u001b" ? 2 : 1) };
  }

  if (next === "P" || next === "^" || next === "_" || next === "X") {
    const stIndex = value.indexOf("\u001b\\", index + 2);
    return { nextIndex: stIndex === -1 ? value.length : stIndex + 2 };
  }

  if (next === "[") {
    let cursor = index + 2;
    while (cursor < value.length) {
      const char = value[cursor];
      if (!char) break;
      const code = char.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) {
        return { nextIndex: cursor + 1 };
      }
      cursor += 1;
    }
    return { nextIndex: value.length };
  }

  return { nextIndex: Math.min(value.length, index + 2) };
}

function renderTerminalScreen(value: string): string {
  const screen = makeScreen();
  let textBuffer = "";

  const flushText = () => {
    if (textBuffer.length > 0) {
      writeText(screen, textBuffer);
      textBuffer = "";
    }
  };

  for (let index = 0; index < value.length; ) {
    const char = value[index];
    if (char === "\u001b") {
      flushText();
      const next = value[index + 1];
      if (next === "[") {
        const sequence = readEscapeSequence(value, index);
        const content = value.slice(index + 2, sequence.nextIndex - 1);
        const command = value[sequence.nextIndex - 1] ?? "";
        handleCsi(screen, content, command);
        index = sequence.nextIndex;
        continue;
      }
      if (next === "7") {
        screen.savedRow = screen.row;
        screen.savedCol = screen.col;
      } else if (next === "8") {
        screen.row = screen.savedRow;
        screen.col = screen.savedCol;
      }
      index = readEscapeSequence(value, index).nextIndex;
      continue;
    }

    textBuffer += char;
    index += 1;
  }
  flushText();

  return screen.lines
    .map((line) =>
      Array.from({ length: line.length }, (_, index) => line[index] ?? " ")
        .join("")
        .trimEnd(),
    )
    .join("\n");
}

const CLAUDE_TUI_SPINNER_CHARS = new Set(["✻", "✽", "✶", "✢", "✳", "✲", "*", "·"]);

function cleanClaudeAnswerLine(value: string): string {
  return value
    .replace(/[─\s]+T3\s+[a-f0-9-]+\s*[─\s]*$/i, "")
    .replace(/^[─\s]+/, "")
    .replace(/─+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeClaudeTuiLine(
  line: string,
  options: { readonly requireAnswerMarker?: boolean } = {},
): string | undefined {
  const collapsed = line
    .replace(/\u00a0/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .trim();
  if (!collapsed) return undefined;
  const markedAnswer = collapsed.match(/^[●◆◇○]\s*(.+)$/u);
  if (options.requireAnswerMarker && !markedAnswer) return undefined;
  if (markedAnswer) {
    const answer = cleanClaudeAnswerLine(markedAnswer[1]?.trim() ?? "");
    return answer.length > 0 ? answer : undefined;
  }
  if (collapsed === "0q" || collapsed === ";") return undefined;
  if (/^T3 [a-f0-9-]{4,}/i.test(collapsed)) return undefined;
  if (collapsed.includes("ClaudeCode") || /^Claude Code\b/.test(collapsed)) return undefined;
  if (/^Sonnet\b|^Opus\b|^Haiku\b/.test(collapsed) || collapsed.includes("ClaudeAPI")) {
    return undefined;
  }
  if (collapsed.startsWith("~/") || collapsed.includes("/git/")) return undefined;
  if (collapsed.includes("T3PTY") || collapsed.includes("T3 PTY")) return undefined;
  if (collapsed.includes("bypasspermissions") || collapsed.includes("bypass permissions")) {
    return undefined;
  }
  if ((collapsed.match(/─/gu)?.length ?? 0) > 5) return undefined;
  if (/^[─\s]+(?:T3\b.*)?[─\s]*$/.test(collapsed)) return undefined;
  if (collapsed.startsWith("❯")) return undefined;
  if (collapsed.startsWith("⏵⏵")) return undefined;
  if (collapsed.startsWith("Resume this session with:")) return undefined;
  if (collapsed.startsWith("claude --resume ")) return undefined;
  if (/^Cooked for\b/.test(collapsed)) return undefined;

  const withoutSpinnerStatus = collapsed.replace(
    /^[✻✽✶✢✳✲*·]\s*(?:Puzzling|Thinking|Creating|Baked|Cooking|Herding|Musing|Crafting|Running|Working).*/u,
    "",
  );
  if (!withoutSpinnerStatus.trim()) return undefined;

  const answerLine = withoutSpinnerStatus.replace(/^[●◆◇○]\s*/, "").trim();
  if (CLAUDE_TUI_SPINNER_CHARS.has(answerLine)) return undefined;
  if (/^\(\d+s\b.*tokens\)$/.test(answerLine)) return undefined;
  return answerLine.length > 0 ? answerLine : undefined;
}

function looksLikeClaudeTui(value: string): boolean {
  return (
    value.includes("Claude") ||
    value.includes("⏵⏵") ||
    value.includes("bypass permissions") ||
    value.includes("bypasspermissions") ||
    value.includes("\u001b]0;")
  );
}

function extractClaudeTuiOutput(value: string): string {
  const rendered = renderTerminalScreen(value);
  const lines = rendered
    .split("\n")
    .map((line) => normalizeClaudeTuiLine(line, { requireAnswerMarker: true }))
    .filter((line): line is string => line !== undefined);

  return Array.from(new Set(lines)).join("\n");
}

export function normalizePtyText(value: string): string {
  const screenOutput = extractClaudeTuiOutput(value);
  if (screenOutput.length > 0) {
    return screenOutput;
  }
  if (looksLikeClaudeTui(value)) {
    return "";
  }

  const stripped = stripAnsiEscapes(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const lines: string[] = [];
  for (const chunk of stripped.split("\n")) {
    const carriageParts = chunk.split("\r");
    const latest = carriageParts[carriageParts.length - 1] ?? "";
    lines.push(latest);
  }
  return lines
    .map((line) => normalizeClaudeTuiLine(line))
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function appendCappedPtyOutput(input: {
  readonly existing: string;
  readonly chunk: string;
  readonly maxChars?: number;
  readonly snapshot?: boolean;
}): { readonly text: string; readonly appended: string; readonly truncated: boolean } {
  const maxChars = input.maxChars ?? PTY_TURN_OUTPUT_MAX_CHARS;
  const normalized = normalizePtyText(input.chunk);
  if (normalized.length === 0 || input.existing.endsWith(PTY_TRUNCATION_MARKER)) {
    return { text: input.existing, appended: "", truncated: false };
  }
  if (input.snapshot && input.existing.length > 0 && normalized.startsWith(input.existing)) {
    const incremental = normalized.slice(input.existing.length);
    if (incremental.length === 0) {
      return { text: input.existing, appended: "", truncated: false };
    }
    return appendCappedPtyOutput({
      existing: input.existing,
      chunk: incremental,
      maxChars,
    });
  }
  if (input.snapshot && input.existing.length > 0) {
    return { text: input.existing, appended: "", truncated: false };
  }

  const available = maxChars - input.existing.length;
  if (available <= 0) {
    return {
      text: `${input.existing}${PTY_TRUNCATION_MARKER}`,
      appended: PTY_TRUNCATION_MARKER,
      truncated: true,
    };
  }

  if (normalized.length <= available) {
    return {
      text: input.existing + normalized,
      appended: normalized,
      truncated: false,
    };
  }

  const appended = `${normalized.slice(0, available)}${PTY_TRUNCATION_MARKER}`;
  return {
    text: input.existing + appended,
    appended,
    truncated: true,
  };
}

export function chunkPtyDelta(delta: string, maxChars = PTY_DELTA_MAX_CHARS): string[] {
  if (delta.length <= maxChars) {
    return delta.length > 0 ? [delta] : [];
  }
  const chunks: string[] = [];
  for (let index = 0; index < delta.length; index += maxChars) {
    chunks.push(delta.slice(index, index + maxChars));
  }
  return chunks;
}
