#!/usr/bin/env tsx
/**
 * selfrecap — a session restarts itself after its recap, and the log of it.
 *
 *   selfrecap restart     restart YOURSELF (run from inside the Claude Code session)
 *   selfrecap log [N]     the last N nudge/restart events (default 20)
 *
 * Run from the selfrecap folder: `npx tsx scripts/selfrecap.ts restart`
 * (or `npm run selfrecap -- restart`).
 *
 * WINDOWS ONLY. A restart is optional: without it the operator restarts the
 * session by hand with the command `recap.ts --go` prints. It needs the
 * voice's `restart` template in config.yaml, and Claude Code with
 * cross-session messaging (v2.1.224+, native Windows v2.1.234+), whose
 * session registry tells it when the session is idle.
 *
 * `restart` takes no target: it acts on the session that runs it (see
 * callerSession) and on nothing else. It does not kill a busy session: it
 * waits for the turn to end (the registry says `idle`), then closes the
 * session and resumes the same id in a new console, with a first prompt so
 * the session carries on unattended. Then it checks the session really came
 * back (expected id, expected name, live, not stuck on a dialog) and records
 * the outcome either way: logs/lifecycle.log, logs/lifecycle-state.json, and
 * /contexts `lifecycle`.
 *
 * A session is only ever resumed by its id: never by name, never with
 * --continue (either can open another session or fork this one).
 *
 * The scheduling side (who is calling, the checks, the lock, launching the
 * helper) is src/lib/restart.ts, shared with `recap.ts <voice> --go
 * --restart`; the helper's side (`_run`) is here.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { DEFAULTS, loadConfig, type AppConfig } from "../src/config.js";
import { LOG_DIR, recordLifecycle, tailLifecycleLog } from "../src/lib/lifecycle-log.js";
import { killTree, resumePrompt, sleep, voiceRefs, waitFor } from "../src/lib/lifecycle.js";
import { RUN_DIR, RestartError, WINDOWS_ONLY, callerSession, lockHeld, releaseLock, scheduleSelfRestart, type RestartJob } from "../src/lib/restart.js";
import {
  claudeEnv,
  knownAccounts,
  liveByName,
  liveBySessionId,
  pidExists,
  pipeExists,
  readRegistry,
  removeDeadRow,
  type LiveSession,
} from "../src/lib/sessions.js";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** How long a restart waits for the session's turn to end before giving up without killing. */
const IDLE_TIMEOUT_MS = 20 * 60_000;
/** The registry must say idle this long before the kill: a message landing right after a turn starts another. */
const IDLE_STABLE_MS = 3_000;
/** How long a resumed session has to appear in the registry. */
const APPEAR_TIMEOUT_MS = 90_000;
/** How long it may sit on a dialog before the resume counts as stuck. */
const STUCK_MS = 60_000;
/** How long after a resume counts as success the helper keeps watching for a late dialog or a crash. */
const AFTER_RESUME_WATCH_MS = 3 * 60_000;

const [cmd, ...rest] = process.argv.slice(2);

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

// A detached run needs no config (its spec carries everything) and must not die
// on one that is mid-edit: that would end the restart with no outcome recorded.
let config: AppConfig;
try {
  config = loadConfig(process.env.RECAP_CONFIG || path.join(REPO, "config.yaml"));
} catch (e: any) {
  if (cmd !== "_run") fail(`selfrecap: config.yaml did not load: ${e?.message ?? e}`);
  config = { ...DEFAULTS };
}
const accounts = knownAccounts(config.accounts, voiceRefs(config).flatMap((v) => (v.account ? [v.account] : [])));

function short(account: string): string {
  return path.basename(account);
}

function usage(code = 1): never {
  console.log(fs.readFileSync(SELF, "utf8").split("*/")[0]!.split("\n").slice(2, 9).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
  process.exit(code);
}


// ─── waiting on the registry ───────────────────────────────────────────────

function rowOf(account: string, pid: number, sessionId: string): LiveSession | undefined {
  return readRegistry(account).find((r) => r.pid === pid && r.sessionId === sessionId);
}

/** Wait until the session's turn has ended (idle, held for IDLE_STABLE_MS) or it is gone. */
async function waitIdle(account: string, pid: number, sessionId: string): Promise<"idle" | "gone" | "timeout"> {
  let idleSince: number | null = null;
  const r = await waitFor(
    () => {
      const row = rowOf(account, pid, sessionId);
      if (!row || !row.alive) return "gone" as const;
      if (row.status === "idle") {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= IDLE_STABLE_MS) return "idle" as const;
      } else {
        idleSince = null;
      }
      return undefined;
    },
    IDLE_TIMEOUT_MS,
    500,
  );
  return r ?? "timeout";
}

