#!/usr/bin/env node
// usage-statusline: the documented source of selfrecap's plan-usage bars.
//
// Claude Code runs a configured status line command with a JSON description
// of the session on stdin, and for Pro, Max and Ultra subscribers that JSON
// carries `rate_limits` (the five-hour and seven-day windows: used_percentage
// and resets_at). This script, set as the status line (or called from yours
// with the same stdin), saves that object for the session's account, and
// prints a short line such as `5h 23% · 7d 41%` (nothing with --quiet).
//
//   statusLine: { "type": "command", "command": "node <selfrecap-dir>/scripts/usage-statusline.mjs" }
//
// It costs nothing: no model call, no network, no credentials. It writes one
// small JSON file per account to ~/.selfrecap/usage/ (SELFRECAP_USAGE_DIR
// moves it), named by a hash of the account folder, holding only the
// rate_limits object, the time, the Claude Code version and the account
// folder's base name. The selfrecap server (usage.source: documented) reads
// those files for /contexts. The account is read off `transcript_path`
// (<account>/projects/<folder>/<session>.jsonl).
//
// Plain Node, no dependencies, no TypeScript: a status line runs often.
// Every error is swallowed: a status line must never fail.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const quiet = process.argv.includes("--quiet");
/** Rewrite an unchanged reading at most this often: the status line runs on every update. */
const REWRITE_MS = 60_000;

function usageDir(env = process.env) {
  return env.SELFRECAP_USAGE_DIR || path.join(os.homedir(), ".selfrecap", "usage");
}

/** The account folder a transcript belongs to, or null when the path does not have that shape. */
function accountOfTranscript(transcript) {
  if (typeof transcript !== "string" || !transcript) return null;
  const projects = path.dirname(path.dirname(path.resolve(transcript)));
  if (path.basename(projects).toLowerCase() !== "projects") return null;
  return path.dirname(projects);
}

/** The file one account's reading is kept in. Must match src/lib/account-usage.ts. */
function usageFileFor(account, dir) {
  const key = crypto.createHash("sha256").update(path.resolve(account).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(dir, `${key}.json`);
}

function pct(w) {
  return w && typeof w.used_percentage === "number" ? `${Math.round(w.used_percentage)}%` : null;
}

function save(input, dir) {
  const rl = input?.rate_limits;
  const account = accountOfTranscript(input?.transcript_path);
  if (!rl || typeof rl !== "object" || !account) return;
  const file = usageFileFor(account, dir);
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    if (JSON.stringify(old.rate_limits) === JSON.stringify(rl) && Date.now() - Date.parse(old.captured_at) < REWRITE_MS) return;
  } catch {
    // No reading yet, or an unreadable one: write.
  }
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    version: 1,
    account: path.basename(account),
    captured_at: new Date().toISOString(),
    claude_code_version: typeof input.version === "string" ? input.version : null,
    rate_limits: rl,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body));
  fs.renameSync(tmp, file);
}

function main(raw) {
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  try {
    save(input, usageDir());
  } catch {
    // Never fail a status line.
  }
  if (quiet) return;
  const parts = [];
  const five = pct(input?.rate_limits?.five_hour);
  const week = pct(input?.rate_limits?.seven_day);
  if (five) parts.push(`5h ${five}`);
  if (week) parts.push(`7d ${week}`);
  if (parts.length) process.stdout.write(`${parts.join(" · ")}\n`);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => main(raw));