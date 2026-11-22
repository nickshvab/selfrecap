/**
 * The timeline of a recap period: what happened between the session's recap
 * stack and the cut, one entry per thing said or seen, in the order of the
 * session file. The draft's cold readers read it; the checker reads a
 * shortened copy of it; `recap.ts --entry` prints entries from it.
 *
 * Entries, by tag:
 *   <OPERATOR>    what the operator said (the tag is the operator's name in
 *                 capitals, config draft.operator), including messages sent
 *                 while the session was working
 *   VOICE         what the session said, and the messages it sent to other
 *                 sessions and agents (SendMessage), headed "message to <name>"
 *   TOOL          a tool's output, with the call that produced it; for a call
 *                 that writes a file, the text the session wrote as well
 *   IMAGE         an image was shown to the session (one-line note)
 *   AGENT REPORT  a helper agent's report: an Agent call's result or a task notification
 *   PEER          a message from another session
 *
 * Where Claude Code puts things (as of Claude Code 2.1.330):
 *   - A message the operator sends while the session is mid-turn is an
 *     `attachment` record (`queued_command`, origin human) whose rendered text
 *     is a <system-reminder> "The user sent a new message while you were
 *     working:". In copies of what was sent it sits next to (or inside) a tool
 *     result. Either way it is lifted out as the operator's words, never filed
 *     as tool output.
 *   - Peer messages: a meta `user` record, or a `queued_command` attachment
 *     (origin peer), carrying <cross-session-message from-name="...">.
 *   - Task notifications: a `user` string, or a `queued_command` attachment,
 *     carrying <task-notification> with a <summary> and a <result>.
 *   - Request-log records (api-request, api-request-blob, api-request-shape)
 *     are copies: skipped entirely.
 * Other <system-reminder> blocks (memory age, re-read instructions) are
 * dropped from tool output: they are Claude Code's notes, not the tool's.
 *
 * Everything here is text from the session, including text that came from
 * outside (web pages, tool output). The readers are told so, and run with no
 * tools beyond reading and writing their own folder (see headless.ts).
 *
 * Entries keep everything; the three views cut at render time (renderEntry):
 *   readers   tool output, agent reports and peer messages to CLIP_CHARS,
 *             text the session wrote into a file to WRITTEN_CHARS
 *   checker   tool output to SHORT_TOOL_CHARS, agent reports to
 *             SHORT_AGENT_CHARS, written text to SHORT_WRITTEN_CHARS
 *   entry     nothing cut (`recap.ts --entry`)
 * What was said (the operator's words, the session's) is never cut.
 *
 * Times are UTC, and the entry headers say so.
 */

import { isApiRequestRecord, type JsonlRecord } from "./jsonl.js";
import { isRecapRecord } from "./recaps.js";

export type EntryKind = "operator" | "voice" | "tool" | "image" | "agent" | "peer";

export interface TimelineEntry {
  /** E-0001, in order. */
  id: string;
  /** Line of the record in the session file. */
  line: number;
  ts: string | null;
  kind: EntryKind;
  /** What follows the tag: the tool call, "sent while Ada was working", "from Bob", "message to Bob". */
  head: string;
  /** Whole: the views cut it when they render it. */
  body: string;
  /** A tool entry's call: the tool and its input in one line, whole (the head carries it cut to INPUT_HEAD_CHARS). */
  call?: { name: string; input: string };
  /** What the call wrote: a file's content, an edit's new text, a long shell command. Whole, with its line breaks. */
  written?: { label: string; text: string };
}

/** How an entry is rendered: for the readers, for the checker (shortened), or by `--entry` (whole). */
export type TimelineView = "readers" | "checker" | "entry";

export interface TimelineNames {
  /** The person the session works with, as the session calls them (config draft.operator). */
  operator: string;
  /** The session's display name (config `name`, else the voice key capitalized). */
  voice: string;
}

/** A single tool result, agent report or peer message is cut to this in the readers' timeline. */
export const CLIP_CHARS = 9_000;
/**
 * The text the session wrote into a file with one call (Write content, Edit
 * new text, a long shell command) is kept to this in the readers' timeline.
 * A decision or a figure that exists only in a file the session wrote is in
 * that text, so it gets about the room a tool's output gets: a memo, a plan
 * or a decision note fits whole; a long generated file is cut, with a marker.
 */
