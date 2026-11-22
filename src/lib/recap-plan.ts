/**
 * Recap plan — everything a session near its context limit needs for /remember,
 * worked out from config and the live session so the session juggles no paths
 * and counts no files: where the session lives now, the recap stack, the next
 * recap number and body path, the sentinel values, and the restart command.
 *
 * The next number comes from the session's recap stack, not from the folder:
 * the stack is what surgery keeps and what the voice has in context. The
 * folder is checked against it and disagreements come back as warnings.
 *
 * With the draft on (PlanOptions.draft), the plan also sizes the draft for
 * the next recap: its real size once `recap.ts --draft` has written it, else
 * an estimate; a written draft not yet read counts against the body budget.
 * Without it, the plan is what it was before the draft existed.
 */

import fs from "fs";
import path from "path";
import { checkRestart, displayNameOf, getVoice, isUnderAllowedRoots, recapsDirOf, restartCommandFor, type AppConfig, type VoiceConfig } from "../config.js";
import { resolveLiveSession } from "./continuation.js";
import { DRAFT_SHARE_OF_TIMELINE, charsReadOf, draftFileFor, draftTokensFor, draftsDirFor, timelineChars } from "./draft.js";
import { loadJsonl, type JsonlRecord } from "./jsonl.js";
import { readContextSize } from "./monitor.js";
import { locateCut, readPendingCut } from "./pending-cut.js";
import { decodeBodyText, formatRecapId, nextRecapNumber, recapBodyFileName, scanRecapStack } from "./recaps.js";

export interface RecapPlan {
  voice: string;
  /** The name the session answers to. */
  name: string;
  /** The sentinel name bodies must carry (config.sentinel_name). */
  sentinel_name: string;
  home: string | null;
  recaps_dir: string | null;
  memories_dir: string | null;
  /** Paths are base names unless config.expose_paths is on. */
  session: {
    configured_path: string;
    live_path: string;
    live_session_id: string;
    exists: boolean;
    continuation_hops: number;
    continuation_chain?: string[];
    broken_link?: string;
  };
  context: { tokens_total: number; percent_of_1m: number; last_usage_ts: string | null } | null;
  /**
   * How much room is left before the old session crosses the ceiling, and how
   * long the body can be. The window between --go and the restart is where
   * a session can fail to finish the cycle: this is the number to write to.
   */
  headroom: {
    ceiling_percent: number;
    tokens_to_ceiling: number;
    reserve_tokens: number;
    /** What is still to read of a written draft: counted here, so TIGHT and NO ROOM already include it. 0 without the draft. */
    draft_tokens: number;
    body_budget_chars: number;
    tight: boolean;
  } | null;
  /**
   * The draft for the next recap: its real size once `--draft` has written it,
   * else an estimate from the timeline it would be made from. Null when the
   * draft is off for this plan, or there is no session or recaps folder.
   */
  draft: {
    /** In the voice's own recaps folder: <recaps>/drafts/draft-for-<id>.md. */
    path: string;
    exists: boolean;
    /** Characters: the file's, or the estimate. */
    chars: number;
    /** About how many tokens reading all of it costs. */
    tokens: number;
    /** Written: what the session has not read yet (Read calls since it was written). Not written: all of it. */
    unread_tokens: number;
    estimated: boolean;
    /** For the estimate: the timeline's length, from the end of the recap stack up to... */
    timeline_chars: number | null;
    /** ...the pending cut, or the end of the session when there is none. */
    up_to: "pending_cut" | "now" | null;
    /** The body budget left after reading all of it (the estimate only; a written draft is counted in headroom). */
    body_budget_after_chars: number | null;
  } | null;
  /**
   * Whether `recap.ts --go --restart` can restart this session itself
   * (`selfrecap restart`), and why not when it cannot. Checked again, with
   * the calling session, when it runs.
   */
  self_restart: { available: boolean; reason: string };
  /** The recap stack at the head of the live session, oldest first. */
  stack: Array<{
    line_idx: number;
    id: string | null;
    period_covered: string | null;
    cut_through_uuid: string | null;
    applied_at: string | null;
  }>;
  next: {
    number: number;
    id: string;
    predecessor_id: string | null;
    /** Where to write the body. Null when no recaps folder is configured. */
    body_path: string | null;
    /** A body for this number is already written (not yet applied). */
    body_exists: boolean;
    /**
     * Length of that body in characters — what the headroom budget counts.
     * Not bytes: `wc -c` counts bytes, and many non-Latin characters take two
     * or more, so a body in a non-Latin script looks twice its size to it.
     */
    body_chars: number | null;
  };
  /** Recap numbers found as recap-NNN.body.txt in the recaps folder. */
  bodies_on_disk: number[];
  /** Now minus five minutes: find-cut-point's filter against matching this very conversation. */
  suggested_before_timestamp: string;
  restart_command: string | null;
  warnings: string[];
}

