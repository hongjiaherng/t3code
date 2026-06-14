import { describe, it, assert } from "@effect/vitest";

import {
  appendCappedPtyOutput,
  chunkPtyDelta,
  normalizePtyText,
  PTY_DELTA_MAX_CHARS,
  PTY_TRUNCATION_MARKER,
} from "./ptyTerminalText.ts";

describe("ptyTerminalText", () => {
  it("strips ANSI escape codes", () => {
    assert.equal(normalizePtyText("\x1b[31mred\x1b[0m"), "red");
  });

  it("normalizes carriage-return redraws to the latest line", () => {
    assert.equal(
      normalizePtyText("Downloading 10%\rDownloading 90%\nDone"),
      "Downloading 90%\nDone",
    );
  });

  it("drops split Claude TUI title/control noise", () => {
    const output = appendCappedPtyOutput({
      existing: "",
      chunk: "\x1b]0;✳ T3 f97609d2\x07\n\n\x1b[>0q",
    });

    assert.equal(output.appended, "");
    assert.equal(output.text, "");
  });

  it("extracts completed Claude TUI answer lines", () => {
    const output = appendCappedPtyOutput({
      existing: "",
      chunk: "●OK",
    });

    assert.equal(output.appended, "OK");
    assert.equal(output.text, "OK");
  });

  it("cleans Claude TUI box drawing from answer lines", () => {
    const output = appendCappedPtyOutput({
      existing: "",
      chunk: "●─Test 4 acknowledged. What would─you─like─me─to─do?──── T3 f97609d2 ──",
    });

    assert.equal(output.appended, "Test 4 acknowledged. What would you like me to do?");
  });

  it("does not duplicate output when re-normalizing accumulated PTY data", () => {
    let raw = "\x1b]0;⠐ T3 PTY smoke\x07\r✻ Creating…\r\r\n";
    let output = appendCappedPtyOutput({ existing: "", chunk: raw });
    assert.equal(output.appended, "");

    raw = "●OK";
    output = appendCappedPtyOutput({ existing: output.text, chunk: raw, snapshot: true });
    assert.equal(output.appended, "OK");

    output = appendCappedPtyOutput({ existing: output.text, chunk: raw, snapshot: true });
    assert.equal(output.appended, "");
    assert.equal(output.text, "OK");
  });

  it("caps retained output and appends a truncation marker", () => {
    const result = appendCappedPtyOutput({
      existing: "a".repeat(249_990),
      chunk: "b".repeat(100),
    });

    assert.equal(result.truncated, true);
    assert.equal(result.text.endsWith(PTY_TRUNCATION_MARKER), true);
    assert.equal(result.text.length <= 250_000 + PTY_TRUNCATION_MARKER.length, true);
  });

  it("chunks deltas to the maximum emitted size", () => {
    const chunks = chunkPtyDelta("x".repeat(PTY_DELTA_MAX_CHARS + 5));

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.length, PTY_DELTA_MAX_CHARS);
    assert.equal(chunks[1]?.length, 5);
  });
});