/**
 * Close a session: kill its tree, then confirm it is dead twice over: the
 * process is gone AND its pipe is gone (an unreadable pipe listing confirms
 * nothing). Only then clear its registry row.
 */
async function closeSession(row: LiveSession): Promise<boolean> {
  killTree(row.pid);
  const gone = await waitFor(() => (!pidExists(row.pid) && !pipeExists(row.pipe) ? true : undefined), 15_000, 250);
  if (!gone) return false;
  removeDeadRow(row);
  return true;
}

// ─── resuming ──────────────────────────────────────────────────────────────

/**
 * Resume the session in this console by its exact id, then check it came
 * back right. The command is the voice's `restart` template from config.yaml,
 * the one `recap.ts --go` prints, so there is one version of it. The caller
 * holds the lock; it is released as soon as the outcome is known (registered
 * or given up), not when the session later exits.
 */
async function resumeHere(spec: RestartJob): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Checked before every attempt: someone may have brought it up in between.
    const already = [...liveBySessionId(spec.session_id, accounts), ...liveByName(spec.name, [spec.account])];
    if (already.length > 0) {
      const r = already[0]!;
      releaseLock(spec.name);
      recordLifecycle(spec.voice, "aborted", `not resumed: already live (${r.name ?? "?"}, pid ${r.pid}, ${short(r.account)})`, spec.session_id);
      return banner(`${spec.name} is already live (pid ${r.pid}). Not resumed: a second session on one name makes the name reach neither.`);
    }
    const outcome = await resumeOnce(spec);
    if (outcome.ok) {
      releaseLock(spec.name);
      recordLifecycle(spec.voice, "resumed", outcome.detail, spec.session_id);
      // Keep watching a while: a safety pause or a crash can come a moment after the first busy.
      const late = await watchAfterResume(spec.name, spec.session_id, spec.account, outcome.exited);
      if (late) recordLifecycle(spec.voice, "resume_failed", late, spec.session_id);
      await outcome.done;
      if (late) return banner(`${spec.name}: ${late}`, spec.command);
      return;
    }
    if (outcome.stillRunning) {
      // Up but wrong or stuck: a retry would make a second session. Record it now;
      // the banner can only show once the session lets go of this console.
      releaseLock(spec.name);
      recordLifecycle(spec.voice, "resume_failed", outcome.detail, spec.session_id);
      await outcome.done;
      return banner(`${spec.name}: ${outcome.detail}`, spec.command);
    }
    recordLifecycle(spec.voice, attempt === 1 ? "aborted" : "resume_failed", `attempt ${attempt}: ${outcome.detail}`, spec.session_id);
    if (attempt === 1) await sleep(5_000);
  }
  releaseLock(spec.name);
  return banner(`${spec.name} did not come back after two attempts.`, spec.command);
}

/**
 * After a resume counted as success: null if it stays healthy for a while, else
 * what went wrong. Stands down the moment the session starts a new restart of
 * its own (it takes the lock again): restarting itself on purpose is not a
 * failed resume.
 */
async function watchAfterResume(name: string, sessionId: string, account: string, exited: () => boolean): Promise<string | null> {
  let waitingSince: number | null = null;
  const r = await waitFor(
    () => {
      if (lockHeld(name)) return "handed-over";
      if (exited()) return lockHeld(name) ? "handed-over" : "exited within minutes of its resume";
      const now = liveBySessionId(sessionId, [account])[0];
      if (!now) return lockHeld(name) ? "handed-over" : "its session disappeared within minutes of its resume";
      if (now.status === "waiting") {
        waitingSince ??= Date.now();
        if (Date.now() - waitingSince >= STUCK_MS) return `stuck after its resume: ${now.waitingFor ?? "waiting"}; it needs a hand at its window`;
      } else {
        waitingSince = null;
      }
      return undefined;
    },
    AFTER_RESUME_WATCH_MS,
    2000,
  );
  return r === undefined || r === "handed-over" ? null : r;
}

