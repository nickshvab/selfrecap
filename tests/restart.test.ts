/**
 * The restart core shared by `selfrecap restart` and `recap.ts --go
 * --restart`: the lock, the checks made before anything is scheduled, and
 * the preflight --go --restart runs before anything is cut. Liveness and the
 * helper itself need Windows and a live session; these parts run anywhere.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { LOCK_STALE_MS, RestartError, acquireLock, checkSelfRestart, goRestartPreflight, lockFile, lockHeld, releaseLock } from "../src/lib/restart.js";
import type { LiveSession } from "../src/lib/sessions.js";
import { configFor, tmpDir } from "./helpers.js";

const account = path.join(os.homedir(), ".claude-test-account");
const cwd = path.resolve("/work/app");
const folder = cwd.replace(/[^A-Za-z0-9]/g, "-");
const session = (id: string) => path.join(account, "projects", folder, `${id}.jsonl`);

function setup() {
  const logDir = tmpDir();
  const cfg = configFor(tmpDir(), {
    voices: {
      ada: { session: session("aaaaaaaa-1111-4111-8111-111111111111"), restart: `cd ${cwd}; claude --resume {session_id} --name Ada`, name: "Ada" },
      bob: { session: session("bbbbbbbb-2222-4222-8222-222222222222"), restart: `cd ${cwd}; claude --resume {session_id} --name Bob`, name: "Bob" },
      cid: { session: session("cccccccc-3333-4333-8333-333333333333"), restart: "claude --resume abc", name: "Cid" },
    },
  });
  const deps = { platform: "win32", parseCheck: () => null, logDir };
  return { cfg, deps, logDir };
}

function caller(name: string, sessionId = "aaaaaaaa-1111-4111-8111-111111111111"): LiveSession {
  return {
    account, pid: 4242, sessionId, name, cwd: null, kind: "interactive", status: "busy", waitingFor: null,
    statusUpdatedAt: null, startedAt: null, pipe: null, file: "f", alive: true,
  };
}

const refusal = (fn: () => unknown): RestartError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RestartError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("the restart lock", () => {
  it("one holder per name; released; a stale lock is taken over", () => {
    const base = tmpDir();
    expect(lockHeld("Ada", base)).toBe(false);
    expect(acquireLock("Ada", base)).toBe(true);
    expect(lockHeld("ada", base), "names are case-insensitive").toBe(true);
    expect(acquireLock("ADA", base), "a second taker is refused").toBe(false);
    releaseLock("Ada", base);
    expect(lockHeld("Ada", base)).toBe(false);
    fs.mkdirSync(path.dirname(lockFile("Ada", base)), { recursive: true });
    fs.writeFileSync(lockFile("Ada", base), JSON.stringify({ what: "restart", at: new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString() }));
    expect(lockHeld("Ada", base), "a dead helper's lock is stale").toBe(false);
    expect(acquireLock("Ada", base)).toBe(true);
  });
});

describe("checkSelfRestart", () => {
  it("passes for a configured voice on its own account with a safe template", () => {
    const { cfg, deps } = setup();
    const r = checkSelfRestart(cfg, caller("Ada"), deps);
    expect(r.voice.key).toBe("ada");
    expect(r.command).toBe(`cd ${cwd}; claude --resume aaaaaaaa-1111-4111-8111-111111111111 --name Ada`);
  });

  it("refuses off Windows, a session that is no voice, an unsafe template, one that does not parse, and a pending restart", () => {
    const { cfg, deps, logDir } = setup();
    expect(refusal(() => checkSelfRestart(cfg, caller("Ada"), { ...deps, platform: "linux" })).message).toMatch(/Windows-only/);
    expect(refusal(() => checkSelfRestart(cfg, caller("Stranger"), deps)).message).toMatch(/is not a voice in config\.yaml/);
    expect(refusal(() => checkSelfRestart(cfg, { ...caller("Ada"), account: path.join(os.homedir(), ".claude-other") }, deps)).message, "the same name on another account is not the voice").toMatch(
      /is not a voice/,
    );
    expect(refusal(() => checkSelfRestart(cfg, caller("Cid"), deps)).message).toMatch(/restart template is not safe to run/);
    expect(refusal(() => checkSelfRestart(cfg, caller("Ada"), { ...deps, parseCheck: () => "Missing closing quote" })).message).toMatch(/does not parse in PowerShell/);
    acquireLock("Ada", logDir);
    const pending = refusal(() => checkSelfRestart(cfg, caller("Ada"), deps));
    expect(pending.message).toMatch(/already pending/);
    expect(pending.code).toBe(6);
  });
});

describe("goRestartPreflight: refused before anything is cut", () => {
  it("off Windows", () => {
    const { cfg, deps } = setup();
    expect(refusal(() => goRestartPreflight(cfg, "ada", caller("Ada"), { ...deps, platform: "darwin" })).message).toMatch(/^--restart: selfrecap restart is Windows-only/);
  });

  it("not from a session (a terminal)", () => {
    const { cfg, deps } = setup();
    expect(refusal(() => goRestartPreflight(cfg, "ada", null, deps)).message).toMatch(/this is not one/);
  });

  it("from another voice's session", () => {
    const { cfg, deps } = setup();
    expect(refusal(() => goRestartPreflight(cfg, "ada", caller("Bob", "bbbbbbbb-2222-4222-8222-222222222222"), deps)).message).toBe(
      "--restart would restart the session that runs it, Bob, not ada.",
    );
  });

  it("passes for the voice's own session", () => {
    const { cfg, deps } = setup();
    expect(goRestartPreflight(cfg, "Ada", caller("Ada"), deps).key).toBe("ada");
  });
});
