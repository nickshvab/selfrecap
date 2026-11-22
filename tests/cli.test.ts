/**
 * scripts/recap.ts run as the session runs it, against a real server on a
 * free loopback port, with every child_process call recorded
 * (fixtures/spawn-recorder.mjs). Proves the draft's off state: --draft and
 * --check refuse with one line naming the setting, the plan has no Draft
 * line, --find still saves the cut, and nothing is started. Then the
 * environment override turns it on for --draft --prepare-only, which builds
 * the work folder in the voice's own folder and still starts nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import yaml from "js-yaml";
import { loadConfig } from "../src/config.js";
import { DEFAULT_SERVER, recapCommand, shellArg } from "../src/lib/next-command.js";
import { buildApp } from "../src/server.js";
import { Session, tmpDir } from "./helpers.js";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const RECORDER = pathToFileURL(fileURLToPath(new URL("./fixtures/spawn-recorder.mjs", import.meta.url))).href;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", async () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

let close: () => Promise<void> = async () => {};
let ctx: { server: string; configFile: string; logDir: string; recaps: string; s: Session; boundary: string };

beforeAll(async () => {
  const dir = tmpDir();
  const projects = path.join(dir, "account", "projects", "-work-app");
  fs.mkdirSync(projects, { recursive: true });
  const s = new Session();
  s.meta("mode", { mode: "normal" });
  s.recap("ada", "ada-recap-001");
  s.user("first task, about the parser");
  s.assistantWithUsage("done with the parser", 400_000);
  s.system("turn_duration");
  const boundary = "a new arc opens with the exporter work today";
  s.user(boundary);
  s.assistantWithUsage("on it", 410_000);
  const session = s.write(projects);
  const recaps = path.join(dir, "recaps");
  fs.mkdirSync(recaps);
  const port = await freePort();
  const configFile = path.join(dir, "config.yaml");
  fs.writeFileSync(
    configFile,
    yaml.dump({
      server: { port, host: "127.0.0.1" },
      voices: { ada: { session, recaps, name: "Ada" } },
      allowed_roots: [path.join(dir, "account", "projects")],
      backup_dir: path.join(dir, "backups"),
    }),
  );
  const config = loadConfig(configFile);
  const { app } = buildApp(config);
  await app.listen({ port, host: "127.0.0.1" });
  close = () => app.close();
  ctx = { server: `http://127.0.0.1:${port}`, configFile, logDir: path.join(dir, "logs"), recaps, s, boundary };
}, 30_000);

afterAll(async () => {
  await close();
});

/** Run the CLI as a child (asynchronously: the server it calls runs in this process). */
async function recap(args: string[], env: Record<string, string> = {}) {
  const spawnLog = path.join(tmpDir(), "spawns.jsonl");
  const base = { ...process.env };
  delete base.SELFRECAP_DRAFT;
  const child = spawn(process.execPath, ["--import", RECORDER, "--import", "tsx", "scripts/recap.ts", ...args, "--server", ctx.server], {
    cwd: REPO,
    env: { ...base, RECAP_CONFIG: ctx.configFile, RECAP_LOG_DIR: ctx.logDir, SPAWN_LOG: spawnLog, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => child.kill(), 50_000);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  const spawned = fs.existsSync(spawnLog)
    ? fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { fn: string; command: string })
    : [];
  // tsx compiles the script with esbuild, which may run as a child process of its own: that is not the script's doing.
  return { code, out, err, spawned: spawned.filter((x) => !/esbuild/i.test(x.command)) };
}

describe("recap.ts with the draft off (the default)", async () => {
  it("--draft refuses with one line naming the setting, and starts nothing", async () => {
    const r = await recap(["ada", "--draft"]);
    expect(r.code).toBe(1);
    expect(r.err.trim().split("\n")).toHaveLength(1);
    expect(r.err).toMatch(/is off: set draft\.enabled: true in config\.yaml \(or SELFRECAP_DRAFT=1\)/);
    expect(r.spawned).toEqual([]);
  }, 60_000);

  it("--check refuses the same way, and starts nothing", async () => {
    const r = await recap(["ada", "--check"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^The check \(--check\) is off: set draft\.enabled/);
    expect(r.spawned).toEqual([]);
  }, 60_000);

  it("SELFRECAP_DRAFT=0 keeps it off even when the config turns it on", async () => {
    const on = path.join(tmpDir(), "config.yaml");
    const cfg = yaml.load(fs.readFileSync(ctx.configFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(on, yaml.dump({ ...cfg, draft: { enabled: true } }));
    const r = await recap(["ada", "--draft"], { RECAP_CONFIG: on, SELFRECAP_DRAFT: "0" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is off/);
    expect(r.spawned).toEqual([]);
  }, 60_000);

  it("--plan has no Draft line, says whether self-restart is there, and starts nothing", async () => {
    const r = await recap(["ada", "--plan"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^Next recap +ada-recap-002$/m);
    expect(r.out).not.toMatch(/^Draft /m);
    expect(r.out).toMatch(/^Self-restart +no: /m);
    expect(r.out).toMatch(/^Pending cut +none/m);
    expect(r.spawned).toEqual([]);
  }, 60_000);

  it("--find still saves the cut, and the plan shows it", async () => {
    const r = await recap(["ada", "--find", "exporter work today", "--before", "now"]);
    expect(r.code, r.err).toBe(0);
    const t1 = ctx.s.recs.find((x) => x.type === "system")!;
    expect(r.out).toContain(`Cut saved: ${t1.uuid}.`);
    expect(r.out).toMatch(/the dry run fills it into your sentinel/);
    // The printed next step carries the --server this run was given (a free port, not the default).
    expect(r.out).toMatch(new RegExp(`^Read the seam first: npx tsx scripts/recap\\.ts ada --around 5 --server ${ctx.server.replace(/\./g, "\\.")}$`, "m"));
    expect(r.out, "a record's time is UTC and says so").toMatch(/ 2026-\d\d-\d\dT\d\d:\d\d:\d\dZ  a new arc opens/);
    const plan = await recap(["ada", "--plan"]);
    expect(plan.out).toMatch(new RegExp(`^Pending cut +${t1.uuid}  \\(line 4, system/turn_duration; saved \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC by --find`, "m"));
    expect(plan.spawned).toEqual([]);
  }, 60_000);

  it("--at prints the moment it searched before in UTC, and the next step with this run's server", async () => {
    const r = await recap(["ada", "--at", "2099-01-01T00:00:00Z"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^─── the last record before 2099-01-01T00:00:00\.000Z ───$/m);
    expect(r.out).toMatch(new RegExp(`^Read further around it: npx tsx scripts/recap\\.ts ada --around \\d+ --server ${ctx.server.replace(/\./g, "\\.")}$`, "m"));
  }, 60_000);

  it("--go --restart with --force is refused before anything is sent", async () => {
    const r = await recap(["ada", "--go", "--restart", "--force"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--force and --restart do not go together/);
    expect(r.spawned).toEqual([]);
  }, 60_000);

  it("--restart without --go prints the command to run, with this run's server and body file", async () => {
    const r = await recap(["ada", "my body.txt", "--restart"]);
    expect(r.code).toBe(1);
    expect(r.err.trim()).toBe(`--restart goes with --go: npx tsx scripts/recap.ts ada 'my body.txt' --go --restart --server ${ctx.server}`);
  }, 60_000);
});

describe("next-step commands", () => {
  it("carry a non-default --server everywhere, --operator where the timeline is read, the body file where the body is used", () => {
    const server = "http://127.0.0.1:9292";
    expect(recapCommand("ada", ["--around", "133"], { server })).toBe("npx tsx scripts/recap.ts ada --around 133 --server http://127.0.0.1:9292");
    expect(recapCommand("ada", ["--go", "--restart"], { server: `${server}/` })).toBe("npx tsx scripts/recap.ts ada --go --restart --server http://127.0.0.1:9292");
    expect(recapCommand("ada", ["--around", "133"], { server: DEFAULT_SERVER }), "the default is left out").toBe("npx tsx scripts/recap.ts ada --around 133");
    expect(recapCommand("ada", ["--around", "133"]), "nothing passed, nothing carried").toBe("npx tsx scripts/recap.ts ada --around 133");
    const all = { server, operator: "Sam Lee", body: "/r/recap-002.body.txt" };
    expect(recapCommand("ada", ["--check"], all)).toBe("npx tsx scripts/recap.ts ada /r/recap-002.body.txt --check --operator 'Sam Lee' --server http://127.0.0.1:9292");
    expect(recapCommand("ada", ["--entry", "E-0001,E-0002"], all)).toBe("npx tsx scripts/recap.ts ada --entry E-0001,E-0002 --operator 'Sam Lee' --server http://127.0.0.1:9292");
    expect(recapCommand("ada", ["--go"], all), "--go takes the body file, not the operator").toBe("npx tsx scripts/recap.ts ada /r/recap-002.body.txt --go --server http://127.0.0.1:9292");
    expect(recapCommand("ada", [], all), "the dry run").toBe("npx tsx scripts/recap.ts ada /r/recap-002.body.txt --server http://127.0.0.1:9292");
    expect(recapCommand("ada", ["--around", "7"], all)).toBe("npx tsx scripts/recap.ts ada --around 7 --server http://127.0.0.1:9292");
    expect(shellArg("C:\\recaps\\recap-002.body.txt")).toBe("C:\\recaps\\recap-002.body.txt");
    expect(shellArg("it's here")).toBe('"it\'s here"');
  });
});

describe("recap.ts with SELFRECAP_DRAFT=1", async () => {
  it("--draft --prepare-only builds the work folder in the voice's own folder and starts nothing", async () => {
    const find = await recap(["ada", "--find", "exporter work today", "--before", "now"]);
    expect(find.code, find.err).toBe(0);
    const r = await recap(["ada", "--draft", "--prepare-only"], { SELFRECAP_DRAFT: "1" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Nothing started \(--prepare-only\)/);
    const work = path.join(ctx.recaps, "drafts", ".work");
    expect(fs.existsSync(path.join(work, "timeline.md"))).toBe(true);
    expect(fs.existsSync(path.join(work, "part-1", "brief.md"))).toBe(true);
    expect(fs.readFileSync(path.join(ctx.recaps, "drafts", ".gitignore"), "utf8")).toMatch(/^\*$/m);
    expect(fs.readFileSync(path.join(work, "part-1", "brief.md"), "utf8")).toMatch(/Ada works with the operator/);
    expect(r.spawned, "no claude, no shell: nothing at all").toEqual([]);
    const plan = await recap(["ada", "--plan"], { SELFRECAP_DRAFT: "1" });
    expect(plan.out).toMatch(/^Draft +not made yet; .*up to the pending cut/m);
    expect(plan.spawned).toEqual([]);
  }, 60_000);

  it("a RECAP_CONFIG that names a missing file is named as such, not as unset", async () => {
    const missing = path.join(tmpDir(), "missing.yaml");
    const r = await recap(["ada", "--plan"], { SELFRECAP_DRAFT: "1", RECAP_CONFIG: missing });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^Warning +RECAP_CONFIG names .*missing\.yaml, which is not there$/m);
    expect(r.out).not.toMatch(/no RECAP_CONFIG/);
  }, 60_000);
});
