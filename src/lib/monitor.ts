/**
 * Context size monitor.
 *
 * Reverse-engineered from CC's /context implementation:
 *   1. Scan JSONL backward from last line
 *   2. Skip records with isSidechain: true (subagents — separate context)
 *   3. Find most recent assistant message with `usage` object
 *   4. Total context = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * Cache-read tokens count toward context window even though they're cheap to bill.
 * Output tokens are not part of the input context window.
 *
 * Memory: long sessions leave transcripts of tens of megabytes, and parsing a
 * whole one to find its last usage record costs several hundred MB of heap for
 * a moment. The nudger and the routes read every voice's file again and again,
 * so readContextSize reads the file from its end in growing chunks, on bytes,
 * and counts lines in a streaming pass. It returns exactly what the whole-file
 * reading returns (readContextSizeFull, kept as the fallback and as the
 * reference the tests compare against). An unchanged file is answered from a
 * cache keyed by path, size and mtime.
 */

import fs from "fs";
import { loadJsonl, type JsonlRecord } from "./jsonl.js";

export interface ContextReading {
  voice?: string;
  file: string;
  tokens_total: number;
  percent_of_1m: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  file_size_bytes: number;
  line_count: number;
  last_usage_ts: string | null;
  last_usage_line_idx: number;
  /** `sessionId` on the record the reading came from: lets a caller prove the reading is the session it asked for. */
  session_id: string | null;
}

/** The record a reading is taken from: the main thread's assistant turn that carries usage. */
const isUsageRecord = (r: JsonlRecord | undefined): boolean =>
  Boolean(r) && r!.isSidechain !== true && r!.type === "assistant" && Boolean(r!.message?.usage);

function readingFrom(
  r: JsonlRecord | null,
  file: string,
  size: number,
  lineCount: number,
  lineIdx: number,
  voice?: string,
): ContextReading {
  if (!r) {
    // No usage entry yet — file empty or only system records
    return {
      voice,
      file,
      tokens_total: 0,
      percent_of_1m: 0,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      output_tokens: 0,
      file_size_bytes: size,
      line_count: lineCount,
      last_usage_ts: null,
      last_usage_line_idx: -1,
      session_id: null,
    };
  }
  const usage = r.message!.usage!;
  const input = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const total = input + cacheRead + cacheCreation;
  return {
    voice,
    file,
    tokens_total: total,
    percent_of_1m: Number(((total / 1_000_000) * 100).toFixed(2)),
    input_tokens: input,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    output_tokens: output,
    file_size_bytes: size,
    line_count: lineCount,
    last_usage_ts: r.timestamp ?? null,
    last_usage_line_idx: lineIdx,
    session_id: typeof r.sessionId === "string" ? r.sessionId : null,
  };
}

/**
 * The whole-file reading: every line parsed. The fallback, and the reference
 * the fast path must equal. `records`, when given, are this file's
 * already-loaded records (saves a second read of a large file).
 */
export function readContextSizeFull(filePath: string, voice?: string, records?: JsonlRecord[]): ContextReading | null {
  if (!fs.existsSync(filePath)) return null;
  const stats = fs.statSync(filePath);
  records ??= loadJsonl(filePath);
  for (let i = records.length - 1; i >= 0; i--) {
    if (isUsageRecord(records[i])) return readingFrom(records[i]!, filePath, stats.size, records.length, i, voice);
  }
  return readingFrom(null, filePath, stats.size, records.length, -1, voice);
}

const FIRST_CHUNK = 256 * 1024;
/** Past this much tail without a usage record, read the whole file the old way rather than guess. */
const MAX_TAIL = 64 * 1024 * 1024;
const COUNT_CHUNK = 1024 * 1024;
const EDGE = 64 * 1024;

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.allocUnsafe(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, buf, off, len - off, pos + off);
    if (n === 0) break;
    off += n;
  }
  return off === len ? buf : buf.subarray(0, off);
}

/**
 * The byte range String.prototype.trim keeps, as loadJsonl reads it: the same
 * whitespace rule (decoded, so Unicode spaces and a BOM count too), measured
 * back into bytes. Grows its window if a file ends in a long run of whitespace.
 */
function trimmedRange(fd: number, size: number): { start: number; end: number } {
  let end = size;
  for (let win = EDGE; ; win *= 4) {
    const from = Math.max(0, size - win);
    const text = readAt(fd, from, size - from).toString("utf8");
    const kept = text.trimEnd();
    if (kept.length > 0 || from === 0) {
      end = size - Buffer.byteLength(text.slice(kept.length), "utf8");
      break;
    }
  }
  if (end <= 0) return { start: 0, end: 0 };
  let start = 0;
  for (let win = EDGE; ; win *= 4) {
    const len = Math.min(win, end);
    const text = readAt(fd, 0, len).toString("utf8");
    const kept = text.trimStart();
    if (kept.length > 0 || len === end) {
      start = Buffer.byteLength(text.slice(0, text.length - kept.length), "utf8");
      break;
    }
  }
  return { start, end };
}

