/**
 * Plan usage per Claude account: the bars `/usage` shows in Claude Code
 * ("Current session", "Current week (all models)", and a per-model week).
 * OFF BY DEFAULT: set `usage.enabled: true` in config.yaml to opt in. Two
 * sources, chosen by `usage.source`:
 *
 * DOCUMENTED (the default): what Claude Code hands its status line command.
 * For Pro, Max and Ultra subscribers its JSON carries `rate_limits` (the
 * five-hour and seven-day windows, with used_percentage and resets_at), and
 * scripts/usage-statusline.mjs, set as the status line, saves that object per
 * account in ~/.selfrecap/usage/ (SELFRECAP_USAGE_DIR moves it). This server
 * only reads those files: no credentials, no network, no model call. The
 * numbers are as fresh as the last status line update on that account, and
 * there is no per-model week.
 *
 * UNDOCUMENTED (usage.source: undocumented), described below:
 *
 * Source: GET https://api.anthropic.com/api/oauth/usage with the account's own
 * OAuth access token from <account>/.credentials.json. This is the endpoint
 * Claude Code's /usage screen calls. It is NOT a documented API and may change
 * or stop answering without notice: if it does, this reports an error for that
 * account and everything else keeps working. (The documented alternative, the
 * status line's `rate_limits`, carries only the session and the all-models
 * week, not the per-model weekly bar.) It may also refuse clients other than
 * Claude Code; this one sends `User-Agent: selfrecap/<version>` and reports a
 * refusal as one.
 *
 * Safety:
 *  - The token is read, sent only to api.anthropic.com (where Claude Code sends
 *    it), and never logged or returned. It is re-read from the file on every
 *    run and never kept: Claude Code rotates it, and a re-login replaces it.
 *  - The token is NEVER refreshed here. Refreshing rotates the refresh token and
 *    could log Claude Code out. An expired token is reported as such; the next
 *    Claude Code session on that account refreshes it.
 *  - Fetched on demand only: when /contexts is asked, at most once per
 *    REFRESH_MS. No background polling: with nobody asking, nothing calls the
 *    endpoint.
 *  - On macOS, Claude Code may keep the login in the Keychain instead of
 *    .credentials.json; then there is nothing to read and the account is
 *    simply left out.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { UsageSource } from "../config.js";
import { VERSION } from "../version.js";

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const USER_AGENT = `selfrecap/${VERSION}`;
const REFRESH_MS = 2 * 60_000;
const TIMEOUT_MS = 8_000;
/** How long the very first request waits for numbers before answering without them. */
const FIRST_WAIT_MS = 3_000;

export interface UsageWindow {
  /** As /usage titles it: "Current session", "Current week (all models)", "Current week (<model>)". */
  label: string;
  /** session | weekly_all | weekly_scoped | ... */
  kind: string;
  percent: number;
  resets_at: string | null;
  /** The server's own verdict: normal, warning, ... */
  severity: string | null;
}

export interface AccountUsage {
  /** Account folder name, e.g. .claude */
  account: string;
  /** Where the numbers came from (config usage.source). */
  source: UsageSource;
  plan: string | null;
  ok: boolean;
  error?: string;
  /** When these numbers were fetched (the last success). */
  fetched_at: string | null;
  /** When the last attempt ran, successful or not. */
  checked_at: string | null;
  windows: UsageWindow[];
}

const cache = new Map<string, AccountUsage>();
/** Per account: no request before this time (ms), set from a 429's retry-after. */
const backoffUntil = new Map<string, number>();

/** The last known usage per account, keyed by account folder name. */
export function accountUsageSnapshot(): Record<string, AccountUsage> {
  return Object.fromEntries([...cache.entries()].map(([k, v]) => [k, { ...v, windows: [...v.windows] }]));
}

function labelFor(kind: string, scope: any): string {
  if (kind === "session") return "Current session";
  if (kind === "weekly_all") return "Current week (all models)";
  const model = scope?.model?.display_name;
  if (model) return `Current week (${model})`;
  return kind.replace(/_/g, " ");
}

