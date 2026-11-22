#!/usr/bin/env tsx
/**
 * recap — everything a session runs for /remember. The server knows where the
 * session and its recap bodies live (config.yaml), so the session passes its
 * voice name. No curl anywhere: requests go out from Node, so non-Latin text
 * and other non-ASCII characters arrive intact.
 *
 * The cycle:
 *   1. --find "<phrase>"   names the cut and saves it as the pending cut ("Cut saved")
 *   2. --draft             (opt-in) a cold reader reads the period up to the cut; the draft is written beside the body.
 *                          The session reads ALL of it, then writes the body itself, from memory.
 *   3. --check             (opt-in) a cold model compares the body with the record; the report is printed (one round)
 *   4. --go --restart      dry run, execute only if every check is clean, then schedule `selfrecap restart`
 *                          (Windows, with a restart command); elsewhere: --go, and the operator restarts the session
 *
 * The draft and the check are OFF unless config.yaml says `draft: { enabled: true }`
 * or the environment has SELFRECAP_DRAFT=1 (the environment wins; SELFRECAP_DRAFT=0
 * turns them off). Off, --draft and --check refuse with one line and nothing
 * else changes: --find, --cut, --entry, the placeholder fill and --go --restart
 * cost nothing and work either way.
 *
 * Usage:
 *   npx tsx scripts/recap.ts <voice> --plan                        context, headroom, stack, next recap, body path, pending cut, restart
 *   npx tsx scripts/recap.ts <voice> --find "<phrase>"             search the session; names the cut for a user match and saves it
 *   npx tsx scripts/recap.ts <voice> --cut <uuid>                  set the pending cut directly
 *   npx tsx scripts/recap.ts <voice> --around <line> [--span N]    read the records around a line (default ±30)
 *   npx tsx scripts/recap.ts <voice> --at <ISO time>               the last record before a moment
 *   npx tsx scripts/recap.ts <voice> --draft                       the draft (opt-in): a cold reader reads the period up to the pending cut
 *   npx tsx scripts/recap.ts <voice> --check                       the check (opt-in) of the body at the plan's body path
 *   npx tsx scripts/recap.ts <voice> --entry E-0123[,E-0456]       print timeline entries in full (the numbers a draft line ends with)
 *   npx tsx scripts/recap.ts <voice> --draft-clean                 remove the work folder (it holds the raw period)
 *   npx tsx scripts/recap.ts <voice>                               dry-run the body at the plan's body path
 *   npx tsx scripts/recap.ts <voice> --go                          execute for real
 *   npx tsx scripts/recap.ts <voice> --go --restart                execute only if the dry run is clean, then schedule selfrecap restart
 *   npx tsx scripts/recap.ts <voice> <body-file> [--go|--check]    explicit body file (the 1.0 form, still works)
 *
 * Flags:
 *   --go              execute (default is a dry run)
 *   --restart         with --go: dry run first, execute only if every check passes, then schedule the restart
 *                     (Windows only; refused before anything is cut where it cannot run)
 *   --force           allow the cut to delete a recap record outside the leading stack (not with --restart)
 *   --json            print the server's full response instead of the checklist
 *   --before <ISO>    with --find: only matches before this time (default: the plan's, now minus 5 minutes); `now` for no cutoff
 *   --split           with --draft: parts of about 230,000 characters, up to 4 readers at once on draft.split_reader_model
 *                     (the default is one reader over the whole period, or the fewest parts over 1,000,000 characters)
 *   --reader-model m  with --draft: the readers' model (default draft.reader_model, or draft.split_reader_model with --split)
 *   --part <n>        with --draft: run only reader n; the other parts keep the lines an earlier run left
 *   --prepare-only    with --draft: build the timeline and the briefs, start nothing, print the prompts
 *   --check-model m   with --check: the checker's model (default draft.check_model)
 *   --operator <name> what the timeline and the briefs call the person you work with (default draft.operator)
 *   --server <url>    server URL (default http://127.0.0.1:9090)
 *
 * `--find -` reads the phrase from stdin.
 *
 * Auth: the POST routes (/find-cut-point, /surgery) require the X-Recap-Token
 * header. This script reads the token the server generated at
 * ~/.selfrecap/token and sends it.
 *
 * Local files: the pending cut is logs/recap-state/<voice>.pending-cut.json
 * (RECAP_LOG_DIR moves logs/). --cut,
 * --draft, --check, --entry and --go --restart read the server's config.yaml
 * themselves (in the parent of scripts/, or RECAP_CONFIG) to find the live session
 * file without the server handing out its path. Everything of the period
 * stays in the voice's own folder: the draft and the check report in
 * <recaps>/drafts/, the raw period in <recaps>/drafts/.work/, removed after a
 * successful --go. A voice with no recaps folder gets no draft and no check.
 *
 * Exit codes: 0 done (or already done), 1 refused or invalid input,
 * 2 server unreachable or erroring.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { DEFAULTS, DEFAULT_SENTINEL, DRAFT_ENV, draftGate, getVoice, isUnderAllowedRoots, loadConfig, type AppConfig } from "../src/config.js";
import { resolveLiveSession } from "../src/lib/continuation.js";
import {
  checkFileFor,
  draftFileFor,
  draftTokensFor,
  draftsDirFor,
  draftsGitLine,
  ensureDraftsDir,
  entryCut,
  layoutLine,
  mergeDraft,
  prepareDraft,
  promptFor,
  readMeta,
  readerModelFor,
  removeWorkDir,
  runCheck,
  runReaders,
  sumRuns,
  uncoveredNotice,
  workDirFor,
  type DraftContext,
} from "../src/lib/draft.js";
import { checkClaudeVersion, runHeadless, type HeadlessResult } from "../src/lib/headless.js";
import { loadJsonl, type JsonlRecord } from "../src/lib/jsonl.js";
import { DEFAULT_SERVER, recapCommand } from "../src/lib/next-command.js";
import { clearPendingCut, locateCut, readPendingCut, savePendingCut } from "../src/lib/pending-cut.js";
import { TIGHT_CHARS, headroomFor } from "../src/lib/recap-plan.js";
import { CUT_PLACEHOLDER, decodeBodyText, fillSentinelCut, parseSentinel, sentinelParseError, sentinelRe } from "../src/lib/recaps.js";
import { RestartError, WINDOWS_ONLY, callerSession, goRestartPreflight, scheduleSelfRestart } from "../src/lib/restart.js";
import type { LiveSession } from "../src/lib/sessions.js";
import { dryRunFailures } from "../src/lib/surgery.js";
import { buildTimeline, parseEntryIds, renderEntry, utcMinute } from "../src/lib/timeline.js";

/** A recap applied this recently is taken to be the surgery just run. */
const RECENT_MINUTES = 120;
const REPO = fileURLToPath(new URL("../", import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--server", "--find", "--around", "--span", "--at", "--before", "--cut", "--reader-model", "--check-model", "--part", "--operator", "--entry"]);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (VALUE_FLAGS.has(args[i]!)) {
    i++;
    continue;
  }
  if (!args[i]!.startsWith("-")) positional.push(args[i]!);
}
const serverBase = (flag("--server") ?? DEFAULT_SERVER).replace(/\/+$/, "");
const voice = positional[0];
const explicitBody = positional[1];
const go = args.includes("--go");
const restart = args.includes("--restart");
const force = args.includes("--force");
const asJson = args.includes("--json");

/** A recap.ts command to print for the session to run next: it carries --server, --operator and the body file where they apply (next-command.ts). */
const nextCmd = (...a: string[]) => recapCommand(voice!, a, { server: serverBase, operator: flag("--operator"), body: explicitBody });

