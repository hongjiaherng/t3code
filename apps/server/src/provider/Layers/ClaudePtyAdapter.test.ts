import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  type ClaudePtySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  PtyAdapter,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
} from "../../terminal/Services/PTY.ts";
import {
  buildClaudeArgs,
  buildClaudePtyLaunch,
  claudePtyOutputLooksInputReady,
  claudePtyOutputLooksTrustPrompt,
  makeClaudePtyAdapter,
  parseClaudeTranscriptAssistantMessages,
  parseClaudeTranscriptEvents,
} from "./ClaudePtyAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const CLAUDE_PTY = ProviderDriverKind.make("claudePty");
const PTY_CONFIG: ClaudePtySettings = { enabled: true, binaryPath: "claude", customModels: [] };

class FakePtyProcess implements PtyProcess {
  readonly pid = 1234;
  readonly writes: string[] = [];
  readonly kills: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {
    // The PTY provider does not resize PTYs.
  }

  kill(signal?: string): void {
    this.kills.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

function makeHarness() {
  const spawned: PtySpawnInput[] = [];
  const processes: FakePtyProcess[] = [];
  const ptyLayer = Layer.succeed(PtyAdapter, {
    spawn: (input) =>
      Effect.sync(() => {
        spawned.push(input);
        const process = new FakePtyProcess();
        processes.push(process);
        return process;
      }),
  });
  return { ptyLayer, spawned, processes };
}

it("builds local launch args for a fresh session", () => {
  const args = buildClaudeArgs({
    model: "claude-sonnet-4-6",
    effort: "high",
    runtimeMode: "full-access",
    sessionId: "session-1",
    resume: false,
    threadId: asThreadId("thread-abcdef"),
  });

  assert.deepEqual(args, [
    "--session-id",
    "session-1",
    "--name",
    "T3 thread-a",
    "--model",
    "claude-sonnet-4-6",
    "--effort",
    "high",
    "--permission-mode",
    "bypassPermissions",
  ]);
  // --permission-mode bypassPermissions enables bypass on its own. Adding
  // --dangerously-skip-permissions makes the interactive TUI show an accept/exit
  // dialog on every launch whose default is "No, exit", so a stray Enter kills
  // Claude; the PTY must never pass it.
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  // The PTY drives the interactive TUI; it must never run in print mode.
  assert.equal(args.includes("-p"), false);
  assert.equal(args.includes("--print"), false);
  assert.equal(args.includes("--output-format"), false);
});

it("builds resume launch args for persisted PTY sessions", () => {
  const args = buildClaudeArgs({
    model: "claude-sonnet-4-6",
    effort: undefined,
    runtimeMode: "full-access",
    sessionId: "session-1",
    resume: true,
    threadId: asThreadId("thread-abcdef"),
  });

  assert.equal(args[0], "--resume");
  assert.equal(args[1], "session-1");
  assert.equal(args.includes("--session-id"), false);
});

it("builds plan permission launch args without skipping permissions", () => {
  const args = buildClaudeArgs({
    model: "claude-sonnet-4-6",
    effort: undefined,
    runtimeMode: "full-access",
    permissionMode: "plan",
    sessionId: "session-1",
    resume: true,
    threadId: asThreadId("thread-abcdef"),
  });

  assert.deepEqual(args.slice(-2), ["--permission-mode", "plan"]);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

it("builds a local launch from the configured binary", () => {
  const launch = buildClaudePtyLaunch({
    binaryPath: "claude",
    cwd: "/repo",
    args: ["--session-id", "session-1", "--model", "claude-sonnet-4-6"],
  });

  assert.equal(launch.shell, "claude");
  assert.equal(launch.cwd, "/repo");
  assert.deepEqual(launch.args, ["--session-id", "session-1", "--model", "claude-sonnet-4-6"]);
});

it("detects Claude TUI input readiness from terminal output", () => {
  assert.equal(
    claudePtyOutputLooksInputReady(
      [
        "╭─── Claude Code v2.1.141 ───╮",
        "❯ ",
        "⏵⏵ bypass permissions on (shift+tab to cycle) ● high · /effort",
      ].join("\n"),
    ),
    true,
  );
  assert.equal(claudePtyOutputLooksInputReady("Welcome back! Conversation compacted"), false);
});

it("does not read Claude's loading banner as input readiness", () => {
  // The steady-state prompt with the bypass footer is ready.
  const ready = "❯ \n⏵⏵ bypass permissions on (shift+tab to cycle) · /effort";
  assert.equal(claudePtyOutputLooksInputReady(ready), true);

  // The startup spinner has no prompt caret and must not read as ready, or a
  // turn would fire into the loading screen.
  assert.equal(claudePtyOutputLooksInputReady("✻ Booting… (esc to interrupt)"), false);
});

it("detects Claude's workspace-trust dialog for a new folder", () => {
  const trust = [
    "╭─────────────────────────────────────────╮",
    "│ Do you trust the files in this folder?    │",
    "│ /some/new/project                         │",
    "│ ❯ 1. Yes, proceed                         │",
    "│   2. No, exit                             │",
    "╰─────────────────────────────────────────╯",
  ].join("\n");
  assert.equal(claudePtyOutputLooksTrustPrompt(trust), true);

  // The steady-state input prompt is not a trust dialog.
  const ready = "❯ \n⏵⏵ bypass permissions on (shift+tab to cycle) · /effort";
  assert.equal(claudePtyOutputLooksTrustPrompt(ready), false);
});

it("parses assistant text from Claude JSONL transcripts", () => {
  const messages = parseClaudeTranscriptAssistantMessages(
    [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "from disk" },
          ],
        },
      }),
      "{partial",
    ].join("\n"),
  );

