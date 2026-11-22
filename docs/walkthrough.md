# Walkthrough: a recap from start to finish

This is a complete worked example: register a session, read its plan, find a cut point, write a recap, perform the surgery, restart, and verify. Placeholders use generic names; substitute your own. (The `/remember` skill runs steps 2–7 for a session on itself; this is the same flow by hand.)

Prerequisites: the server is running (`npm start`), and you know which Claude Code session you want to recap. Every command below runs in the selfrecap folder.

---

## 1. Register the session as a voice

Find your session's JSONL file:

```bash
# macOS / Linux
ls -t ~/.claude/projects/*/*.jsonl | head

# Windows PowerShell
Get-ChildItem "$env:USERPROFILE\.claude\projects\*\*.jsonl" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
```

Add it to `config.yaml`, with a folder for its recap bodies and the command that resumes it:

```yaml
voices:
  my-session:
    session: "~/.claude/projects/-Users-you-projects-app/<session-uuid>.jsonl"
    recaps: "~/selfrecap-voices/my-session"
    restart: "cd ~/projects/app && claude --resume {session_id} --name My-session"
```

On Windows the restart command runs in Windows PowerShell 5.1: use `;` instead of `&&`, as in `restart: 'cd C:\Users\you\projects\app; claude --resume {session_id} --name My-session'`.

Check it with `npm run check-config`, then restart the server so it picks up the new voice. (You can skip registration and pass `file_path` directly in every request, but a registered voice is less to type, follows continued sessions, and gets a recap plan.)

---

## 2. Read the plan

```bash
npx tsx scripts/recap.ts my-session --plan
```

```
─── Recap plan: my-session ───
Context        81.2% (812,000 tokens), last usage 2026-01-15T10:04:11.000Z
Headroom       158,000 tokens to 97%, 40,000 kept for the rest of the protocol: write the body in under ~295,000 characters (characters, not bytes: `wc -c` counts a multi-byte character two or more times)
Session        <session-uuid>
               <session-uuid>.jsonl
Recap stack    none yet: this is your first recap
Next recap     my-session-recap-001
Body file      /Users/you/selfrecap-voices/my-session/recap-001.body.txt  (not written yet)
Sentinel       "sentinel": "RECAP-CYCLE", "voice": "my-session", "id": "my-session-recap-001"
               "cut_through_uuid": "CUT_UUID" is filled from the pending cut by the dry run
Search cutoff  2026-01-15T09:59:11.000Z  (now minus 5 minutes; --find uses it)
Pending cut    none (--find saves the cut it names; --cut <uuid> sets one)
Restart        cd ~/projects/app && claude --resume <session-uuid> --name My-session
Self-restart   no: selfrecap restart is Windows-only: after --go the operator restarts the session with the restart command
```

The second Session line is the live file (its base name unless `expose_paths`). With the draft on, a Draft line follows the Headroom line; with `home` set, a Memories line names the voice's memories folder; once a cut is saved, the Pending cut line names it and the line it sits on. On Windows with a restart command that passes its checks, Self-restart says `yes`.

If the context is comfortably under your threshold, you don't need a recap yet. Recap when the session is large enough that the next stretch of work risks hitting the context limit — typically well before you actually run out, while there is still room to author a thoughtful recap. The Headroom line says how long the body can be: it ends in `TIGHT` when the budget is under 40,000 characters, and says `NO ROOM` when none is left (at about 93% of the window); then do not recap.

---

## 3. Find the cut point

A good cut point is a real phase boundary: the end of one mode of work, just before a different mode begins. Not an arbitrary percentage. Search for a distinctive phrase from the user message that opened the new mode:

```bash
npx tsx scripts/recap.ts my-session --find "now let's move on to the dashboard"
```

```
─── 1 match(es) for "now let's move on to the dashboard" before 2026-01-15T09:59:11.000Z ───
   1032  user                       aaaaaaaa-…  ← bbbbbbbb…  2026-01-14T18:20:03Z  now let's move on to the dashboard…
Boundary: the user message at line 1032. Cut through its parent: bbbbbbbb-…
Cut saved: bbbbbbbb-…. --plan shows it, --cut <uuid> replaces it; the dry run fills it into your sentinel.
Read the seam first: npx tsx scripts/recap.ts my-session --around 1032
```

The cut goes through the boundary message's **parent** — the record the conversation stood on when it arrived (usually a `system` record after the last reply). Everything from the start of the cut range through that record gets replaced by your recap; the boundary message itself stays, opening the surviving part. `--find` saved it as the **pending cut**; if several messages match, or you pick the cut by reading the seam, set it with `--cut <uuid>`. Read the seam before you commit to it:

```bash
npx tsx scripts/recap.ts my-session --around 1032
```

The search only looks before the plan's cutoff, so it does not match the conversation where you are discussing the search itself. Other ways in: `--at <ISO time>` (the last record before a moment), or `POST /find-cut-point` directly (with the `X-Recap-Token` header; see [api.md](./api.md#post-find-cut-point)) for the `anchor_offset` method.

---

## 4. Write the recap body