/** Lines in [start, end): loadJsonl's split("\n") count, without holding the file. */
function countLines(fd: number, start: number, end: number): number {
  if (end <= start) return 0;
  let newlines = 0;
  const buf = Buffer.allocUnsafe(Math.min(COUNT_CHUNK, end - start));
  for (let pos = start; pos < end; ) {
    const len = Math.min(buf.length, end - pos);
    const n = fs.readSync(fd, buf, 0, len, pos);
    if (n === 0) break;
    for (let i = buf.indexOf(0x0a, 0); i !== -1 && i < n; i = buf.indexOf(0x0a, i + 1)) newlines++;
    pos += n;
  }
  return newlines + 1;
}

function parse(line: Buffer): JsonlRecord | undefined {
  try {
    return JSON.parse(line.toString("utf8")) as JsonlRecord;
  } catch {
    return undefined; // a half-written or broken line: loadJsonl's `{}`, never a usage record
  }
}

type TailResult = { record: JsonlRecord; fromEnd: number } | { record: null } | "too-far";

/**
 * The last usage record in [start, end), reading backwards in growing chunks.
 * Lines are cut on the newline byte before decoding, so a chunk edge inside a
 * multi-byte character never splits a line; a chunk's first, partial line is
 * dropped unless the chunk starts at `start`. `fromEnd` counts the lines after it.
 */
function lastUsageRecord(fd: number, start: number, end: number): TailResult {
  let checked = 0; // complete lines already looked at, from the end
  for (let chunk = FIRST_CHUNK; ; chunk *= 4) {
    const pos = Math.max(start, end - chunk);
    const buf = readAt(fd, pos, end - pos);
    let lineEnd = buf.length;
    let fromEnd = 0;
    while (true) {
      const nl = lineEnd > 0 ? buf.lastIndexOf(0x0a, lineEnd - 1) : -1;
      if (nl === -1 && pos > start) break; // partial first line: read further back
      if (fromEnd >= checked) {
        const r = parse(buf.subarray(nl + 1, lineEnd));
        if (isUsageRecord(r)) return { record: r!, fromEnd };
      }
      fromEnd++;
      if (nl === -1) return { record: null }; // reached the first line of the file
      lineEnd = nl;
    }
    checked = fromEnd;
    if (pos === start) return { record: null };
    if (end - pos >= MAX_TAIL) return "too-far";
  }
}

interface Cached {
  size: number;
  mtimeMs: number;
  reading: ContextReading;
}
const cache = new Map<string, Cached>();
const CACHE_MAX = 512;

/** For tests: forget cached readings. */
export function clearContextCache(): void {
  cache.clear();
}

/**
 * The context reading of a session file, or null if it does not exist.
 * `records`, when given, are this file's already-loaded records: the reading is
 * taken from them and the file is not read again.
 */
export function readContextSize(filePath: string, voice?: string, records?: JsonlRecord[]): ContextReading | null {
  if (records) return readContextSizeFull(filePath, voice, records);
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    const hit = cache.get(filePath);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { ...hit.reading, voice };

    const { start, end } = trimmedRange(fd, st.size);
    const lineCount = countLines(fd, start, end);
    let reading: ContextReading;
    if (lineCount === 0) {
      reading = readingFrom(null, filePath, st.size, 0, -1);
    } else {
      const tail = lastUsageRecord(fd, start, end);
      if (tail === "too-far") {
        // The whole-file memory cost comes back for this one file: say so, so a memory spike can be traced here.
        console.warn(`[monitor] no usage record in the last ${MAX_TAIL / 1024 / 1024} MB of ${filePath} (${st.size} bytes): reading the whole file`);
        const full = readContextSizeFull(filePath);
        if (!full) return null;
        reading = full;
      } else if (tail.record) {
        reading = readingFrom(tail.record, filePath, st.size, lineCount, lineCount - 1 - tail.fromEnd);
      } else {
        reading = readingFrom(null, filePath, st.size, lineCount, -1);
      }
    }
    // A file that grew while we read is not cached: its size or mtime no longer match what was read.
    const after = fs.fstatSync(fd);
    if (after.size === st.size && after.mtimeMs === st.mtimeMs) {
      cache.delete(filePath);
      cache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, reading: { ...reading, voice: undefined } });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    }
    return { ...reading, voice };
  } finally {
    fs.closeSync(fd);
  }
}
