# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-11-22

The draft before the recap and the check after it, both opt-in; the pending
cut, so a session no longer carries a uuid from one call to the next;
`--go --restart`; a documented source for the plan-usage bars.

Why the draft exists is described in [docs/why-the-draft.md](./docs/why-the-draft.md).

### Added

- **The draft (`recap.ts <voice> --draft`, opt-in).** Before writing its
  recap, a session has a cold reader, a headless `claude -p` run on its own
  account, read the period being cut and write short lines: what was learned,
  what was decided, who said it. They are merged by day into
  `<recaps>/drafts/draft-for-<id>.md`; the session reads all of it, then
  writes the body itself, from memory. One reader over the whole period by
  default (`draft.reader_model`, opus); `--split` reads in parts of about
  230,000 characters on `draft.split_reader_model` (sonnet), up to four at
  once; `--part <n>` reruns one part; `--prepare-only` builds everything and
  starts nothing; `--reader-model <m>` and `--operator <name>` set the
  readers' model and what they call the operator for one run. A timeline over 1,000,000 characters goes to the fewest
  parts under that size. The timeline carries the text the session wrote
  into files (Write content, Edit new text, long shell commands) up to 8,000
  characters per call, 2,000 in the checker's record, and heads a message
  the session sent with its recipient's name.
- **The check (`recap.ts <voice> --check`, opt-in).** One cold checker
  (`draft.check_model`, opus) compares the finished body with a shortened
  record of the period and reports what is wrong, what comes from after the
  cut, unsupported lines about the session, what is still owed, and decisions
  the body misses. One round; the report goes to
  `<recaps>/drafts/check-for-<id>.md`. `--check-model <m>` sets the
  checker's model for one run.
- **`draft` config section and `SELFRECAP_DRAFT`.** `draft: { enabled,
  reader_model, split_reader_model, check_model, operator }`, off by default.
  `SELFRECAP_DRAFT=1` or `0` overrides `enabled`; the environment wins. Off,
  `--draft` and `--check` refuse with one line naming the setting, the plan
  has no Draft line, and nothing starts a model.
- **The pending cut.** `--find` saves the cut it names
  (`logs/recap-state/<voice>.pending-cut.json`), `--cut <uuid>` sets one,
  `--plan` shows it, and a body whose sentinel says
  `"cut_through_uuid": "CUT_UUID"` (or has none) gets it filled in by the dry
  run or `--check`. `--go` clears it. `--find` with no match before the
  cutoff says what lies after it; `--before now` searches to the end.
- **`--entry E-0123[,...]`** prints timeline entries in full (the numbers a
  draft line ends with); **`--draft-clean`** removes the work folder.
- **`--go --restart`.** Dry run, execute only if every check of the dry run
  is clean, then schedule `selfrecap restart`, in one call. Refused before
  anything is cut off Windows, without a usable restart command, from a
  terminal, or from another voice's session, and then the refusal prints the
  plain `--go` command and how to restart by hand; refused with `--force`
  too, with a line saying to run `--go --force` without `--restart`.
- **The recap plan** gains `self_restart` (`available` and a `reason`),
  `headroom.draft_tokens`, and, with `?draft=1`, `draft` (the draft's size, or
  an estimate up to `?cut=<uuid>`). A written draft not yet read counts
  against the body budget.
- **`usage.source`**: `documented` (the default) reads the `rate_limits`
  Claude Code hands its status line, saved by the new
  `scripts/usage-statusline.mjs`; no credentials, no network. `undocumented`
  is the 1.1 behaviour (each account's login token, Claude Code's own usage
  endpoint), now only when chosen. `/contexts` `account_usage` entries carry
  `source`.
- **`scripts/check-headless-fence.ts`**: one small headless run with the
  draft's flags that checks your Claude Code refuses writes and reads outside
  the run's folder (`--model <m>`, default `haiku`).
- **`docs/options.md`**: every optional feature in one place, with its
  default, how to turn it on, what it costs and where it runs.

### Changed

- **Request-log records** (`api-request`, `api-request-blob`,
  `api-request-shape`: uuid-less copies Claude Code writes beside the
  conversation, again on every resume) are no longer counted as tool calls or
  results, so a cut made before the latest resume is not refused with false
  orphans, and `/find-cut-point` no longer matches their copies of a message.
  Surgery diagnostics add `api_request_records_cut`.
- **`selfrecap restart`** shares its checks, lock and helper launch with
  `--go --restart` (`src/lib/restart.ts`); its behaviour is unchanged.
- Reworded, same meaning: the prompt a resumed session gets, the nudge text,
  and the `sentinel_voice_mismatch` reason.