Write the body file at the plan's Body file path. Write, in the session's own words, a summary of the period being cut: the decisions made and why, the state of the work, open threads, working conventions established. Keep what will still matter a month from now; drop tactical detail that lives in your commit history.

End the file with a fenced JSON block carrying the sentinel, with the values from the plan:

````text
Hey. Here is the auth + early-dashboard period, told back to you.

You shipped the auth refactor (token rotation, the session-fixation fix) and
locked the decision to keep sessions server-side rather than JWT. The dashboard
work began after — that is still live in the surviving transcript below, so it
is not repeated here. Open thread: the rate-limiter config is still a guess and
wants real numbers once there is traffic.

```json
{"sentinel":"RECAP-CYCLE","voice":"my-session","id":"my-session-recap-001","cut_through_uuid":"CUT_UUID","period_covered":"2026-01-08_to_2026-01-14"}
```
````

`CUT_UUID` is a placeholder: the CLI helper in the next step fills in the pending cut from step 3 and reads `cut_through_uuid` from this block, so you don't pass it separately. The server checks the `voice` and the `id` against the session's recap stack.

**Optional, with the draft on** (off by default; see the README, "The draft and the check"): before writing, `npx tsx scripts/recap.ts my-session --draft` has a cold reader write a draft of the period up to the pending cut. Read all of it, then write the body yourself, from memory, checking draft lines against the record (`--entry E-0123`). After writing, `--check` compares the body with the record; correct what it shows to be untrue.

---

## 5. Dry-run the surgery

The helper reads your body from the plan's path, fills in the pending cut, extracts the cut point from the sentinel, and calls `/surgery` in dry-run mode (no change to the session file):

```bash
npx tsx scripts/recap.ts my-session
```

(An explicit body file still works: `recap.ts my-session path/to/body.txt`.) Read the diagnostics:

- `ok: true`, and `recap_id` equals `expected_recap_id`
- `cut_through_line_idx` — the record just before your boundary message
- `lines_cut` / `total_lines_after` — confirm the cut spans what you expect
- `leading_recaps_preserved` / `new_recap_position` — for a first recap `0`, and the position just after any header records (the uuid-less metadata lines Claude Code writes at the top of the file)
- `chain_reaches_recap: true`, `cut_orphaned_tool_results: 0`
- `pair_balance` — `orphans: 0`, or `tail_orphan_only: true` if you are running this from inside the session itself

A refusal names what to fix. If anything looks off, adjust your cut point or body and dry-run again. Nothing has been written yet.

---

## 6. Execute

When the dry-run looks right, run it for real:

```bash
npx tsx scripts/recap.ts my-session --go
```

The server writes a verified backup to `backup_dir` first, then performs the cut, injects your recap, re-points the records whose parent was cut, and swaps the file in — carrying over anything the session appended meanwhile. After the checklist (now with `backup_path`), the output ends like this:

```
─── SURGERY EXECUTED ───
Report   Was 81.2% / 2,051 lines / 3.4 MB. Now 1,019 lines / 1.7 MB (cut 50% of lines).
Your running session is still the pre-surgery one: every turn from here costs context in the OLD session.
Now send your report and stop. The operator closes this terminal and runs, in a new one:
     cd ~/projects/app && claude --resume <session-uuid> --name My-session
```

Run `--go` again within 120 minutes and it answers `ALREADY DONE`; later it says the next body file is not found. Either way, do not write another body: `--plan`'s Recap stack line shows the recap is in.

The change is on disk. The running session is still using its in-memory copy from before — the surgery does not affect a live session until it reloads the file.

---

## 7. Restart the session

Close the Claude Code session and run the restart command the `--go` output printed — in essence, in the session's folder:

```bash
claude --resume <session-uuid>
```

On resume, Claude Code re-reads the (now rewritten) transcript. The session comes back reading its own recap as the opening of its history, followed by the surviving records. See [cache-mechanics.md](./cache-mechanics.md) for why a restart is required rather than a live reload. (On Windows a session can do this itself: `recap.ts <voice> --go --restart` runs the dry run, executes only if it is clean, and schedules `selfrecap restart`, in one call; see [operations.md](./operations.md#optional-windows-only-the-nudger-and-selfrecap-restart).)

---

## 8. Verify

- `curl http://127.0.0.1:9090/contexts` — the token count should have dropped substantially after the first post-resume turn, and `stale_reading` should be `false`.
- The backup (`backup_path`, in `backup_dir/<voice>/`) is your safety net. If the recap reads wrong or the session cannot carry on its work, close the session and restore it:
  ```bash
  cp <backup_path> <original-jsonl-path>
  ```
  then restart again and revise the recap.

  The server never does this on its own; a restore is your decision. The backup holds the session file as surgery read it, plus the lines the session wrote during the swap. Copying it back brings the cut period back and removes the recap. It also erases everything the session wrote to the file after the surgery, such as the turns since the restart. Restore before you go on working, or accept that loss. Backups older than the newest three are gzipped: `gunzip` one first.

That is the full cycle. The next time the session fills up, you can recap again — the new recap will layer on top of this one (see multi-recap layering in [protocol.md](./protocol.md)).