if (!voice || args.includes("--help") || args.includes("-h")) {
  console.error("Usage:");
  console.error("  npx tsx scripts/recap.ts <voice> --plan                        context, headroom, stack, next recap, body path, pending cut, restart");
  console.error('  npx tsx scripts/recap.ts <voice> --find "<phrase>"             search the session; names the cut for a user match and saves it');
  console.error("  npx tsx scripts/recap.ts <voice> --cut <uuid>                  set the pending cut directly");
  console.error("  npx tsx scripts/recap.ts <voice> --around <line> [--span N]    read the records around a line (default ±30)");
  console.error("  npx tsx scripts/recap.ts <voice> --at <ISO time>               the last record before a moment");
  console.error("  npx tsx scripts/recap.ts <voice> --draft                       the draft (opt-in): a cold reader reads the period up to the pending cut");
  console.error("  npx tsx scripts/recap.ts <voice> --check                       the check (opt-in): a cold model compares the body with the record");
  console.error("  npx tsx scripts/recap.ts <voice> --entry E-0123[,E-0456]       print timeline entries in full (the numbers a draft line ends with)");
  console.error("  npx tsx scripts/recap.ts <voice> --draft-clean                 remove the work folder (it holds the raw period)");
  console.error("  npx tsx scripts/recap.ts <voice> [--go] [--force]              dry-run (or execute) the body at the plan's body path");
  console.error("  npx tsx scripts/recap.ts <voice> --go --restart                execute only if the dry run is clean, then schedule selfrecap restart (Windows)");
  console.error("  npx tsx scripts/recap.ts <voice> <body-file> [--go|--check]    same, with an explicit body file");
  console.error("");
  console.error("The draft and the check are off unless config.yaml has draft.enabled: true (or SELFRECAP_DRAFT=1).");
  console.error("");
  console.error("Flags: --json (full server response), --before <ISO|now> (with --find), --split, --reader-model <m>, --part <n>,");
  console.error("       --prepare-only (with --draft), --check-model <m> (with --check), --operator <name>, --server <url>");
  process.exit(1);
}

async function request(url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; text: string; data: any }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e: any) {
    console.error(`Request failed: ${e.message}`);
    console.error(`Is the server running at ${serverBase}?`);
    process.exit(2);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON; the caller reports it.
  }
  return { status: res.status, ok: res.ok, text, data };
}

function authToken(): string {
  const tokenPath = path.join(os.homedir(), ".selfrecap", "token");
  try {
    return fs.readFileSync(tokenPath, "utf8").trim();
  } catch {
    console.error(`Auth token not found at ${tokenPath}.`);
    console.error("Start the selfrecap server at least once so it can generate the token, then retry.");
    process.exit(2);
  }
}

const post = (route: string, body: unknown) =>
  request(`${serverBase}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", "X-Recap-Token": authToken() },
    body: JSON.stringify(body),
  });

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 60000));
}

/** The restart command, or words that cannot be mistaken for one. */
function restartLine(command: string | null | undefined, sessionId: string | undefined): string {
  return (
    command ??
    `claude --resume ${sessionId ?? "<session-id>"}  (no restart command in config.yaml for ${voice}: run it in the session's own folder, on its own account)`
  );
}

const n = (x: number) => x.toLocaleString("en-US");
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const seconds = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.round(ms / 1000)} s`);
/** The time now for a progress line, in UTC like every time this script prints. */
const clock = () => `${new Date().toISOString().slice(11, 19)} UTC`;
const slash = (p: string) => p.replace(/\\/g, "/");

/** How a record reads in a list: "user", "user (tool result)", "system/turn_duration", ... */
function kind(r: any): string {
  if (r.type === "user" && r.is_tool_result) return "user (tool result)";
  return `${r.type ?? "?"}${r.subtype ? `/${r.subtype}` : ""}`;
}

/** An ISO time in UTC to the second, "2026-01-15T09:30:00Z" (what --at takes); the text as it is when it does not parse. */
function isoZ(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${new Date(t).toISOString().slice(0, 19)}Z`;
}

/** A time given on the command line, read the way the script reads it and sent on in UTC, so what is printed is what is used. */
function utcIso(given: string): string {
  const t = Date.parse(given);
  return Number.isNaN(t) ? given : new Date(t).toISOString();
}

/** A record's time in a list: UTC, to the second. */
function time(iso: string | null | undefined): string {
  return iso ? isoZ(iso).padEnd(20) : " ".repeat(20);
}

// ─── The local config ──────────────────────────────────────────────────────

/**
 * The config.yaml this script reads itself: in the selfrecap folder (the
 * parent of scripts/), or RECAP_CONFIG, the
 * same file the server reads when both run from this checkout. It decides
 * whether the draft and the check are on, names the operator, and lets
 * --cut, --draft, --check, --entry and --go --restart find the live session
 * file (the server hands out only its base name unless expose_paths).
 */
let localCache: { config: AppConfig; found: boolean; note: string | null } | null = null;
function local(): { config: AppConfig; found: boolean; note: string | null } {
  if (localCache) return localCache;
  const file = process.env.RECAP_CONFIG || path.join(REPO, "config.yaml");
  if (!fs.existsSync(file)) {
    const note = process.env.RECAP_CONFIG
      ? `RECAP_CONFIG names ${file}, which is not there`
      : "no config.yaml in the selfrecap folder (the parent of scripts/) and no RECAP_CONFIG";
    localCache = { config: { ...DEFAULTS, problems: [] }, found: false, note };
  } else {
    try {
      localCache = { config: loadConfig(file), found: true, note: null };
    } catch (e: any) {
      localCache = { config: { ...DEFAULTS, problems: [] }, found: false, note: `config.yaml did not load (${e?.message ?? e})` };
    }
  }
  return localCache;
}

/** Whether the draft and the check are on here: config draft.enabled, overridden by SELFRECAP_DRAFT. */
function draftOn(): boolean {
  return draftGate(local().config).enabled;
}

/** The one line --draft and --check print when the draft is off. */
function refuseDraftOff(what: string): never {
  fail(`${what} is off: set draft.enabled: true in config.yaml (or ${DRAFT_ENV}=1) to use it. Nothing was started.`);
}

/** A path for a message: in full only with expose_paths (the voice's own recaps folder is always shown in full). */
const show = (p: string) => (local().config.expose_paths ? slash(p) : path.basename(p));

// ─── Plan ──────────────────────────────────────────────────────────────────

async function getPlan(required: boolean): Promise<any> {
  // The draft's estimate runs up to the pending cut this script holds: the server is told it, not left to find it.
  const pending = draftOn() ? readPendingCut(voice!.toLowerCase()) : null;
  const query = `draft=${draftOn() ? 1 : 0}${pending ? `&cut=${encodeURIComponent(pending.cut_uuid)}` : ""}`;
  const res = await request(`${serverBase}/voices/${encodeURIComponent(voice!)}/recap-plan?${query}`);
  if (res.ok) return res.data;
  if (res.data?.error === "voice_not_found") fail(res.data.message);
  if (required) {
    console.error(`Could not get the recap plan (HTTP ${res.status}): ${res.text}`);
    if (res.status === 404) console.error("The server is older than this script (no recap-plan route): tell the operator.");
    process.exit(2);
  }
  return null; // An older server has no plan route; with an explicit body file we carry on without it.
}

/** The voice's config key: the plan's when there is one. */
const voiceKey = (plan: any | null): string => plan?.voice ?? voice!.toLowerCase();

/** The names the timeline and the briefs use. */
function namesFor(plan: any): { operator: string; voice: string } {
  const key: string = plan.voice;
  return { operator: flag("--operator") ?? local().config.draft.operator, voice: plan.name ?? key.charAt(0).toUpperCase() + key.slice(1) };
}

const sentinelOf = (plan: any | null): string => plan?.sentinel_name ?? DEFAULT_SENTINEL;

/**
 * The live session's records, read from disk. The file is found through this
 * script's own config.yaml, kept to allowed_roots, and must be the session
 * the server's plan names; null with the reason when it cannot be.
 */
function tryLiveRecords(plan: any): { records: JsonlRecord[] } | { error: string } {
  const { config, found, note } = local();
  if (!found) return { error: `this command reads the session file itself, through the server's config.yaml, and ${note}: set RECAP_CONFIG to it` };
  let entry;
  try {
    entry = getVoice(config, plan.voice).entry;
  } catch {
    return { error: `${plan.voice} is not in the config.yaml this script read, but the server knows it: set RECAP_CONFIG to the server's config.yaml` };
  }
  const live = resolveLiveSession(entry.session).resolved_path;
  if (!isUnderAllowedRoots(config, path.resolve(live)).ok) return { error: "the session file is outside allowed_roots: it is not read" };
  if (path.basename(live, ".jsonl") !== plan.session?.live_session_id) {
    return { error: `the config.yaml this script read leads to session ${path.basename(live, ".jsonl")}, the server's to ${plan.session?.live_session_id}: set RECAP_CONFIG to the server's config.yaml` };
  }
  if (!fs.existsSync(live)) return { error: `the live session file is not there: ${show(live)}` };
  return { records: loadJsonl(live) };
}