/** The windows out of a usage response: the `limits` list when present, else the older five_hour / seven_day fields. */
export function parseUsage(j: any): UsageWindow[] {
  if (Array.isArray(j?.limits) && j.limits.length > 0) {
    return j.limits
      .filter((l: any) => typeof l?.percent === "number")
      .map((l: any) => ({
        label: labelFor(String(l.kind ?? "limit"), l.scope),
        kind: String(l.kind ?? "limit"),
        percent: l.percent,
        resets_at: typeof l.resets_at === "string" ? l.resets_at : null,
        severity: typeof l.severity === "string" ? l.severity : null,
      }));
  }
  const out: UsageWindow[] = [];
  const add = (w: any, kind: string, label: string) => {
    if (w && typeof w.utilization === "number") {
      out.push({ label, kind, percent: w.utilization, resets_at: w.resets_at ?? null, severity: null });
    }
  };
  add(j?.five_hour, "session", "Current session");
  add(j?.seven_day, "weekly_all", "Current week (all models)");
  return out;
}

async function fetchOne(account: string): Promise<void> {
  const name = path.basename(account);
  const prev = cache.get(name);
  const now = new Date().toISOString();
  const keep = (error: string) =>
    cache.set(name, {
      account: name,
      source: "undocumented",
      plan: prev?.plan ?? null,
      ok: false,
      error,
      fetched_at: prev?.fetched_at ?? null,
      checked_at: now,
      windows: prev?.windows ?? [],
    });

  let oauth: any;
  try {
    oauth = JSON.parse(fs.readFileSync(path.join(account, ".credentials.json"), "utf8"))?.claudeAiOauth;
  } catch {
    cache.delete(name); // not logged in on this account: nothing to show
    return;
  }
  if (!oauth?.accessToken) {
    cache.delete(name);
    return;
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
    keep("login token expired; the next Claude Code session on this account refreshes it");
    return;
  }
  const wait = (backoffUntil.get(name) ?? 0) - Date.now();
  if (wait > 0) {
    keep(`usage endpoint rate-limited this account; next try in ${Math.ceil(wait / 60_000)} min`);
    return;
  }
  try {
    const res = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      // The token in the file is rotated by the CLI and replaced on re-login; it is re-read every run.
      keep(`login token rejected (HTTP ${res.status}): the account needs a fresh login or session, picked up on the next check`);
      return;
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      if (retry > 0) {
        backoffUntil.set(name, Date.now() + retry * 1000);
        keep(`usage endpoint rate-limited this account (HTTP 429); next try in ${Math.ceil(retry / 60)} min`);
      } else {
        keep("usage endpoint refused this client (HTTP 429 with no retry time): it may answer Claude Code only");
      }
      return;
    }
    if (!res.ok) {
      keep(`usage endpoint answered HTTP ${res.status}`);
      return;
    }
    const windows = parseUsage(await res.json());
    if (windows.length === 0) {
      keep("usage endpoint answered, but with no limits in a shape this server knows");
      return;
    }
    cache.set(name, { account: name, source: "undocumented", plan: oauth.subscriptionType ?? null, ok: true, fetched_at: now, checked_at: now, windows });
  } catch (e: any) {
    keep(`usage fetch failed: ${e?.name === "TimeoutError" ? "timeout" : (e?.message ?? e)}`);
  }
}

let lastRefresh = 0;
let inFlight: Promise<void> | null = null;

// ─── The documented source: what the status line was handed ─────────────────

/** Where scripts/usage-statusline.mjs keeps its readings. */
export function usageDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SELFRECAP_USAGE_DIR || path.join(os.homedir(), ".selfrecap", "usage");
}

