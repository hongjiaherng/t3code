// @effect-diagnostics nodeBuiltinImport:off - reads Claude's JSONL transcript files directly.
// @effect-diagnostics globalDate:off - PTY event timestamps come from wall-clock callbacks.
// @effect-diagnostics globalDateInEffect:off - same wall-clock timestamps inside session effects.
// @effect-diagnostics globalTimers:off - turn idle/timeout detection uses real OS timers.
// @effect-diagnostics globalTimersInEffect:off - turn idle/timeout detection uses real OS timers.
/**
 * ClaudePtyAdapter - experimental Claude Code provider driven through a PTY.
 *
 * Spawns the interactive `claude` terminal UI inside a pseudo-terminal, feeds
 * user prompts via bracketed paste, and reads Claude's JSONL transcript files
 * (`~/.claude/projects/<cwd>/<sessionId>.jsonl`) to surface assistant text,
 * tool calls, and tool results as canonical T3 runtime events. This lets T3
 * use Claude Code's subscription-authenticated interactive mode while still
 * rendering responses in the T3 chat UI.
 *
 * Adapted from gigq/t3code. Local-only (SSH remote projects removed) and
 * re-fitted onto the current driver/instance provider architecture: the
 * adapter is a captured closure produced by {@link ../Drivers/ClaudePtyDriver}
 * rather than an injected `Context.Service`.
 *
 * @module ClaudePtyAdapter
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import {
  type CanonicalItemType,
  type ClaudePtySettings,
  EventId,
  type ModelSelection,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { Effect, Queue, Stream } from "effect";

import { PtyAdapter, type PtyProcess } from "../../terminal/Services/PTY.ts";
import { normalizeClaudeCliEffort } from "./ClaudeProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ClaudePtyAdapterShape } from "../Services/ClaudePtyAdapter.ts";
import { chunkPtyDelta, stripAnsiEscapes } from "../ptyTerminalText.ts";

const PROVIDER = ProviderDriverKind.make("claudePty");
const TURN_IDLE_COMPLETE_MS = 2_500;
const TURN_NO_OUTPUT_WARNING_MS = 30_000;
const TURN_HARD_TIMEOUT_MS = 20 * 60 * 1_000;
const TRANSCRIPT_POLL_MS = 1_000;
const INPUT_READY_DELAY_MS = 2_500;
// After the input box appears, wait for the TUI to stop emitting output for this
// long before pasting. Claude's startup banner keeps rendering for a beat after
// the prompt caret shows; pasting + Enter into that churn lands the text in the
// box but the Enter races the re-render and is dropped, so the turn never
// submits. Quiescence is far more reliable than a fixed settle delay.
const INPUT_READY_QUIET_MS = 700;
const INPUT_READY_QUIET_MAX_WAIT_MS = 6_000;
const RESUME_INPUT_READY_FALLBACK_MS = 20_000;
const INPUT_ACK_TIMEOUT_MS = 5_000;
const INPUT_ACK_POLL_MS = 250;
const INPUT_READY_OUTPUT_MAX_CHARS = 20_000;
// Gap between pasting the prompt and sending Enter (see submitViaBracketedPaste).
const PROMPT_SUBMIT_DELAY_MS = 120;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
type ClaudePtyPermissionMode = "bypassPermissions" | "default" | "plan";

interface ClaudePtyResumeState {
  readonly kind?: "claudePty";
  readonly sessionId?: string;
}

interface ActiveTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly itemId: RuntimeItemId;
  emittedLength: number;
  outputText: string;
  baselineKeys: Set<string>;
  seenTranscriptKeys: Set<string>;
  toolItems: Map<
    string,
    {
      readonly itemType: CanonicalItemType;
      readonly title: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly detail: string | undefined;
    }
  >;
  sawOutput: boolean;
  completed: boolean;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  noOutputTimer: ReturnType<typeof setTimeout> | undefined;
  hardTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
}

interface ClaudePtySessionContext {
  session: ProviderSession;
  pty: PtyProcess;
  readonly sessionId: string;
  readonly cwd: string;
  inputReadyAtMs: number;
  inputReady: boolean;
  inputReadyOutput: string;
  trustPromptHandled: boolean;
  lastDataAtMs: number;
  readonly inputReadyResolvers: Set<() => void>;
  currentPermissionMode: ClaudePtyPermissionMode;
  currentEffort: string | undefined;
  activeTurn: ActiveTurnState | undefined;
  stopped: boolean;
  removeDataListener: () => void;
  removeExitListener: () => void;
}

export interface ClaudePtyLaunch {
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function eventId(): EventId {
  return EventId.make(randomUUID());
}

function turnId(): TurnId {
  return TurnId.make(randomUUID());
}

function itemId(): RuntimeItemId {
  return RuntimeItemId.make(randomUUID());
}

function readResumeState(value: unknown): ClaudePtyResumeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    ...(record.kind === "claudePty" ? { kind: "claudePty" as const } : {}),
    ...(typeof record.sessionId === "string" && record.sessionId.trim().length > 0
      ? { sessionId: record.sessionId }
      : {}),
  };
}

function claudePtyResumeCursor(sessionId: string): ClaudePtyResumeState {
  return { kind: "claudePty", sessionId };
}

function runtimePermissionMode(
  input: Pick<ProviderSessionStartInput, "runtimeMode">,
): ClaudePtyPermissionMode {
  return input.runtimeMode === "full-access" ? "bypassPermissions" : "default";
}

function turnPermissionMode(input: {
  readonly runtimeMode: ProviderSessionStartInput["runtimeMode"];
  readonly interactionMode?: ProviderInteractionMode | undefined;
}): ClaudePtyPermissionMode {
  if (input.interactionMode === "plan") {
    return "plan";
  }
  return runtimePermissionMode(input);
}

/**
 * The CLI `--effort` flag value for a model selection, normalized through the
 * same mapping the Claude Agent SDK adapter uses (drops `ultrathink`, maps
 * `ultracode` to `xhigh`, etc.). Returns undefined when no effort applies.
 */