function liveRecords(plan: any): JsonlRecord[] {
  const r = tryLiveRecords(plan);
  if ("error" in r) fail(`Cannot read your session: ${r.error}.`);
  return r.records;
}

/** The pending cut, when it was chosen in the session that is live now. */
function pendingFor(plan: any | null): { cut_uuid: string } | null {
  if (!plan) return null;
  const p = readPendingCut(plan.voice);
  return p && p.session_id === plan.session?.live_session_id ? p : null;
}

/** The pending cut line(s) for --plan. */
function pendingCutLines(plan: any): Array<[string, string]> {
  const pending = readPendingCut(plan.voice);
  if (!pending) return [["Pending cut", "none (--find saves the cut it names; --cut <uuid> sets one)"]];
  const how = `saved ${utcMinute(pending.saved_at)} by ${pending.source === "find" ? `--find "${oneLine(pending.phrase ?? "", 40)}"` : "--cut"}`;
  const lines: Array<[string, string]> = [];
  if (pending.session_id !== plan.session?.live_session_id) {
    lines.push(["Pending cut", `${pending.cut_uuid}  NOT USABLE: it was saved in session ${pending.session_id}; the live one is ${plan.session?.live_session_id}. Set it again with --find or --cut.`]);
    return lines;
  }
  const live = plan.session?.exists ? tryLiveRecords(plan) : null;
  const at = live && "records" in live ? locateCut(live.records, pending.cut_uuid, { sentinel: sentinelOf(plan) }) : null;
  if (at && !at.ok) {
    lines.push(["Pending cut", `${pending.cut_uuid}  NOT USABLE: ${at.reason}. Set it again with --find or --cut.`]);
    return lines;
  }
  const where = at?.ok ? `line ${at.idx}, ${at.record}` : `line ${pending.line ?? "?"} when saved${pending.record ? `, ${pending.record}` : ""}`;
  lines.push(["Pending cut", `${pending.cut_uuid}  (${where}; ${how})`]);
  if (pending.boundary) lines.push(["", `opens the new arc: "${oneLine(pending.boundary, 70)}"`]);
  return lines;
}

const kTokens = (t: number) => `${Math.max(1, Math.round(t / 1000))}k tokens`;

/** The plan's Draft line: the real size and what is left to read, or the estimate and what reading it would leave. */
function draftLine(plan: any): string | null {
  const d = plan.draft;
  if (!d) return null;
  if (d.exists) {
    const left =
      d.unread_tokens === 0
        ? "read since it was written: already in your context"
        : d.unread_tokens < d.tokens
          ? `about ${kTokens(d.unread_tokens)} of it not read yet, counted in Headroom`
          : "counted in Headroom until you have read it";
    return `${d.path}  (${n(d.chars)} characters, about ${kTokens(d.tokens)} to read; ${left})`;
  }
  const upTo = d.up_to === "pending_cut" ? "up to the pending cut" : "up to now (no pending cut)";
  let text =
    `not made yet; a long period takes many minutes to read, so make it early. Estimate: about ${kTokens(d.tokens)} to read, ` +
    `a tenth of the ${n(d.timeline_chars)} characters of timeline since your last recap ${upTo}`;
  if (d.body_budget_after_chars != null) {
    const after = d.body_budget_after_chars;
    text += after <= 0 ? ". Reading it would leave NO ROOM for the body: skip the draft" : `. Reading it would leave ~${n(after)} characters for the body${after < TIGHT_CHARS ? ": TIGHT, skip the draft" : ""}`;
  }
  return text;
}

/** Whether this session can restart itself after --go: the plan says, or (an older server) Windows with a restart command. */
const canSelfRestart = (plan: any | null): boolean =>
  plan?.self_restart ? plan.self_restart.available === true : process.platform === "win32" && !!plan?.restart_command;

function printPlan(plan: any, extra: Array<[string, string]> = []): void {
  const s = plan.session;
  const ctx = plan.context;
  const stack: any[] = plan.stack ?? [];
  const last = stack[stack.length - 1];
  const withDraft = draftOn();
  console.log(`─── Recap plan: ${plan.voice} ───`);
  let context = "(no reading)";
  if (ctx) {
    context = `${ctx.percent_of_1m}% (${n(ctx.tokens_total)} tokens), last usage ${ctx.last_usage_ts ?? "none"}`;
    const lastAt = Date.parse(last?.applied_at ?? "");
    const usageAt = Date.parse(ctx.last_usage_ts ?? "");
    if (!Number.isNaN(lastAt) && !Number.isNaN(usageAt) && lastAt > usageAt) {
      context += "  (taken before your last surgery; it updates once your first reply after the restart is recorded)";
    }
  }
  console.log(`Context        ${context}`);
  const h = plan.headroom;
  if (h) {
    const draftTokens: number = h.draft_tokens ?? 0;
    // Without the draft's share: what a session that skips reading it has.
    const withoutDraft = draftTokens > 0 && ctx ? headroomFor(ctx.tokens_total).body_budget_chars : null;
    // "NO ROOM" means: do not recap. With room for the body alone, it is TIGHT: skip the draft.
    const verdict =
      h.body_budget_chars <= 0
        ? withoutDraft
          ? `TIGHT: no room to read the draft as well. Skip it, and write the body short, in under ~${n(withoutDraft)} characters`
          : "NO ROOM: do not write a recap now; tell the operator"
        : `write the body in under ~${n(h.body_budget_chars)} characters (characters, not bytes: \`wc -c\` counts a multi-byte character two or more times)` +
          `${withoutDraft ? `, ~${n(withoutDraft)} if you skip the draft` : ""}` +
          `${h.tight ? (withDraft ? ". TIGHT: skip the draft, write short, dry-run, --go, restart, report, stop" : ". TIGHT: write short, dry-run, --go, restart, report, stop") : ""}`;
    const kept = `${n(h.reserve_tokens)} kept for the rest of the protocol${draftTokens > 0 ? `, ${n(draftTokens)} for the draft still to read` : ""}`;
    console.log(`Headroom       ${n(h.tokens_to_ceiling)} tokens to ${h.ceiling_percent}%, ${kept}: ${verdict}`);
  }
  const dl = withDraft ? draftLine(plan) : null;
  if (dl) console.log(`Draft          ${dl}`);
  console.log(
    `Session        ${s.live_session_id}${s.continuation_hops > 0 ? `  (continued ${s.continuation_hops}x from the configured anchor)` : ""}`,
  );
  console.log(`               ${s.live_path}${s.exists ? "" : "  (FILE NOT FOUND)"}`);
  if (stack.length === 0) {
    console.log("Recap stack    none yet: this is your first recap");
  } else {
    const range = stack.length === 1 ? `1 recap: ${last.id ?? "?"}` : `${stack.length} recaps: ${stack[0].id ?? "?"} .. ${last.id ?? "?"}`;
    console.log(`Recap stack    ${range}`);
    console.log(`               last: ${last.id ?? "?"}${last.period_covered ? `, period ${last.period_covered}` : ""}`);
    console.log("               (they are the first messages of your context; no need to re-read them from disk)");
  }
  console.log(`Next recap     ${plan.next.id}`);
  if (plan.next.body_path) {
    const written =
      plan.next.body_chars != null
        ? `(already written: ${n(plan.next.body_chars)} characters${h ? ` of the ~${n(h.body_budget_chars)} budget` : ""}; surgery will use it)`
        : "(not written yet)";
    console.log(`Body file      ${plan.next.body_path}  ${plan.next.body_exists ? written : "(not written yet)"}`);
  } else {
    console.log("Body file      (no recaps folder configured: pass a body path)");
  }
  const sentinelFields = [`"sentinel": "${sentinelOf(plan)}"`, `"voice": "${plan.voice}"`, `"id": "${plan.next.id}"`];
  if (plan.next.predecessor_id) sentinelFields.push(`"predecessor_recap": "${plan.next.predecessor_id}"`);
  console.log(`Sentinel       ${sentinelFields.join(", ")}`);
  console.log(`               "cut_through_uuid": "${CUT_PLACEHOLDER}" is filled from the pending cut by the dry run${withDraft ? " (or --check)" : ""}`);
  if (plan.memories_dir) console.log(`Memories       ${plan.memories_dir}`);
  console.log(`Search cutoff  ${plan.suggested_before_timestamp}  (now minus 5 minutes; --find uses it)`);
  for (const [label, text] of extra) console.log(`${label.padEnd(15)}${text}`);
  console.log(`Restart        ${restartLine(plan.restart_command, s.live_session_id)}`);
  if (plan.self_restart) {
    console.log(`Self-restart   ${plan.self_restart.available ? "yes" : "no"}: ${plan.self_restart.reason}`);
  } else if (plan.restart_command) {
    console.log("               (selfrecap restart runs exactly this, on Windows; see Step 8)");
  }
  for (const w of plan.warnings ?? []) console.log(`Warning        ${w}`);
  const note = local().note;
  if (withDraft && note) console.log(`Warning        ${note}`);
  const gateNote = draftGate(local().config).note;
  if (gateNote) console.log(`Warning        ${gateNote}`);
}

