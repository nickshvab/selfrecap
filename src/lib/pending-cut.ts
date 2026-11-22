/**
 * The pending cut: the record a session has chosen to cut through, saved
 * between the calls of one recap cycle so the session does not carry a uuid
 * from one command to the next.
 *
 *   recap.ts <voice> --find "<phrase>"   saves it when the search names exactly one cut
 *   recap.ts <voice> --cut <uuid>        sets it directly
 *   recap.ts <voice> --plan              shows it
 *   recap.ts <voice> --draft / --check   read it
 *   recap.ts <voice> (dry run) / --go    fill the body's placeholder from it; --go clears it once the surgery has run
 *
 * One small JSON file per voice in logs/recap-state/ (RECAP_LOG_DIR moves
 * logs/). logs/ is git-ignored, already holds the lifecycle log, and lives as
 * long as the checkout: a temp folder could be emptied between the find and
 * the surgery. recap.ts owns the file; it passes the cut to the server's plan
 * when it asks for the draft's estimate (the server reads the file itself
 * only when it is not told).
 */

import fs from "fs";
import path from "path";
import { getRecordText, type JsonlRecord } from "./jsonl.js";
import { LOG_DIR } from "./lifecycle-log.js";
import { scanRecapStack } from "./recaps.js";

export interface PendingCut {
  /** Config key of the voice, lower-case. */
  voice: string;
  /** The record the cut goes through. */
  cut_uuid: string;
  /** The live session it was chosen in. */
  session_id: string;
  /** Its line in that file when it was saved, and what it is (`system/turn_duration`). */
  line: number | null;
  record: string | null;
  /** The opening words of the message that opens the new arc, when --find named it. */
  boundary: string | null;
  source: "find" | "cut";
  phrase?: string;
  saved_at: string;
}

export function pendingCutFile(voice: string, base = LOG_DIR): string {
  return path.join(base, "recap-state", `${voice.toLowerCase()}.pending-cut.json`);
}

/** The voice's pending cut, or null when there is none (or the file does not read). */
export function readPendingCut(voice: string, base = LOG_DIR): PendingCut | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingCutFile(voice, base), "utf8"));
    if (raw && typeof raw === "object" && typeof raw.cut_uuid === "string" && raw.cut_uuid.length > 0) return raw as PendingCut;
  } catch {
    // No file, or not JSON: no pending cut.
  }
  return null;
}

/** Save (replace) the voice's pending cut. Returns what was saved and what it replaced. */
export function savePendingCut(
  cut: Omit<PendingCut, "saved_at" | "voice"> & { voice: string },
  base = LOG_DIR,
  now = new Date(),
): { saved: PendingCut; replaced: PendingCut | null } {
  const replaced = readPendingCut(cut.voice, base);
  const saved: PendingCut = { ...cut, voice: cut.voice.toLowerCase(), saved_at: now.toISOString() };
  const file = pendingCutFile(cut.voice, base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2));
  fs.renameSync(tmp, file);
  return { saved, replaced };
}

/** Remove the voice's pending cut. True when there was one. */
export function clearPendingCut(voice: string, base = LOG_DIR): boolean {
  const file = pendingCutFile(voice, base);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export type CutLocation =
  | {
      ok: true;
      /** Line of the cut record. */
      idx: number;
      /** First line after the header records and the recap stack: where the period starts. */
      stackEnd: number;
      /** `type[/subtype]` of the cut record. */
      record: string;
      preview: string;
    }
  | { ok: false; reason: string };

/**
 * Where a cut sits in a session's records: it must be a record after the
 * recap stack. `sentinel` is config.sentinel_name. It is a named option on
 * purpose: a voice name passed in its place would type-check as a string and
 * find no recaps at all, so a cut inside the stack would pass.
 */
export function locateCut(records: ReadonlyArray<JsonlRecord | null | undefined>, cutUuid: string, opts: { sentinel: string }): CutLocation {
  const idx = records.findIndex((r) => r?.uuid === cutUuid);
  if (idx < 0) return { ok: false, reason: `${cutUuid} is not a record in the live session file` };
  const stack = scanRecapStack(records, opts.sentinel);
  if (idx < stack.end) {
    return { ok: false, reason: `${cutUuid} (line ${idx}) is in the header or the recap stack (lines 0..${stack.end - 1}); a cut goes after it` };
  }
  const r = records[idx]!;
  return {
    ok: true,
    idx,
    stackEnd: stack.end,
    record: `${r.type ?? "?"}${r.subtype ? `/${r.subtype}` : ""}`,
    preview: getRecordText(r).replace(/\s+/g, " ").trim().slice(0, 70),
  };
}
