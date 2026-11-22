/**
 * The context reading from the end of the file must equal the whole-file
 * reading, field for field, on every shape a live transcript takes.
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { clearContextCache, readContextSize, readContextSizeFull } from "../src/lib/monitor.js";
import { loadJsonl } from "../src/lib/jsonl.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "recap-monitor-")));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Lines of a transcript: a main-thread assistant turn with usage, a sidechain one, a user turn. */
const assistant = (n: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    sessionId: "s-main",
    timestamp: `2026-11-21T10:${String(n % 60).padStart(2, "0")}:00Z`,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `turn ${n}` }],
      usage: { input_tokens: n, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 10 * n, output_tokens: 5 },
    },
    ...extra,
  });
const sidechain = (n: number) => assistant(n, { isSidechain: true, sessionId: "s-sub" });
const user = (text: string) => JSON.stringify({ type: "user", sessionId: "s-main", message: { role: "user", content: text } });

function file(name: string, content: string | Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

/** The fast reading must equal the whole-file reading, field for field. */
function same(p: string) {
  clearContextCache();
  const fast = readContextSize(p, "v");
  const full = readContextSizeFull(p, "v");
  expect(fast, path.basename(p)).toEqual(full);
  return fast;
}

describe("readContextSize reads the tail", () => {
  it("equals the whole-file reading on plain, sidechain, torn, empty and BOM files", () => {
    const plain = same(file("plain.jsonl", [user("hi"), assistant(1), user("more"), assistant(2), user("last")].join("\n") + "\n"))!;
    expect(plain.tokens_total).toBe(2 + 2000 + 20);
    expect(plain.line_count).toBe(5);
    expect(plain.last_usage_line_idx).toBe(3);
    expect(plain.session_id).toBe("s-main");

    // The last lines are a subagent's: they are skipped, the main thread's last turn counts.
    const side = same(file("sidechain-tail.jsonl", [assistant(7), user("go"), sidechain(30), sidechain(31)].join("\n") + "\n"))!;
    expect(side.last_usage_line_idx).toBe(0);
    expect(side.input_tokens).toBe(7);

    // Claude Code is still writing the last line.
    const torn = same(file("half-written.jsonl", [assistant(3), user("x"), assistant(4)].join("\n") + "\n" + assistant(5).slice(0, 40)))!;
    expect(torn.input_tokens).toBe(4);
    expect(torn.line_count).toBe(4);

    // No usage at all, an empty file, whitespace only.
    expect(same(file("no-usage.jsonl", [user("a"), user("b")].join("\n")))!.last_usage_line_idx).toBe(-1);
    expect(same(file("empty.jsonl", ""))!.line_count).toBe(0);
    expect(same(file("blank.jsonl", "\n\n  \n"))!.line_count).toBe(0);

    // A BOM and leading blank lines (trimmed by loadJsonl), CRLF line ends, a blank line in the middle.
    same(file("bom-crlf.jsonl", "﻿\n\n" + [user("a"), assistant(8), "", user("b")].join("\r\n") + "\r\n"));

    expect(readContextSize(path.join(dir, "missing.jsonl"))).toBeNull();
  });

  it("finds a record far from the end, a record bigger than a chunk, and keeps multi-byte text whole", () => {
    // The usage record sits ~2 MB before the end, behind user turns: the reading grows its chunk to find it.
    const filler = Array.from({ length: 400 }, (_, i) => user(`filler ${i} ${"x".repeat(5000)}`));
    same(file("far.jsonl", [assistant(9), ...filler].join("\n") + "\n"));

    // One record of ~3 MB (an image as base64): bigger than the first chunk.
    const huge = assistant(11, {
      message: {
        role: "assistant",
        content: [{ type: "image", data: "A".repeat(3 * 1024 * 1024) }],
        usage: { input_tokens: 11, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
      },
    });
    expect(same(file("huge-record.jsonl", [assistant(10), huge, user("after")].join("\n") + "\n"))!.input_tokens).toBe(11);

    // Cyrillic text across the 256 KB chunk edge: lines are cut on bytes, never inside a character.
    for (const shift of [0, 1, 2, 3]) {
      const pad = "я".repeat(131_000 + shift); // 2 bytes each, so the edge falls inside characters
      same(file(`utf8-${shift}.jsonl`, [assistant(12), user(pad), user("ще")].join("\n") + "\n"));
    }
  });

  it("answers an unchanged file from the cache and never a changed one", () => {
    clearContextCache();
    const p = file("growing.jsonl", assistant(1) + "\n");
    const first = readContextSize(p)!;
    expect(first.input_tokens).toBe(1);
    expect(readContextSize(p, "alice")).toEqual({ ...first, voice: "alice" }); // from the cache, voice applied

    fs.appendFileSync(p, assistant(2) + "\n");
    const grown = readContextSize(p)!;
    expect(grown.input_tokens).toBe(2);
    expect(grown.line_count).toBe(2);
    expect(grown).toEqual(readContextSizeFull(p));

    // Rewritten to the same length (a surgery-like swap): mtime moves, the reading follows.
    const t = new Date(Date.now() + 5000);
    fs.writeFileSync(p, assistant(3) + "\n" + " ".repeat(assistant(2).length) + "\n");
    fs.utimesSync(p, t, t);
    expect(readContextSize(p)).toEqual(readContextSizeFull(p));
    expect(readContextSize(p)!.input_tokens).toBe(3);
  });

  it("takes the reading from records the caller already loaded", () => {
    clearContextCache();
    const p = file("preloaded.jsonl", [user("a"), assistant(6), user("b")].join("\n") + "\n");
    const records = loadJsonl(p);
    expect(readContextSize(p, "v", records)).toEqual(readContextSizeFull(p, "v"));
    expect(readContextSize(path.join(dir, "gone.jsonl"), "v", [])).toBeNull();
  });
});