if (args.includes("--plan")) {
  const plan = await getPlan(true);
  printPlan(plan, pendingCutLines(plan));
  process.exit(0);
}

// ─── Reading the session: --find, --cut, --around, --at ────────────────────

function printRows(records: any[], mark?: number): void {
  const lineOf = new Map<string, number>();
  for (const r of records) if (r.uuid) lineOf.set(r.uuid, r.line_index);
  for (const r of records) {
    const parent = r.parent_uuid ? (lineOf.has(r.parent_uuid) ? `← ${lineOf.get(r.parent_uuid)}` : `← ${r.parent_uuid.slice(0, 8)}…`) : "";
    const prefix = r.line_index === mark ? ">" : " ";
    console.log(
      `${prefix}${String(r.line_index).padStart(5)}  ${kind(r).padEnd(26)} ${(r.uuid ?? "(no uuid)").padEnd(36)} ${parent.padEnd(12)} ${time(r.timestamp)}  ${oneLine(r.content_preview ?? "", 70)}`,
    );
  }
}

/** A typed user message: the kind whose parent is a cut. */
const typedUser = (m: any) => m.type === "user" && m.selectable && !m.is_tool_result;

const findArg = flag("--find");
if (findArg !== undefined) {
  const phrase = findArg === "-" ? fs.readFileSync(0, "utf8").trim() : findArg;
  if (!phrase || phrase.length < 3) fail("--find needs a phrase of at least 3 characters (6+ distinctive words from one line work best).");
  const plan = await getPlan(false);
  const beforeArg = flag("--before");
  // `--before now` searches to the end: for a boundary the cutoff hid.
  const before = beforeArg === "now" ? new Date().toISOString() : beforeArg !== undefined ? utcIso(beforeArg) : plan?.suggested_before_timestamp;
  const search = (cutoff?: string) =>
    post("/find-cut-point", { voice, method: "marker_phrase", phrase, exclude_recap: true, limit: 20, ...(cutoff ? { before_timestamp: cutoff } : {}) });
  const res = await search(before);
  if (!res.ok) fail(`Search failed (HTTP ${res.status}): ${res.data?.message ?? res.text}`, res.status >= 500 ? 2 : 1);
  const r = res.data;
  console.log(`─── ${r.total_matches} match(es) for "${oneLine(phrase, 60)}"${before ? ` before ${before}` : ""}${r.truncated ? `, first ${r.returned_count} shown` : ""} ───`);
  printRows(r.matches);
  const typed = r.matches.filter(typedUser);
  if (r.total_matches === 0) {
    // The cutoff keeps the search off this very conversation, and it also
    // hides a boundary from the last five minutes. Look past it, but only to
    // say what is there: a match after the cutoff is often the session's own
    // conversation (someone quoting the phrase), so it is never saved.
    const late = before ? await search() : null;
    if (late?.ok && late.data.total_matches > 0) {
      const where = beforeArg === undefined ? ", in the last five minutes (they hold this conversation too)" : "";
      console.log(`Nothing before the cutoff, but ${late.data.total_matches} match(es) after it${where}:`);
      printRows(late.data.matches);
      console.log("If your boundary message is one of these, search again with --before now (or --before <a time just after it>). No cut was saved.");
    } else {
      console.log("No match. Usually the phrase crosses a line break, or its punctuation differs (— vs -, ’ vs '). Try 4–6 words from within one line.");
    }
  } else if (typed.length === 1) {
    const m = typed[0];
    console.log(`Boundary: the user message at line ${m.line_index}. Cut through its parent: ${m.parent_uuid ?? "(none: it is the first record)"}`);
    if (m.parent_uuid && plan?.session?.live_session_id) {
      const parent = [...(m.context_before ?? [])].find((x: any) => x.uuid === m.parent_uuid);
      const { replaced } = savePendingCut({
        voice: voiceKey(plan),
        cut_uuid: m.parent_uuid,
        session_id: plan.session.live_session_id,
        line: parent?.line_index ?? null,
        record: parent ? kind(parent) : null,
        boundary: oneLine(m.content_preview ?? "", 120),
        source: "find",
        phrase,
      });
      const users = draftOn() ? "--draft, --check and the dry run use it" : "the dry run fills it into your sentinel";
      console.log(`Cut saved: ${m.parent_uuid}. --plan shows it, --cut <uuid> replaces it; ${users}.`);
      if (replaced && replaced.cut_uuid !== m.parent_uuid) console.log(`(It replaces the pending cut ${replaced.cut_uuid}.)`);
    }
    console.log(`Read the seam first: ${nextCmd("--around", String(m.line_index))}`);
  } else if (typed.length > 1) {
    console.log(`${typed.length} user messages match; pick the one that opens your new arc and cut through its parent (← line above): --cut <uuid>. No cut was saved.`);
  } else {
    console.log("None of the matches is a message someone typed (tool output, your own text, or a queued copy). Search words from the user message itself.");
  }
  if (r.matches.some((m: any) => m.type === "queue-operation")) console.log("(queue-operation lines are queued copies of a message: ignore them.)");
  process.exit(0);
}

const cutArg = flag("--cut");
if (cutArg !== undefined) {
  if (!UUID_RE.test(cutArg)) fail("--cut needs a record's uuid (from --find or --around).");
  const plan = await getPlan(true);
  const records = liveRecords(plan);
  const at = locateCut(records, cutArg, { sentinel: sentinelOf(plan) });
  if (!at.ok) fail(`Not saved: ${at.reason}.`);
  const rec = records[at.idx];
  const { replaced } = savePendingCut({
    voice: plan.voice,
    cut_uuid: cutArg,
    session_id: plan.session.live_session_id,
    line: at.idx,
    record: at.record,
    boundary: null,
    source: "cut",
  });
  console.log(`Cut saved: ${cutArg} (line ${at.idx}, ${at.record}${at.preview ? `: "${oneLine(at.preview, 60)}"` : ""}).`);
  if (replaced && replaced.cut_uuid !== cutArg) console.log(`(It replaces the pending cut ${replaced.cut_uuid}.)`);
  const c = rec?.message?.content;
  if (rec?.type === "user" && (typeof c === "string" || (Array.isArray(c) && !c.some((b: any) => b?.type === "tool_result")))) {
    console.log(`Note: this is a user message. The cut usually goes through its parent (${rec.parentUuid ?? "none"}); the dry run refuses a cut that drops the message opening the new arc.`);
  }
  process.exit(0);
}

