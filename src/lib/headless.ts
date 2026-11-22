/**
 * One headless Claude Code run: `claude -p` with a one-line prompt, no
 * session kept, started in an empty neutral folder, and its JSON result read
 * back. The draft's readers and the check's checker run this way, started by
 * recap.ts and waited for.
 *
 * What a run reads is untrusted: the period it summarizes holds web pages,
 * tool output and messages from others, any of which can carry text written
 * to steer a model. So a run gets only what its job needs, and nothing it
 * could be talked into using against the machine:
 *
 *   --restricted               no tool that runs commands or code, no WebFetch; the file
 *                              tools are confined to the working directories; user, project
 *                              and local settings files are not loaded (so none of their
 *                              hooks, permission rules or MCP servers); bypassPermissions is
 *                              refused; writes to settings, git and tool-configuration files
 *                              need a person to approve them, and there is none (below)
 *   --tools Read,Write,Edit    read its brief and its part of the record, write its one file
 *   --add-dir <run folder>     its own folder under <recaps>/drafts/.work/: the only working
 *                              directory besides the empty neutral folder it starts in
 *   --permission-mode acceptEdits   edits inside the working directories go through without a prompt
 *   --permission-prompts none  anything else that would ask is denied, not left waiting
 *   --settings {...}           blockReadsOutsideWorkingDirectories and
 *                              blockWritesOutsideWorkingDirectories: the file tools refuse
 *                              paths outside the working directories in every mode (a second
 *                              fence behind --restricted); disableAllHooks
 *   --safe-mode                no CLAUDE.md, skills, plugins, hooks or MCP servers: a cold reader
 *   --strict-mcp-config        and no MCP servers from anywhere else either
 *   --disable-slash-commands   no skills or commands
 *   --no-session-persistence   no transcript: these runs never show in a resume list
 *   --name <label>             the run's name while it runs (selfrecap-reader-1-<voice>):
 *                              it never answers to the voice's own name
 *   --output-format json       duration, cost, tokens and denied calls come back with the result
 *
 * Needs Claude Code MIN_CLAUDE_VERSION or later (blockWritesOutsideWorkingDirectories
 * came in 2.1.314, --restricted in 2.1.248, --permission-prompts in 2.1.259);
 * checkClaudeVersion refuses an older one before anything starts.
 *
 * The environment is the caller's, so the run is billed to the same Claude
 * account as the session that runs recap.ts (API credit when
 * ANTHROPIC_API_KEY is set), minus every CLAUDE* variable but
 * CLAUDE_CONFIG_DIR (the account) and CLAUDE_CODE_OAUTH_TOKEN: the rest
 * describe the calling session (its pid, messaging pipe, Remote Control,
 * effort), and a child that inherits them acts as part of it.
 *
 * Tests inject their own HeadlessRunner; nothing here is called by them.
 */

import { spawn, spawnSync } from "child_process";
import path from "path";
import { claudeBin } from "./sessions.js";

/** The oldest Claude Code whose flags and settings keep a run inside its folder. */
export const MIN_CLAUDE_VERSION = "2.1.314";

export interface HeadlessRun {
  /** A short label for messages: "reader 2", "checker". */
  label: string;
  /** The name the run carries while it runs: never the voice's own. */
  name?: string;
  prompt: string;
  model: string;
  /** The empty neutral folder the run starts in: no CLAUDE.md near it, nothing of the period in it. */
  cwd: string;
  /** Its own folder in the work folder (--add-dir); its brief names files there by absolute path. */
  addDirs?: string[];
  timeoutMs: number;
}

export interface HeadlessResult {
  /** Exited 0 and Claude did not report an error. Says nothing about the file it was asked to write. */
  ok: boolean;
  exitCode: number | null;
  /** Wall time of the run. */
  durationMs: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  turns: number | null;
  /** The model that answered, as Claude Code reports it. */
  model: string | null;
  /**
   * Tool calls Claude Code refused (a write or read outside the run's folder,
   * a protected file), as "Tool name-of-file". Null when not reported. A
   * refused call usually means the period held text that steered the model.
   */
  denied: string[] | null;
  error?: string;
}

export type HeadlessRunner = (run: HeadlessRun) => Promise<HeadlessResult>;

const KEEP_CLAUDE_VARS = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]);

/** The caller's environment without the variables that tie a process to the calling session. */
export function headlessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^claude/i.test(k) && !KEEP_CLAUDE_VARS.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  return env;
}

/** The settings a run gets on top of the managed ones (--restricted loads no others). Only keys Claude Code documents. */
export function headlessSettings(): Record<string, unknown> {
  return {
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    },
    disableAllHooks: true,
  };
}

