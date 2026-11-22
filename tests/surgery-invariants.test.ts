/**
 * Invariant tests — the credibility core. After surgery the resulting file must
 * preserve the chain, never dangle into the cut range, keep tool pairs balanced,
 * and preserve leading recaps.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { dryRunFailures, performSurgery } from "../src/lib/surgery.js";
import { loadJsonl } from "../src/lib/jsonl.js";
import { isRecapRecord } from "../src/lib/recaps.js";
import {
  FIXTURE_PATH,
  SENTINEL,
  Session,
  chainFromLeaf,
  fixtureRecords,
  lines,
  makeWorkspace,
  recapText,
  records,
  tmpDir,
  type TempWorkspace,
} from "./helpers.js";

const RECAP_BODY =
  "New recap body for this cycle.\n\n```json\n" +
  JSON.stringify({ sentinel: SENTINEL, voice: "tester", id: "recap-002", version: 1 }) +
  "\n```\n";

// Cut at sess-uuid-10: a clean end_turn assistant after the recap and after two
// complete tool pairs (so no pair is split by the cut).
const CUT_UUID = "sess-uuid-10";

let ws: TempWorkspace[] = [];
afterEach(() => {
  for (const w of ws) w.cleanup();
  ws = [];
});

function newWorkspace(): TempWorkspace {
  const w = makeWorkspace();
  ws.push(w);
  return w;
}

describe("surgery invariants (dry run)", () => {
  it("reports a valid plan without mutating the file", async () => {
    const w = newWorkspace();
    const before = fs.readFileSync(w.filePath, "utf8");
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
      dry_run: true,
    });
    expect(res.ok).toBe(true);
    expect(res.dry_run).toBe(true);
    // No mutation in dry run.
    expect(fs.readFileSync(w.filePath, "utf8")).toBe(before);
    expect(fs.existsSync(w.backupDir)).toBe(false);
  });
});

describe("surgery invariants (real)", () => {
  it("parentUuid chain is unbroken from new recap to last surviving record", async () => {
    const w = newWorkspace();
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);

    const out = loadJsonl(w.filePath);
    // Walk the chain: each record's parentUuid must equal the previous uuid.
    // Index 0 is the preserved leading recap (parentUuid null).
    expect(out[0]?.parentUuid).toBe(null);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]?.parentUuid).toBe(out[i - 1]?.uuid);
    }
  });

  it("no surviving record points at a uuid that was in the cut range", async () => {
    const w = newWorkspace();
    // Cut range (after the leading recap) is sess-uuid-01..sess-uuid-10 inclusive.
    const cutRangeUuids = new Set(
      fixtureRecords()
        .slice(1, 11)
        .map((r) => r.uuid)
        .filter((u): u is string => typeof u === "string"),
    );
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);

    const out = loadJsonl(w.filePath);
    for (const r of out) {
      if (r.parentUuid) {
        expect(cutRangeUuids.has(r.parentUuid)).toBe(false);
      }
    }
  });

  it("tool_use ids match tool_result ids (zero orphans) for a non-splitting cut", async () => {
    const w = newWorkspace();
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics.pair_balance).not.toBeNull();
    expect(res.diagnostics.pair_balance?.orphans).toBe(0);

    // Independently confirm the id sets are equal in the written file.
    const out = loadJsonl(w.filePath);
    const useIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const r of out) {
      const c = r.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === "tool_use" && b.id) useIds.add(b.id);
          if (b?.type === "tool_result" && b.tool_use_id) resultIds.add(b.tool_use_id);
        }
      }
    }
    expect([...useIds].sort()).toEqual([...resultIds].sort());
  });

  it("preserves N leading recaps and inserts one more (N -> N+1)", async () => {
    const w = newWorkspace();
    // Fixture has exactly 1 leading recap.
    const leadingBefore = 1;
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics.leading_recaps_preserved).toBe(leadingBefore);

    const out = loadJsonl(w.filePath);
    // Count consecutive leading recaps in the output, using the same detection
    // the library uses (getRecordText, not raw JSON which escapes the quotes).
    let count = 0;
    for (const r of out) {
      if (!r.uuid) continue;
      if (isRecapRecord(r, SENTINEL)) count++;
      else break;
    }
    expect(count).toBe(leadingBefore + 1);
  });

  it("new_recap_position equals leading_recaps_preserved", async () => {
    const w = newWorkspace();
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics.new_recap_position).toBe(res.diagnostics.leading_recaps_preserved);

    // And the new recap really sits at that index in the output.
    const out = loadJsonl(w.filePath);
    const pos = res.diagnostics.new_recap_position!;
    expect(out[pos]?.uuid).toBe(res.diagnostics.new_recap_uuid);
  });

  it("writes a backup of the original before mutating", async () => {
    const w = newWorkspace();
    const originalText = fs.readFileSync(FIXTURE_PATH, "utf8");
    const res = await performSurgery({
      file_path: w.filePath,
      cut_through_uuid: CUT_UUID,
      recap_content: RECAP_BODY,
      backup_dir: w.backupDir,
      sentinel_name: SENTINEL,
    });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(w.backupDir)).toBe(true);
    const backups = fs.readdirSync(w.backupDir);
    expect(backups.length).toBe(1);
    // The backup is the pre-surgery content (== the fixture we copied in).
    const backupText = fs.readFileSync(`${w.backupDir}/${backups[0]}`, "utf8");
    expect(backupText).toBe(originalText);
  });
});

/**
 * A session brought up from disk after its first tool call: Claude Code then
 * writes request-log records holding COPIES of the earlier tool_use and
 * tool_result. Counted as conversation, the copies after the cut would look
 * like surviving results of a cut tool call.
 */