  assert.deepEqual(messages, [{ uuid: "assistant-1", text: "hello from disk" }]);
});

it("parses Claude JSONL tool use and tool result events", () => {
  const events = parseClaudeTranscriptEvents(
    [
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-tool",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "I'll check." },
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Bash",
              input: { command: "git status --short" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "user-tool-result",
        toolUseResult: { stdout: "ok\n", stderr: "", interrupted: false },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "ok\n",
              is_error: false,
            },
          ],
        },
      }),
      "{partial",
    ].join("\n"),
  );

  assert.deepEqual(events, [
    {
      kind: "assistant_text",
      key: "assistant-tool:text:0",
      uuid: "assistant-tool",
      text: "I'll check.",
      stopReason: "tool_use",
    },
    {
      kind: "tool_use",
      key: "assistant-tool:tool:toolu_123",
      uuid: "assistant-tool",
      toolUseId: "toolu_123",
      toolName: "Bash",
      input: { command: "git status --short" },
    },
    {
      kind: "tool_result",
      key: "user-tool-result:result:toolu_123:0",
      uuid: "user-tool-result",
      toolUseId: "toolu_123",
      content: "ok\n",
      isError: false,
      toolUseResult: { stdout: "ok\n", stderr: "", interrupted: false },
    },
  ]);
});