- **Times are UTC and say so.** A full timestamp ends in `Z` (the rows of
  `--find`, `--around` and `--at` now read `2026-01-14T18:20:03Z`); a shorter
  one says `UTC` (the pending cut's time, the draft's and the check's progress
  lines, the resume prompt, the timeline's entry headers). `--at` and
  `--before` read a time without a zone as local time, and send and print the
  UTC it stands for.
- **Printed next steps carry the caller's flags.** A command `recap.ts`
  prints for the session to run next carries `--server` when it is not the
  default, `--operator` on `--draft`, `--check` and `--entry`, and an explicit
  body file on `--check`, the dry run and `--go`.
- `install-skill` needs a 1.2.0 server.

### Security

- The draft's and the check's runs read untrusted text (the period) and are
  fenced in: `--restricted`, only Read, Write and Edit, writes and reads
  confined to the run's own folder and the empty temporary folder it starts
  in, no settings files, hooks, MCP servers or
  skills, prompts denied, permissions never bypassed. They need Claude Code
  2.1.314 or later. See SECURITY.md, "The draft and the check".

### Compatibility

- Node.js 20.1 or later (`engines` said 20): the draft reads folders with
  `readdirSync`'s `recursive` option, which 20.0 does not have.
- Existing `config.yaml` files load unchanged. A file with `usage.enabled:
  true` and no `source` now gets the documented source: add
  `source: undocumented` to keep the 1.1 bars.
- `buildRecapPlan` sizes the draft only when asked; the nudger, check-config
  and `selfrecap restart` never ask.

## [1.1.1] - 2026-11-22

### Fixed

- **Memory on long sessions.** A context reading parsed the whole transcript to
  find its last usage record: several hundred MB of heap for a moment on a
  70 MB file, on every `/context` call, every recap plan and every nudger tick.
  It now reads the file from its end in growing chunks and counts lines in a
  streaming pass (about 6 MB instead of about 580 MB on a 71 MB transcript),
  and answers an unchanged file from a cache keyed by path, size and mtime. The
  reading is the same, field for field. Past 64 MB of tail without a usage
  record it falls back to the whole-file reading and logs a line saying so.
  `/contexts` still loads each voice's live file whole, because it also reads
  the recap stack.

## [1.1.0] - 2026-10-15

Surgery that is safe to run from inside the live session and cannot strand a
resumed session, the recap plan, session continuation, a fuller `/contexts`, and an
updated `/remember` skill. Optional, Windows-only, off by default: a context
nudger and `selfrecap restart`.

### Added

- **`GET /voices/:voice/recap-plan`** — everything a session needs for
  `/remember`: context and headroom (the body budget in characters), the recap
  stack, the next recap number, id and body path, the sentinel values, a
  `suggested_before_timestamp`, the restart command with the live session id.
- **`GET /voices/:voice/records?around=&span=`** — the records around a line,
  for reading a seam before choosing the cut.
- **Session continuation** — a voice's session follows Claude Code's
  `continued-in` markers to the live file, for readings, the plan and surgery.
  `/voices`, `/context/:voice` and `/contexts` report the hops; a broken link is
  reported and surgery refuses the frozen ancestor.
- **`/contexts`** — per voice: continuation info, the recap stack, headroom, a
  `stale_reading` flag, liveness (Windows) and the last nudge/restart event.
- **Plan-usage bars** (`usage.enabled`, off by default) — `/contexts`
  `account_usage`, read with each account's own login token from an
  undocumented Anthropic endpoint. See the README before turning it on.
- **`scripts/recap.ts`** — `--plan`, `--find`, `--around`, `--at`; the body
  defaults to the plan's path; requests go out from Node (no curl), so
  non-ASCII text arrives intact; a repeated `--go` answers ALREADY DONE; the
  diagnostics print as a checklist (`--json` for the full response).
- **Context nudger** (`nudge.enabled`, off by default, Windows only) — a live
  session past `nudge.at` percent is told to recap and restart.
- **`selfrecap restart`** (`scripts/selfrecap.ts`, Windows only, optional) — a
  session restarts itself after its recap: waits for its turn to end, closes
  it, resumes the same id in a new console with a resume prompt, checks
  it came back, records the outcome (`selfrecap log`).
- **`npm run check-config`** and **`npm run install-skill`**.
- New config keys: per voice `recaps`, `home`, `restart`, `name` (and
  `session`, with `path` still accepted); top-level `accounts`, `nudge`,
  `usage`. `config.yaml` problems are reported per entry instead of failing.

### Changed

- **Surgery re-parents by chain.** Every survivor whose parent was cut now
  points at the new recap (before, only the next line was re-pointed; when that
  line was a metadata record the resumed session never reached its recaps), and
  the server checks that the chain from the newest message reaches the recap.
- **Surgery refuses more cuts that would hurt the session**: one that splits a
  tool call from its surviving result (`cut_splits_tool_call`), one through a
  user message whose reply survives (`cut_is_user_message`), one that leaves
  the chain broken (`chain_broken`), one through the newest message, after
  which nothing survives for the next message to hang off (`cut_at_the_end`),
  a sentinel whose id is not the next in the
  voice's stack (`sentinel_id_mismatch`) or whose voice is another
  (`sentinel_voice_mismatch`). An unparseable first survivor is now refused as
  `chain_broken` (was `first_survivor_unparseable`).
- **Header records** (uuid-less metadata Claude Code writes at the top of a
  file) are kept in place and skipped before the recap stack.
- **Recaps are recognized structurally**: a user message whose string content
  carries the sentinel. Text that only quotes the sentinel elsewhere (a tool
  result, assistant text, a task notification) no longer counts, so
  `cut_range_has_existing_recap` no longer fires on routine work. Recaps
  written without an `id`, or whose sentinel block does not parse, are still
  recognized; a new body's sentinel must parse.
- **The swap is safe under a live session**: lines appended during surgery are
  carried into the new file; a half-written line is waited out; the rename is
  retried while another process holds the file; a file that shrank or changed
  before the read point stops the surgery (409, nothing changed). This
  replaces 1.0's in-process lock and mtime abort. The live file is never
  restored from the older backup after a failed write.
- **Backups** are verified (fsync + read-back), kept per voice in
  `backup_dir/<voice>/`, the newest three raw and older ones gzipped.
- The injected recap copies `permissionMode` and `gitBranch` from the
  conversation when present and leaves them out otherwise (1.0 refused a
  session without `gitBranch`).
- `/find-cut-point` with `exclude_recap` skips injected recap records only.
- The `/remember` skill drives the cycle from the plan and ends with
  `selfrecap restart` where configured, else the operator's restart.

### Compatibility

- Existing `config.yaml` files load unchanged. Voice names are now
  case-insensitive and reported lower-case.
- Existing recaps keep matching: `sentinel_name` works as before, and recaps
  without ids or with a sentinel block that does not parse are still
  recognized and protected.
- Passing both `voice` and `file_path` is now a 400 (it was ambiguous).
- `/surgery` returns 409 for a swap that could not be finished and 500 for a
  failed backup; refusals stay 400.

## [1.0.0] - 2026-05-25

First public release. An HTTP API for Claude Code session continuity: find clean
cut points in JSONL transcripts, monitor context-window size, and perform
self-authored recap surgery as an alternative to lossy auto-compaction.

### Added

- **`POST /find-cut-point`** — locate a record in a session by `marker_phrase`,
  `timestamp`, or `anchor_offset`, returning each match's `uuid` plus a
  surrounding context window. Supports `exclude_recap`, `limit` (default 50,
  max 500), and a `before_timestamp` self-contamination filter.
- **`GET /context/:voice`** and **`GET /context?path=...`** — current
  context-window size, computed the way Claude Code's own `/context` does
  (last non-sidechain `assistant.usage`, summing input + cache-read +
  cache-creation tokens).
- **`GET /contexts`** — single-call snapshot of every configured voice, with
  per-voice error isolation.
- **`POST /surgery`** — cut + inject + parent-pointer repair. Removes records
  through `cut_through_uuid`, injects a self-authored recap as a new user
  message, and repairs the chain. Dry-run mode, timestamped backups, and atomic
  temp-file-plus-rename writes with rollback on failure.
- **Multi-recap layering** — prior recaps already at the top of a file are
  detected and preserved, so recap-002 compounds on recap-001 instead of
  destroying it.
- **`GET /health`** and **`GET /voices`** — liveness and configured-voice listing.
- **`scripts/recap.ts`** — CLI wrapper around `/surgery` that extracts
  `cut_through_uuid` from the recap body's sentinel automatically; dry-run by
  default, `--go` to execute.
- **The `/remember` Claude Code skill** — sessions invoke the recap cycle on
  themselves.
- **Configurable sentinel name** (`sentinel_name`, default `RECAP-CYCLE`) for
  marking and preserving recap injections across cycles.
- **Security hardening** — `allowed_roots` path allowlist with symlink
  resolution and `.jsonl` enforcement, `expose_paths: false` to strip
  filesystem paths from responses, loopback-only binding, body limits, and log
  redaction. See `SECURITY.md`.
- **Pair-balance diagnostics** including the `tail_orphan_only` self-loop signal.
- **Test suite** (Vitest) over hand-crafted JSONL fixtures covering invariants,
  boundaries, the finder, and security regressions.
- **pm2 deploy path** via `npm run build` + `node dist/server.js`.
- Documentation: `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, and the
  `docs/` set (`protocol.md`, `walkthrough.md`, `recap-writing-guide.md`,
  `cache-mechanics.md`).

[1.2.0]: https://github.com/nickshvab/selfrecap/releases/tag/v1.2.0