const BODY_RE = /^recap-(\d{3,})\.body\.txt$/;

/** The context window percent_of_1m assumes. */
const WINDOW_TOKENS = 1_000_000;
/** The line the old session must not cross before its restart: past it, the cycle may not finish. */
const CEILING = 0.97;
/**
 * Tokens kept for everything the voice does after reading the plan, apart
 * from writing the body: the searches and seam reads, the dry run, --go and
 * the report, plus its own reasoning in between.
 *
 * An estimate: the tool output of a cycle is around 12k tokens and the
 * /remember text around 12k (usually not yet in the plan's reading), so a
 * cycle with an easy seam (one search, one seam read, no backtracking) needs
 * around 24k for the whole protocol. The other 16k is a margin for hard seams,
 * where reasoning over several candidates is what grows.
 */
export const RESERVE_TOKENS = 40_000;
/** Characters per token for recap prose, counted low so the budget errs small (non-Latin text often tokenizes densely). */
const CHARS_PER_TOKEN = 2.5;
/** Below this body budget the plan says TIGHT. */
export const TIGHT_CHARS = 40_000;

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

/**
 * Paths go out with forward slashes. On Windows, Claude Code runs commands
 * through Git Bash, where an unquoted backslash path silently turns into a
 * junk file name.
 */
function slash(p: string): string;
function slash(p: string | null): string | null;
function slash(p: string | null): string | null {
  return p === null ? null : p.replace(/\\/g, "/");
}

/** Room left before the ceiling, and the body budget that leaves after the reserve and the draft still to read. */
export function headroomFor(tokensTotal: number, draftTokens = 0): NonNullable<RecapPlan["headroom"]> {
  const toCeiling = Math.max(0, Math.floor(WINDOW_TOKENS * CEILING) - tokensTotal);
  const budget = Math.max(0, Math.floor((toCeiling - RESERVE_TOKENS - draftTokens) * CHARS_PER_TOKEN));
  return {
    ceiling_percent: CEILING * 100,
    tokens_to_ceiling: toCeiling,
    reserve_tokens: RESERVE_TOKENS,
    draft_tokens: draftTokens,
    body_budget_chars: budget,
    tight: budget < TIGHT_CHARS,
  };
}

/**
 * Whether `selfrecap restart` can be scheduled for this voice, from config
 * and platform alone. The calling session, the PowerShell parse of the
 * command and the lock are checked when it runs.
 */
export function selfRestartFor(name: string, entry: VoiceConfig, platform: string = process.platform): RecapPlan["self_restart"] {
  if (platform !== "win32") {
    return { available: false, reason: "selfrecap restart is Windows-only: after --go the operator restarts the session with the restart command" };
  }
  if (!entry.restart) return { available: false, reason: `no restart command in config.yaml for ${name}: after --go the operator restarts the session by hand` };
  const check = checkRestart(entry.session, entry.restart);
  if (check.errors.length > 0) return { available: false, reason: `the restart command fails its checks (${check.errors[0]}): the operator restarts the session by hand` };
  return { available: true, reason: "--go --restart runs the surgery, then schedules selfrecap restart for the session that runs it" };
}