async function resumeOnce(spec: RestartJob): Promise<{
  ok: boolean;
  stillRunning: boolean;
  detail: string;
  done: Promise<void>;
  exited: () => boolean;
}> {
  // A PowerShell literal: the resume prompt has no single quotes.
  const child = spawn("powershell", ["-NoProfile", "-Command", `${spec.command} '${resumePrompt(spec.recap_id)}'`], {
    stdio: "inherit",
    env: claudeEnv(spec.account),
    windowsHide: false,
  });
  let exited = false;
  const done = new Promise<void>((resolve) => {
    child.on("exit", () => ((exited = true), resolve()));
    child.on("error", (e) => {
      console.error(`selfrecap: could not run the restart command: ${e.message}`);
      exited = true;
      resolve();
    });
  });
  const isExited = () => exited;

  const row = await waitFor(() => (exited ? null : liveBySessionId(spec.session_id, [spec.account])[0]), APPEAR_TIMEOUT_MS, 1000);
  if (!row) {
    // Still running but never registered: stuck before start (a wizard, a picker). A retry would stack a second one.
    if (!exited) return { ok: false, stillRunning: true, detail: "running, but no live session with that id after 90 s: stuck before start", done, exited: isExited };
    return { ok: false, stillRunning: false, detail: "the resume exited before it came up", done, exited: isExited };
  }
  if (row.name?.toLowerCase() !== spec.name.toLowerCase()) {
    return { ok: false, stillRunning: true, detail: `came back as "${row.name ?? "(no name)"}", not ${spec.name}: unreachable by name`, done, exited: isExited };
  }
  // Up, right id, right name. Not stuck on a dialog (a safety pause, a picker)?
  let waitingSince: number | null = null;
  const settled = await waitFor(
    () => {
      if (exited) return "exited" as const;
      const now = liveBySessionId(spec.session_id, [spec.account])[0];
      if (!now) return "exited" as const;
      if (now.status === "waiting") {
        waitingSince ??= Date.now();
        return Date.now() - waitingSince >= STUCK_MS ? (`stuck: ${now.waitingFor ?? "waiting"}` as const) : undefined;
      }
      waitingSince = null;
      return now.status === "busy" || now.status === "idle" ? ("ok" as const) : undefined;
    },
    APPEAR_TIMEOUT_MS,
    1000,
  );
  if (settled === "ok") return { ok: true, stillRunning: true, detail: `up as ${row.name}, pid ${row.pid}, ${short(row.account)}`, done, exited: isExited };
  if (settled === "exited") return { ok: false, stillRunning: false, detail: "came up, then exited", done, exited: isExited };
  return { ok: false, stillRunning: true, detail: `came up but ${settled ?? "never settled"}: it needs a hand at its window`, done, exited: isExited };
}

/** Print a failure so it stays on screen until someone reads it. */
async function banner(message: string, command?: string): Promise<void> {
  const red = (s: string) => `\x1b[1;37;41m${s}\x1b[0m`;
  console.log("");
  console.log(red("  selfrecap restart: DID NOT HAPPEN  "));
  console.log(`  ${message}`);
  if (command) {
    console.log("  To resume by hand, in a new terminal:");
    console.log(`     ${command}`);
  }
  console.log(`  Recorded in ${path.join(LOG_DIR, "lifecycle.log")}`);
  console.log("");
  if (!process.stdin.isTTY) return;
  console.log("  Press Enter to close this window.");
  await new Promise<void>((resolve) => readline.createInterface({ input: process.stdin }).once("line", () => resolve()));
}

// ─── the detached run ──────────────────────────────────────────────────────

/**
 * Execute a spec in the helper process launched through WMI. Refused inside a
 * Claude session: the helper runs in a clean user environment, so a `_run`
 * with CLAUDECODE set is a session calling it by hand, which would skip every
 * check `restart` makes about who is asking. Only spec files this script
 * wrote (under logs/run/) are read.
 */