export const WRITTEN_CHARS = 8_000;
/** In the checker's shortened timeline, a tool output is cut to this... */
export const SHORT_TOOL_CHARS = 500;
/** ...an agent report to this... */
export const SHORT_AGENT_CHARS = 1_500;
/** ...and the text the session wrote into a file to this: where its decisions and figures are. What was said stays whole. */
export const SHORT_WRITTEN_CHARS = 2_000;
/** A call's input in an entry's head line, in one line. */
const INPUT_HEAD_CHARS = 300;
/** One part with --split: what a smaller reader model takes comfortably in one run. */
export const PART_CHARS = 230_000;
/** Lines longer than this are wrapped: a reader reading by line must not lose the end of one. */
const WRAP_CHARS = 1_000;

const MIDTURN_OPERATOR = "The user sent a new message while you were working:";
const MIDTURN_PEER = "Another Claude session sent a message while you were working:";
const MIDTURN_TAIL = /\n\s*This is how Claude Code surfaces messages[\s\S]*$/;
const REMINDER_RE = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder\b[^>]*>/g;
const IMAGE_SHOWN = "[an image was shown to the voice here]";
const IMAGE_ATTACHED = "[an image was attached here]";
const AGENT_TOOLS = new Set(["Agent", "Task"]);

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n[... ${s.length - max} more characters cut ...]` : s;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** "2026-01-15 09:30 UTC" from an ISO time; the text as it is when it does not parse. */
export function utcMinute(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The tag an entry is shown under. */
export function tagOf(kind: EntryKind, names: TimelineNames): string {
  switch (kind) {
    case "operator":
      return names.operator.toUpperCase();
    case "voice":
      return "VOICE";
    case "tool":
      return "TOOL";
    case "image":
      return "IMAGE";
    case "agent":
      return "AGENT REPORT";
    case "peer":
      return "PEER";
  }
}

// ─── Lifting messages out of text ────────────────────────────────────────────

interface Lifted {
  kind: "operator" | "peer" | "agent";
  head: string;
  body: string;
  /** Arrived in the middle of the session's turn. */
  midTurn: boolean;
  /** A peer message: who sent it, by name and by address. */
  peer?: { name: string | null; address: string | null };
}

function parsePeer(text: string): { from: string; name: string | null; address: string | null; body: string } | null {
  const open = /<cross-session-message\b([^>]*)>/.exec(text);
  if (!open) return null;
  const attrs = open[1] ?? "";
  const name = /from-name="([^"]*)"/.exec(attrs)?.[1] || null;
  const address = /\bfrom="([^"]*)"/.exec(attrs)?.[1] || null;
  const start = open.index + open[0].length;
  const end = text.indexOf("</cross-session-message>", start);
  return { from: name ?? address ?? "another session", name, address, body: (end >= 0 ? text.slice(start, end) : text.slice(start)).trim() };
}

function parseTask(text: string): { head: string; body: string } | null {
  const at = text.indexOf("<task-notification>");
  if (at < 0) return null;
  const end = text.indexOf("</task-notification>", at);
  const inner = text.slice(at + "<task-notification>".length, end >= 0 ? end : undefined);
  const tag = (t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(inner)?.[1]?.trim() || null;
  const summary = tag("summary");
  const status = tag("status");
  const result = tag("result");
  const rest = inner.replace(/<(task-id|tool-use-id|output-file|note|usage|status|summary)>[\s\S]*?<\/\1>/g, "").trim();
  return { head: `${summary ?? "a background task"}${status ? ` (${status})` : ""}`, body: result ?? (rest || summary || "") };
}

/** What a system-reminder (or an unwrapped notice) carries for the timeline, if anything. */
function liftOne(inner: string): Lifted | null {
  const t = inner.trim();
  if (t.startsWith(MIDTURN_OPERATOR)) {
    const body = t.slice(MIDTURN_OPERATOR.length).replace(MIDTURN_TAIL, "").trim();
    return body ? { kind: "operator", head: "", body, midTurn: true } : null;
  }
  if (t.includes("<cross-session-message")) {
    const p = parsePeer(t);
    return p ? { kind: "peer", head: `from ${p.from}`, body: p.body, midTurn: t.startsWith(MIDTURN_PEER), peer: p } : null;
  }
  if (t.includes("<task-notification>")) {
    const k = parseTask(t);
    return k ? { kind: "agent", head: k.head, body: k.body, midTurn: true } : null;
  }
  return null;
}

/**
 * Split text into what is its own and what Claude Code put into it: system
 * reminders are removed (and lifted when they carry a message), and a
 * mid-turn notice written without the wrapper is cut off and lifted.
 */
export function liftMessages(text: string): { rest: string; lifted: Lifted[] } {
  const lifted: Lifted[] = [];
  let rest = text.replace(REMINDER_RE, (_all, inner: string) => {
    const l = liftOne(inner);
    if (l) lifted.push(l);
    return "";
  });
  for (const marker of [MIDTURN_OPERATOR, MIDTURN_PEER]) {
    const at = rest.indexOf(marker);
    if (at < 0) continue;
    const l = liftOne(rest.slice(at));
    if (!l) continue;
    lifted.push(l);
    rest = rest.slice(0, at);
  }
  return { rest: rest.trim(), lifted };
}

// ─── Building ────────────────────────────────────────────────────────────────

function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  let image = false;
  for (const b of prompt) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b?.type === "image") image = true;
  }
  if (image) parts.push(IMAGE_ATTACHED);
  return parts.join("\n");
}

function inputText(input: unknown): string {
  try {
    return JSON.stringify(input ?? "").replace(/\\n/g, " ");
  } catch {
    return String(input);
  }
}

/**
 * What a call wrote, taken out of its one-line input and kept whole with its
 * line breaks: a file's content (Write), an edit's new text (Edit, MultiEdit),
 * a notebook cell (NotebookEdit), and a shell command too long for the head
 * (a heredoc or a commit message is text the session wrote). A decision that
 * exists only in a file the session wrote is in this text. `rest` is the
 * input without it, for the head.
 */
function writtenBy(name: string, input: any): { label: string; text: string; rest: unknown } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const without = (key: string) => Object.fromEntries(Object.entries(input).filter(([k]) => k !== key));
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  switch (name) {
    case "Write": {
      const t = text(input.content);
      return t ? { label: "Wrote", text: t, rest: without("content") } : null;
    }
    case "Edit": {
      const t = text(input.new_string);
      return t ? { label: "New text", text: t, rest: without("new_string") } : null;
    }
    case "MultiEdit": {
      const edits: any[] = Array.isArray(input.edits) ? input.edits : [];
      const t = edits.map((e) => text(e?.new_string)).filter((x): x is string => x !== null);
      return t.length ? { label: "New text", text: t.join("\n[next edit]\n"), rest: { ...without("edits"), edits: edits.map((e) => ({ old_string: e?.old_string })) } } : null;
    }
    case "NotebookEdit": {
      const t = text(input.new_source);
      return t ? { label: "New cell source", text: t, rest: without("new_source") } : null;
    }
    case "Bash": {
      const t = text(input.command);
      return t && oneLine(t, Infinity).length > INPUT_HEAD_CHARS ? { label: "Command", text: t, rest: without("command") } : null;
    }
  }
  return null;
}

/** An address rather than a name: "uds:...", a pipe or socket path. */
const ADDRESS_RE = /^[a-z][a-z0-9+.-]*:|[\\/]/i;

/**
 * A SendMessage call: the recipient by name when the input names one, else
 * its address (named later from the period's peer messages), the summary,
 * and the text.
 */
function sendMessageOf(input: any): { name: string | null; address: string | null; summary: string | null; text: string } {
  const fields = [input?.to, input?.recipient, input?.name, input?.recipient_name].filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const name = fields.find((v) => !ADDRESS_RE.test(v.trim()))?.trim() ?? null;
  const address = fields.find((v) => ADDRESS_RE.test(v.trim())) ?? null;
  const summary = typeof input?.summary === "string" && input.summary.trim() ? input.summary.trim() : null;
  const m = input?.message ?? input?.content ?? input?.text;
  return { name, address, summary, text: typeof m === "string" ? m : inputText(m) };
}

/** The head of a message the session sent: "message to Bob". */
function messageHead(name: string | null, summary: string | null): string {
  return name ? `message to ${name}` : `message to another session${summary ? ` (its summary: "${oneLine(summary, 100)}")` : ""}`;
}

/**
 * The timeline of lines `from` to `to` (inclusive) of a session's records.
 * Entries get ids E-0001.. in order. `sentinel` is config.sentinel_name: a
 * recap record inside the period (a pasted one) is left out, not read as
 * something the operator said.
 */
export function buildTimeline(
  records: ReadonlyArray<JsonlRecord | null | undefined>,
  from: number,
  to: number,
  names: TimelineNames,
  opts: { sentinel: string },
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const calls = new Map<string, { name: string; input: string; written: { label: string; text: string } | null }>();
  // A mid-turn message can reach the file twice (the attachment, and a copy
  // beside a tool result): the second, close after the first, is dropped.
  const liftedAt = new Map<string, number>();
  // Peer names by address, from the period's peer messages: a message the
  // session sent to an address is headed with the name behind it.
  const peerNames = new Map<string, string>();
  const unnamed: Array<{ entry: TimelineEntry; address: string; summary: string | null }> = [];
  const notePeer = (p: { name: string | null; address: string | null } | null | undefined) => {
    if (p?.name && p.address) peerNames.set(p.address, p.name);
  };

  const add = (line: number, ts: string | null, kind: EntryKind, head: string, body: string, extra: Partial<TimelineEntry> = {}): TimelineEntry | null => {
    const text = body.trim();
    if (!text && !extra.written) return null;
    const entry: TimelineEntry = { id: "", line, ts, kind, head, body: text, ...extra };
    entries.push(entry);
    return entry;
  };
  const addLifted = (line: number, ts: string | null, l: Lifted) => {
    if (l.kind === "operator" && l.midTurn) {
      const key = l.body.replace(/\s+/g, " ").trim();
      const seen = liftedAt.get(key);
      if (seen !== undefined && line - seen <= 50) return;
      liftedAt.set(key, line);
      add(line, ts, "operator", `sent while ${names.voice} was working`, l.body);
      return;
    }
    notePeer(l.peer);
    add(line, ts, l.kind, l.head, l.body);
  };
  const addOperatorText = (line: number, ts: string | null, text: string) => {
    const { rest, lifted } = liftMessages(text);
    add(line, ts, "operator", "", rest);
    for (const l of lifted) addLifted(line, ts, l);
  };

  for (let i = Math.max(0, from); i <= to && i < records.length; i++) {
    const r = records[i];
    if (!r || isApiRequestRecord(r) || r.isSidechain === true) continue;
    const ts = typeof r.timestamp === "string" ? r.timestamp : null;

    if (r.type === "attachment") {
      const a = (r as any).attachment;
      if (a?.type !== "queued_command") continue;
      const text = promptText(a.prompt);
      if (!text.trim()) {
        // No prompt kept: take the message out of what the model was shown.
        const shown = Array.isArray((r as any).rendered) ? (r as any).rendered.map((x: any) => x?.content ?? "").join("\n") : "";
        for (const l of liftMessages(shown).lifted) addLifted(i, ts, l);
        continue;
      }
      const task = text.includes("<task-notification>") ? parseTask(text) : null;
      const peer = !task && text.includes("<cross-session-message") ? parsePeer(text) : null;
      if (task) addLifted(i, ts, { kind: "agent", head: task.head, body: task.body, midTurn: true });
      else if (peer) addLifted(i, ts, { kind: "peer", head: `from ${peer.from}`, body: peer.body, midTurn: true, peer });
      else if (a.origin?.kind === "human" || a.humanTurn === true || (!a.origin && a.commandMode === "prompt")) {
        addLifted(i, ts, { kind: "operator", head: "", body: text, midTurn: true });
      } else {
        add(i, ts, "agent", `notification (${a.origin?.kind ?? a.commandMode ?? "unknown"})`, text);
      }
      continue;
    }

    if (!r.uuid) continue;
    const c = r.message?.content;

    if (r.type === "assistant") {
      if (typeof c === "string") {
        add(i, ts, "voice", "", c);
        continue;
      }
      for (const b of Array.isArray(c) ? c : []) {
        if (b?.type === "tool_use" && typeof b.id === "string") {
          const name = String(b.name ?? "?");
          const written = writtenBy(name, b.input);
          calls.set(b.id, { name, input: inputText(written ? written.rest : b.input), written: written ? { label: written.label, text: written.text } : null });
          if (b.name === "SendMessage") {
            const m = sendMessageOf(b.input);
            const entry = add(i, ts, "voice", messageHead(m.name, m.summary), m.text);
            if (entry && !m.name && m.address) unnamed.push({ entry, address: m.address, summary: m.summary });
          }
        } else if (b?.type === "text" && typeof b.text === "string") {
          add(i, ts, "voice", "", b.text);
        }
      }
      continue;
    }

    if (r.type !== "user") continue;

    if (typeof c === "string") {
      if (isRecapRecord(r, opts.sentinel)) continue;
      const t = c.trimStart();
      if (t.startsWith("<task-notification")) {
        const k = parseTask(t);
        if (k) add(i, ts, "agent", k.head, k.body);
      } else if (t.includes("<cross-session-message")) {
        const p = parsePeer(t);
        notePeer(p);
        if (p) add(i, ts, "peer", `from ${p.from}`, p.body);
      } else if (r.isMeta === true) {
        // Skill text, caveats and other notes Claude Code adds as user records.
      } else if (t.startsWith("<command-")) {
        const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1]?.trim() ?? "";
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? "";
        add(i, ts, "operator", "ran a command", `${name} ${args}`);
      } else if (t.startsWith("<local-command-")) {
        // A slash command's own output: machinery.
      } else if (t.startsWith("<bash-input>")) {
        add(i, ts, "operator", "ran in the shell", t.replace(/<\/?bash-input>/g, ""));
      } else if (t.startsWith("<bash-stdout>") || t.startsWith("<bash-stderr>")) {
        add(i, ts, "tool", `shell (run by ${names.operator})`, t.replace(/<\/?bash-(stdout|stderr)>/g, ""));
      } else {
        addOperatorText(i, ts, c);
      }
      continue;
    }

    if (!Array.isArray(c)) continue;
    if (r.isMeta === true) {
      for (const b of c) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.includes("<cross-session-message")) {
          const p = parsePeer(b.text);
          notePeer(p);
          if (p) add(i, ts, "peer", `from ${p.from}`, p.body);
        }
      }
      continue;
    }
    const said: string[] = [];
    let attached = false;
    const later: Lifted[] = [];
    for (const b of c) {
      if (b?.type === "tool_result") {
        const call = calls.get(b.tool_use_id) ?? { name: "?", input: "", written: null };
        const parts: any[] = Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content ?? "") }];
        let image = false;
        const texts: string[] = [];
        for (const x of parts) {
          if (x?.type === "image") image = true;
          else if (x?.type === "text" && typeof x.text === "string") texts.push(x.text);
          else if (typeof x === "string") texts.push(x);
        }
        const { rest, lifted } = liftMessages(texts.join("\n"));
        later.push(...lifted);
        if (call.name === "SendMessage" && b.is_error !== true) continue; // the message itself is the voice's entry
        const kind: EntryKind = image ? "image" : AGENT_TOOLS.has(call.name) ? "agent" : "tool";
        const body = image ? [rest, IMAGE_SHOWN].filter(Boolean).join("\n") : rest;
        add(i, ts, kind, `${call.name} · called with: ${oneLine(call.input, INPUT_HEAD_CHARS)}`, body, {
          call: { name: call.name, input: call.input },
          ...(call.written ? { written: call.written } : {}),
        });
      } else if (b?.type === "text" && typeof b.text === "string") {
        const { rest, lifted } = liftMessages(b.text);
        if (rest) said.push(rest);
        later.push(...lifted);
      } else if (b?.type === "image") {
        attached = true;
      }
    }
    if (said.length > 0 || attached) add(i, ts, "operator", "", [...said, ...(attached ? [IMAGE_ATTACHED] : [])].join("\n"));
    for (const l of later) addLifted(i, ts, l);
  }

  for (const u of unnamed) {
    const name = peerNames.get(u.address);
    if (name) u.entry.head = messageHead(name, u.summary);
  }
  entries.forEach((e, n) => (e.id = `E-${String(n + 1).padStart(4, "0")}`));
  return entries;
}

// ─── Rendering and splitting ─────────────────────────────────────────────────

/** Break lines longer than `width` at a space (or hard), so no reader loses the end of a line. */
export function wrapLong(text: string, width = WRAP_CHARS): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width) return line;
      const out: string[] = [];
      let rest = line;
      while (rest.length > width) {
        let at = rest.lastIndexOf(" ", width);
        if (at < width / 2) at = width;
        out.push(rest.slice(0, at));
        rest = rest.slice(at).replace(/^ /, "");
      }
      out.push(rest);
      return out.join("\n");
    })
    .join("\n");
}

/** The most of an entry's body (its output, report or message) a view keeps; what was said is never cut. */
function bodyCap(kind: EntryKind, view: TimelineView): number {
  if (view === "entry" || kind === "operator" || kind === "voice") return Infinity;
  if (view === "checker" && (kind === "tool" || kind === "image")) return SHORT_TOOL_CHARS;
  if (view === "checker" && kind === "agent") return SHORT_AGENT_CHARS;
  return CLIP_CHARS;
}

/**
 * One entry as a view shows it: the readers' (the default), the checker's
 * (tool output and agent reports shortened, written text kept to
 * SHORT_WRITTEN_CHARS) or `--entry`'s (everything whole, the call's input too).
 */
export function renderEntry(e: TimelineEntry, names: TimelineNames, view: TimelineView = "readers"): string {
  let head = e.head;
  let body = clip(e.body, bodyCap(e.kind, view));
  if (e.written) {
    const max = view === "readers" ? WRITTEN_CHARS : view === "checker" ? SHORT_WRITTEN_CHARS : Infinity;
    const text =
      e.written.text.length > max
        ? `${e.written.text.slice(0, max)}\n[... ${e.written.text.length - max} more characters of the written text cut here; --entry ${e.id} prints it whole ...]`
        : e.written.text;
    body = `${e.written.label}:\n${text}${body ? `\n\nOutput:\n${body}` : ""}`;
  }
  if (view === "entry" && e.call && oneLine(e.call.input, Infinity).length > INPUT_HEAD_CHARS) {
    head = `${e.call.name} · called with: (in full below)`;
    body = `Called with:\n${e.call.input}\n\n${body}`;
  }
  const time = e.ts ? utcMinute(e.ts) : "";
  return `### ${e.id} · ${time} · ${tagOf(e.kind, names)}${head ? ` · ${head}` : ""}\n\n${wrapLong(body)}\n`;
}

