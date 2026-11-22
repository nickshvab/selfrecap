/**
 * The documented source of the plan-usage bars: scripts/usage-statusline.mjs,
 * fed the JSON Claude Code hands a status line, saves `rate_limits` per
 * account; the server reads it back. No credentials, no network.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { accountUsage, documentedUsage, parseStatusLineLimits, usageFileFor } from "../src/lib/account-usage.js";
import { tmpDir } from "./helpers.js";

const SCRIPT = fileURLToPath(new URL("../scripts/usage-statusline.mjs", import.meta.url));

function statusLine(input: unknown, dir: string, args: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, SELFRECAP_USAGE_DIR: dir },
  });
}

const inAnHour = Math.floor(Date.now() / 1000) + 3600;
const inADay = Math.floor(Date.now() / 1000) + 86_400;

function account() {
  const root = tmpDir();
  const acct = path.join(root, ".claude");
  const transcript = path.join(acct, "projects", "-work-app", "11111111-1111-4111-8111-111111111111.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  return { acct, transcript, dir: path.join(root, "usage") };
}

describe("usage-statusline.mjs", () => {
  it("saves the rate limits for the transcript's account and prints a short line", () => {
    const { acct, transcript, dir } = account();
    const r = statusLine(
      {
        transcript_path: transcript,
        version: "2.1.330",
        model: { display_name: "Model" },
        rate_limits: { five_hour: { used_percentage: 23.5, resets_at: inAnHour }, seven_day: { used_percentage: 41.2, resets_at: inADay } },
      },
      dir,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("5h 24% · 7d 41%");
    const saved = JSON.parse(fs.readFileSync(usageFileFor(acct, dir), "utf8"));
    expect(saved.account).toBe(".claude");
    expect(saved.claude_code_version).toBe("2.1.330");
    expect(saved.rate_limits.five_hour.used_percentage).toBe(23.5);
    expect(Object.keys(saved).sort(), "nothing else of the session is kept").toEqual(["account", "captured_at", "claude_code_version", "rate_limits", "version"]);
  });

  it("--quiet prints nothing; no rate limits, a transcript of another shape, or bad input save nothing and never fail", () => {
    const { transcript, dir } = account();
    expect(statusLine({ transcript_path: transcript, rate_limits: { five_hour: { used_percentage: 1, resets_at: inAnHour } } }, dir, ["--quiet"]).stdout).toBe("");
    const other = account();
    expect(statusLine({ transcript_path: other.transcript }, other.dir).status).toBe(0);
    expect(statusLine({ transcript_path: "/x/y.jsonl", rate_limits: { five_hour: { used_percentage: 1 } } }, other.dir).status).toBe(0);
    expect(statusLine("not json", other.dir).status).toBe(0);
    expect(fs.existsSync(other.dir)).toBe(false);
  });
});

describe("the documented source on the server", () => {
  it("reads the saved windows, labelled like /usage; a reset window is dropped", () => {
    const now = Date.now();
    const w = parseStatusLineLimits(
      { five_hour: { used_percentage: 12, resets_at: Math.floor(now / 1000) - 10 }, seven_day: { used_percentage: 51, resets_at: inADay }, spend_limit: { used_percentage: 60, resets_at: inADay } },
      now,
    );
    expect(w.map((x) => [x.kind, x.label, x.percent])).toEqual([
      ["weekly_all", "Current week (all models)", 51],
      ["spend_limit", "Spend limit", 60],
    ]);
    expect(w[0]!.resets_at).toBe(new Date(inADay * 1000).toISOString());
  });

  it("documentedUsage: a reading, none yet, and one whose windows have all reset", async () => {
    const { acct, transcript, dir } = account();
    const none = documentedUsage(acct, dir)!;
    expect(none.ok).toBe(false);
    expect(none.source).toBe("documented");
    expect(none.error!).toMatch(/no status-line reading for this account yet/);
    expect(documentedUsage(path.join(tmpDir(), "missing-account"), dir), "no such account folder: left out").toBeNull();

    statusLine({ transcript_path: transcript, rate_limits: { five_hour: { used_percentage: 5, resets_at: inAnHour } } }, dir);
    const got = documentedUsage(acct, dir)!;
    expect(got).toMatchObject({ account: ".claude", source: "documented", ok: true, plan: null });
    expect(got.windows.map((x) => x.percent)).toEqual([5]);
    process.env.SELFRECAP_USAGE_DIR = dir;
    try {
      expect((await accountUsage([acct], { warn: () => {} }, "documented"))[".claude"]?.ok).toBe(true);
    } finally {
      delete process.env.SELFRECAP_USAGE_DIR;
    }

    expect(documentedUsage(acct, dir, (inAnHour + 10) * 1000)!.error!).toMatch(/no window that is still open/);
  });
});
