/**
 * Recap records and the recap sentinel.
 *
 * One definition of "a recap" for the whole server and for scripts/recap.ts,
 * so the CLI, the finder, the planner and surgery cannot disagree.
 *
 * The sentinel name is configurable (config.sentinel_name, default
 * RECAP-CYCLE) and passed in by every caller, so recaps written with another
 * marker keep matching.
 *
 * A recap RECORD is a `user` record whose content is a plain string carrying
 * the sentinel — the shape surgery injects. Other
 * records that mention the sentinel (a tool_result that read a body file, a
 * queue-operation, the /remember skill text in a tool call, assistant text, a
 * sentinel-shaped regex in a message) are not recaps. A user message that
 * pastes a whole body has the recap's shape and does count. Before 1.1 any
 * record whose text contained the sentinel counted, which made `--force`
 * routine and so switched off the guard against cutting a real recap.
 *
 * The recap STACK is the run of recap records at the head of a session, after
 * any header records (uuid-less metadata Claude Code writes when it starts a
 * file). Surgery keeps the stack and inserts the new recap after it.
 */

import type { JsonlRecord } from "./jsonl.js";
import { DEFAULT_SENTINEL } from "../config.js";

export interface Sentinel {
  sentinel: string;
  voice?: string;
  id?: string;
  cut_through_uuid?: string;
  period_covered?: string;
  [key: string]: unknown;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches the sentinel key with this name: `"sentinel": "<name>"`, any spacing. */
export function sentinelRe(name = DEFAULT_SENTINEL, flags = ""): RegExp {
  return new RegExp(`"sentinel"\\s*:\\s*"${escapeRe(name)}"`, flags);
}

/**
 * Text of a recap body file, with CRLF turned into LF. UTF-8 with its BOM
 * dropped, or UTF-16 when the file starts with a UTF-16 BOM — what Windows
 * PowerShell 5.1 `>` writes.
 */
export function decodeBodyText(buf: Buffer): string {
  let text: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString("utf16le");
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    le.swap16();
    text = le.toString("utf16le");
  } else {
    text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  }
  return text.replace(/\r\n/g, "\n");
}

/** Index of the `}` closing the object that opens at `open`, or -1. Skips braces inside JSON strings. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lastSentinelKey(text: string, name: string): number | null {
  let at: number | null = null;
  for (const m of text.matchAll(sentinelRe(name, "g"))) at = m.index ?? 0;
  return at;
}

/**
 * The sentinel object around the LAST sentinel key in `text`. The skill puts
 * the sentinel at the end of the body; an earlier one is a quoted predecessor
 * and is never used, even when the last one is broken — a broken final block
 * must fail, not quietly fall back to the predecessor's cut point.
 * Pretty-printed, compact and nested sentinels all parse.
 */
export function parseSentinel(text: string, name = DEFAULT_SENTINEL): Sentinel | null {
  return sentinelBlock(text, name)?.sentinel ?? null;
}

/** The last sentinel in `text` with where its object starts (`{`) and ends (`}`), or null. */
function sentinelBlock(text: string, name: string): { open: number; close: number; key: number; sentinel: Sentinel } | null {
  const key = lastSentinelKey(text, name);
  if (key === null) return null;
  // Try enclosing objects nearest-first; a nested object before the key closes before it.
  let open = text.lastIndexOf("{", key);
  for (let tries = 0; open >= 0 && tries < 32; tries++) {
    const close = matchingBrace(text, open);
    if (close > key) {
      try {
        const obj = JSON.parse(text.slice(open, close + 1));
        if (obj && typeof obj === "object" && obj.sentinel === name) return { open, close, key, sentinel: obj as Sentinel };
      } catch {
        // Not JSON from this brace — try the next one out.
      }
    }
    if (open === 0) break;
    open = text.lastIndexOf("{", open - 1);
  }
  return null;
}

/** What a body may carry in the sentinel before the cut is known; the pending cut fills it (see fillSentinelCut). */
export const CUT_PLACEHOLDER = "CUT_UUID";