async function run(specFile: string): Promise<void> {
  if (process.env.CLAUDECODE) fail("selfrecap: _run is the restart helper's own step and is refused inside a Claude session. Use selfrecap restart.", 3);
  const resolved = path.resolve(specFile);
  if (path.dirname(resolved).toLowerCase() !== path.resolve(RUN_DIR()).toLowerCase() || !fs.existsSync(resolved)) {
    fail(`selfrecap: _run takes only a spec file selfrecap wrote in ${RUN_DIR()}.`);
  }
  const spec = JSON.parse(fs.readFileSync(resolved, "utf8")) as RestartJob;
  fs.rmSync(resolved, { force: true });

  // Whatever goes wrong from here must end in a recorded outcome, never in silence.
  const died = (e: unknown) => {
    releaseLock(spec.name);
    recordLifecycle(spec.voice, "resume_failed", `restart helper crashed: ${(e as any)?.message ?? e}`, spec.session_id);
  };
  process.on("uncaughtException", (e) => {
    died(e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    died(e);
    process.exit(1);
  });

  process.title = `selfrecap: restart ${spec.name}`;
  console.log(`selfrecap: ${spec.name} asked to restart. Waiting for its turn to end (pid ${spec.pid})...`);
  const state = await waitIdle(spec.account, spec.pid, spec.session_id);
  if (state === "timeout") {
    releaseLock(spec.name);
    recordLifecycle(spec.voice, "aborted", `never went idle in ${IDLE_TIMEOUT_MS / 60_000} min; nothing was killed, nothing resumed`, spec.session_id);
    return banner(`${spec.name} never went idle, so nothing was killed. It is still running.`);
  }
  if (state === "gone") {
    // Closed before the helper acted: by the session, or by the operator's
    // hand. Either way that was a decision, and resuming over it would override it.
    releaseLock(spec.name);
    recordLifecycle(spec.voice, "aborted", "closed by someone else before the helper acted; not resumed", spec.session_id);
    return banner(`${spec.name} was closed before the restart helper acted, so it was not resumed.`, spec.command);
  }
  const row = rowOf(spec.account, spec.pid, spec.session_id);
  if (!row?.alive || !(await closeSession(row))) {
    releaseLock(spec.name);
    recordLifecycle(spec.voice, "aborted", `pid ${spec.pid} did not close; nothing else was done`, spec.session_id);
    return banner(`${spec.name} (pid ${spec.pid}) did not close. Nothing else was done.`);
  }
  console.log(`selfrecap: ${spec.name} closed. Resuming it by id ${spec.session_id}.`);
  return resumeHere(spec);
}

// ─── commands ──────────────────────────────────────────────────────────────

function cmdRestart(target: string | undefined): void {
  if (process.platform !== "win32") {
    fail(`${WINDOWS_ONLY}\n  Restart by hand: close this session, then run the command \`recap.ts --go\` printed.`);
  }
  try {
    const caller = callerSession();
    if (!caller) {
      fail("selfrecap: restart is run by a session from inside itself (its Bash tool). From a terminal: close the session's window, then run its restart command.");
    }
    if (target && caller.name?.toLowerCase() !== target.toLowerCase()) {
      fail(`selfrecap: restart acts only on the session that runs it. ${target} restarts itself, or its operator restarts it.`, 3);
    }
    scheduleSelfRestart(config, caller, (line) => console.log(line));
  } catch (e) {
    if (e instanceof RestartError) fail(e.message, e.code);
    throw e;
  }
}

function cmdLog(n: string | undefined): void {
  const lines = tailLifecycleLog(Number(n) || 20);
  console.log(lines.length ? lines.join("\n") : "(no lifecycle events yet)");
}

// ─── main ──────────────────────────────────────────────────────────────────

switch (cmd) {
  case "restart":
    cmdRestart(rest[0]);
    break;
  case "log":
    cmdLog(rest[0]);
    break;
  case "_run":
    await run(rest[0] ?? fail("selfrecap: _run needs a spec file"));
    process.exit(0);
  case undefined:
  case "help":
  case "--help":
  case "-h":
    usage(cmd ? 0 : 1);
  default:
    fail(`selfrecap: unknown command "${cmd}". Try: selfrecap help`);
}
