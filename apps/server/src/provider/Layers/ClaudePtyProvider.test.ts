import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect } from "effect";

import { type ClaudePtySettings } from "@t3tools/contracts";
import { buildInitialClaudePtyProviderSnapshot } from "./ClaudePtyProvider.ts";

const enabledConfig: ClaudePtySettings = { enabled: true, binaryPath: "claude", customModels: [] };
const disabledConfig: ClaudePtySettings = {
  enabled: false,
  binaryPath: "claude",
  customModels: [],
};

it.effect("reports a disabled initial snapshot when Claude PTY is off", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildInitialClaudePtyProviderSnapshot(disabledConfig);
    assert.equal(snapshot.enabled, false);
    // Even when disabled, the Claude model list is advertised for the picker.
    assert.ok(snapshot.models.length > 0);
  }),
);

it.effect("reports an enabled, not-yet-checked snapshot exposing Claude models", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildInitialClaudePtyProviderSnapshot(enabledConfig);
    assert.equal(snapshot.enabled, true);
    assert.ok(snapshot.models.some((model) => model.slug === "claude-sonnet-4-6"));
  }),
);
