/**
 * ClaudePtyDriver - `ProviderDriver` for the experimental Claude PTY runtime.
 *
 * Mirrors {@link ./GrokDriver}: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures over the per-instance `ClaudePtySettings`.
 *
 * The adapter drives Claude Code's interactive `claude` terminal through a PTY
 * (see {@link ../Layers/ClaudePtyAdapter}); text generation reuses the Claude
 * CLI implementation since it targets the same binary. Maintenance is
 * manual-only because the Claude Agent driver already owns `claude` updates.
 *
 * @module provider/Drivers/ClaudePtyDriver
 */
import {
  ClaudePtySettings,
  ProviderDriverKind,
  type ClaudeSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { PtyAdapter } from "../../terminal/Services/PTY.ts";
import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudePtyAdapter } from "../Layers/ClaudePtyAdapter.ts";
import {
  buildInitialClaudePtyProviderSnapshot,
  checkClaudePtyProviderStatus,
} from "../Layers/ClaudePtyProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";

const decodeClaudePtySettings = Schema.decodeSync(ClaudePtySettings);

const DRIVER_KIND = ProviderDriverKind.make("claudePty");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type ClaudePtyDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | PtyAdapter
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const ClaudePtyDriver: ProviderDriver<ClaudePtySettings, ClaudePtyDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude PTY",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudePtySettings,
  defaultConfig: (): ClaudePtySettings => decodeClaudePtySettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClaudePtySettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeClaudePtyAdapter(effectiveConfig);
      // Text generation reuses the Claude CLI; the PTY config carries no
      // HOME/launch-arg overrides, so fill the Claude-specific fields blank.
      const textGenerationConfig: ClaudeSettings = {
        ...effectiveConfig,
        homePath: "",
        launchArgs: "",
      };
      const textGeneration = yield* makeClaudeTextGeneration(textGenerationConfig, processEnv);

      const checkProvider = checkClaudePtyProviderStatus(effectiveConfig).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<ClaudePtySettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          buildInitialClaudePtyProviderSnapshot(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude PTY snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