const aroundArg = flag("--around");
if (aroundArg !== undefined) {
  const line = Number(aroundArg);
  if (!Number.isInteger(line) || line < 0) fail("--around needs a line number (from --find or --at).");
  const span = flag("--span") ?? "30";
  const res = await request(`${serverBase}/voices/${encodeURIComponent(voice!)}/records?around=${line}&span=${encodeURIComponent(span)}`);
  if (!res.ok) fail(`Could not read the records (HTTP ${res.status}): ${res.data?.message ?? res.text}`, res.status >= 500 ? 2 : 1);
  const r = res.data;
  console.log(`─── lines ${r.from}..${r.to} of ${r.total_lines} (← = parent line) ───`);
  printRows(r.records, line);
  process.exit(0);
}

const atArg = flag("--at");
if (atArg !== undefined) {
  if (Number.isNaN(Date.parse(atArg))) fail(`--at needs an ISO time, e.g. 2026-01-15T09:30:00Z (UTC). Got: ${atArg}`);
  // A time without a zone is read as local time: the UTC it stands for is what is sent and printed.
  const at = utcIso(atArg);
  const res = await post("/find-cut-point", { voice, method: "timestamp", before: at, exclude_recap: true });
  if (!res.ok) fail(`Search failed (HTTP ${res.status}): ${res.data?.message ?? res.text}`, res.status >= 500 ? 2 : 1);
  const m = res.data.matches?.[0];
  if (!m) fail(`Nothing before ${at}.`);
  console.log(`─── the last record before ${at} ───`);
  printRows([...m.context_before, m, ...m.context_after], m.line_index);
  console.log(`Read further around it: ${nextCmd("--around", String(m.line_index))}`);
  process.exit(0);
}

// ─── The draft and the check ───────────────────────────────────────────────

/** Dollars as Claude Code reports them: cents, or four places for a run under ten cents. */
const usd = (x: number) => `$${x.toFixed(x < 0.1 ? 4 : 2)}`;

function costLine(runs: readonly HeadlessResult[]): string {
  const s = sumRuns(runs);
  const cost = runs.some((r) => r.costUsd !== null) ? `${usd(s.costUsd)} as Claude Code reports it` : "cost not reported";
  return `${s.runs} run(s), ${cost}; tokens: input ${n(s.input)}, output ${n(s.output)}, cache read ${n(s.cacheRead)}, cache write ${n(s.cacheWrite)}`;
}

/** Tool calls Claude Code refused a run: the period tried to steer it. Null when none. */
function deniedLine(runs: readonly HeadlessResult[]): string | null {
  const denied = runs.flatMap((r) => r.denied ?? []);
  if (denied.length === 0) return null;
  return (
    `${denied.length} tool call(s) refused (${[...new Set(denied)].slice(0, 5).join(", ")}): text in the period steered a run toward something ` +
    "outside its folder, and Claude Code blocked it. Treat that run's output with care, and tell the operator."
  );
}

/** One line naming the config key, when a run failed over its model. */
function modelHint(runs: readonly HeadlessResult[], model: string, key: string, cliFlag: string): string | null {
  return runs.some((r) => /model/i.test(r.error ?? "")) ? `The model "${model}" may be the trouble: set ${key} in config.yaml, or pass ${cliFlag} <model>.` : null;
}

/** The voice's drafts folder, <recaps>/drafts, or null with no recaps folder. */
const draftsOf = (plan: any): string | null => (plan?.next?.body_path ? draftsDirFor(plan.next.body_path) : null);

/** The drafts folder, or a refusal naming the config key: there is no shared place to fall back to. */
function requireDrafts(plan: any, what: string): string {
  const drafts = draftsOf(plan);
  if (drafts) return drafts;
  const why = plan?.recaps_dir ? `its recaps folder ${plan.recaps_dir} does not exist` : "it has no recaps folder in config.yaml";
  fail(
    `No ${what} for ${plan?.voice ?? voice}: ${why}. Set \`recaps\` (or \`home\`) under voices.${plan?.voice ?? voice} in config.yaml. ` +
      "The draft and the period it is made from are kept only in the voice's own folder (<recaps>/drafts/), never in a shared place.",
  );
}

/** Remove the work folder; one line when there was one. */
function cleanWork(plan: any): void {
  const drafts = draftsOf(plan);
  if (drafts && removeWorkDir(workDirFor(drafts))) console.log(`Removed ${slash(workDirFor(drafts))} (the raw period). The draft and the check report stay.`);
}

/** Claude Code must be there and new enough before any run starts. */
function requireClaude(): void {
  const v = checkClaudeVersion();
  if (!v.ok) fail(`No run started: ${v.message}`);
}

/** The period up to the pending cut, and what the draft needs to know about it. */
function draftSetup(plan: any, cutUuid: string, what: string): { records: JsonlRecord[]; from: number; to: number; ctx: DraftContext } {
  const work = workDirFor(requireDrafts(plan, what));
  const records = liveRecords(plan);
  const sentinel = sentinelOf(plan);
  const at = locateCut(records, cutUuid, { sentinel });
  if (!at.ok) fail(`The cut does not fit this session: ${at.reason}. Set it again with --find or --cut.`);
  return {
    records,
    from: at.stackEnd,
    to: at.idx,
    ctx: {
      voice: plan.voice,
      names: namesFor(plan),
      sentinel,
      recapId: plan.next.id,
      previousRecapId: plan.next.predecessor_id ?? null,
      sessionId: plan.session.live_session_id,
      cutUuid,
      work,
    },
  };
}

if (args.includes("--draft-clean")) {
  const plan = await getPlan(false);
  const drafts = draftsOf(plan);
  if (drafts && fs.existsSync(workDirFor(drafts))) cleanWork(plan);
  else console.log(`Nothing to remove: ${drafts ? `${slash(workDirFor(drafts))} is not there` : "no recaps folder, so no work folder"}.`);
  process.exit(0);
}

const entryArg = flag("--entry");
if (entryArg !== undefined) {
  const { ids, bad } = parseEntryIds(entryArg);
  if (bad.length > 0 || ids.length === 0) fail(`--entry takes the entry numbers a draft line ends with: --entry E-0123 or --entry E-0123,E-0456${bad.length ? ` (not an entry: ${bad.join(", ")})` : ""}.`);
  const plan = await getPlan(true);
  const records = liveRecords(plan);
  const sentinel = { sentinel: sentinelOf(plan) };
  const drafts = draftsOf(plan);
  const at = entryCut(records, plan.session.live_session_id, drafts ? readMeta(workDirFor(drafts)) : null, pendingFor(plan), sentinel);
  if (!at.ok) fail(`No entries: ${at.reason}.`);
  const where = locateCut(records, at.cut, sentinel);
  if (!where.ok) fail(`No entries: ${where.reason}.`);
  const names = namesFor(plan);
  // The same timeline the draft was made from: numbered from the end of the recap stack, up to that cut.
  const entries = buildTimeline(records, where.stackEnd, where.idx, names, sentinel);
  const byId = new Map(entries.map((e) => [e.id, e]));
  console.log(`─── ${ids.length} of ${n(entries.length)} timeline entries, up to the cut ${at.source === "draft" ? "the draft was made for" : "pending now"} (${at.cut}) ───`);
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) {
      console.log(`### ${id}: not in this timeline (it runs E-0001 to ${entries[entries.length - 1]?.id ?? "nothing"}).\n`);
      continue;
    }
    // Whole: no cap on the output, the written text or the call's input.
    console.log(renderEntry(e, names, "entry").replace("\n", `  (session line ${e.line}; --around ${e.line} shows the records)\n`));
  }
  process.exit(0);
}