function resolveClaudePtyCliEffort(
  modelSelection: ModelSelection | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!modelSelection) {
    return undefined;
  }
  return normalizeClaudeCliEffort(
    getModelSelectionStringOptionValue(modelSelection, "effort"),
    model,
  );
}

function rawEffortFromSelection(modelSelection: ModelSelection | undefined): string | undefined {
  return modelSelection ? getModelSelectionStringOptionValue(modelSelection, "effort") : undefined;
}

export function buildClaudeArgs(input: {
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly runtimeMode: ProviderSessionStartInput["runtimeMode"];
  readonly permissionMode?: ClaudePtyPermissionMode;
  readonly sessionId: string;
  readonly resume: boolean;
  readonly threadId: ThreadId;
}): string[] {
  const args = [
    input.resume ? "--resume" : "--session-id",
    input.sessionId,
    "--name",
    `T3 ${input.threadId.slice(0, 8)}`,
  ];
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.effort) {
    args.push("--effort", input.effort);
  }
  const permissionMode = input.permissionMode ?? runtimePermissionMode(input);
  // Pass only --permission-mode. Adding --dangerously-skip-permissions makes the
  // interactive TUI show a "Bypass Permissions mode" accept/exit dialog on every
  // launch (fresh and --resume); a stray Enter selects "No, exit" and Claude dies
  // with code=1. --permission-mode bypassPermissions enables bypass on its own,
  // with no dialog, so turns run straight through.
  args.push("--permission-mode", permissionMode);
  return args;
}

/**
 * Resolve a command to an absolute executable path.
 *
 * Unlike a shell (or `execvp` on Unix), node-pty does not search `PATH` for a
 * bare command name on Windows, so spawning `claude` directly fails with
 * "File not found". When the configured binary is a bare name we walk `PATH`
 * (honoring `PATHEXT` on Windows) and hand node-pty the full path; anything
 * already path-qualified is passed through untouched, and an unresolved name
 * falls through so node-pty can surface its own error.
 */
function resolveExecutablePath(command: string): string {
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  if (!pathValue) {
    return command;
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => ext.trim())
          .filter(Boolean)
      : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return command;
}

export function buildClaudePtyLaunch(input: {
  readonly binaryPath: string;
  readonly cwd: string | undefined;
  readonly args: ReadonlyArray<string>;
}): ClaudePtyLaunch {
  return {
    shell: input.binaryPath,
    args: [...input.args],
    cwd: input.cwd ?? process.cwd(),
  };
}

function bestEffortAnswerText(answers: ProviderUserInputAnswers): string {
  return Object.values(answers)
    .flatMap((value) => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value))
        return value.filter((entry): entry is string => typeof entry === "string");
      if (
        value &&
        typeof value === "object" &&
        Array.isArray((value as { answers?: unknown }).answers)
      ) {
        return (value as { answers: unknown[] }).answers.filter(
          (entry): entry is string => typeof entry === "string",
        );
      }
      return [];
    })
    .join(", ");
}

// Bracketed-paste markers tell the TUI "this is a paste, not keystrokes" so it
// does not fire slash-command/autocomplete popups per character.
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
// Chunk large prompts so a single write cannot overflow the PTY input buffer.
const PASTE_CHUNK_CHARS = 4_096;

/**
 * Paste text into Claude's input box and submit it. The Enter is a SEPARATE
 * write sent after a short gap: Claude's Ink TUI ignores a carriage return that
 * arrives in the same chunk as the bracketed paste, so a combined write lands
 * the text in the box but never submits it (the turn then hangs forever and the
 * next prompt is rejected with "already has an active turn").
 */
function submitViaBracketedPaste(context: ClaudePtySessionContext, value: string): void {
  context.pty.write(BRACKETED_PASTE_START);
  for (let i = 0; i < value.length; i += PASTE_CHUNK_CHARS) {
    context.pty.write(value.slice(i, i + PASTE_CHUNK_CHARS));
  }
  context.pty.write(BRACKETED_PASTE_END);
  setTimeout(() => {
    if (context.stopped) return;
    context.pty.write("\r");
  }, PROMPT_SUBMIT_DELAY_MS);
}

function plainInput(value: string): string {
  return `${value}\r`;
}

export function claudePtyOutputLooksInputReady(value: string): boolean {
  const compact = stripAnsiEscapes(value)
    .replace(/ /g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s+/g, "")
    .toLowerCase();
  return (
    compact.includes("❯") &&
    (compact.includes("shift+tabtocycle") ||
      compact.includes("/effort") ||
      compact.includes("bypasspermissions"))
  );
}

// Phrases Claude's interactive workspace-trust dialog shows for an untrusted
// directory. The affirmative option ("Yes, proceed") is the highlighted default,
// so a plain Enter accepts it. Print mode (-p) skips this prompt, but the PTY
// drives the interactive TUI, so a fresh launch in a new folder blocks here.
const CLAUDE_TRUST_PROMPT_TRIGGERS = [
  "doyoutrustthefilesinthisfolder",
  "doyoutrustthefiles",
  "isthisaprojectyou",
  "quicksafetycheck",
] as const;

