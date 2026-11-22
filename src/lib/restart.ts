/**
 * Scheduling a session's restart of itself: the part of `selfrecap restart`
 * that `recap.ts <voice> --go --restart` needs too, so both go through one
 * code path. WINDOWS ONLY, like everything that reads liveness.
 *
 *   callerSession        which Claude Code session runs this process (null for a terminal)
 *   checkSelfRestart     everything checked before anything is scheduled: Windows, the
 *                        caller is a configured voice, its restart template is safe and
 *                        parses in PowerShell, no restart already pending
 *   scheduleSelfRestart  the checks again, then the lock, then the helper in its own console
 *   goRestartPreflight   for --go --restart: the same checks, BEFORE the surgery, plus
 *                        "the caller is the voice being cut"
 *
 * Nothing here exits the process: a refusal is a RestartError carrying the
 * words and the exit code `selfrecap` uses for it, and the script decides how
 * to say it.
 *
 * The helper that waits for the turn to end, closes the session and resumes
 * it is `selfrecap _run` (scripts/selfrecap.ts), started through WMI by
 * runDetached, outside the caller's process tree and with the user's own
 * environment; a log folder chosen with RECAP_LOG_DIR is handed over to it.
 * One lock per name, from the launch until the outcome is known, keeps a
 * doubled restart from starting two sessions on one name.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { checkRestart, restartCommandFor, type AppConfig } from "../config.js";
import { resolveLiveSession } from "./continuation.js";
import { LOG_DIR, recordLifecycle } from "./lifecycle-log.js";
import { isAncestor, launchDetached, powershellParseError, processParents, voiceOfSession, type VoiceRef } from "./lifecycle.js";
import { buildRecapPlan } from "./recap-plan.js";
import { pipeKey, readRegistry, type LiveSession } from "./sessions.js";

/** The repo root, scripts/selfrecap.ts and tsx's loader, from src/lib or dist/lib alike. */
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SELFRECAP = fileURLToPath(new URL("../../scripts/selfrecap.ts", import.meta.url));
const TSX_LOADER = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

/** A restart lock older than this is a dead helper's: taken over. Idle wait + resume check + slack. */
export const LOCK_STALE_MS = 30 * 60_000;

/** A refusal: its message, and the exit code `selfrecap` uses for it. */
export class RestartError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

/** Test seams: the platform, the PowerShell parse check, and where the lock lives. */
export interface RestartDeps {
  platform?: string;
  parseCheck?: (commandLine: string) => string | null;
  logDir?: string;
}

// ─── one restart per name at a time ────────────────────────────────────────

export const RUN_DIR = (base = LOG_DIR) => path.join(base, "run");

export function lockFile(name: string, base = LOG_DIR): string {
  return path.join(RUN_DIR(base), `lock-${name.toLowerCase()}.json`);
}

/**
 * Take the lock for a name, held from the moment a restart is launched until
 * its session is registered again (or the restart gave up). Without it a
 * doubled `selfrecap restart` would see the name free twice and start two
 * copies: two sessions on one name, and neither is reachable by it.
 */
export function acquireLock(name: string, base = LOG_DIR): boolean {
  const file = lockFile(name, base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ what: "restart", at: new Date().toISOString(), pid: process.pid, nonce: crypto.randomUUID() });
  try {
    fs.writeFileSync(file, body, { flag: "wx" });
    return true;
  } catch {
    try {
      const held = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Date.now() - Date.parse(held.at) < LOCK_STALE_MS) return false;
    } catch {
      // unreadable: treat as stale
    }
    // Take over a stale lock by replacing it whole, then check it is ours: of
    // two takers at once, only the one whose body is there holds it.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    try {
      return fs.readFileSync(file, "utf8") === body;
    } catch {
      return false;
    }
  }
}

export function releaseLock(name: string, base = LOG_DIR): void {
  fs.rmSync(lockFile(name, base), { force: true });
}