if (args.includes("--draft")) {
  // Off: one line, before the server is asked anything and before anything starts.
  if (!draftOn()) refuseDraftOff("The draft (--draft)");
  const started = Date.now();
  const plan = await getPlan(true);
  const drafts = requireDrafts(plan, "draft");
  const pending = pendingFor(plan);
  if (!pending) fail('No pending cut in this session. Name the cut first: --find "<words of the message that opens the new arc>" (or --cut <uuid>).');
  const { records, from, to, ctx } = draftSetup(plan, pending.cut_uuid, "draft");
  const partArg = flag("--part");
  const only = partArg !== undefined ? Number(partArg) : undefined;
  if (only !== undefined && (!Number.isInteger(only) || only < 1)) fail("--part needs a part number (1, 2, ...).");
  const split = args.includes("--split");
  const layout = split ? "split" : "whole";
  const earlier = readMeta(ctx.work);
  const keepLines = only !== undefined && earlier?.cut_uuid === ctx.cutUuid && earlier?.session_id === ctx.sessionId && earlier?.layout === layout;
  if (only !== undefined && !keepLines) console.log("(The work folder was for another cut or another layout, or is gone: the other parts have no earlier lines.)");
  let meta;
  try {
    meta = prepareDraft(records, { from, to }, ctx, { split, keepLines });
  } catch (e: any) {
    fail(`No draft: ${e.message}.`);
  }
  if (only !== undefined && only > meta.parts.length) fail(`--part ${only}: the timeline has ${meta.parts.length} part(s).`);
  const settings = local().config.draft;
  const model = readerModelFor(split, flag("--reader-model"), settings);
  console.log(`─── Draft for ${plan.next.id}: ${plan.voice} ───`);
  console.log(`Period   lines ${from}..${to} after ${plan.next.predecessor_id ?? "the start"}, ${meta.from} to ${meta.to}: ${n(meta.entries)} entries, ${n(meta.chars)} characters`);
  console.log(`         ${Object.entries(meta.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`Parts    ${meta.parts.length}: ${meta.parts.map((p) => `${p.first}..${p.last}`).join(", ")}`);
  console.log(`Readers  ${layoutLine(meta, model)}`);
  console.log(`Work     ${slash(ctx.work)}  (the raw period, in your own folder, out of git; removed after --go, or by --draft-clean)`);
  if (args.includes("--prepare-only")) {
    console.log("Nothing started (--prepare-only). One reader per part, each with this prompt:");
    for (const p of meta.parts) console.log(`  ${promptFor(p.brief)}`);
    console.log("Each writes the lines.json in its own part folder. Then run --draft without --prepare-only.");
    process.exit(0);
  }
  requireClaude();
  console.log(`Waiting${only !== undefined ? ` (only part ${only})` : ""}.`);
  const outcomes = await runReaders(meta, runHeadless, { model, only, log: (line) => console.log(`  ${clock()}  ${line}`) });
  const runs = outcomes.flatMap((o) => o.runs);
  const merged = mergeDraft(meta, outcomes, ctx.names, { entryCommand: nextCmd("--entry", "E-0001,E-0002") });
  if (outcomes.every((o) => !o.ok)) {
    for (const o of outcomes) console.error(`part ${o.part.n}: ${o.error ?? "failed"}`);
    console.error("No reader produced a file that parses: nothing was written. The timeline and the briefs are in the work folder.");
    if (runs.length > 0) console.error(`Cost     ${costLine(runs)}`);
    const hint = modelHint(runs, model, split ? "draft.split_reader_model" : "draft.reader_model", "--reader-model");
    if (hint) console.error(hint);
    fail(
      split
        ? "Go on without the draft and say so in your report, or try once more."
        : "Rerun with --split (several readers on smaller parts), or go on without the draft and say so in your report.",
    );
  }
  const draftPath = draftFileFor(drafts, plan.next.id);
  ensureDraftsDir(drafts);
  fs.writeFileSync(draftPath, merged.markdown);
  console.log("─── DRAFT READY ───");
  console.log(`Draft    ${slash(draftPath)}`);
  console.log(`         ${merged.lines} lines, ${n(merged.markdown.length)} characters (about ${kTokens(draftTokensFor(merged.markdown.length))} to read), took ${seconds(Date.now() - started)}`);
  console.log(`Git      ${draftsGitLine(drafts)}`);
  if (runs.length > 0) console.log(`Cost     ${costLine(runs)}`);
  for (const o of outcomes) {
    const r = o.runs[o.runs.length - 1];
    const state = o.ok ? `${o.lines.length} lines${o.reused ? " (from an earlier run)" : ""}` : `NOT COVERED: ${o.error}`;
    console.log(`  part ${o.part.n} (${o.part.first}..${o.part.last}): ${state}${r ? `, ${seconds(r.durationMs)}${o.attempts > 1 ? `, ${o.attempts} attempts` : ""}${r.costUsd !== null ? `, ${usd(sumRuns(o.runs).costUsd)}` : ""}` : ""}${o.note ? ` (${o.note})` : ""}`);
  }
  const denied = deniedLine(runs);
  if (denied) console.log(`Refused  ${denied}`);
  console.log("Read ALL of it before you write the body. Its lines are traces, not the truth: check lines about yourself, and words");
  console.log(`or decisions given to ${ctx.names.operator}, against the record (${nextCmd("--entry", "E-NNNN")} prints an entry).`);
  console.log("Then write the body yourself, from memory, in your own words. Next:");
  console.log(`     ${nextCmd("--check")}`);
  const notice = uncoveredNotice(merged.uncovered, meta.layout);
  if (notice) console.log(notice);
  process.exit(0);
}

if (args.includes("--check")) {
  if (!draftOn()) refuseDraftOff("The check (--check)");
  const started = Date.now();
  const plan = await getPlan(true);
  // Before anything is written: the record and the report live only in the voice's own folder.
  const drafts = requireDrafts(plan, "check");
  const sentinelName = sentinelOf(plan);
  const bodyPath: string = explicitBody ?? plan.next.body_path;
  if (!fs.existsSync(bodyPath)) fail(`Body file not found: ${bodyPath}. Write ${plan.next.id} there first.`);
  const pending = pendingFor(plan);
  const text = decodeBodyText(fs.readFileSync(bodyPath));
  const fill = fillSentinelCut(text, pending?.cut_uuid ?? null, sentinelName);
  if (fill.action === "no_sentinel") {
    fail(
      `The body has no ${sentinelName} sentinel that parses. End it with ` +
        `{"sentinel":"${sentinelName}","voice":"${plan.voice}","id":"${plan.next.id}","version":1,"cut_through_uuid":"${CUT_PLACEHOLDER}"}.`,
    );
  }
  if (fill.action === "no_pending") fail(`The sentinel's cut_through_uuid is ${fill.was === "missing" ? "missing" : "the placeholder"}, and there is no pending cut. Name the cut first: --find or --cut.`);
  if (fill.action === "mismatch") {
    fail(`The body's sentinel says cut_through_uuid ${fill.body_cut}; the pending cut is ${fill.pending_cut}. Make them one: fix the body, or set the cut with --cut <uuid>.`);
  }
  if (fill.action === "unfillable") fail("The sentinel's cut_through_uuid holds something that is not a string: write the uuid in by hand.");
  if (fill.action === "filled") {
    fs.writeFileSync(bodyPath, fill.text);
    console.log(`Sentinel cut_through_uuid filled from the pending cut: ${fill.cut}`);
  }
  const draftsExisted = fs.existsSync(drafts);
  const { records, from, to, ctx } = draftSetup(plan, fill.cut, "check");
  let meta = readMeta(ctx.work);
  if (!meta || meta.cut_uuid !== fill.cut || meta.session_id !== ctx.sessionId || !fs.existsSync(path.join(ctx.work, "timeline-short.md"))) {
    const same = meta?.cut_uuid === fill.cut && meta?.session_id === ctx.sessionId;
    try {
      meta = prepareDraft(records, { from, to }, ctx, { keepLines: same });
    } catch (e: any) {
      fail(`No record to check against: ${e.message}.`);
    }
    console.log("Record   rebuilt (the work folder was gone, or was for another cut).");
  }
  const model = flag("--check-model") ?? local().config.draft.check_model;
  requireClaude();
  console.log(`─── Check of ${plan.next.id}: ${n(fill.text.length)} characters against ${n(meta.entries)} entries (${meta.from} to ${meta.to}), ${model} ───`);
  const outcome = await runCheck(fill.text, ctx.names, runHeadless, { model, work: ctx.work, voice: plan.voice, log: (line) => console.log(`  ${clock()}  ${line}`) });
  if (!outcome.ok || !outcome.report) {
    if (outcome.runs.length > 0) console.error(`Cost     ${costLine(outcome.runs)}`);
    const hint = modelHint(outcome.runs, model, "draft.check_model", "--check-model");
    if (hint) console.error(hint);
    fail(`No check report: ${outcome.error ?? "the checker wrote nothing"}. The body is unchanged; you may go on without the check.`);
  }
  const reportPath = checkFileFor(drafts, plan.next.id);
  ensureDraftsDir(drafts);
  fs.writeFileSync(reportPath, `${outcome.report}\n`);
  console.log("─── CHECK REPORT ───");
  console.log(outcome.report);
  console.log("────────────────────");
  console.log(`Report   ${slash(reportPath)}`);
  if (!draftsExisted) console.log(`Git      ${draftsGitLine(drafts)}`);
  console.log(`Took     ${seconds(Date.now() - started)}; ${costLine(outcome.runs)}`);
  const denied = deniedLine(outcome.runs);
  if (denied) console.log(`Refused  ${denied}`);
  console.log(`One round. What is untrue is corrected or removed, always (doubt the checker? ${nextCmd("--entry", "E-NNNN")} prints what it names).`);
  console.log("What it says is missing is your call. There is no second check.");
  console.log(`Then: ${canSelfRestart(plan) ? nextCmd("--go", "--restart") : nextCmd("--go")}  (or a plain dry run first: ${nextCmd()}).`);
  process.exit(0);
}

// ─── Body ──────────────────────────────────────────────────────────────────

if (restart && !go) fail(`--restart goes with --go: ${nextCmd("--go", "--restart")}`);
if (restart && force) fail("--force and --restart do not go together: a recap in the cut range needs the operator. Run --go --force without --restart.");

/**
 * With --restart, this session must be able to restart itself BEFORE
 * anything is cut: a surgery whose restart then fails leaves the session
 * running on the old context at the context limit.
 */
let restartAs: { config: AppConfig; caller: LiveSession } | null = null;

function refuseRestart(why: string, plan: any | null): never {
  console.error(`--restart refused: ${why}`);
  console.error("Nothing was executed. Run the surgery without it:");
  console.error(`     ${nextCmd("--go")}`);
  console.error("then the operator closes this session and runs, in a new terminal:");
  console.error(`     ${restartLine(plan?.restart_command, plan?.session?.live_session_id)}`);
  process.exit(1);
}

function prepareRestart(plan: any | null): void {
  if (process.platform !== "win32") refuseRestart(WINDOWS_ONLY, plan);
  if (!plan) refuseRestart("it needs the recap plan, and the server did not give one", plan);
  if (plan.self_restart && !plan.self_restart.available) refuseRestart(plan.self_restart.reason, plan);
  const { config, found, note } = local();
  if (!found) refuseRestart(`it reads the server's config.yaml itself, and ${note}: set RECAP_CONFIG to it`, plan);
  try {
    const caller = callerSession();
    goRestartPreflight(config, plan.voice, caller);
    restartAs = { config, caller: caller! };
  } catch (e) {
    if (e instanceof RestartError) refuseRestart(e.message.replace(/^selfrecap: /, ""), plan);
    throw e;
  }
}

/** After the surgery: schedule the restart, and say how to bring the session back by hand. */
function scheduleRestart(plan: any, restartCommand: string | null | undefined, sessionId: string | undefined): void {
  if (!restartAs) return;
  console.log("─── RESTART ───");
  try {
    scheduleSelfRestart(restartAs.config, restartAs.caller, (line) => console.log(line));
  } catch (e) {
    if (!(e instanceof RestartError)) throw e;
    console.error(`RESTART NOT SCHEDULED: ${e.message}`);
    console.error("The recap IS in your session. Run `npx tsx scripts/selfrecap.ts restart` yourself; if it refuses, the operator restarts you by hand:");
    console.error(`     ${restartLine(restartCommand, sessionId)}`);
    process.exit(1);
  }
  const name = plan?.name ?? voice;
  console.log("Before you end the turn: nothing of yours may still be running (background shells, agents you started): the restart");
  console.log("waits for this session to go idle. Then send your report and stop.");
  console.log(`For the operator, if ${name} is not back within a few minutes, by hand:`);
  console.log(`     ${restartLine(restartCommand, sessionId)}`);
}

function alreadyDone(plan: any | null, id: string, minutes: number | null, restartCommand: string, sessionId?: string): never {
  console.log("─── ALREADY DONE ───");
  console.log(`${id} is in your session${minutes !== null ? ` (applied ${minutes} minute(s) ago)` : ""}. Nothing to run, nothing to write.`);
  if (plan) clearPendingCut(plan.voice);
  cleanWork(plan);
  if (restartAs) {
    scheduleRestart(plan, restartCommand, sessionId);
    process.exit(0);
  }
  if (canSelfRestart(plan)) {
    console.log("Restart to load it: run `selfrecap restart` (Step 8), then send your report and stop.");
    console.log("If that is not available, the operator closes this terminal and runs, in a new one:");
  } else {
    console.log("Restart to load it: the operator closes this terminal and runs, in a new one:");
  }
  console.log(`     ${restartCommand}`);
  process.exit(0);
}

const plan = await getPlan(!explicitBody);
const sentinelName = sentinelOf(plan);
if (restart) prepareRestart(plan);
const bodyPath: string | null = explicitBody ?? plan?.next?.body_path ?? null;
if (!bodyPath) fail(`No body file: ${voice} has no recaps folder in config.yaml. Pass the body path explicitly.`);
if (!fs.existsSync(bodyPath)) {
  const last = plan?.stack?.[plan.stack.length - 1];
  const minutes = minutesSince(last?.applied_at);
  if (!explicitBody && last?.id && minutes !== null && minutes <= RECENT_MINUTES) {
    alreadyDone(plan, last.id, minutes, restartLine(plan.restart_command, plan.session?.live_session_id), plan.session?.live_session_id);
  }
  console.error(`Body file not found: ${bodyPath}`);
  if (!explicitBody) console.error(`Write ${plan?.next?.id ?? "the recap"} there first, with your Write tool (see --plan).`);
  process.exit(1);
}
if (explicitBody && plan?.next?.body_path && path.resolve(explicitBody) !== path.resolve(plan.next.body_path)) {
  console.log(`Note: the plan's body path for ${plan.next.id} is ${plan.next.body_path}`);
}

let body = decodeBodyText(fs.readFileSync(bodyPath));
// The pending cut fills the placeholder here too, for a session that skipped the check (or has it off).
const fill = fillSentinelCut(body, pendingFor(plan)?.cut_uuid ?? null, sentinelName);
if (fill.action === "filled") {
  fs.writeFileSync(bodyPath, fill.text);
  body = fill.text;
  console.log(`Sentinel cut_through_uuid filled from the pending cut: ${fill.cut}`);
} else if (fill.action === "mismatch") {
  if (restart) {
    fail(`The body's sentinel says cut_through_uuid ${fill.body_cut}; the pending cut is ${fill.pending_cut}. --restart goes only on one cut: fix the body, or set the cut with --cut <uuid>. Nothing was executed.`);
  }
  console.log(`Note: the body's cut ${fill.body_cut} is not the pending cut ${fill.pending_cut} (from --find/--cut). The body's is used.`);
} else if (fill.action === "no_pending" && fill.was === "placeholder") {
  fail(`The sentinel's cut_through_uuid is still the placeholder ${CUT_PLACEHOLDER}, and there is no pending cut in this session. Name the cut with --find or --cut (or write the uuid in).`);
}
const sentinel = parseSentinel(body, sentinelName);
if (!sentinel) {
  console.error("─── Body validation failed ───");
  if (sentinelRe(sentinelName).test(body)) {
    console.error(`The sentinel block at the end of the body is not valid JSON: ${sentinelParseError(body, sentinelName)}.`);
    console.error("Usually a trailing comma after the last field, or a quote left open.");
  } else {
    console.error(`The body has no ${sentinelName} sentinel. End it with a fenced JSON block, like:`);
    console.error(
      `{"sentinel":"${sentinelName}","voice":"${plan?.voice ?? voice}","id":"${plan?.next?.id ?? "<voice>-recap-NNN"}","version":1,"cut_through_uuid":"<uuid>"}`,
    );
  }
  process.exit(1);
}
const cutThroughUuid = sentinel.cut_through_uuid;
if (!cutThroughUuid || typeof cutThroughUuid !== "string") fail("The sentinel has no `cut_through_uuid`. Add it: it is the surgery handoff key.");

// Checks against the plan, before anything is sent.
if (plan) {
  const bodyVoice = typeof sentinel.voice === "string" ? sentinel.voice.toLowerCase() : null;
  if (bodyVoice && bodyVoice !== plan.voice) fail(`This body is ${sentinel.voice}'s (its sentinel says so); you ran it as ${plan.voice}.`);
  const id = typeof sentinel.id === "string" ? sentinel.id.toLowerCase() : null;
  const stack: any[] = plan.stack ?? [];
  const applied = id ? stack.find((r) => typeof r.id === "string" && r.id.toLowerCase() === id) : undefined;
  if (applied) {
    const minutes = minutesSince(applied.applied_at);
    const sameCut = !applied.cut_through_uuid || applied.cut_through_uuid === cutThroughUuid;
    if (sameCut && applied === stack[stack.length - 1] && minutes !== null && minutes <= RECENT_MINUTES) {
      alreadyDone(plan, applied.id, minutes, restartLine(plan.restart_command, plan.session?.live_session_id), plan.session?.live_session_id);
    }
    fail(
      `The last sentinel in this body is ${applied.id}, a recap already in your session${applied.applied_at ? ` (applied ${applied.applied_at})` : ""}. ` +
        `End the body with your own sentinel: "id": "${plan.next.id}".`,
    );
  }
}

// ─── Surgery ───────────────────────────────────────────────────────────────

/** One /surgery call. A refusal (ok false with a reason) comes back; an unknown state stops here. */
async function surgery(dryRun: boolean): Promise<{ result: any; httpOk: boolean }> {
  const res = await post("/surgery", {
    voice,
    cut_through_uuid: cutThroughUuid,
    recap_content: body,
    dry_run: dryRun,
    ...(force ? { force_overwrite_recap: true } : {}),
  });
  if (!res.data) fail(`Server returned non-JSON (HTTP ${res.status}):\n${res.text}`, 2);
  // A response with `ok: false` and a reason is a refusal: its state is known
  // (nothing changed). Anything else that is not ok leaves it unknown.
  if (!res.ok && (typeof res.data.ok !== "boolean" || typeof res.data.reason !== "string")) {
    console.error(`─── SERVER ERROR (HTTP ${res.status}) ───`);
    console.error(res.data.message ?? res.text);
    fail("It is not known whether the surgery happened. Run --plan and check the recap stack before retrying.", 2);
  }
  const result = res.data;
  if (!res.ok && typeof result.reason === "string" && result.reason.startsWith("already_applied")) {
    alreadyDone(plan, result.diagnostics?.recap_id ?? String(sentinel!.id), null, restartLine(result.restart_command, result.live_session_id), result.live_session_id);
  }
  return { result, httpOk: res.ok };
}

/** The checklist the skill reads, by the diagnostics' JSON names. */
function printChecklist(result: any): void {
  const d = result.diagnostics ?? {};
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const pb = d.pair_balance;
    const rows: Array<[string, unknown]> = [
      ["ok", result.ok],
      ["recap_id", `${d.recap_id} (expected ${d.expected_recap_id ?? "n/a"})`],
      ["cut_through_line_idx", `${d.cut_through_line_idx}${d.cut_through_record ? ` — ${d.cut_through_record.type}${d.cut_through_record.preview ? `: "${oneLine(d.cut_through_record.preview, 60)}"` : ""}` : ""}`],
      ["lines_cut", `${d.lines_cut} of ${d.total_lines_before} (total_lines_after ${d.total_lines_after})`],
      ["leading_recaps_preserved", d.leading_recaps_preserved],
      ["new_recap_position", d.new_recap_position],
      ["repointed_records", d.repointed_records],
      ["chain_reaches_recap", d.chain_reaches_recap],
      ["cut_orphaned_tool_results", (d.cut_orphaned_tool_results ?? []).length],
      ["pair_balance", pb ? `orphans ${pb.orphans}, tail_orphan_only ${pb.tail_orphan_only}` : "n/a"],
      ["cut_range_has_existing_recap", d.cut_range_has_existing_recap],
    ];
    if (!result.dry_run) {
      rows.push(["backup_path", d.backup_path], ["carried_tail_lines", d.carried_tail_lines], ["rename_attempts", d.rename_attempts]);
    }
    for (const [k, v] of rows) console.log(`  ${k.padEnd(29)}${v}`);
  }
  for (const w of result.warnings ?? []) console.log(`Warning: ${w}`);
}