export function claudePtyOutputLooksTrustPrompt(value: string): boolean {
  const compact = stripAnsiEscapes(value).replace(/\s+/g, "").toLowerCase();
  return CLAUDE_TRUST_PROMPT_TRIGGERS.some((trigger) => compact.includes(trigger));
}

function clearTurnTimers(turn: ActiveTurnState): void {
  if (turn.idleTimer) clearTimeout(turn.idleTimer);
  if (turn.noOutputTimer) clearTimeout(turn.noOutputTimer);
  if (turn.hardTimeoutTimer) clearTimeout(turn.hardTimeoutTimer);
  turn.idleTimer = undefined;
  turn.noOutputTimer = undefined;
  turn.hardTimeoutTimer = undefined;
}

function notePtyData(context: ClaudePtySessionContext, data: string): void {
  if (context.stopped) return;
  if (data.length > 0) context.lastDataAtMs = Date.now();
  if (!context.inputReady) {
    context.inputReadyOutput = `${context.inputReadyOutput}${data}`.slice(
      -INPUT_READY_OUTPUT_MAX_CHARS,
    );
    if (!context.trustPromptHandled && claudePtyOutputLooksTrustPrompt(context.inputReadyOutput)) {
      // Accept the trust dialog (Enter selects the default "Yes, proceed"), then
      // wait for the real prompt: drop the dialog so input-ready re-detects on the
      // post-accept TUI and push the readiness fallback out so a turn does not
      // fire into the loading screen.
      context.trustPromptHandled = true;
      context.inputReadyOutput = "";
      context.inputReadyAtMs = Date.now() + INPUT_READY_DELAY_MS;
      context.pty.write("\r");
      return;
    }
    if (claudePtyOutputLooksInputReady(context.inputReadyOutput)) {
      context.inputReady = true;
      for (const resolve of context.inputReadyResolvers) resolve();
      context.inputReadyResolvers.clear();
    }
  }
  const activeTurn = context.activeTurn;
  if (activeTurn && !activeTurn.completed && data.length > 0) activeTurn.sawOutput = true;
}

function claudeProjectDirectoryName(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

function claudeTranscriptPath(cwd: string, sessionId: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    claudeProjectDirectoryName(cwd),
    `${sessionId}.jsonl`,
  );
}

async function findLocalClaudeTranscript(sessionId: string): Promise<string | undefined> {
  const projectsDir = join(homedir(), ".claude", "projects");
  const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projectsDir, entry.name, `${sessionId}.jsonl`);
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Keep scanning; Claude can store by cwd, and cwd can differ from T3's project path.
    }
  }
  return undefined;
}

function waitForInputReady(context: ClaudePtySessionContext): Promise<void> {
  if (context.inputReady) return Promise.resolve();
  const delayMs = context.inputReadyAtMs - Date.now();
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const resolveReady = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      context.inputReadyResolvers.delete(resolveReady);
      resolve();
    }, delayMs);
    context.inputReadyResolvers.add(resolveReady);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve once the PTY has emitted no output for `quietMs`, or `maxWaitMs`
 * elapses. Used to let Claude's startup banner finish rendering before we paste a
 * prompt, so the submit Enter is not dropped mid-render.
 */
async function waitForQuiet(
  context: ClaudePtySessionContext,
  quietMs: number,
  maxWaitMs: number,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (!context.stopped && Date.now() < deadline) {
    const sinceData = Date.now() - context.lastDataAtMs;
    if (sinceData >= quietMs) return;
    await sleep(Math.min(quietMs - sinceData, 50));
  }
}

// Markers Claude Code sets in the environment so a `claude` it spawns knows it is
// nested (a child/subagent session). We spawn a real top-level session, so strip
// them. `CLAUDE_CODE_CHILD_SESSION` in particular makes the spawned CLI run as a
// child that never persists a conversation transcript, which the adapter relies
// on to detect turn completion; `CLAUDECODE` degrades the TUI. These are only
// present when the server itself was launched from inside Claude Code (e.g. the
// live smoke test); the desktop app spawns from Electron, where they are absent.
function isClaudeNestingEnvKey(key: string): boolean {
  return /^CLAUDE_CODE_/i.test(key) || key === "CLAUDECODE" || key === "AI_AGENT";
}

/**
 * Environment for the spawned Claude PTY: inherit the user's shell/auth context,
 * present a faithful interactive terminal, and drop the "I am nested in Claude
 * Code" markers so the child renders its true top-level TUI and persists a
 * transcript.
 */
function claudePtyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    COLUMNS: String(DEFAULT_COLS),
    LINES: String(DEFAULT_ROWS),
  };
  for (const key of Object.keys(env)) {
    if (isClaudeNestingEnvKey(key)) delete env[key];
  }
  return env;
}

interface ClaudeTranscriptAssistantTextEvent {
  readonly kind: "assistant_text";
  readonly key: string;
  readonly uuid: string;
  readonly text: string;
  readonly stopReason: string | undefined;
}

interface ClaudeTranscriptToolUseEvent {
  readonly kind: "tool_use";
  readonly key: string;
  readonly uuid: string;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: unknown;
}

interface ClaudeTranscriptToolResultEvent {
  readonly kind: "tool_result";
  readonly key: string;
  readonly uuid: string;
  readonly toolUseId: string;
  readonly content: unknown;
  readonly isError: boolean;
  readonly toolUseResult: unknown;
}

