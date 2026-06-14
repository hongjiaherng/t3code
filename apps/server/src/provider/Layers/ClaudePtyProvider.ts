/**
 * ClaudePtyProvider - status snapshot for the experimental Claude PTY driver.
 *
 * The PTY provider drives the same `claude` binary as the Claude Agent SDK
 * provider, so it reuses Claude's built-in model list. The status probe is
 * deliberately lightweight: it only confirms the binary runs (`claude
 * --version`). Authentication is handled by Claude Code's interactive session
 * at runtime, so we report it as unknown rather than running a separate probe.
 *
 * @module ClaudePtyProvider
 */
import { type ClaudePtySettings, ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { CLAUDE_BUILT_IN_MODELS, DEFAULT_CLAUDE_MODEL_CAPABILITIES } from "./ClaudeProvider.ts";

const PROVIDER = ProviderDriverKind.make("claudePty");
const CLAUDE_PTY_PRESENTATION = {
  displayName: "Claude PTY",
  showInteractionModeToggle: false,
} as const;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runClaudePtyCommand = Effect.fn("runClaudePtyCommand")(function* (
  config: ClaudePtySettings,
  args: ReadonlyArray<string>,
) {
  const command = ChildProcess.make(config.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(config.binaryPath, command);
});

export const checkClaudePtyProviderStatus = Effect.fn("checkClaudePtyProviderStatus")(function* (
  config: ClaudePtySettings,
) {
  const checkedAt = yield* nowIso;
  const models = providerModelsFromSettings(
    CLAUDE_BUILT_IN_MODELS,
    PROVIDER,
    config.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!config.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PTY_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude PTY is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudePtyCommand(config, ["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: CLAUDE_PTY_PRESENTATION,
      enabled: config.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude PTY health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PTY_PRESENTATION,
      enabled: config.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude CLI is installed but timed out while running `claude --version`.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: CLAUDE_PTY_PRESENTATION,
      enabled: config.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Claude CLI is installed but failed to run. ${detail}`
          : "Claude CLI is installed but failed to run.",
      },
    });
  }

  return buildServerProvider({
    presentation: CLAUDE_PTY_PRESENTATION,
    enabled: config.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: { status: "unknown" },
      message:
        "Claude PTY drives Claude Code's interactive session. Sign in with `claude` directly if prompted.",
    },
  });
});

export const buildInitialClaudePtyProviderSnapshot = (
  config: ClaudePtySettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      CLAUDE_BUILT_IN_MODELS,
      PROVIDER,
      config.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!config.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PTY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude PTY is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PTY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude PTY status has not been checked in this session yet.",
      },
    });
  });
