---
name: remember
description: Recap surgery protocol — run when your context approaches the context limit (~80%+ of the 1M window), or when the selfrecap server's context nudge tells you to. Get your plan from the server, find and save a clean cut point in your own transcript, read the draft of the period if your operator turned it on, write the recap yourself, have it checked (same condition), then execute and restart: `--go --restart` where your plan says you can restart yourself, otherwise `--go` and your operator restarts you. The AI-facing companion to the selfrecap server.
---

# /remember — self-authored recap surgery

> Slash-command body. Your operator (the human who runs this session) invokes this when your context approaches the context limit, or you do when the selfrecap server's context nudge reaches you.
> You run the whole cycle yourself, without asking the operator first. One exception: if nobody told you the selfrecap folder or your voice name, ask for them (How you talk to the server). At the end either you restart yourself (`--go --restart`, Windows, optional) or the operator restarts your terminal.
> This is the AI-facing companion to the `selfrecap` HTTP server. The server does the mechanics: it knows your session file, your recap folder, your next recap number and your restart command (`recap.ts <your-voice> --plan`, where your voice is the name this session is registered under in the server's config). You do the writing.

---

## Operator overrides (optional)

If the operator passed any text after `/remember`, treat it as a per-session instruction modifying the default protocol. Read it carefully and incorporate before proceeding through the steps below. For example: "pause for review before --go" (adds an approval gate before execution), "use Mode B" (write in the second person whatever Step 1 says; see Who is speaking), "cut shorter than usual" (pick an earlier seam).

Operator-passed text: $ARGUMENTS

If the line above is empty or only placeholder text, run the protocol as written.

---

## The calls

```bash
cd <selfrecap-dir>
npx tsx scripts/recap.ts <your-voice> --plan              # 0. your plan (Step 0)
npx tsx scripts/recap.ts <your-voice> --find "<phrase>"   # 1. the cut is found and saved, "Cut saved" (Step 3)
npx tsx scripts/recap.ts <your-voice> --draft             # 2. only if your plan has a Draft line (Step 3b)
npx tsx scripts/recap.ts <your-voice> --check             # 3. only if your plan has a Draft line (Step 5b)
npx tsx scripts/recap.ts <your-voice> --go --restart      # 4. only if your plan's Self-restart line says yes (Step 7)
```

Between 2 and 3 you read the whole draft and write the body. With no Draft line there is no 2 or 3: you write the body after 1. If Self-restart says no, 4 is the dry run (`recap.ts <your-voice>`), then `--go`, and the operator restarts you. Either way, the steps below are the whole protocol.

**The draft and the check** are on only if your operator turned them on (`draft.enabled` in the selfrecap folder's `config.yaml`, which `SELFRECAP_DRAFT` in your environment overrides); then your plan has a Draft line. The reader and the checker are `claude -p` runs on your operator's account, outside your context; each run prints its cost, and only the draft, the report and your own writing cost you tokens. With no Draft line, do not turn them on yourself: that spends your operator's usage and is their decision. You may tell them the option exists. With a Draft line you may still skip either; say so in your report. Why they are there: a recap written from memory alone tends to lose decisions made by others, most often the operator's, and to smooth the story; the draft is there to remind you, the check to catch untruth (the experiment behind this is described in `docs/why-the-draft.md`).

Both are slow (the draft took about ten minutes on a long period with the default reader; a reader may run 40 minutes and is started once more if its file does not parse; the check takes a few minutes, at most 25, also with one retry), longer than a foreground shell call may last. Start each as a background command, wait for its completion notice, and do nothing meanwhile. Do not poll and do not start it twice: every turn you take while waiting costs headroom. The cut is a past seam, so 1 and 2 can run early, before the context limit; the writing can come later.

The draft is a short version of everything said in the period: treat it like your session file. It lies only in your own recaps folder, out of git; its work files are removed after the cut.

Before 4, nothing of yours may still be running in the background (a reader or checker, a shell, an agent you started): the restart waits for your session to go idle.

---

## What just happened and what you do now

Either your operator typed `/remember` in your terminal, or the selfrecap server's context nudge (a message delivered by a short-lived `claude -p` run named `Nudge-<your-name>`, starting `From the selfrecap server`) told you that your context passed the line, and you ran it yourself. If the nudge says your recap is already applied but you were not restarted, do not recap again: restart as it says. Either way your context is approaching the context limit — typically 80%+ of the 1M-token window.

What you are about to do: find the right cut point in your own transcript and let `--find` save it; read the draft if your plan has a Draft line; write a recap of the period before the cut, yourself, from memory; have it checked (same condition); then have the server replace that period in your own session file with your recap, and restart. Nobody reviews the body before it goes in, so every check below is yours to make.

### How you talk to the server

Everything runs through one helper, `scripts/recap.ts`, in the selfrecap folder (`<selfrecap-dir>` below: wherever your operator cloned it). It talks to the server at `http://127.0.0.1:9090` (add `--server <url>` if your operator runs it elsewhere; the commands it prints for you to run next carry it), reads the auth token the server keeps at `~/.selfrecap/token` and sends it, and sends text from Node, so non-ASCII text (non-Latin scripts, em-dashes, smart quotes) arrives intact. You need no curl and no token handling. `<your-voice>` is the short name your session is registered under in the server's `config.yaml` (case does not matter).

If nobody told you `<selfrecap-dir>` or `<your-voice>` (in a message or your project's `CLAUDE.md`), ask your operator before anything else. Do not guess either: a wrong voice is another session.

`recap.ts` exits 0 when done, 1 when it refuses (the printed reason says what to fix), and 2 when the server is unreachable or failed (`Is the server running at …?`): then stop and tell the operator. After a 2 from `--go`, run `--plan` before anything else (Step 7).

The server only reads and writes files under its configured `allowed_roots` (default `~/.claude/projects/`). A session on another Claude Code account is refused unless that account's `projects/` folder is in `allowed_roots`: if your plan warns that your session file is outside allowed_roots, tell the operator.

---

## Step 0 — Read the room

Before anything else, get your plan:

```bash
cd <selfrecap-dir>
npx tsx scripts/recap.ts <your-voice> --plan
```

The plan is everything the server knows about you: your context, your headroom, your session, your recap stack, your next recap id, the exact path for your body file, the sentinel values to copy, the search cutoff Step 3 uses, your memories folder, your pending cut, the command that restarts you, and whether you can restart yourself (the Self-restart line). A Draft line appears only when your operator turned the draft on, a Memories line only when your voice has a `home`. Keep it at hand; the steps below refer to it. Your final report takes its numbers from the Report line `--go` prints (Step 8), not from the plan. It looks like this, shortened:

```
─── Recap plan: my-session ───
Context        84.1% (841,000 tokens), last usage 2026-01-15T10:04:11.000Z
Headroom       129,000 tokens to 97%, 40,000 kept for the rest of the protocol: write the body in under ~222,500 characters (…)
Draft          not made yet; … Estimate: about 7k tokens to read, … Reading it would leave ~205,000 characters for the body
…
Recap stack    1 recap: my-session-recap-001
               last: my-session-recap-001, period 2026-01-01_to_2026-01-08
Next recap     my-session-recap-002
Body file      C:/Users/you/selfrecap-voices/my-session/recap-002.body.txt  (not written yet)
Sentinel       "sentinel": "RECAP-CYCLE", "voice": "my-session", "id": "my-session-recap-002", "predecessor_recap": "my-session-recap-001"
Memories       C:/Users/you/selfrecap-voices/my-session/memories
Search cutoff  2026-01-15T09:59:11.000Z  (now minus 5 minutes; --find uses it)
Pending cut    none (--find saves the cut it names; --cut <uuid> sets one)
Restart        cd C:\Users\you\projects\my-app; claude --resume 00000000-… --name My-session
Self-restart   yes: --go --restart runs the surgery, then schedules selfrecap restart for the session that runs it
```

**The Headroom line is the number to write to.** Surgery happens on disk; your running session keeps growing until it restarts, and a session that crosses 97% between writing the body and the restart can fail to finish the cycle. Headroom is what is left before 97%, minus 40k tokens kept for everything else this protocol costs (the searches and seam reads, the dry run, `--go`, your report, your reasoning in between), and minus what is left to read of a written draft. The body budget in characters is counted low on purpose. Write under it. Below 40,000 characters the line ends in `TIGHT` (from about 91% of the window, earlier with a draft to read); with no budget left it says `NO ROOM` (about 93%). The Draft line says the same about reading the draft.

If the plan prints warnings, read them. A warning about your session, your recaps folder or your restart command is a config problem: tell the operator before going further. If the command answers `HTTP 404` or `no recap-plan route`, the server is older than this skill: stop and tell the operator.

**Decide whether to proceed:**

- At roughly 80% or above (and below 95%) — the signal is correct. Proceed.
- Below 80% — the cycle is being run early. Proceed.
- Headroom says TIGHT — proceed, but skip the draft, write short, then dry-run, `--go`, restart, report and stop, with nothing in between.
- Headroom says NO ROOM, or you are above 95% — DO NOT execute. There is not enough room left to write the recap well, and a recap written with that little room tends to skip steps. Tell the operator, then end your turn and wait: what happens next is their decision. If a context nudge reaches you while you wait, reply with one line and do not run /remember again: every turn costs room you do not have.

---

## Step 1 — Name the kind of work

Pick the row closest to the work in this session. It decides three things later: where a good cut falls (Step 3), which person to write in (Step 4), and what to look for when you re-read the body (Step 4). If none fits exactly, take the closest; the protocol works either way.

| Your work in this session | A good cut falls at | Write in | On the re-read, look for |
| --- | --- | --- | --- |
| Mostly code: building, shipping, debugging | the end of a sprint or feature, "ready for the next phase" | Mode A, first person | skipped care: repeats of the last recap, padding, repeated headings, things from after the cut |
| Mostly writing: copy, content, tone, positioning | a settled direction or positioning, a change in how the work is done | Mode A, first person | a body that reads well but skips the structure: the sentinel, the pending cut, the checklist |
| Mostly decisions: reviews, planning, direction | a major decision made, a change of project phase | Mode B, second person | padding: every decision chain kept "just in case", alternatives and reasoning crowding out the decisions |
| Several of these in one session | the end of a migration, a change of role | Mode B, second person; group the decisions by area | every area covered in full where one line would do |

Note your row in your reasoning; the steps below refer to it.

---

## Step 2 — Check for predecessor recaps

You may be writing your first recap, or recap-002 or later on top of earlier ones. Earlier recaps stay at the start of your transcript, your new recap goes right after them, and the cut range begins after them (see `docs/protocol.md`). Your new recap must not repeat what they cover.

**Your plan already has the answer.** Its Recap stack line lists the recaps at the top of your session, and its Next recap line names the one you are writing. Do not count files: the server numbers from your session, which is what surgery keeps.

**If no predecessor recaps exist** (your first cycle):

- Period covered = session start → the cut point you'll choose at Step 3.
- Who else is involved (users, other agents), if anyone, and what each is responsible for, and your working conventions, in full.
- This is your recap-001.

**If predecessor recap(s) exist** (recap-002 or later):

Your predecessors are already in your context: the server keeps them at the top of your session, so they were the first messages you loaded. Do not re-read them from disk. Near the context limit, re-reading your whole stack is the most expensive move there is, and it buys nothing you do not already hold. The plan gives the last predecessor's `period_covered`: your period starts where it ended.

One exception. If you cannot find them in your context (you cannot recall how your last recap opens), open only the LAST body file, in your recaps folder under its number. It names its own predecessor and its period, which is all you need to avoid overlap.

- Your new recap covers ONLY the period from the LAST predecessor's cut point forward, up to your new cut point.
- People and working conventions: only what changed in this period. The predecessor holds the rest.

A recap-002 that repeats recap-001 spends room on text you will then read twice, one after the other. Build on the predecessor; don't repeat it.

---

## Step 3 — Find your cut point

The cut point is the record the conversation stood on when the user message that opens a new arc arrived: that message's `parent_uuid`. It is usually a `system` record written after your last reply (turn_duration, stop_hook_summary, away_summary), sometimes your `assistant` `end_turn` itself. It must be a real phase transition, not an arbitrary percentage target; your row in Step 1 says what one looks like for your work. The server re-links everything after the cut to your recap, and refuses a cut that would split a tool call, cut the boundary message itself, cut through your newest message, or leave the conversation unable to reach your recap — so a wrong pick costs a retry, never a broken session.

Aim for a cut depth between roughly 30% and 70% of your file. Going under 30% means you're cutting too little — you'll be back at the context limit soon. Going over ~80% means you're risking too much of the period in summary form; it's safer to cut at a closer phase boundary even if it means recap-002 sooner. Find the seam first; let the percentage fall where it does. To measure it: `--around <line>` prints `lines a..b of <total>`, and the boundary's line over that total is your cut depth; the dry run prints `lines_cut <n> of <total>`.

**Three methods for finding the cut_through_uuid, ranked by reliability.** All three run through `recap.ts`.

**Method A — Boundary user-turn approach (most reliable).**

Mentally walk back from now to the moment your work-mode shifted. Identify the FIRST user message that opened the new mode. Its `parent_uuid` — the record the conversation stood on just before it — is your cut_through.

Search for a distinctive 6+ word phrase from that message, taken from within one line:

```bash
cd <selfrecap-dir>
npx tsx scripts/recap.ts <your-voice> --find "<distinctive 6+ word phrase>"
```

It searches only before your plan's cutoff (now minus 5 minutes), so it does not match this very conversation — right now you are discussing the recap, and your own current activity would otherwise match. It lists up to 20 matches with their line, type and parent. When exactly one of them is a `user` message, it names the cut outright: "Boundary: the user message at line N. Cut through its parent: <uuid>", and saves it as your pending cut ("Cut saved"). A message that arrived while you were busy also shows up as a uuid-less `queue-operation` line: ignore that one. Never use the boundary message's own `uuid` — that would cut the very message that opens your new arc (the server refuses it). If your boundary is younger than five minutes, nothing matches before the cutoff: `--find` lists what matches after it and saves nothing; if your boundary is one of them, search again with `--before now`.

Then read the seam before you commit to it:

```bash
npx tsx scripts/recap.ts <your-voice> --around <line>
```

That prints the 30 records before and after the line — type, uuid, which line each one hangs off (`← 888`), time and the opening words — so you can see the end of the old arc and the start of the new one. `--span 60` reads further.

**Method B — Last-prep-statement approach.**

Your own last assistant response containing a distinctive arc-closing phrase: "All seven specs locked. Ready to ship." or your equivalent. `--find` it; the `assistant` match's own `uuid` is the answer.

**Method C — Timestamp fallback.**

If you roughly know when the boundary happened (say around 09:30 today, UTC):

```bash
npx tsx scripts/recap.ts <your-voice> --at 2026-MM-DDT09:30:00Z
```

It shows the last record before that moment. Then `--around` that line to find the user message that opens the new arc, and take its `parent_uuid` as in Method A.

**If your search returns zero matches**: usually the phrase crosses a line break, or its punctuation differs (— vs -, ’ vs '). Search 4–6 words from within one line. If the phrase really is gone (summarized away in an earlier cycle), pick a boundary closer to now, or use Method C.

**If your cut_through_uuid candidate is one of your existing recaps**: `--cut` refuses it, and so does the dry run (`cut_inside_recap_stack`). Pick a point after your last recap.

`--plan` shows your pending cut: `Pending cut  <uuid>  (line 1031, system/turn_duration; saved 2026-01-15 10:01 UTC by --find "…")`. If the search named several user messages, take the one that opens the new arc, usually the earliest (a later one tends to quote or repeat it): read its seam with `--around`, or search a longer phrase until one matches. If you chose it that way, or by reading the seam (Methods B and C), set the cut yourself: `npx tsx scripts/recap.ts <your-voice> --cut <uuid>`. You do not copy the uuid anywhere: the sentinel takes a placeholder (Step 4), and the tool fills it from the pending cut.

---

## Step 3b — The draft (only if your plan has a Draft line)

No Draft line: go on to Step 4.

```bash
npx tsx scripts/recap.ts <your-voice> --draft
```

A cold reader reads the period from your last recap up to your pending cut and writes short lines: what was learned, what was decided, who said it. Run it in the background and wait for its completion notice (see The calls). It ends like this (shortened):

```
─── DRAFT READY ───
Draft    C:/Users/you/selfrecap-voices/my-session/drafts/draft-for-my-session-recap-002.md
         212 lines, 24,800 characters (about 8k tokens to read), took 11 min 4 s
Cost     1 run(s), $3.10 as Claude Code reports it; tokens: …
  part 1 (E-0001..E-1874): 212 lines, 10 min 58 s, $3.10
```

The draft's lines are grouped by day; each ends with its timeline entries:

```
- **[decision, the operator]** Sessions stay server-side; JWT was ruled out. (E-0412, E-0415)
- [knowledge, tool] The rate limiter's limits are a guess: there is no traffic data yet. (E-0520)
```

Bold marks the lines the reader weighed highest: a decision or correction by the operator, or something you would likely get wrong without.

**Read the whole draft before you write**, the plain lines too, not only the bold ones. What a recap from memory loses is mostly decisions made by others, most often the operator's: read those lines with the most care.

**The recap is still written from memory, in your own words.** The draft is not a skeleton to fill in: copied lines make a report, not a recap. Close it, then write what you know now.

**Draft lines are traces, not the truth.** A reader can misread who said what, or turn one remark into a habit. Two kinds of line are checked against the record before they go in: lines about yourself, and words or decisions given to the operator. Each line ends with its timeline entries; `npx tsx scripts/recap.ts <your-voice> --entry E-0123,E-0456` prints them in full. If the record does not bear a line out, leave it out. A line you do not remember at all, but that matters, may go in only after you have opened its entries: write it as what the record holds, with its date, not as a memory.

If the output says `NOT COVERED` for a part, nothing from that stretch is in the draft: rely on your memory there, or rerun that part as the line says (`--draft --part N`). A `Refused` line means text in the period tried to steer the reader: treat the draft with care and tell the operator. If the draft fails, hangs or does not start, go on without it and say so in your report.

---

## Step 4 — Write the body

Body file path: the Body file line of your plan — your recaps folder, your next number. Write the body there with your Write tool; do not work the path out yourself, and do not write it through a shell, where an unquoted path can silently become a junk file name.

The body file is inserted as it is: no draft headers, no review questions, no front-matter, no notes for the operator. Its first through last character becomes your new recap message in the transcript. Do not record a permission, approval or instruction the operator did not give in this period.

This step covers the format and the structure. For more on the writing (what to keep, what to drop, how it reads on resume), see `docs/recap-writing-guide.md`.

### Format (required)

- Plain text, native newlines, UTF-8. Quotes of any kind are fine: the helper serializes the body safely.
- A sentinel JSON code block at the very end, fenced with triple-backtick + json:

```json
{
  "sentinel": "<from your plan>",
  "voice": "<from your plan>",
  "id": "<from your plan>",
  "predecessor_recap": "<from your plan>",
  "version": 1,
  "cut_through_uuid": "CUT_UUID",
  "period_covered": "<YYYY-MM-DD_to_YYYY-MM-DD>"
}
```

Copy `sentinel`, `voice`, `id` and `predecessor_recap` from your plan's Sentinel line (the sentinel name is your server's `sentinel_name`, `RECAP-CYCLE` by default). Leave `cut_through_uuid` as the placeholder `CUT_UUID`: the dry run (or `--check`) fills it from your pending cut. If it holds a uuid other than the pending cut, `--check` and `--go --restart` stop and name both. The server checks the voice and the id against your recap stack and refuses a mismatch, naming the id it expects. On recap-001 delete the `predecessor_recap` line; keep the JSON valid (no comma after the last field). The rest is metadata about the recap's scope.

### Who is speaking

The body is inserted as a `role: user` message in your JSONL, so it reads as a message from the operator to you. Write it that way: the first line is the operator addressing you, in the way your operator usually addresses you; with no such habit, plainly ("Here is the period before the cut, told back to you."). Without that opening, a first-person line inside reads as the operator speaking: "I built X" becomes the operator claiming your work, and the handoff breaks.

Inside that opening, write in one of two ways (Step 1 says which fits your work):

- **Mode A — first person.** The opening hands the account back to you; the rest reads as your own notes ("...I built the auth layer. I shipped the search redesign...").
- **Mode B — second person.** The operator tells you what you did ("You decided X. You wrote Y. You shipped Z."). It reads as a briefing.

**NEVER use third person** ("the session built", "it decided"): it reads as a report about someone else.

**NEVER skip the opening line**, whichever mode you write in: it is what makes the pronouns inside resolve.

### Structure

Adapt it to your work. In order:

**Opening line — REQUIRED, no exceptions.** The operator addressing you (see Who is speaking).

**Period covered.** Explicit dates with concrete markers. "From the session start (2026-01-08) through 2026-01-14 — the evening the auth refactor shipped." Avoid "approximately" if you can be specific.

**Decisions made.** The most important section. A flat list works; in a session with several kinds of work, group them by area (architecture, product, operations, and so on). For each decision: the decision, then a one-line rationale or context. NOT the alternatives considered, NOT the history of how you got there.

**The filter — apply to every decision and every claim:**

> **"Will I need this in a month?"**
>
> If yes → write it down.
> If no → leave the detail out. Tactical execution details (we did X then Y, we changed a heading, time spent on a step) may stay on disk: commit history, file diffs, a running task/notes file if you keep one. Whether to leave a trace that something happened is your decision: one line that it was done, and where, can be worth keeping even when how it was done is not.
>
> What MUST be in: final outcomes, decisions made, validated conclusions, important points from the period being cut, shipped work, settled positions.

If you shipped an entire epic with two tasks: flag the epic done. The fact that it took four hours, that you fixed three bugs along the way, that you renamed a function — all of that is in your repo's commit history. The recap notes "epic-X shipped, now usable" and moves on.

**Files.** Paths to the files that matter for picking the work back up: key code files, schemas, governance docs, a running task/notes file. Not every file you touched. Where most of the work is recoverable from the filesystem, keep this short.

**Open loops at cut.** What's parked, unresolved, or needs attention after the cut. Typically 3-7 items, each a sentence. These decide what you pick up first.

**People.** Who else is involved (users, other agents), if anyone, and what each is responsible for. Recap-001: each one in 1-3 sentences. Recap-002+: what changed in the period (new people, changed responsibilities).

**Working style.** How the work is done here and how you and the operator work together: conventions agreed, the language and format of your replies, terms you use, how reviews and approvals work. Recap-001: in full. Recap-002+: only what changed in the period. Keep it in proportion: a common failure is a recap that keeps the style and loses the work state ("I reply in short lists" kept; "the positioning settled at Y, decision Z held under pressure Q" lost). Both are needed.

**Narrative.** The period in date order, typically 4-7 beats of one short paragraph each, with specific dates and short verbatim quotes where the exact words matter.

**Closing.** Name the moment where the period ends and the kept turns begin, as a real sentence or exchange, so the recap leads straight into what follows it.

**Sentinel JSON.** Required. The last block in the file.

### Optional: memory files on disk

Your plan's Memories line, if it has one, names a folder of your own (`<home>/memories/`); with no Memories line you have none, and everything goes in the body. Write a memory file only for something you will need again that the body cannot hold within its budget, or that would crowd out the decisions: a long decision history, a full design rationale, a topic you will come back to rarely. Otherwise write none. Keep each one short enough to be worth rereading.

Name each `YYYY-MM-DD-<slug>.md` (`auth-decision-trail`, anything that helps you find it later), and start it with a one-line summary.

The recap points to them, in a section near the end of the body:

```
### Memory files (read when the topic comes up)

- memories/2026-01-14-auth-decision-trail.md — why sessions stay server-side, with the options ruled out
```

One line per file. Skip the section if you wrote none this period.

### Length judgment

Length matches what the period actually contained. There is no target. A quiet stretch with two decisions might be a few paragraphs; a dense period with many interlocking decisions might be much longer.

Your plan's Headroom budget is the hard limit. Measure in characters, not bytes: once the body is written, `--plan` and the dry run print its character count. Do not use `wc -c` — it counts bytes, and many non-Latin characters take two bytes or more, so a body in such a language looks twice its real length.

Don't shrink it to look small or pad it to look thorough: the one-month filter sets the length.

When the first version is done, re-read it once for the failure in your row of Step 1, and cut what fails the filter.

### Anti-patterns to scan and remove

Treat these as suspect when they show up in a recap:

- References to the recap process itself (the cut, the restart, an earlier instance) → write the period as a plain account, like notes you made earlier the same day.
- Abstract self-description instead of what happened → cut.
- Jargon such as intel, asset, deliverable, output, deploy where a plain word fits → use the plain word.
- Ornate phrasing → say it plainly.
- Repeating what an earlier recap already says → cut.
- Anything that happened after the cut → REMOVE. The kept turns already hold it.
- Tactical execution detail ("we changed the H1 from X to Y", "I refactored function Z") → it stays on disk, in commit history. A recap is for outcomes, not process.
- Lists recoverable from disk (file paths, function lists, counts) → leave them on disk.
- Working style at the cost of decisions → tighten.
- Bullets only, no prose → mix the two; bullets alone read dry, prose alone reads imprecise.

---

## Step 5 — Self-review checklist

Before the check or the dry run, answer each:

- Your pending cut (`--plan` shows it) is the `parent_uuid` of your boundary message, found by a single `user` match (a `queue-operation` twin does not count)? The sentinel holds `CUT_UUID` or that same uuid?
- Sentinel JSON valid, at the end of the file, with sentinel, voice, id and predecessor_recap copied from your plan?
- The first line is the operator addressing you?
- Period_covered dates explicit, not approximate?
- Decisions: the one-month filter applied?
- Files: the ones that matter only, not a full list?
- Open loops: 3-7 items, each shaping the work after the cut?
- People and working style: in full on recap-001, only what changed on recap-002+?
- Narrative in date order, with concrete markers; closing names the moment the kept turns begin?
- Length matches the period, and stays under the Headroom budget?
- Work state kept, not only working style?
- Anti-patterns scanned, and the body re-read once for your row's failure (Step 1)?
- If you wrote memory files: listed in the body's "Memory files" section, one line each, named `YYYY-MM-DD-<slug>.md`?
- With a Draft line: did you read the whole draft before writing (or will you say in your report that you skipped it)? Every line about yourself, and every word or decision given to the operator, that came from the draft: checked against the record?

If all yes → proceed to the check (Step 5b) if your plan has a Draft line, otherwise to the dry run (Step 6). If any no → revise. Nobody else reads the body before it goes in.

---

## Step 5b — The check (only if your plan has a Draft line)

```bash
npx tsx scripts/recap.ts <your-voice> --check
```

It fills `CUT_UUID` in your sentinel from the pending cut, rewriting your body file on disk: a notice that the file changed is expected. Then one cold checker reads your body and a shortened record of the period and reports, in under 400 words: what is wrong against the record, what the body says that the period does not hold, lines about you the record does not support, things still owed that the body leaves out, and decisions of the operator the body does not carry. It looks for untruth, not style. Run it in the background too. The report is printed in full and kept beside the draft; its wording is the checker's, for example:

```
─── CHECK REPORT ───
1. Wrong against the record: "The operator chose Redis". E-0611: the operator chose Postgres; Redis was your proposal.
2. After the cut: none found.
3. Lines about you: "I fixed the exporter" is not supported; E-0233 shows a helper agent's fix.
4. Still owed: the migration note promised in E-0702.
5. Decisions missing: none found.
────────────────────
Report   C:/Users/you/selfrecap-voices/my-session/drafts/check-for-my-session-recap-002.md
``` The checker is told that the opening and closing lines are framing and are not checked; everything else is. If it flags the frame anyway, that is its mistake, not the body's.

**One round.** What the report shows to be untrue is corrected or removed, always; if you doubt the checker (it reads a shortened record and can be wrong), open the entries it names with `--entry`. What it says is missing is your call. There is no second check. If no report comes back, go on without the check and say so in your report.

---

## Step 6 — Dry-run

If your plan's Self-restart line says yes, `--go --restart` (Step 7) runs this dry run itself and executes only if it is clean: you may go straight there. Otherwise, or to look first:

```bash
cd <selfrecap-dir>
npx tsx scripts/recap.ts <your-voice>
```

(Default is dry-run; no `--go`. The helper reads your body from the plan's path and fills `CUT_UUID` from your pending cut. An explicit path still works: `recap.ts <your-voice> <body-file>`.)

The server checks everything it can before it writes anything, and a refusal names what to fix. Read every diagnostic anyway. Your checklist:

- `ok: true` — the basic invariant.
- `cut_through_line_idx` names the record you cut through: it should be the record just before your boundary message (usually a `system` record), not the message itself.
- `recap_id` equals `expected_recap_id`.
- `lines_cut <n> of <total>`: n over total is your cut depth (Step 3); `total_lines_after` is dramatically less than before.
- `leading_recaps_preserved` equals the size of your recap stack (0 on your first cycle).
- `new_recap_position` is right after your stack (header records, the uuid-less metadata Claude Code writes at the top of the file, count too, so it can be larger than the stack size).
- `chain_reaches_recap: true` and `cut_orphaned_tool_results: 0` — the server refuses otherwise.
- `pair_balance`: orphans 0, or every orphan is your own in-flight Bash call (`tail_orphan_only: true`). The latter is benign: the tool_result of the very command running the helper lands after the swap.
- `cut_range_has_existing_recap: false`. Reading a body or quoting a sentinel does not trip it; `true` means a user message carrying a recap sits inside your cut range — an injected recap or a pasted copy of one (the reason names its id). Stop and tell the operator: `--force` would delete it, which is safe only for a paste.

If the dry-run fails, the Reason and Also lines say what to fix: a wrong id comes back with the right one, a bad cut point with why. Fix it and dry-run again. A refused surgery writes nothing.

If diagnostics look right → proceed.

---

## Step 7 — Execute

**First: nothing of yours may still be running in the background** (a reader or checker, a shell, an agent you started): a scheduled restart waits for your session to go idle.

If your plan's Self-restart line says yes:

```bash
cd <selfrecap-dir>
npx tsx scripts/recap.ts <your-voice> --go --restart
```

It checks first that you can restart yourself, then runs the dry run. If the dry run is not clean, it stops before anything is written and names what is wrong, after the checklist:

```
─── NOT EXECUTED: the dry run is not clean ───
  - ok is false: cut_is_user_message: line 1032 is a user message ("now let's move on to the dashboard") whose reply survives, …
─── FAILED ───
Reason: cut_is_user_message: …
Nothing was written.
```

Fix it and run the same command again. If it is clean, it executes, prints the checklist, and schedules your restart (Step 8); read `cut_through_line_idx` once anyway (Step 6). If `--restart` itself is refused, nothing was executed: the output prints the plain `--go` command and how the operator restarts you by hand.

Otherwise:

```bash
npx tsx scripts/recap.ts <your-voice> --go
```

On `--go`, the server:

1. Writes a verified backup of your session to its `backup_dir` (default `./backups/<your-voice>/`; older backups are compressed, never deleted).
2. Cuts the period after your recap stack, through `cut_through_line_idx`.
3. Inserts your new recap right after the stack.
4. Re-links every record whose parent was cut to your new recap, and checks that the conversation reaches it.
5. Swaps the file in without losing anything your session writes meanwhile.

Verify:

- `ok: true`, `dry_run: false`.
- `backup_path` populated with the new backup file.
- `carried_tail_lines` may be above 0: that is your own turn landing during the swap, and it is in the new file.

If `--go` is refused (`─── FAILED ───`), the live file was not changed; the reason says why. If it ends `It is not known whether the surgery happened` (exit 2), run `--plan`: if its Recap stack line ends with your new recap, the surgery ran. Run `--go` again within 120 minutes of a success and it answers:

```
─── ALREADY DONE ───
my-session-recap-002 is in your session (applied 3 minute(s) ago). Nothing to run, nothing to write.
```

Later it answers `Body file not found` for the next number instead. Either way, do not write a new body: if `--plan`'s Recap stack ends with your recap, the surgery ran; restart if you have not.

Surgery is on disk. Your running session keeps using its pre-surgery in-memory context until a restart makes Claude Code re-read the file (see `docs/cache-mechanics.md`). Every turn from here costs context in the OLD session, so keep the rest short.

---

## Step 8 — Restart, report, stop

Only after `--go` succeeded. The output ends by telling you which of the two applies; after `--go --restart`, shortened:

```
─── SURGERY EXECUTED ───
Report   Was 84.1% / 2,051 lines / 3.4 MB. Now 1,019 lines / 1.7 MB (cut 50% of lines).
…
─── RESTART ───
selfrecap: restart scheduled for My-session (helper pid 18244, in its own console).
…
For the operator, if My-session is not back within a few minutes, by hand:
     cd C:\Users\you\projects\my-app; claude --resume 00000000-… --name My-session
```

**If you ran `--go --restart`**, the restart is already scheduled: its `RESTART` block says `restart scheduled`. If it says `RESTART NOT SCHEDULED` instead, the recap is in your session: run `selfrecap restart` yourself, as below. **If you ran plain `--go` and it says to run `selfrecap restart`**, run it now, in your shell tool:

```bash
cd <selfrecap-dir>
npx tsx scripts/selfrecap.ts restart
```

It does not close you at once. It prints `restart scheduled`, then waits for your turn to end. When you go idle it closes this session, resumes it **by your session id** in a new console, and sends a resume prompt as your first prompt, so you carry on by yourself. It also checks that you really came back (right id, right name, not stuck on a dialog) and records the outcome where the operator can see it (`npx tsx scripts/selfrecap.ts log`, and `/contexts`). If it refuses, read its line: it names the reason. Do not work around it. Put the reason in your report; the operator restarts you by hand.

**Otherwise** the operator restarts you: they close this terminal and run the restart command the `--go` output printed.

Then write your report as the last message of this turn: a short note with the essentials. The shape below is a guide, not a template to copy verbatim.

What to include, briefly:

- It's done, all clean (or flag if anything was off).
- One-line metrics: the Report line of the `--go` output (pre-cut and post-cut shape), so the operator can cross-check against `/contexts`.
- How the restart happens: `selfrecap restart` is scheduled (or why it refused), or the operator's step.
- The restart command exactly as the `--go` output printed it: it carries your folder and your live session id.
- With a Draft line: whether you read the draft and ran the check, or skipped either.

Example shape:

```
Recap-NNN done. All checks clean.

Was: <pre-percent>% / <pre-lines> lines / <pre-MB>MB
Now: <post-lines> lines / <post-MB>MB (cut <cut-percent>%)
Backup at <backup_path>.

<Restarting myself with selfrecap restart. If I'm not back, by hand: | Ready for restart: close this terminal, then run:>
<the restart command from the --go output, verbatim>
```

Replace placeholders with real numbers from your execute response. A few lines is fine.

Then end your turn. Nothing after the report: a scheduled restart waits for you to go idle, and every further turn costs context in the old session.

---

## After the restart

When you resume (to the resume prompt, or to your operator), start here.

### You cannot tell from inside

After the restart you cannot tell from inside whether it happened: nothing in your context marks the cut. Rely on the external signals:

- System reminders refreshed (deferred-tools list, MCP server instructions).
- File timestamps on disk.
- A sharp token drop in `/contexts` (`http://127.0.0.1:9090/contexts`), a dashboard or your plan's Context line. It shows only once your first reply after the resume is recorded; until then they still show the reading from before the restart.
- The resume prompt ("selfrecap restart resumed this session at HH:MM UTC after <recap id>").
- Your operator's confirmation.

After your first turn after the resume, check them. If any is present, the restart happened. Do not claim from inside whether the restart happened; report what the signals show.

### What you have now

The recap replaces the transcript of the period it covers: that text is no longer in your context. Your recaps at the top and the turns after the cut are what you work from.

If you made a draft, it stays in `drafts/` beside your recap bodies. Do not reread it after the restart: it has done its work.

If the recap and the kept turns do not let you carry on the work, tell the operator. The backup (its path is in your Step 8 report) can restore the pre-surgery state, and the recap can be revised and retried.

### If you wrote memory files this cycle

They are in your memories folder (the Memories line of your plan), and the body's "Memory files" section lists them. Read only the ones your current work needs, when it needs them.