type ClaudeTranscriptEvent =
  | ClaudeTranscriptAssistantTextEvent
  | ClaudeTranscriptToolUseEvent
  | ClaudeTranscriptToolResultEvent;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function classifyClaudeToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent") || normalized.includes("subagent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

function titleForClaudeTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Tool";
  }
}

function summarizeClaudeToolRequest(toolName: string, input: unknown): string | undefined {
  const inputRecord = asRecord(input);
  const commandValue = inputRecord?.command ?? inputRecord?.cmd;
  if (typeof commandValue === "string" && commandValue.trim().length > 0) {
    return `${toolName}: ${commandValue.trim().slice(0, 400)}`;
  }
  const serialized = JSON.stringify(input);
  if (!serialized) return toolName;
  return serialized.length <= 400
    ? `${toolName}: ${serialized}`
    : `${toolName}: ${serialized.slice(0, 397)}...`;
}

function summarizeClaudeToolResult(content: unknown): string | undefined {
  if (typeof content === "string") return content.slice(0, 2_000);
  if (Array.isArray(content)) {
    const text = content
      .flatMap((entry) => {
        const record = asRecord(entry);
        return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
      })
      .join("\n");
    if (text.trim().length > 0) return text.slice(0, 2_000);
  }
  const serialized = JSON.stringify(content);
  return serialized ? serialized.slice(0, 2_000) : undefined;
}

function extractClaudeTranscriptEvents(record: unknown): ReadonlyArray<ClaudeTranscriptEvent> {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  const entry = record as Record<string, unknown>;
  if (typeof entry.uuid !== "string") return [];
  const uuid = entry.uuid;
  const message = entry.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  if (entry.type === "assistant") {
    const stopReason =
      typeof (message as { stop_reason?: unknown }).stop_reason === "string"
        ? (message as { stop_reason: string }).stop_reason
        : undefined;
    return content.flatMap((block, index): ClaudeTranscriptEvent[] => {
      const typed = asRecord(block);
      if (!typed) return [];
      if (typed.type === "text" && typeof typed.text === "string" && typed.text.length > 0) {
        return [
          {
            kind: "assistant_text",
            key: `${uuid}:text:${index}`,
            uuid,
            text: typed.text,
            stopReason,
          },
        ];
      }
      if (
        typed.type === "tool_use" &&
        typeof typed.id === "string" &&
        typeof typed.name === "string"
      ) {
        return [
          {
            kind: "tool_use",
            key: `${uuid}:tool:${typed.id}`,
            uuid,
            toolUseId: typed.id,
            toolName: typed.name,
            input: typed.input,
          },
        ];
      }
      return [];
    });
  }

  if (entry.type === "user") {
    return content.flatMap((block, index): ClaudeTranscriptEvent[] => {
      const typed = asRecord(block);
      if (!typed || typed.type !== "tool_result" || typeof typed.tool_use_id !== "string") {
        return [];
      }
      return [
        {
          kind: "tool_result",
          key: `${uuid}:result:${typed.tool_use_id}:${index}`,
          uuid,
          toolUseId: typed.tool_use_id,
          content: typed.content,
          isError: typed.is_error === true,
          toolUseResult: entry.toolUseResult,
        },
      ];
    });
  }

  return [];
}

function transcriptRecordContainsUserPrompt(record: unknown, prompt: string): boolean {
  const entry = asRecord(record);
  if (!entry) return false;
  if (entry.type === "last-prompt" && entry.lastPrompt === prompt) return true;
  if (entry.type !== "user") return false;
  const message = asRecord(entry.message);
  if (!message) return false;
  const content = message.content;
  if (typeof content === "string") return content === prompt;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block === "string") return block === prompt;
    const typed = asRecord(block);
    return typed?.type === "text" && typed.text === prompt;
  });
}

function claudeTranscriptContainsUserPrompt(jsonl: string, prompt: string): boolean {
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      if (transcriptRecordContainsUserPrompt(JSON.parse(trimmed) as unknown, prompt)) {
        return true;
      }
    } catch {
      // Claude can append while we read; ignore partial trailing JSON.
    }
  }
  return false;
}

export function parseClaudeTranscriptEvents(jsonl: string): ReadonlyArray<ClaudeTranscriptEvent> {
  const events: ClaudeTranscriptEvent[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      events.push(...extractClaudeTranscriptEvents(parsed));
    } catch {
      // Claude can append while we read; ignore partial trailing JSON.
    }
  }
  return events;
}

export function parseClaudeTranscriptAssistantMessages(
  jsonl: string,
): ReadonlyArray<{ readonly uuid: string; readonly text: string }> {
  const grouped = new Map<string, string>();
  for (const event of parseClaudeTranscriptEvents(jsonl)) {
    if (event.kind !== "assistant_text") continue;
    grouped.set(event.uuid, `${grouped.get(event.uuid) ?? ""}${event.text}`);
  }
  return Array.from(grouped, ([uuid, text]) => ({ uuid, text }));
}