// it.live (real Clock): the adapter submits Enter via a real OS timer and
// waits for input quiescence in real time, so the test waits in real time too.
it.live("starts a session, spawns claude, and writes prompts via bracketed paste", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const adapter = yield* makeClaudePtyAdapter(PTY_CONFIG);

    const session = yield* adapter.startSession({
      threadId: asThreadId("thread-pty-start"),
      runtimeMode: "full-access",
      cwd: "/repo",
    });
    assert.equal(session.provider, CLAUDE_PTY);
    const spawned = harness.spawned[0];
    assert.ok(spawned);
    // makeClaudePtyAdapter resolves a bare "claude" to its absolute path when the
    // binary is on PATH (Windows node-pty does not search PATH), so accept either
    // the bare name or a resolved "…/claude[.exe]" path.
    assert.match(spawned.shell, /(^|[\\/])claude(\.exe)?$/i);
    assert.equal((spawned.args ?? []).includes("--print"), false);

    // Make the PTY look input-ready so sendTurn does not wait the full delay.
    harness.processes[0]?.emitData("❯ \n⏵⏵ bypass permissions on (shift+tab to cycle) /effort");

    const turnResult = yield* adapter.sendTurn({
      threadId: asThreadId("thread-pty-start"),
      input: "say hello",
      attachments: [],
      interactionMode: "default",
    });

    assert.equal(turnResult.threadId, "thread-pty-start");
    // The prompt is pasted (bracketed, chunked) without a trailing carriage
    // return; the last write so far must not submit.
    const writesAfterPaste = harness.processes[0]?.writes ?? [];
    assert.equal(writesAfterPaste.slice(-3).join(""), "\x1b[200~say hello\x1b[201~");
    assert.equal(writesAfterPaste.at(-1)?.includes("\r"), false);

    // Enter is a SEPARATE write sent after a short gap; a combined paste+Enter
    // lands the text in Claude's input box but never submits it.
    yield* Effect.sleep("250 millis");
    assert.equal(harness.processes[0]?.writes.at(-1), "\r");

    yield* adapter.interruptTurn(asThreadId("thread-pty-start"));
    yield* adapter.stopSession(asThreadId("thread-pty-start"));
  }).pipe(Effect.provide(harness.ptyLayer));
});

const INPUT_READY_BANNER = "❯ \n⏵⏵ bypass permissions on (shift+tab to cycle) /effort";

// Like FakePtyProcess, but reports input readiness shortly after a listener is
// attached so sendTurn does not block on the real readiness timeout. The emit is
// deferred a macrotask so the session context is assigned (startSession attaches
// the listener before the context exists), and is suppressed once disposed.
class AutoReadyPtyProcess extends FakePtyProcess {
  override onData(callback: (data: string) => void): () => void {
    const dispose = super.onData(callback);
    let active = true;
    // @effect-diagnostics-next-line globalTimers:off - the fake PTY simulates async terminal output, tied to no fiber.
    setTimeout(() => {
      if (active) callback(INPUT_READY_BANNER);
    }, 0);
    return () => {
      active = false;
      dispose();
    };
  }
}

function makeAutoReadyHarness() {
  const spawned: PtySpawnInput[] = [];
  const processes: AutoReadyPtyProcess[] = [];
  const ptyLayer = Layer.succeed(PtyAdapter, {
    spawn: (input) =>
      Effect.sync(() => {
        spawned.push(input);
        const process = new AutoReadyPtyProcess();
        processes.push(process);
        return process;
      }),
  });
  return { ptyLayer, spawned, processes };
}

const claudePtyModelSelection = (model: string) => ({
  instanceId: ProviderInstanceId.make("claudePty"),
  model,
});

it.effect("relaunches the Claude PTY with --resume when the model changes mid-session", () => {
  const harness = makeAutoReadyHarness();
  return Effect.gen(function* () {
    const adapter = yield* makeClaudePtyAdapter(PTY_CONFIG);
    const threadId = asThreadId("thread-model-switch");

    yield* adapter.startSession({
      threadId,
      runtimeMode: "full-access",
      cwd: "/repo",
      modelSelection: claudePtyModelSelection("claude-sonnet-4-6"),
    });
    assert.equal(harness.spawned.length, 1);
    assert.equal((harness.spawned[0]?.args ?? []).includes("claude-sonnet-4-6"), true);

    yield* adapter.sendTurn({
      threadId,
      input: "switch models",
      attachments: [],
      interactionMode: "default",
      modelSelection: claudePtyModelSelection("claude-opus-4-8"),
    });

    // The model changed, so the PTY must be relaunched with the new model and
    // --resume (so the conversation continues). Guarding on permission mode alone
    // used to drop this, leaving Claude on the model it first started with.
    assert.equal(harness.spawned.length, 2);
    const restartArgs = harness.spawned[1]?.args ?? [];
    assert.equal(restartArgs.includes("claude-opus-4-8"), true);
    assert.equal(restartArgs.includes("--resume"), true);
    assert.equal(restartArgs.includes("claude-sonnet-4-6"), false);

    yield* adapter.interruptTurn(threadId);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.provide(harness.ptyLayer));
});