export type SentinelCutFill =
  /** The sentinel already names a cut; it is the pending one, or there is none to compare. */
  | { action: "kept"; text: string; cut: string }
  /** The placeholder (or no cut at all) was replaced with the pending cut. */
  | { action: "filled"; text: string; cut: string; was: "placeholder" | "missing" }
  /** The sentinel names another cut than the pending one. Nothing is changed. */
  | { action: "mismatch"; body_cut: string; pending_cut: string }
  /** The sentinel needs a cut and there is no pending cut to take it from. */
  | { action: "no_pending"; was: "placeholder" | "missing" }
  /** The field holds something that is neither a string nor null: fix it by hand. */
  | { action: "unfillable" }
  | { action: "no_sentinel" };

/**
 * Put the pending cut into the body's sentinel when it holds the placeholder
 * (`"cut_through_uuid": "CUT_UUID"`), an empty value, or no cut_through_uuid
 * at all. Only the last sentinel is touched, and only that one field: the
 * rest of the body is returned byte for byte. `name` is the sentinel name
 * (config.sentinel_name).
 */
export function fillSentinelCut(text: string, pendingCut: string | null, name = DEFAULT_SENTINEL): SentinelCutFill {
  const block = sentinelBlock(text, name);
  if (!block) return { action: "no_sentinel" };
  const current = block.sentinel.cut_through_uuid;
  if (typeof current === "string" && current.trim() !== "" && current !== CUT_PLACEHOLDER) {
    if (pendingCut && current !== pendingCut) return { action: "mismatch", body_cut: current, pending_cut: pendingCut };
    return { action: "kept", text, cut: current };
  }
  if (current !== undefined && current !== null && typeof current !== "string") return { action: "unfillable" };
  const was = "cut_through_uuid" in block.sentinel ? "placeholder" : "missing";
  if (!pendingCut) return { action: "no_pending", was };
  const inner = text.slice(block.open, block.close + 1);
  let filled: string;
  if (was === "placeholder") {
    // The field exists with the placeholder, an empty string or null: replace its value.
    filled = inner.replace(/("cut_through_uuid"\s*:\s*)("(?:[^"\\]|\\.)*"|null)/, `$1${JSON.stringify(pendingCut)}`);
  } else {
    // No field: add it right after the sentinel's own key, which this block holds.
    const m = sentinelRe(name, "y");
    m.lastIndex = block.key - block.open;
    if (!m.exec(inner)) return { action: "unfillable" };
    filled = `${inner.slice(0, m.lastIndex)}, "cut_through_uuid": ${JSON.stringify(pendingCut)}${inner.slice(m.lastIndex)}`;
  }
  const out = text.slice(0, block.open) + filled + text.slice(block.close + 1);
  if (parseSentinel(out, name)?.cut_through_uuid !== pendingCut) return { action: "unfillable" };
  return { action: "filled", text: out, cut: pendingCut, was };
}

/**
 * Why the last sentinel block in `text` does not parse — usually a trailing
 * comma. Null when it parses or when there is no sentinel key at all.
 */
export function sentinelParseError(text: string, name = DEFAULT_SENTINEL): string | null {
  const key = lastSentinelKey(text, name);
  if (key === null || parseSentinel(text, name)) return null;
  const open = text.lastIndexOf("{", key);
  if (open < 0) return "there is no { before the sentinel key";
  const close = matchingBrace(text, open);
  if (close < 0) return "the block's braces never close";
  try {
    JSON.parse(text.slice(open, close + 1));
    return `the block parses, but its sentinel field is not ${name}`;
  } catch (e: any) {
    return e.message;
  }
}

/**
 * Text Claude Code writes as `user` messages itself: slash-command echoes and
 * their output, `!` shell lines, task notifications, interrupt markers. None
 * of it is a recap or a typed message, even when it quotes a sentinel.
 */