/**
 * Entry ids from `--entry`: "E-0123,E-0456", "e-123", "123". Returns the ids
 * as the timeline writes them, and the words that are not an entry number.
 */
export function parseEntryIds(arg: string): { ids: string[]; bad: string[] } {
  const ids: string[] = [];
  const bad: string[] = [];
  for (const word of arg.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(?:E-?)?(\d{1,6})$/i.exec(word);
    if (!m || Number(m[1]) === 0) bad.push(word);
    else {
      const id = `E-${String(Number(m[1])).padStart(4, "0")}`;
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return { ids, bad };
}

/** Entries by tag, for the report. */
export function countByTag(entries: readonly TimelineEntry[], names: TimelineNames): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    const t = tagOf(e.kind, names);
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

/**
 * Split rendered entries into parts of at most about `maxChars` each, at
 * entry boundaries, as even as the entries allow. Returns inclusive index
 * ranges. A part can run over by at most one entry.
 */
export function splitParts(sizes: readonly number[], maxChars = PART_CHARS): Array<[number, number]> {
  if (sizes.length === 0) return [];
  const total = sizes.reduce((a, b) => a + b, 0);
  const parts = Math.max(1, Math.ceil(total / maxChars));
  const per = total / parts;
  const ranges: Array<[number, number]> = [];
  let acc = 0;
  let current = -1;
  sizes.forEach((size, i) => {
    const g = Math.min(parts - 1, Math.floor(acc / per));
    if (g !== current) {
      ranges.push([i, i]);
      current = g;
    } else {
      ranges[ranges.length - 1]![1] = i;
    }
    acc += size;
  });
  return ranges;
}