export interface PlanOptions {
  /**
   * Size the draft and count a written one in headroom. Off unless asked
   * for: it reads the whole period. The plan route asks when the draft is on
   * (recap.ts says which, by its own config and SELFRECAP_DRAFT); the
   * nudger, check-config and selfrecap restart never do, so their "no room"
   * stays about the body alone.
   */
  draft?: boolean;
  /**
   * The pending cut the draft's estimate runs up to, as recap.ts holds it.
   * Without it the pending-cut file in the log folder is read.
   */
  cut?: string;
  /** Where pending cuts are kept (tests). */
  logDir?: string;
}

/**
 * The draft for the next recap, from what the plan already read. Lives here,
 * beside the headroom it is counted in, so the plan route, `--plan` and the
 * TIGHT line read one number.
 */
function draftInfo(
  config: AppConfig,
  records: ReadonlyArray<JsonlRecord>,
  name: string,
  display: string,
  bodyPath: string,
  nextId: string,
  opts: PlanOptions,
): NonNullable<RecapPlan["draft"]> {
  const file = draftFileFor(draftsDirFor(bodyPath), nextId);
  if (fs.existsSync(file)) {
    const chars = fs.readFileSync(file, "utf8").length;
    const tokens = draftTokensFor(chars);
    const read = charsReadOf(records, file, fs.statSync(file).mtimeMs);
    return {
      path: slash(file),
      exists: true,
      chars,
      tokens,
      unread_tokens: draftTokensFor(Math.max(0, chars - read)),
      estimated: false,
      timeline_chars: null,
      up_to: null,
      body_budget_after_chars: null,
    };
  }
  const sentinel = { sentinel: config.sentinel_name };
  const from = scanRecapStack(records, config.sentinel_name).end;
  const cut = opts.cut ?? readPendingCut(name, opts.logDir)?.cut_uuid ?? null;
  const at = cut ? locateCut(records, cut, sentinel) : null;
  const to = at?.ok ? at.idx : records.length - 1;
  const timeline = timelineChars(records, from, to, { operator: config.draft.operator, voice: display }, sentinel);
  const chars = Math.round(timeline.chars * DRAFT_SHARE_OF_TIMELINE);
  const tokens = draftTokensFor(chars);
  return {
    path: slash(file),
    exists: false,
    chars,
    tokens,
    unread_tokens: tokens,
    estimated: true,
    timeline_chars: timeline.chars,
    up_to: at?.ok ? "pending_cut" : "now",
    body_budget_after_chars: null,
  };
}