export const GENERATED_USER_TEXT = /^(<command-|<local-command-|<bash-|<task-notification|\[Request interrupted by user)/;

/**
 * True for an injected recap: a user record (not meta, not text Claude Code
 * generated) whose string content carries a sentinel that parses. A task
 * notification quoting a sentinel, or a sentinel-shaped regex in some text, is
 * not a recap: counting one would lock it into the stack for good.
 *
 * Neither an `id` nor a sentinel block that parses is required here: 1.0
 * accepted a body whose sentinel merely appeared in the text (a trailing
 * comma, a placeholder), and such recaps must stay recognized, and so stay
 * protected from the cut. New bodies are held to the stricter rule by
 * surgery, which needs the last sentinel to parse.
 */
export function isRecapRecord(r: JsonlRecord | null | undefined, sentinelName = DEFAULT_SENTINEL): boolean {
  if (!r || r.type !== "user" || r.isMeta === true) return false;
  const c = r.message?.content;
  return typeof c === "string" && sentinelRe(sentinelName).test(c) && !GENERATED_USER_TEXT.test(c.trimStart());
}

/** `my-session-recap-016` → 16. Null when the id carries no recap number. */
export function recapNumber(id: string | null | undefined): number | null {
  if (!id) return null;
  const m = /-recap-(\d+)/i.exec(id);
  return m ? parseInt(m[1]!, 10) : null;
}

export function formatRecapId(voice: string, n: number): string {
  return `${voice}-recap-${String(n).padStart(3, "0")}`;
}

export function recapBodyFileName(n: number): string {
  return `recap-${String(n).padStart(3, "0")}.body.txt`;
}

export interface StackRecap {
  /** Line index in the session file. */
  index: number;
  uuid: string;
  id: string | null;
  number: number | null;
  voice: string | null;
  period_covered: string | null;
  cut_through_uuid: string | null;
  /** When the recap was injected (the record's timestamp). */
  applied_at: string | null;
}

export interface RecapStack {
  recaps: StackRecap[];
  /**
   * Index of the first conversation record (the first uuid-bearing record that
   * is not a recap), or records.length when there is none. Everything before it
   * — headers and recaps — is the leading region surgery keeps.
   */
  end: number;
}

/** The recap stack at the head of a session. Every recap counts, whatever its voice or id: none may be cut. */
export function scanRecapStack(records: ReadonlyArray<JsonlRecord | null | undefined>, sentinelName = DEFAULT_SENTINEL): RecapStack {
  const recaps: StackRecap[] = [];
  let i = 0;
  for (; i < records.length; i++) {
    const r = records[i];
    if (!r || !r.uuid) continue; // header, metadata or unreadable line: part of the leading region
    if (!isRecapRecord(r, sentinelName)) break;
    const s = parseSentinel(r.message!.content as string, sentinelName);
    const id = typeof s?.id === "string" ? s.id : null;
    recaps.push({
      index: i,
      uuid: r.uuid,
      id,
      number: recapNumber(id),
      voice: typeof s?.voice === "string" ? s.voice : null,
      period_covered: typeof s?.period_covered === "string" ? s.period_covered : null,
      cut_through_uuid: typeof s?.cut_through_uuid === "string" ? s.cut_through_uuid : null,
      applied_at: typeof r.timestamp === "string" ? r.timestamp : null,
    });
  }
  return { recaps, end: i };
}

/**
 * Next recap number for a stack: one past the highest numbered recap. Falls
 * back to count + 1 when some recap ids carry no number (`basis: "count"`).
 */
export function nextRecapNumber(stack: RecapStack): { number: number; basis: "ids" | "count" } {
  const nums = stack.recaps.map((r) => r.number).filter((n): n is number => n !== null);
  if (stack.recaps.length === 0) return { number: 1, basis: "ids" };
  if (nums.length === stack.recaps.length) return { number: Math.max(...nums) + 1, basis: "ids" };
  return { number: stack.recaps.length + 1, basis: "count" };
}
