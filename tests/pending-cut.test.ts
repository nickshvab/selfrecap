/**
 * The pending cut (saved by --find / --cut, read by --draft, --check and the
 * dry run) and the sentinel fill that puts it into a body written with the
 * CUT_UUID placeholder.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import { clearPendingCut, locateCut, pendingCutFile, readPendingCut, savePendingCut } from "../src/lib/pending-cut.js";
import { CUT_PLACEHOLDER, fillSentinelCut, parseSentinel } from "../src/lib/recaps.js";
import { SENTINEL, Session, tmpDir } from "./helpers.js";

const CUT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";

describe("pending cut", () => {
  it("saved per voice, read back, replaced, cleared", () => {
    const base = tmpDir();
    expect(readPendingCut("ada", base)).toBeNull();
    const first = savePendingCut(
      { voice: "Ada", cut_uuid: CUT, session_id: "s1", line: 10, record: "system/turn_duration", boundary: "new arc", source: "find", phrase: "new arc" },
      base,
    );
    expect(first.replaced).toBeNull();
    expect(first.saved.voice).toBe("ada");
    expect(fs.existsSync(pendingCutFile("ADA", base)), "one file per voice, any case").toBe(true);
    expect(readPendingCut("ada", base)?.cut_uuid).toBe(CUT);

    const second = savePendingCut({ voice: "ada", cut_uuid: OTHER, session_id: "s1", line: 20, record: "assistant", boundary: null, source: "cut" }, base);
    expect(second.replaced?.cut_uuid, "the earlier cut is reported as replaced").toBe(CUT);
    expect(readPendingCut("ada", base)?.cut_uuid).toBe(OTHER);
    expect(readPendingCut("bob", base), "another voice has its own").toBeNull();

    expect(clearPendingCut("ada", base)).toBe(true);
    expect(readPendingCut("ada", base)).toBeNull();
    expect(clearPendingCut("ada", base)).toBe(false);
  });

  it("a file that does not parse reads as none", () => {
    const base = tmpDir();
    savePendingCut({ voice: "ada", cut_uuid: CUT, session_id: "s", line: 1, record: null, boundary: null, source: "cut" }, base);
    fs.writeFileSync(pendingCutFile("ada", base), "{ not json");
    expect(readPendingCut("ada", base)).toBeNull();
  });
});

describe("locateCut", () => {
  function withStack() {
    const s = new Session();
    s.meta("mode", { mode: "normal" });
    const r1 = s.recap("ada", "ada-recap-001");
    s.user("first");
    const a1 = s.assistant("done");
    return { s, r1, a1 };
  }

  it("a record after the recap stack; refuses one in the stack or not in the file", () => {
    const { s, r1, a1 } = withStack();
    const ok = locateCut(s.recs, a1.uuid, { sentinel: SENTINEL });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.idx).toBe(3);
      expect(ok.stackEnd).toBe(2);
      expect(ok.record).toBe("assistant");
    }
    const inStack = locateCut(s.recs, r1.uuid, { sentinel: SENTINEL });
    expect(inStack.ok).toBe(false);
    if (!inStack.ok) expect(inStack.reason).toMatch(/recap stack/);
    const missing = locateCut(s.recs, OTHER, { sentinel: SENTINEL });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/not a record/);
  });

  it("finds the stack only by the sentinel name: a voice name in its place would find no recaps", () => {
    // The mistake this guards against: passing the voice where the sentinel
    // name belongs. Both are strings; the stack would come out empty, the
    // period would start at line 0, and a cut inside the stack would pass.
    const { s, r1 } = withStack();
    expect(locateCut(s.recs, r1.uuid, { sentinel: SENTINEL }).ok).toBe(false);
    const wrong = locateCut(s.recs, r1.uuid, { sentinel: "ada" });
    expect(wrong.ok, "with the voice name the stack is not seen at all").toBe(true);
    if (wrong.ok) expect(wrong.stackEnd, "only the header line is skipped").toBe(1);
  });

  it("honours a configured sentinel name other than the default", () => {
    const s = new Session();
    const recap = s.recap("ada", "ada-recap-001");
    recap.message.content = recap.message.content.replace(`"${SENTINEL}"`, '"OLD-MARK"');
    const a1 = s.assistant("after");
    const at = locateCut(s.recs, a1.uuid, { sentinel: "OLD-MARK" });
    expect(at.ok && at.stackEnd).toBe(1);
    expect(locateCut(s.recs, recap.uuid, { sentinel: "OLD-MARK" }).ok).toBe(false);
  });
});

const body = (sentinel: string) => `Hello Ada. The operator here.\n\nDecisions.\n\n\`\`\`json\n${sentinel}\n\`\`\`\n`;

describe("fillSentinelCut", () => {
  it("the placeholder becomes the pending cut, the rest of the body byte for byte", () => {
    const text = body(`{\n  "sentinel": "${SENTINEL}",\n  "voice": "ada",\n  "id": "ada-recap-002",\n  "cut_through_uuid": "${CUT_PLACEHOLDER}",\n  "version": 1\n}`);
    const r = fillSentinelCut(text, CUT, SENTINEL);
    expect(r.action).toBe("filled");
    if (r.action !== "filled") return;
    expect(r.was).toBe("placeholder");
    expect(parseSentinel(r.text, SENTINEL)?.cut_through_uuid).toBe(CUT);
    expect(r.text, "only the value changed").toBe(text.replace(CUT_PLACEHOLDER, CUT));
  });

  it("a missing or empty cut is added; a compact sentinel stays valid", () => {
    const r = fillSentinelCut(body(`{"sentinel":"${SENTINEL}","voice":"ada","id":"ada-recap-002"}`), CUT, SENTINEL);
    expect(r.action).toBe("filled");
    if (r.action === "filled") {
      expect(r.was).toBe("missing");
      expect(parseSentinel(r.text, SENTINEL)?.cut_through_uuid).toBe(CUT);
      expect(parseSentinel(r.text, SENTINEL)?.id).toBe("ada-recap-002");
    }
    const last = fillSentinelCut(body(`{"voice":"ada","id":"ada-recap-002","sentinel":"${SENTINEL}"}`), CUT, SENTINEL);
    expect(last.action).toBe("filled");
    if (last.action === "filled") expect(parseSentinel(last.text, SENTINEL)?.cut_through_uuid, "works when the sentinel key is the last field").toBe(CUT);
    expect(fillSentinelCut(body(`{"sentinel":"${SENTINEL}","id":"ada-recap-002","cut_through_uuid":""}`), CUT, SENTINEL).action).toBe("filled");
    expect(fillSentinelCut(body(`{"sentinel":"${SENTINEL}","id":"ada-recap-002","cut_through_uuid":null}`), CUT, SENTINEL).action).toBe("filled");
    expect(fillSentinelCut(body(`{"sentinel":"${SENTINEL}","id":"ada-recap-002","cut_through_uuid":7}`), CUT, SENTINEL).action).toBe("unfillable");
  });

  it("another cut than the pending one is refused with both; the same one is kept", () => {
    const text = body(`{"sentinel":"${SENTINEL}","id":"ada-recap-002","cut_through_uuid":"${OTHER}"}`);
    expect(fillSentinelCut(text, CUT, SENTINEL)).toEqual({ action: "mismatch", body_cut: OTHER, pending_cut: CUT });
    const same = fillSentinelCut(text, OTHER, SENTINEL);
    expect(same.action).toBe("kept");
    if (same.action === "kept") expect(same.text).toBe(text);
    expect(fillSentinelCut(text, null, SENTINEL).action, "with no pending cut the body's own cut stands").toBe("kept");
  });

  it("no pending cut for a placeholder; no sentinel at all; only the last sentinel is touched", () => {
    expect(fillSentinelCut(body(`{"sentinel":"${SENTINEL}","id":"x-recap-002","cut_through_uuid":"CUT_UUID"}`), null, SENTINEL)).toEqual({
      action: "no_pending",
      was: "placeholder",
    });
    expect(fillSentinelCut("Hello. No sentinel here.", CUT, SENTINEL)).toEqual({ action: "no_sentinel" });
    const quoted = `Last time: {"sentinel":"${SENTINEL}","id":"x-recap-001","cut_through_uuid":"CUT_UUID"}\n`;
    const r = fillSentinelCut(quoted + body(`{"sentinel":"${SENTINEL}","id":"x-recap-002","cut_through_uuid":"CUT_UUID"}`), CUT, SENTINEL);
    expect(r.action).toBe("filled");
    if (r.action === "filled") expect(r.text.startsWith(quoted), "the quoted predecessor is left as it was").toBe(true);
  });

  it("reads only the configured sentinel name", () => {
    const text = body(`{"sentinel":"OLD-MARK","id":"ada-recap-002","cut_through_uuid":"CUT_UUID"}`);
    expect(fillSentinelCut(text, CUT, SENTINEL).action, "another marker is not this config's sentinel").toBe("no_sentinel");
    const r = fillSentinelCut(text, CUT, "OLD-MARK");
    expect(r.action).toBe("filled");
    if (r.action === "filled") expect(parseSentinel(r.text, "OLD-MARK")?.cut_through_uuid).toBe(CUT);
  });
});