/** The file one account's reading is kept in. Must match scripts/usage-statusline.mjs. */
export function usageFileFor(account: string, dir = usageDir()): string {
  const key = crypto.createHash("sha256").update(path.resolve(account).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(dir, `${key}.json`);
}

/** The windows in a status line's `rate_limits`, minus those whose reset time has passed. */
export function parseStatusLineLimits(rl: any, now = Date.now()): UsageWindow[] {
  const out: UsageWindow[] = [];
  const add = (w: any, kind: string, label: string) => {
    if (!w || typeof w.used_percentage !== "number") return;
    const resets = typeof w.resets_at === "number" ? w.resets_at * 1000 : null;
    // Claude Code drops a window once its reset time passes; a saved reading must too.
    if (resets !== null && resets <= now) return;
    out.push({ label, kind, percent: w.used_percentage, resets_at: resets === null ? null : new Date(resets).toISOString(), severity: null });
  };
  add(rl?.five_hour, "session", "Current session");
  add(rl?.seven_day, "weekly_all", "Current week (all models)");
  add(rl?.spend_limit, "spend_limit", "Spend limit");
  return out;
}

/** One account's usage from the status line's last reading. Reads one small file; never throws. */
export function documentedUsage(account: string, dir = usageDir(), now = Date.now()): AccountUsage | null {
  const name = path.basename(account);
  const checked = new Date(now).toISOString();
  const base = { account: name, source: "documented" as const, plan: null, checked_at: checked };
  let saved: any;
  try {
    saved = JSON.parse(fs.readFileSync(usageFileFor(account, dir), "utf8"));
  } catch (e: any) {
    if (e?.code !== "ENOENT") return { ...base, ok: false, error: "the saved status-line reading does not read", fetched_at: null, windows: [] };
    if (!fs.existsSync(account)) return null; // no such account folder here: nothing to show
    return {
      ...base,
      ok: false,
      error:
        "no status-line reading for this account yet: set scripts/usage-statusline.mjs as its status line (see docs/operations.md); " +
        "Claude Code hands it the limits only for Pro, Max and Ultra subscriptions, after a session's first reply",
      fetched_at: null,
      windows: [],
    };
  }
  const windows = parseStatusLineLimits(saved?.rate_limits, now);
  const fetched = typeof saved?.captured_at === "string" ? saved.captured_at : null;
  if (windows.length === 0) {
    return { ...base, ok: false, error: `the last status-line reading (${fetched ?? "time unknown"}) has no window that is still open; it updates when a session on this account next gets a reply`, fetched_at: fetched, windows: [] };
  }
  return { ...base, ok: true, fetched_at: fetched, windows };
}

/**
 * The usage for these accounts, from the configured source. Documented: the
 * status line's saved readings, read on each call (a few small files).
 * Undocumented: fetched on demand: only when someone asks (a /contexts
 * call), and at most once per REFRESH_MS. Nothing polls in the background,
 * so with nobody asking nothing calls the endpoint.
 *
 * Undocumented returns the cache at once when it is fresh. When it is stale,
 * a refresh starts; the first call (empty cache) waits up to FIRST_WAIT_MS for
 * it, later calls return the previous numbers and the refresh lands for the
 * next poll.
 */
export async function accountUsage(
  accounts: string[],
  log: { warn: (m: string) => void },
  source: UsageSource = "documented",
): Promise<Record<string, AccountUsage>> {
  if (source === "documented") {
    const out: Record<string, AccountUsage> = {};
    for (const a of accounts) {
      const u = documentedUsage(a);
      if (u) out[u.account] = u;
    }
    return out;
  }
  if (Date.now() - lastRefresh >= REFRESH_MS && !inFlight) {
    lastRefresh = Date.now();
    inFlight = Promise.all(
      accounts.map((a) => fetchOne(a).catch((e) => log.warn(`[usage] ${path.basename(a)}: ${e?.message ?? e}`))),
    ).then(() => {
      inFlight = null;
    });
  }
  if (cache.size === 0 && inFlight) {
    await Promise.race([inFlight, new Promise((r) => setTimeout(r, FIRST_WAIT_MS))]);
  }
  return accountUsageSnapshot();
}
