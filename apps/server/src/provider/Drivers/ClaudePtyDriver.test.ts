import assert from "node:assert/strict";

import { it } from "@effect/vitest";

import { ClaudePtySettings, ProviderDriverKind } from "@t3tools/contracts";
import { ClaudePtyDriver } from "./ClaudePtyDriver.ts";

it("advertises the claudePty driver kind and presentation metadata", () => {
  assert.equal(ClaudePtyDriver.driverKind, ProviderDriverKind.make("claudePty"));
  assert.equal(ClaudePtyDriver.metadata.displayName, "Claude PTY");
  assert.equal(ClaudePtyDriver.metadata.supportsMultipleInstances, true);
});

it("uses ClaudePtySettings as its config schema with a disabled default", () => {
  assert.equal(ClaudePtyDriver.configSchema, ClaudePtySettings);

  const config = ClaudePtyDriver.defaultConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.binaryPath, "claude");
  assert.deepEqual(config.customModels, []);
});