export function headlessArgs(run: Pick<HeadlessRun, "prompt" | "model" | "name" | "addDirs">): string[] {
  return [
    "-p",
    run.prompt,
    "--model",
    run.model,
    ...(run.name ? ["--name", run.name] : []),
    // --add-dir takes several values: each one is followed by a flag, never by the prompt.
    ...(run.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    "--output-format",
    "json",
    "--no-session-persistence",
    "--restricted",
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--tools",
    "Read,Write,Edit",
    "--permission-mode",
    "acceptEdits",
    "--permission-prompts",
    "none",
    "--settings",
    JSON.stringify(headlessSettings()),
  ];
}

/** Read what `claude -p --output-format json` printed. Fields it lacks come back null. */
export function parseHeadlessOutput(stdout: string): Omit<HeadlessResult, "ok" | "exitCode" | "durationMs"> & { isError: boolean | null } {
  let j: any = null;
  const text = stdout.trim();
  try {
    j = JSON.parse(text);
  } catch {
    // Some builds print a line before the JSON: take the last line that parses.
    for (const line of text.split(/\r?\n/).reverse()) {
      try {
        j = JSON.parse(line);
        break;
      } catch {
        // keep looking
      }
    }
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const u = j?.usage ?? {};
  const models = j?.modelUsage && typeof j.modelUsage === "object" ? Object.keys(j.modelUsage) : [];
  const denials: any[] | null = Array.isArray(j?.permission_denials) ? j.permission_denials : null;
  return {
    costUsd: num(j?.total_cost_usd),
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    turns: num(j?.num_turns),
    model: models[0] ?? null,
    // The file name only: the path an injected text aimed at is not repeated in full.
    denied: denials
      ? denials.map((d) => {
          const target = d?.tool_input?.file_path ?? d?.tool_input?.path;
          return `${String(d?.tool_name ?? "?")}${typeof target === "string" ? ` ${path.basename(target.replace(/\\/g, "/"))}` : ""}`;
        })
      : null,
    isError: typeof j?.is_error === "boolean" ? j.is_error : null,
    ...(j === null && text ? { error: `output was not JSON: ${text.slice(0, 200)}` } : {}),
  };
}

/** "2.1.330 (Claude Code)" → "2.1.330". */
export function parseClaudeVersion(text: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0] ?? null;
}

export function versionAtLeast(version: string, wanted: string): boolean {
  const a = version.split(".").map((n) => parseInt(n, 10) || 0);
  const b = wanted.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/**
 * The Claude Code a run would start, checked before any run: found, and new
 * enough for the flags that keep a run in its folder. `claude --version`
 * makes no model call.
 */
export function checkClaudeVersion(bin: string | null = claudeBin()): { ok: true; version: string } | { ok: false; message: string } {
  if (!bin) {
    return { ok: false, message: "no claude executable found (on Windows a claude.exe in ~/.local/bin or on PATH; an npm claude.cmd cannot be started without a shell)" };
  }
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", windowsHide: true, env: headlessEnv(), timeout: 30_000 });
  const version = parseClaudeVersion(`${r.stdout ?? ""}`);
  if (r.error || !version) return { ok: false, message: `could not read the Claude Code version (${r.error?.message ?? "no version in its output"})` };
  if (!versionAtLeast(version, MIN_CLAUDE_VERSION)) {
    return {
      ok: false,
      message:
        `Claude Code ${version} is older than ${MIN_CLAUDE_VERSION}, the first with everything that keeps a reader inside its folder ` +
        "(--restricted, --permission-prompts none, permissions.blockWritesOutsideWorkingDirectories). Update Claude Code (claude update).",
    };
  }
  return { ok: true, version };
}

/** Run claude headless and wait for it (or kill it at the timeout: only this child, nothing else). */
export const runHeadless: HeadlessRunner = (run) =>
  new Promise((resolve) => {
    const started = Date.now();
    const nothing = { costUsd: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, turns: null, model: null, denied: null };
    const bin = claudeBin();
    if (!bin) {
      resolve({ ...nothing, ok: false, exitCode: null, durationMs: 0, error: "could not start claude: no claude executable found" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(bin, headlessArgs(run), {
      cwd: run.cwd,
      env: headlessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const { isError, ...rest } = parseHeadlessOutput(stdout);
      const problem =
        error ??
        rest.error ??
        (exitCode !== 0 ? `exited ${exitCode}: ${(stderr || stdout).replace(/\s+/g, " ").trim().slice(-300)}` : isError ? "Claude reported an error" : undefined);
      resolve({
        ...rest,
        ok: exitCode === 0 && isError !== true && !problem,
        exitCode,
        durationMs: Date.now() - started,
        ...(problem ? { error: problem } : {}),
      });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null, `timed out after ${Math.round(run.timeoutMs / 60_000)} min`);
    }, run.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", (e) => finish(null, `could not start claude: ${e.message}`));
    child.on("close", (code) => finish(code));
  });
