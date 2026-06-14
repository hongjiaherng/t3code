/**
 * ClaudePtyAdapter — shape type for the experimental Claude PTY adapter.
 *
 * Like {@link ./ClaudeAdapter}, this is only a naming anchor for the shape
 * the driver bundle satisfies; there is no `Context.Service` tag because the
 * driver model ({@link ../Drivers/ClaudePtyDriver}) captures one adapter per
 * instance as a closure.
 *
 * @module ClaudePtyAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ClaudePtyAdapterShape — per-instance Claude PTY adapter contract. Drives the
 * interactive `claude` terminal UI through a PTY and reads Claude's JSONL
 * transcript files for assistant text, tool calls, and tool results.
 */
export interface ClaudePtyAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