function refused(result: any, executing: boolean): never {
  const d = result.diagnostics ?? {};
  console.error("─── FAILED ───");
  if (result.reason) console.error(`Reason: ${result.reason}`);
  for (const p of (d.problems ?? []).filter((p: string) => p !== result.reason)) console.error(`Also:   ${p}`);
  fail(executing ? "The live file was not changed: a refused surgery never touches it." : "Nothing was written.");
}

console.log(`─── Recap surgery: ${voice}, ${go ? (restart ? "EXECUTE + RESTART" : "EXECUTE") : "dry-run"}${force ? ", force_overwrite" : ""} ───`);
console.log(`Body     ${bodyPath} (${n(body.length)} characters, sentinel ${sentinel.id ?? "(no id)"})`);
console.log(`Cut      ${cutThroughUuid}`);

if (restart) {
  // The same dry run, read by the same checklist: execute only when all of it is right.
  const dry = await surgery(true);
  const failures = dryRunFailures(dry.result, Array.isArray(plan?.stack) ? plan.stack.length : null);
  if (failures.length > 0) {
    printChecklist(dry.result);
    console.error("─── NOT EXECUTED: the dry run is not clean ───");
    for (const f of failures) console.error(`  - ${f}`);
    if (!dry.httpOk || dry.result.ok === false) refused(dry.result, false);
    fail("Nothing was written. Fix what is named, or run the steps by hand.");
  }
  console.log("Dry run  clean: every check passed. Executing.");
}