function resumedAfterToolCall() {
  const s = new Session();
  s.meta("mode", { mode: "normal" });
  s.recap("ada", "ada-recap-001");
  s.user("run it");
  const use = s.toolUse("toolu_old");
  s.toolResult("toolu_old", "ok");
  s.requestBlob({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "ok" }] });
  s.requestLog();
  s.assistant("ran it");
  const t1 = s.system("turn_duration");
  // The resume: the shape, then copies of the whole earlier exchange.
  s.requestShape();
  const copies = [
    s.requestBlob({ role: "assistant", content: [{ type: "tool_use", id: "toolu_old", name: "Bash", input: { command: "ls" } }] }),
    s.requestBlob({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "ok" }] }),
  ];
  s.requestLog();
  s.user("new arc starts here");
  s.assistant("on it");
  return { s, use, t1, copies };
}

function runAda(file: string, dir: string, cut: string, id = "ada-recap-002") {
  return performSurgery({
    file_path: file,
    cut_through_uuid: cut,
    recap_content: recapText("ada", id, cut),
    voice: "ada",
    backup_dir: path.join(dir, "backups"),
    sentinel_name: SENTINEL,
    expose_paths: true,
  });
}

describe("request-log records", () => {
  it("copies after the cut are not counted as surviving tool results", () => {
    const dir = tmpDir();
    const { s, t1, copies } = resumedAfterToolCall();
    const file = s.write(dir);
    const copyLines = copies.map((c) => JSON.stringify(c));

    const res = runAda(file, dir, t1.uuid);
    expect(res.ok, res.reason).toBe(true);
    const d = res.diagnostics;
    expect(d.cut_orphaned_tool_results).toEqual([]);
    expect(d.pair_balance?.orphans).toBe(0);
    expect(d.pair_balance?.tool_use, "the copies are not counted as tool calls").toBe(0);
    expect(d.api_request_records_cut, "the blob and the request record inside the range go with it").toBe(2);
    const after = lines(file);
    for (const c of copyLines) expect(after.includes(c), "a request-log record after the cut is kept byte for byte").toBe(true);
    expect(chainFromLeaf(records(file))).toContain(d.new_recap_uuid!);
  });

  it("a real orphan is still refused when request-log copies sit around it", () => {
    const dir = tmpDir();
    const { s, use } = resumedAfterToolCall();
    const file = s.write(dir);
    const before = fs.readFileSync(file);

    const res = runAda(file, dir, use.uuid);
    expect(res.ok).toBe(false);
    expect(res.reason!).toMatch(/^cut_splits_tool_call/);
    expect(res.diagnostics.cut_orphaned_tool_results, "the real result counts once; its copies not at all").toEqual(["toolu_old"]);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe("dryRunFailures", () => {
  const good = {
    ok: true,
    dry_run: true,
    diagnostics: {
      recap_id: "ada-recap-002",
      expected_recap_id: "ada-recap-002",
      leading_recaps_preserved: 1,
      lines_cut: 40,
      new_recap_position: 2,
      chain_reaches_recap: true,
      cut_orphaned_tool_results: [],
      pair_balance: { tool_use: 3, tool_result: 2, orphans: 1, tail_orphan_only: true },
      cut_range_has_existing_recap: false,
    },
  };

  it("a clean dry run passes; each wrong diagnostic is named", () => {
    expect(dryRunFailures(good, 1)).toEqual([]);
    const bad = {
      ...good,
      diagnostics: {
        ...good.diagnostics,
        expected_recap_id: "ada-recap-003",
        pair_balance: { tool_use: 3, tool_result: 1, orphans: 2, tail_orphan_only: false },
        cut_range_has_existing_recap: true,
      },
    };
    const f = dryRunFailures(bad, 2).join("\n");
    expect(dryRunFailures(bad, 2).length).toBe(4);
    expect(f).toMatch(/recap_id ada-recap-002 is not the expected ada-recap-003/);
    expect(f).toMatch(/leading_recaps_preserved is 1, but your plan's recap stack has 2/);
    expect(f).toMatch(/pair_balance has 2 orphan/);
    expect(f).toMatch(/cut_range_has_existing_recap is true/);
  });

  it("a refusal and a broken chain are both named", () => {
    const refused = dryRunFailures({ ok: false, reason: "chain_broken: x", diagnostics: { ...good.diagnostics, chain_reaches_recap: false } }, 1);
    expect(refused.join("\n")).toMatch(/ok is false: chain_broken[\s\S]*chain_reaches_recap is false/);
    expect(dryRunFailures({ ...good, dry_run: false }, 1)).toEqual(["this was not a dry run"]);
  });
});