/** The recap plan for one voice (case-insensitive name). Throws UnknownVoiceError. */
export function buildRecapPlan(config: AppConfig, voiceName: string, now = new Date(), opts: PlanOptions = {}): RecapPlan {
  const { name, entry } = getVoice(config, voiceName);
  const warnings: string[] = [];

  const resolved = resolveLiveSession(entry.session);
  const livePath = resolved.resolved_path;
  const liveId = path.basename(livePath, ".jsonl");
  const inRoots = isUnderAllowedRoots(config, path.resolve(livePath)).ok;
  if (!inRoots) warnings.push("the session file is outside allowed_roots: it is not read, and surgery would refuse it");
  const exists = inRoots && fs.existsSync(livePath);
  if (inRoots && !exists) warnings.push(`session file not found: ${config.expose_paths ? livePath : path.basename(livePath)}`);
  if (resolved.broken_link) {
    warnings.push(
      `continuation chain broken: the session was continued into ${resolved.broken_link}, whose file is gone. ` +
        `Surgery is refused until config.yaml points at the live file.`,
    );
  }

  const records = exists ? loadJsonl(livePath) : [];
  const stack = scanRecapStack(records, config.sentinel_name);
  const next = nextRecapNumber(stack);
  if (next.basis === "count") warnings.push("some recap ids in the stack carry no number; the next number is a count");
  const lastRecap = stack.recaps[stack.recaps.length - 1];
  const reading = exists ? readContextSize(livePath, name) : null;

  const recapsDir = recapsDirOf(entry);
  let bodies: number[] = [];
  let bodyPath: string | null = null;
  let bodyExists = false;
  let bodyChars: number | null = null;
  if (!recapsDir) {
    warnings.push(`no recaps folder configured for ${name}: set recaps (or home) in config.yaml`);
  } else if (!fs.existsSync(recapsDir)) {
    warnings.push(`recaps folder does not exist: ${recapsDir}`);
  } else {
    bodies = fs
      .readdirSync(recapsDir)
      .map((f) => BODY_RE.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => parseInt(m[1]!, 10))
      .sort((a, b) => a - b);
    bodyPath = path.join(recapsDir, recapBodyFileName(next.number));
    bodyExists = fs.existsSync(bodyPath);
    if (bodyExists) bodyChars = decodeBodyText(fs.readFileSync(bodyPath)).length;
    const beyond = bodies.filter((n) => n > next.number);
    if (beyond.length > 0) {
      warnings.push(
        `the recaps folder has recap-${beyond.map(pad).join(", recap-")} beyond the next number ${pad(next.number)}; ` +
          `the session's stack decides the number`,
      );
    }
    if (stack.recaps.length > 0 && bodies.length === 0) {
      warnings.push(`the session carries ${stack.recaps.length} recap(s) but ${recapsDir} holds no recap bodies: is recaps the right folder?`);
    }
  }
  if (!entry.restart) warnings.push(`no restart command configured for ${name}: set restart in config.yaml so --go can print it`);

  const display = displayNameOf(name, entry);
  const nextId = formatRecapId(name, next.number);
  let draft: RecapPlan["draft"] = null;
  // No recaps folder, no draft: it lives only in the voice's own folder.
  if (opts.draft === true && exists && bodyPath) {
    try {
      draft = draftInfo(config, records, name, display, bodyPath, nextId, opts);
    } catch (e: any) {
      warnings.push(`the draft's size could not be worked out: ${!config.expose_paths && typeof e?.path === "string" ? `${e.code ?? "error"} (${e.syscall ?? "fs"})` : (e?.message ?? e)}`);
    }
  }
  const headroom = reading ? headroomFor(reading.tokens_total, draft?.exists ? draft.unread_tokens : 0) : null;
  if (draft?.estimated && reading) draft.body_budget_after_chars = headroomFor(reading.tokens_total, draft.tokens).body_budget_chars;

  const show = (p: string) => (config.expose_paths ? slash(p) : path.basename(p));
  return {
    voice: name,
    name: display,
    sentinel_name: config.sentinel_name,
    home: slash(entry.home ?? null),
    recaps_dir: slash(recapsDir),
    memories_dir: entry.home ? slash(path.join(entry.home, "memories")) : null,
    session: {
      configured_path: show(resolved.configured_path),
      live_path: show(livePath),
      live_session_id: liveId,
      exists,
      continuation_hops: resolved.continuation_hops,
      ...(resolved.continuation_chain ? { continuation_chain: resolved.continuation_chain } : {}),
      ...(resolved.broken_link ? { broken_link: resolved.broken_link } : {}),
    },
    context: reading
      ? { tokens_total: reading.tokens_total, percent_of_1m: reading.percent_of_1m, last_usage_ts: reading.last_usage_ts }
      : null,
    headroom,
    draft,
    self_restart: selfRestartFor(name, entry),
    stack: stack.recaps.map((r) => ({
      line_idx: r.index,
      id: r.id,
      period_covered: r.period_covered,
      cut_through_uuid: r.cut_through_uuid,
      applied_at: r.applied_at,
    })),
    next: {
      number: next.number,
      id: nextId,
      predecessor_id: lastRecap?.id ?? null,
      body_path: slash(bodyPath),
      body_exists: bodyExists,
      body_chars: bodyChars,
    },
    bodies_on_disk: bodies,
    suggested_before_timestamp: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    restart_command: restartCommandFor(entry, liveId),
    warnings,
  };
}