const { result, httpOk } = await surgery(!go);
printChecklist(result);
if (!httpOk || result.ok === false) refused(result, go);

if (result.dry_run) {
  console.log(`─── DRY-RUN OK ─── Diagnostics look right? Re-run with --go to execute${canSelfRestart(plan) ? " (--go --restart also schedules your restart)" : ""}.`);
} else {
  const d = result.diagnostics ?? {};
  if (plan) clearPendingCut(plan.voice);
  const mb = (x: number) => (x / 1_000_000).toFixed(1);
  const cutPct = d.total_lines_before ? Math.round((100 * d.lines_cut) / d.total_lines_before) : 0;
  console.log("─── SURGERY EXECUTED ───");
  console.log(
    `Report   Was ${plan?.context ? `${plan.context.percent_of_1m}% / ` : ""}${n(d.total_lines_before)} lines / ${mb(d.file_size_before_bytes)} MB. ` +
      `Now ${n(d.total_lines_after)} lines / ${mb(d.file_size_after_bytes)} MB (cut ${cutPct}% of lines).`,
  );
  console.log("Your running session is still the pre-surgery one: every turn from here costs context in the OLD session.");
  // The period is in the recap now: its raw copy goes. The draft and the check report stay.
  cleanWork(plan);
  if (restart) {
    scheduleRestart(plan, result.restart_command, result.live_session_id);
  } else if (canSelfRestart(plan)) {
    console.log("Now run `selfrecap restart` (Step 8): it closes this session when your turn ends and resumes it by id in a");
    console.log("new console, with a resume prompt. Then send your report and stop. If that is not available, the");
    console.log("operator closes this terminal and runs, in a new one:");
    console.log(`     ${restartLine(result.restart_command, result.live_session_id)}`);
  } else {
    console.log("Now send your report and stop. The operator closes this terminal and runs, in a new one:");
    console.log(`     ${restartLine(result.restart_command, result.live_session_id)}`);
  }
}