export const makeClaudePtyAdapter = Effect.fn("makeClaudePtyAdapter")(function* (
  config: ClaudePtySettings,
) {
  const ptyAdapter = yield* PtyAdapter;
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const runtimeContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(runtimeContext);
  const sessions = new Map<ThreadId, ClaudePtySessionContext>();
  // node-pty doesn't search PATH for a bare command on Windows, so resolve the
  // configured binary to a full path up front (e.g. `claude` -> the real
  // `claude.exe`). Resolved once per instance since the config is fixed.
  const resolvedBinaryPath = resolveExecutablePath(config.binaryPath);

  const offerEvent = (event: ProviderRuntimeEvent) => {
    runFork(Queue.offer(events, event));
  };

  const resolveLocalClaudeTranscriptPath = async (
    context: ClaudePtySessionContext,
  ): Promise<string | undefined> => {
    const exactPath = claudeTranscriptPath(context.cwd, context.sessionId);
    try {
      await readFile(exactPath, "utf8");
      return exactPath;
    } catch {
      return await findLocalClaudeTranscript(context.sessionId);
    }
  };

  const readClaudeTranscript = async (context: ClaudePtySessionContext): Promise<string> => {
    const path = await resolveLocalClaudeTranscriptPath(context);
    if (!path) return "";
    return await readFile(path, "utf8").catch(() => "");
  };

  const waitForPromptAcknowledged = async (
    context: ClaudePtySessionContext,
    prompt: string,
    activeTurn: ActiveTurnState,
  ): Promise<boolean> => {
    const deadline = Date.now() + INPUT_ACK_TIMEOUT_MS;
    while (
      Date.now() < deadline &&
      !context.stopped &&
      context.activeTurn === activeTurn &&
      !activeTurn.completed
    ) {
      try {
        const transcript = await readClaudeTranscript(context);
        if (claudeTranscriptContainsUserPrompt(transcript, prompt)) {
          return true;
        }
      } catch {
        // The transcript file can be absent briefly on brand-new sessions.
      }
      await sleep(INPUT_ACK_POLL_MS);
    }
    return false;
  };

  const retryPromptWithPlainInputIfNeeded = async (
    context: ClaudePtySessionContext,
    activeTurn: ActiveTurnState,
    prompt: string,
  ): Promise<void> => {
    if (await waitForPromptAcknowledged(context, prompt, activeTurn)) return;
    if (context.stopped || context.activeTurn !== activeTurn || activeTurn.completed) return;
    context.pty.write(plainInput(prompt));
  };

  const writePromptToPty = (
    context: ClaudePtySessionContext,
    activeTurn: ActiveTurnState,
    prompt: string,
  ): void => {
    submitViaBracketedPaste(context, prompt);
    void retryPromptWithPlainInputIfNeeded(context, activeTurn, prompt);
  };

  const completeTurn = (context: ClaudePtySessionContext, reason: "idle" | "hard-timeout") => {
    const activeTurn = context.activeTurn;
    if (!activeTurn || activeTurn.completed) return;
    activeTurn.completed = true;
    clearTurnTimers(activeTurn);
    const completedAt = nowIso();
    offerEvent({
      type: "item.completed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: completedAt,
      threadId: context.session.threadId,
      turnId: activeTurn.turnId,
      itemId: activeTurn.itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        ...(activeTurn.outputText.length > 0 ? { detail: activeTurn.outputText } : {}),
      },
    });
    offerEvent({
      type: "turn.completed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: completedAt,
      threadId: context.session.threadId,
      turnId: activeTurn.turnId,
      payload: {
        state: reason === "hard-timeout" ? "failed" : "completed",
        ...(reason === "hard-timeout" ? { errorMessage: "Claude PTY turn timed out." } : {}),
      },
    });
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: completedAt,
      resumeCursor: claudePtyResumeCursor(context.sessionId),
    };
    context.activeTurn = undefined;
    offerEvent({
      type: "session.state.changed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: completedAt,
      threadId: context.session.threadId,
      payload: {
        state: "ready",
        ...(reason === "hard-timeout" ? { reason: "turn-timeout" } : {}),
      },
    });
  };

  const scheduleIdleCompletion = (context: ClaudePtySessionContext) => {
    const activeTurn = context.activeTurn;
    if (!activeTurn || activeTurn.completed) return;
    if (activeTurn.idleTimer) clearTimeout(activeTurn.idleTimer);
    activeTurn.idleTimer = setTimeout(() => completeTurn(context, "idle"), TURN_IDLE_COMPLETE_MS);
  };

  const emitTranscriptMessageForTurn = (
    context: ClaudePtySessionContext,
    activeTurn: ActiveTurnState,
    text: string,
    options: { readonly complete: boolean } = { complete: true },
  ) => {
    activeTurn.outputText =
      activeTurn.outputText.length > 0 ? `${activeTurn.outputText}\n${text}` : text;
    activeTurn.sawOutput = true;
    for (const delta of chunkPtyDelta(text)) {
      offerEvent({
        type: "content.delta",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: nowIso(),
        threadId: context.session.threadId,
        turnId: activeTurn.turnId,
        itemId: activeTurn.itemId,
        payload: {
          streamKind: "assistant_text",
          delta,
        },
      });
      activeTurn.emittedLength += delta.length;
    }
    if (options.complete) scheduleIdleCompletion(context);
  };

  const processTranscriptEventForTurn = (
    context: ClaudePtySessionContext,
    activeTurn: ActiveTurnState,
    event: ClaudeTranscriptEvent,
  ): boolean => {
    if (activeTurn.seenTranscriptKeys.has(event.key)) return false;
    activeTurn.seenTranscriptKeys.add(event.key);

    if (event.kind === "assistant_text") {
      emitTranscriptMessageForTurn(context, activeTurn, event.text, {
        complete: event.stopReason !== "tool_use",
      });
      return event.stopReason !== "tool_use";
    }

    if (event.kind === "tool_use") {
      const itemType = classifyClaudeToolItemType(event.toolName);
      const title = titleForClaudeTool(itemType);
      const detail = summarizeClaudeToolRequest(event.toolName, event.input);
      activeTurn.sawOutput = true;
      activeTurn.toolItems.set(event.toolUseId, {
        itemType,
        title,
        toolName: event.toolName,
        input: event.input,
        detail,
      });
      offerEvent({
        type: "item.started",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: nowIso(),
        threadId: context.session.threadId,
        turnId: activeTurn.turnId,
        itemId: RuntimeItemId.make(event.toolUseId),
        payload: {
          itemType,
          status: "inProgress",
          title,
          ...(detail ? { detail } : {}),
          data: {
            toolName: event.toolName,
            input: event.input,
          },
        },
      });
      return false;
    }

    const tool = activeTurn.toolItems.get(event.toolUseId);
    const itemType = tool?.itemType ?? "dynamic_tool_call";
    const title = tool?.title ?? titleForClaudeTool(itemType);
    const detail = summarizeClaudeToolResult(event.content);
    activeTurn.sawOutput = true;
    activeTurn.toolItems.delete(event.toolUseId);
    offerEvent({
      type: "item.completed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: nowIso(),
      threadId: context.session.threadId,
      turnId: activeTurn.turnId,
      itemId: RuntimeItemId.make(event.toolUseId),
      payload: {
        itemType,
        status: event.isError ? "failed" : "completed",
        title,
        ...(detail ? { detail } : {}),
        data: {
          toolUseId: event.toolUseId,
          ...(tool ? { toolName: tool.toolName, input: tool.input } : {}),
          content: event.content,
          toolUseResult: event.toolUseResult,
        },
      },
    });
    return false;
  };

  const pollTranscriptForTurn = async (
    context: ClaudePtySessionContext,
    activeTurn: ActiveTurnState,
  ) => {
    while (!context.stopped && context.activeTurn === activeTurn && !activeTurn.completed) {
      try {
        const transcript = await readClaudeTranscript(context);
        let shouldStopPolling = false;
        for (const event of parseClaudeTranscriptEvents(transcript)) {
          if (activeTurn.baselineKeys.has(event.key)) continue;
          if (processTranscriptEventForTurn(context, activeTurn, event)) {
            shouldStopPolling = true;
          }
        }
        if (shouldStopPolling) {
          return;
        }
      } catch {
        // The transcript file may not exist until Claude records the first turn.
      }
      await sleep(TRANSCRIPT_POLL_MS);
    }
  };

  const failActiveTurn = (context: ClaudePtySessionContext, message: string) => {
    const activeTurn = context.activeTurn;
    if (!activeTurn || activeTurn.completed) return;
    activeTurn.completed = true;
    clearTurnTimers(activeTurn);
    const failedAt = nowIso();
    offerEvent({
      type: "turn.completed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: failedAt,
      threadId: context.session.threadId,
      turnId: activeTurn.turnId,
      payload: {
        state: "failed",
        errorMessage: message,
      },
    });
    context.activeTurn = undefined;
  };

  const markExited = (context: ClaudePtySessionContext, detail: string) => {
    if (context.stopped) return;
    context.stopped = true;
    failActiveTurn(context, detail);
    const exitedAt = nowIso();
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt: exitedAt,
      lastError: detail,
    };
    offerEvent({
      type: "runtime.error",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: exitedAt,
      threadId: context.session.threadId,
      payload: {
        message: detail,
        class: "transport_error",
      },
    });
    offerEvent({
      type: "session.exited",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: exitedAt,
      threadId: context.session.threadId,
      payload: {
        reason: detail,
        recoverable: true,
        exitKind: "error",
      },
    });
  };

  const ensureContext = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    if (!context) {
      throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    }
    if (context.stopped) {
      throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
    }
    return context;
  };

  const restartContextWithPermissionMode = Effect.fn("restartClaudePtyWithPermissionMode")(
    function* (
      context: ClaudePtySessionContext,
      input: {
        readonly modelSelection: ProviderSendTurnInput["modelSelection"];
        readonly permissionMode: ClaudePtyPermissionMode;
      },
    ) {
      const modelSelection = input.modelSelection;
      const model = modelSelection?.model ?? context.session.model;
      // resolveClaudePtyCliEffort returns undefined when no selection is given;
      // fall back to the live effort so an effort-less turn does not look changed.
      const effort = modelSelection
        ? resolveClaudePtyCliEffort(modelSelection, model)
        : context.currentEffort;
      // The PTY is a long-lived interactive process, so keep it alive across
      // turns and only relaunch (with --resume) when the launch config actually
      // changes. Guarding on permission mode alone dropped model/effort switches
      // made from the chat UI, leaving Claude on the model it first started with.
      if (
        context.currentPermissionMode === input.permissionMode &&
        model === context.session.model &&
        effort === context.currentEffort
      ) {
        return;
      }
      const args = buildClaudeArgs({
        model,
        effort,
        runtimeMode: context.session.runtimeMode,
        permissionMode: input.permissionMode,
        sessionId: context.sessionId,
        resume: true,
        threadId: context.session.threadId,
      });
      const launch = buildClaudePtyLaunch({
        binaryPath: resolvedBinaryPath,
        cwd: context.session.cwd,
        args,
      });

      context.removeDataListener();
      context.removeExitListener();
      context.pty.write("/exit\r");
      yield* Effect.sync(() => {
        try {
          context.pty.kill();
        } catch {
          // Best effort cleanup before replacing the PTY process.
        }
      });

      const pty = yield* ptyAdapter
        .spawn({
          shell: launch.shell,
          args: [...launch.args],
          cwd: launch.cwd,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          env: claudePtyEnv(),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: context.session.threadId,
                detail: error.message,
                cause: error,
              }),
          ),
        );

      context.pty = pty;
      context.currentPermissionMode = input.permissionMode;
      context.currentEffort = effort;
      context.inputReady = false;
      context.inputReadyOutput = "";
      context.trustPromptHandled = false;
      context.lastDataAtMs = Date.now();
      context.inputReadyAtMs = Date.now() + RESUME_INPUT_READY_FALLBACK_MS;
      context.removeDataListener = pty.onData((data) => notePtyData(context, data));
      context.removeExitListener = pty.onExit((event) =>
        markExited(
          context,
          `Claude PTY process exited (code=${event.exitCode}, signal=${event.signal}).`,
        ),
      );
      context.session = {
        ...context.session,
        ...(model ? { model } : {}),
        updatedAt: nowIso(),
        resumeCursor: claudePtyResumeCursor(context.sessionId),
      };

      offerEvent({
        type: "session.configured",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: context.session.updatedAt,
        threadId: context.session.threadId,
        payload: {
          config: {
            mode: "interactive-pty",
            shell: launch.shell,
            args: launch.args,
            permissionMode: input.permissionMode,
          },
        },
      });
    },
  );

  const startSession: ClaudePtyAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        existing.pty.write("/exit\r");
        existing.pty.kill();
        existing.removeDataListener();
        existing.removeExitListener();
        sessions.delete(input.threadId);
      }

      const resumeState = readResumeState(input.resumeCursor);
      const sessionId = resumeState?.sessionId ?? randomUUID();
      const isResuming = resumeState?.sessionId !== undefined;
      const modelSelection = input.modelSelection;
      const effort = resolveClaudePtyCliEffort(modelSelection, modelSelection?.model);
      const args = buildClaudeArgs({
        model: modelSelection?.model,
        effort,
        runtimeMode: input.runtimeMode,
        permissionMode: runtimePermissionMode(input),
        sessionId,
        resume: isResuming,
        threadId: input.threadId,
      });
      const launch = buildClaudePtyLaunch({
        binaryPath: resolvedBinaryPath,
        cwd: input.cwd,
        args,
      });

      const pty = yield* ptyAdapter
        .spawn({
          shell: launch.shell,
          args: [...launch.args],
          cwd: launch.cwd,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          env: claudePtyEnv(),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: error.message,
                cause: error,
              }),
          ),
        );

      const createdAt = nowIso();
      let context!: ClaudePtySessionContext;
      const removeDataListener = pty.onData((data) => notePtyData(context, data));
      const removeExitListener = pty.onExit((event) =>
        markExited(
          context,
          `Claude PTY process exited (code=${event.exitCode}, signal=${event.signal}).`,
        ),
      );
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        threadId: input.threadId,
        resumeCursor: claudePtyResumeCursor(sessionId),
        createdAt,
        updatedAt: createdAt,
      };
      context = {
        session,
        pty,
        sessionId,
        cwd: launch.cwd,
        inputReadyAtMs:
          Date.now() + (isResuming ? RESUME_INPUT_READY_FALLBACK_MS : INPUT_READY_DELAY_MS),
        inputReady: false,
        inputReadyOutput: "",
        trustPromptHandled: false,
        lastDataAtMs: Date.now(),
        inputReadyResolvers: new Set(),
        currentPermissionMode: runtimePermissionMode(input),
        currentEffort: effort,
        activeTurn: undefined,
        stopped: false,
        removeDataListener,
        removeExitListener,
      };
      sessions.set(input.threadId, context);

      offerEvent({
        type: "session.started",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt,
        threadId: input.threadId,
        payload: {
          message: "Claude PTY session started.",
          resume: claudePtyResumeCursor(sessionId),
        },
      });
      offerEvent({
        type: "session.configured",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt,
        threadId: input.threadId,
        payload: {
          config: {
            mode: "interactive-pty",
            shell: launch.shell,
            args: launch.args,
            permissionMode: runtimePermissionMode(input),
          },
        },
      });
      offerEvent({
        type: "session.state.changed",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt,
        threadId: input.threadId,
        payload: { state: "ready" },
      });

      return session;
    },
  );

  const sendTurn: ClaudePtyAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* Effect.try({
      try: () => ensureContext(input.threadId),
      catch: (cause) => cause as ProviderAdapterError,
    });
    if (context.activeTurn && !context.activeTurn.completed) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: "Claude PTY already has an active turn.",
      });
    }
    const text = input.input?.trim();
    if (!text) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Claude PTY requires non-empty text input.",
      });
    }
    const permissionMode = turnPermissionMode({
      runtimeMode: context.session.runtimeMode,
      interactionMode: input.interactionMode,
    });
    yield* restartContextWithPermissionMode(context, {
      modelSelection: input.modelSelection,
      permissionMode,
    });

    const startedAt = nowIso();
    const nextTurnId = turnId();
    const nextItemId = itemId();
    const baselineTranscript = yield* Effect.promise(() =>
      readClaudeTranscript(context).catch(() => ""),
    );
    const baselineKeys = new Set(parseClaudeTranscriptEvents(baselineTranscript).map((e) => e.key));
    const modelSelection = input.modelSelection;
    const rawEffort = rawEffortFromSelection(modelSelection);
    const activeTurn: ActiveTurnState = {
      turnId: nextTurnId,
      startedAt,
      itemId: nextItemId,
      emittedLength: 0,
      outputText: "",
      baselineKeys,
      seenTranscriptKeys: new Set(),
      toolItems: new Map(),
      sawOutput: false,
      completed: false,
      idleTimer: undefined,
      noOutputTimer: undefined,
      hardTimeoutTimer: undefined,
    };
    context.activeTurn = activeTurn;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: nextTurnId,
      updatedAt: startedAt,
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
    };
    offerEvent({
      type: "turn.started",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: startedAt,
      threadId: input.threadId,
      turnId: nextTurnId,
      payload: {
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        ...(rawEffort ? { effort: rawEffort } : {}),
      },
    });
    offerEvent({
      type: "session.state.changed",
      eventId: eventId(),
      provider: PROVIDER,
      createdAt: startedAt,
      threadId: input.threadId,
      payload: { state: "running" },
    });

    activeTurn.noOutputTimer = setTimeout(() => {
      if (activeTurn.completed || activeTurn.sawOutput) return;
      offerEvent({
        type: "runtime.warning",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: nowIso(),
        threadId: input.threadId,
        turnId: nextTurnId,
        payload: {
          message: "Claude PTY has not produced output yet.",
        },
      });
    }, TURN_NO_OUTPUT_WARNING_MS);
    activeTurn.hardTimeoutTimer = setTimeout(
      () => completeTurn(context, "hard-timeout"),
      TURN_HARD_TIMEOUT_MS,
    );
    void pollTranscriptForTurn(context, activeTurn);

    yield* Effect.promise(() => waitForInputReady(context));
    if (context.inputReady) {
      yield* Effect.promise(() =>
        waitForQuiet(context, INPUT_READY_QUIET_MS, INPUT_READY_QUIET_MAX_WAIT_MS),
      );
    }
    if (activeTurn.completed || context.activeTurn !== activeTurn || context.stopped) {
      return {
        threadId: input.threadId,
        turnId: nextTurnId,
        resumeCursor: claudePtyResumeCursor(context.sessionId),
      } satisfies ProviderTurnStartResult;
    }
    writePromptToPty(context, activeTurn, text);
    if (input.attachments && input.attachments.length > 0) {
      offerEvent({
        type: "runtime.warning",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: nowIso(),
        threadId: input.threadId,
        turnId: nextTurnId,
        payload: {
          message: "Claude PTY does not support T3 attachments yet.",
          detail: { attachmentCount: input.attachments.length },
        },
      });
    }

    return {
      threadId: input.threadId,
      turnId: nextTurnId,
      resumeCursor: claudePtyResumeCursor(context.sessionId),
    } satisfies ProviderTurnStartResult;
  });

  const interruptTurn: ClaudePtyAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const context = yield* Effect.try({
        try: () => ensureContext(threadId),
        catch: (cause) => cause as ProviderAdapterError,
      });
      context.pty.write("\x03");
      const activeTurn = context.activeTurn;
      if (activeTurn && !activeTurn.completed) {
        activeTurn.completed = true;
        clearTurnTimers(activeTurn);
        const interruptedAt = nowIso();
        offerEvent({
          type: "turn.completed",
          eventId: eventId(),
          provider: PROVIDER,
          createdAt: interruptedAt,
          threadId,
          turnId: activeTurn.turnId,
          payload: { state: "interrupted", stopReason: "interrupt" },
        });
        context.activeTurn = undefined;
      }
    },
  );

  const respondToRequest: ClaudePtyAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, _requestId, decision: ProviderApprovalDecision) {
      const context = yield* Effect.try({
        try: () => ensureContext(threadId),
        catch: (cause) => cause as ProviderAdapterError,
      });
      context.pty.write(decision === "accept" || decision === "acceptForSession" ? "y\r" : "n\r");
    },
  );

  const respondToUserInput: ClaudePtyAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, _requestId, answers: ProviderUserInputAnswers) {
    const context = yield* Effect.try({
      try: () => ensureContext(threadId),
      catch: (cause) => cause as ProviderAdapterError,
    });
    const answerText = bestEffortAnswerText(answers);
    if (answerText.length > 0) {
      submitViaBracketedPaste(context, answerText);
    }
  });

  const stopSession: ClaudePtyAdapterShape["stopSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      if (!context || context.stopped) return;
      context.stopped = true;
      if (context.activeTurn) {
        clearTurnTimers(context.activeTurn);
        context.activeTurn = undefined;
      }
      context.pty.write("/exit\r");
      setTimeout(() => {
        try {
          context.pty.kill();
        } catch {
          // Best effort cleanup.
        }
      }, 2_000);
      context.removeDataListener();
      context.removeExitListener();
      sessions.delete(threadId);
      const stoppedAt = nowIso();
      offerEvent({
        type: "session.state.changed",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: stoppedAt,
        threadId,
        payload: { state: "stopped" },
      });
      offerEvent({
        type: "session.exited",
        eventId: eventId(),
        provider: PROVIDER,
        createdAt: stoppedAt,
        threadId,
        payload: {
          reason: "Claude PTY session stopped.",
          recoverable: true,
          exitKind: "graceful",
        },
      });
    });

  const readThread: ClaudePtyAdapterShape["readThread"] = (threadId) =>
    Effect.succeed({ threadId, turns: [] });

  const rollbackThread: ClaudePtyAdapterShape["rollbackThread"] = (threadId) =>
    Effect.succeed({ threadId, turns: [] });

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () =>
      Effect.succeed(Array.from(sessions.values()).map((context) => context.session)),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread,
    rollbackThread,
    stopAll: () =>
      Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
        discard: true,
      }),
    streamEvents: Stream.fromQueue(events),
  } satisfies ClaudePtyAdapterShape;
});