export function lockHeld(name: string, base = LOG_DIR): boolean {
  try {
    const held = JSON.parse(fs.readFileSync(lockFile(name, base), "utf8"));
    return Date.now() - Date.parse(held.at) < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function short(account: string): string {
  return path.basename(account);
}

// ─── who is calling ────────────────────────────────────────────────────────

/**
 * The Claude Code session this process runs inside; null for a human terminal.
 *
 * Claude Code gives every tool process its session's pid, id and messaging
 * pipe (CLAUDE_PID, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_MESSAGING_SOCKET).
 * All three must match one live registry row. And when the process tree can
 * answer (from Git Bash it usually cannot: see isAncestor), that pid must be
 * above us. This stops mistakes: a stale variable, a copied command, a script
 * run from the wrong shell. It is not a lock against a session that forges
 * another's environment on purpose.
 *
 * A subagent inside a session inherits the session's environment, so it counts
 * as the session: `selfrecap restart` from a session's own helper agent
 * restarts that session. That is the session's own act (it launched the helper).
 */
export function callerSession(env: NodeJS.ProcessEnv = process.env): LiveSession | null {
  if (!env.CLAUDECODE) return null;
  const pid = Number(env.CLAUDE_PID);
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  const pipe = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!pid || !sessionId || !pipe) {
    throw new RestartError(
      "selfrecap: inside Claude Code, but CLAUDE_PID / CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_MESSAGING_SOCKET is missing: " +
        "cannot tell which session is calling (Claude Code without cross-session messaging?).",
    );
  }
  const account = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const row = readRegistry(account).find((r) => r.pid === pid && r.sessionId === sessionId && r.alive);
  if (!row) throw new RestartError(`selfrecap: no live registry row for this session (pid ${pid}, ${sessionId}) in ${account}${path.sep}sessions.`);
  if (!row.pipe || pipeKey(row.pipe) !== pipeKey(pipe)) {
    throw new RestartError("selfrecap: this session's messaging pipe does not match its registry row. The environment does not describe the session running selfrecap; refusing.");
  }
  if (isAncestor(pid, process.pid, processParents()) === "no") {
    throw new RestartError(`selfrecap: pid ${pid} is not above this process in the process tree. The environment does not describe the session running selfrecap; refusing.`);
  }
  return row;
}

// ─── the spec a detached run executes ──────────────────────────────────────

export interface RestartJob {
  kind: "restart";
  voice: string;
  name: string;
  account: string;
  pid: number;
  session_id: string;
  command: string;
  recap_id: string | null;
}

/**
 * Run a spec in its own process outside the caller's tree, in a new console.
 * On a launch failure the lock is released and the failure recorded, and this
 * throws a RestartError.
 */
export function runDetached(spec: RestartJob): number {
  fs.mkdirSync(RUN_DIR(), { recursive: true });
  const file = path.join(RUN_DIR(), `${spec.kind}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  let commandLine = `"${process.execPath}" --import ${TSX_LOADER} "${SELFRECAP}" _run "${file}"`;
  // The helper starts with the user's own environment, not ours: a log folder
  // chosen with RECAP_LOG_DIR has to be handed over, or the helper would look
  // for this spec (and the lock) in the default one.
  if (process.env.RECAP_LOG_DIR) {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    commandLine =
      `powershell.exe -NoProfile -Command "$env:RECAP_LOG_DIR=${q(process.env.RECAP_LOG_DIR)}; ` +
      `& ${q(process.execPath)} --import ${q(TSX_LOADER)} ${q(SELFRECAP)} _run ${q(file)}"`;
  }
  try {
    return launchDetached(commandLine, REPO);
  } catch (e: any) {
    fs.rmSync(file, { force: true });
    releaseLock(spec.name);
    recordLifecycle(spec.voice, "aborted", `restart: the helper could not be started: ${e?.message ?? e}`, spec.session_id);
    throw new RestartError(`selfrecap: could not start the restart helper: ${e?.message ?? e}\n  Nothing was done. Recorded in selfrecap log.`);
  }
}

// ─── restarting yourself ───────────────────────────────────────────────────

export const WINDOWS_ONLY =
  "selfrecap restart is Windows-only (it checks liveness through Claude Code's Windows named pipes and starts the new console through WMI).";

/**
 * Everything checked before a restart is scheduled; writes nothing. Returns
 * the voice the caller is and its restart command. Throws RestartError.
 */
export function checkSelfRestart(config: AppConfig, caller: LiveSession, deps: RestartDeps = {}): { voice: VoiceRef; command: string } {
  if ((deps.platform ?? process.platform) !== "win32") throw new RestartError(WINDOWS_ONLY);
  const name = caller.name ?? "(unnamed)";
  const voice = voiceOfSession(config, caller);
  if (!voice) {
    throw new RestartError(
      `selfrecap: ${name} on ${short(caller.account)} is not a voice in config.yaml (by its --name and account), so there is nothing to resume it into.\n` +
        `  Put this line in your report; the operator restarts you by hand.`,
    );
  }
  const check = checkRestart(voice.entry.session, voice.entry.restart);
  if (check.errors.length > 0) {
    throw new RestartError(`selfrecap: ${voice.name}'s restart template is not safe to run:\n  ${check.errors.join("\n  ")}\n  Put this in your report; the operator restarts you by hand.`);
  }
  const command = restartCommandFor(voice.entry, caller.sessionId)!;
  // Nothing is closed unless the command that resumes the session parses.
  const parse = (deps.parseCheck ?? powershellParseError)(command);
  if (parse) {
    throw new RestartError(`selfrecap: ${voice.name}'s restart command does not parse in PowerShell (${parse}).\n  Put this in your report; the operator restarts you by hand.`);
  }
  if (lockHeld(voice.name, deps.logDir)) {
    throw new RestartError(`selfrecap: a restart is already pending for ${voice.name}. Nothing new scheduled: send your report and end your turn.`, 6);
  }
  return { voice, command };
}

/**
 * Schedule the caller's restart: when its turn ends, the helper closes the
 * session and resumes it by id in its own console. `say` gets the lines as
 * they happen. Returns the helper's pid. Throws RestartError.
 */
export function scheduleSelfRestart(config: AppConfig, caller: LiveSession, say: (line: string) => void, deps: RestartDeps = {}): number {
  const { voice } = checkSelfRestart(config, caller, deps);
  // Resume the id that is actually running. If config.yaml leads somewhere
  // else, that is drift: say it loudly, but do not resume a guess.
  const resolved = resolveLiveSession(voice.entry.session);
  const configId = path.basename(resolved.resolved_path, ".jsonl");
  const drift = configId !== caller.sessionId;
  if (drift) {
    const detail = `running ${caller.sessionId}, but config.yaml leads to ${configId}: update the voice's session`;
    recordLifecycle(voice.key, "id_drift", detail, caller.sessionId);
    say(`selfrecap: WARNING ${detail}. Resuming the running id.`);
  }
  const command = restartCommandFor(voice.entry, caller.sessionId)!;
  // Name the recap in the resume prompt only if one really landed in THIS session
  // since this process started. Under drift the plan reads another file.
  let recapId: string | null = null;
  if (!drift) {
    try {
      const last = buildRecapPlan(config, voice.key).stack.at(-1);
      if (last?.id && last.applied_at && caller.startedAt && Date.parse(last.applied_at) > caller.startedAt) recapId = last.id;
    } catch {
      // No plan: the resume prompt simply does not name a recap.
    }
  }
  if (!acquireLock(voice.name, deps.logDir)) {
    throw new RestartError(`selfrecap: a restart is already pending for ${voice.name}. Nothing new scheduled: send your report and end your turn.`, 6);
  }
  const pid = runDetached({
    kind: "restart",
    voice: voice.key,
    name: voice.name,
    account: caller.account,
    pid: caller.pid,
    session_id: caller.sessionId,
    command,
    recap_id: recapId,
  });
  recordLifecycle(voice.key, "restart_scheduled", `helper pid ${pid}`, caller.sessionId);
  say(`selfrecap: restart scheduled for ${voice.name} (helper pid ${pid}, in its own console).`);
  say(`  Send your report, then end your turn. When you go idle this session closes and resumes by id`);
  say(`  ${caller.sessionId} in that console, with a resume prompt. Nothing after the report: every`);
  say(`  further turn here costs context in the old session.`);
  return pid;
}

/**
 * For `recap.ts <voice> --go --restart`, before anything is cut: a surgery
 * whose restart then fails would leave the session running on the old
 * context at the context limit. Windows, a calling session, and that session is the
 * voice being cut; then every check `selfrecap restart` makes. Throws
 * RestartError; writes nothing.
 */
export function goRestartPreflight(config: AppConfig, planVoice: string, caller: LiveSession | null, deps: RestartDeps = {}): VoiceRef {
  if ((deps.platform ?? process.platform) !== "win32") throw new RestartError(`--restart: ${WINDOWS_ONLY}`);
  if (!caller) {
    throw new RestartError("--restart schedules selfrecap restart for the Claude Code session that runs it, and this is not one (a terminal, or a script outside a session).");
  }
  const { voice } = checkSelfRestart(config, caller, deps);
  if (voice.key !== planVoice.toLowerCase()) {
    throw new RestartError(`--restart would restart the session that runs it, ${voice.name}, not ${planVoice}.`);
  }
  return voice;
}
