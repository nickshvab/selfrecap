# HTTP API reference

All endpoints are served over loopback. POST routes mutate or compute against your transcript files; treat the server as a local tool, not a public service. POST routes need the `X-Recap-Token` header, with the token from `~/.selfrecap/token`. The CLI helper `scripts/recap.ts` calls these routes for you ([the scripts](../README.md#scripts)); the security layers are in [SECURITY.md](../SECURITY.md). Errors share one shape: [Errors](#errors).

**`POST /surgery` executes unless the request says `"dry_run": true`.** See [the route](#post-surgery).

## `GET /health`

Liveness check.

```bash
curl http://127.0.0.1:9090/health
```

```json
{
  "status": "ok",
  "version": "1.2.0",
  "voices_registered": 1,
  "voices_missing_file": 0,
  "config_problems": 0
}
```

## `GET /voices`

List configured voices and per-file state.

```bash
curl http://127.0.0.1:9090/voices
```

```json
{
  "voices": {
    "my-session": {
      "exists": true,
      "file_size_bytes": 3440000,
      "last_modified": "2026-01-08T12:00:00.000Z",
      "live_session_id": "00000000-0000-0000-0000-000000000000",
      "continuation_hops": 0,
      "has_recaps_folder": true,
      "has_restart": true
    }
  },
  "problems": []
}
```

When `expose_paths: false` (the default), the filesystem `path` is omitted from this response. `problems` lists everything wrong with `config.yaml`, one line each (a broken voice entry is left out; the others keep working).

## `GET /context/:voice` (also `GET /context?path=...`)

Read the current context-window size for a session. Computed the way Claude Code's own `/context` does: scan backward for the last non-sidechain `assistant` record with a `usage` block, then sum `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.

```bash
curl http://127.0.0.1:9090/context/my-session
# or, for any path without registering a voice:
curl "http://127.0.0.1:9090/context?path=/absolute/path/to/session.jsonl"
```

```json
{
  "voice": "my-session",
  "file": "/.../session.jsonl",
  "tokens_total": 528000,
  "percent_of_1m": 52.8,
  "input_tokens": 6,
  "cache_read_tokens": 525256,
  "cache_creation_tokens": 2726,
  "output_tokens": 1392,
  "file_size_bytes": 3440000,
  "line_count": 2032,
  "last_usage_ts": "2026-01-08T12:00:00.000Z",
  "last_usage_line_idx": 2030
}
```

`tokens_total` is what counts toward the 1M context window. `output_tokens` is reported but does not count toward input context. For a voice the reading comes from the live file (see [session continuation](./operations.md#session-continuation)), and the response adds `configured_path`, `resolved_path` and `continuation_hops` (base names unless `expose_paths`). `file` is omitted unless `expose_paths`.

## `GET /contexts`

A single-call snapshot of every configured voice, for you or a dashboard of your own (none ships with selfrecap). Per-voice errors (missing file, no usage entries) are isolated — one bad voice does not break the rest.

```bash
curl http://127.0.0.1:9090/contexts
```

```json
{
  "snapshot_at": "2026-01-08T12:00:00.000Z",
  "voice_count": 2,
  "voices": {
    "my-session": {
      "exists": true,
      "configured_path": "00000000-0000-0000-0000-000000000000.jsonl",
      "resolved_path": "00000000-0000-0000-0000-000000000000.jsonl",
      "continuation_hops": 0,
      "tokens_total": 528000,
      "percent_of_1m": 52.8,
      "line_count": 2032,
      "last_usage_ts": "2026-01-08T12:00:00.000Z",
      "last_usage_line_idx": 2030,
      "headroom": { "ceiling_percent": 97, "tokens_to_ceiling": 442000, "reserve_tokens": 40000, "body_budget_chars": 1005000, "tight": false },
      "recaps": { "count": 1, "last_id": "my-session-recap-001", "last_applied_at": "2026-01-05T09:12:00.000Z" },
      "stale_reading": false,
      "live": [{ "pid": 4242, "session_id": "00000000-0000-0000-0000-000000000000", "status": "idle", "started_at": "2026-01-08T08:00:00.000Z" }],
      "lifecycle": { "event": "resumed", "ok": true, "at": "2026-01-08T08:00:41.000Z", "session_id": "00000000-0000-0000-0000-000000000000", "detail": "up as My-session, pid 4242, .claude" }
    },
    "voice-a": {
      "exists": false,
      "error": "file_not_found"
    }
  }
}
```

- `headroom` — room left before 97% of the window, and the recap body budget that leaves after a 40k-token reserve for the rest of the cycle (see the recap plan below).
- `recaps` — the recap stack at the head of the live session.
- `stale_reading` / `stale_reason` — the reading does not describe the context the session will run on: the file sits behind a broken continuation link, the last recap landed after the running process started (it holds the old context until it restarts), or the reading was taken before the last recap was applied (it updates after the first reply following the restart). Off Windows, where `live` is `null`, a recent recap is caught only by the last of these.
- `live` — the running Claude Code sessions answering to this voice's name on its account. `null` where liveness cannot be checked (anywhere but Windows; see [the optional Windows features](./operations.md#optional-windows-only-the-nudger-and-selfrecap-restart)).
- `lifecycle` — the last nudge or restart event (shape and event names under [`GET /lifecycle`](#get-lifecycle)), or `null`.
- `account_usage` (top level) — only with `usage.enabled`: each account's plan-usage windows. Its shape, with an example: [options.md, Plan-usage bars](./options.md#plan-usage-bars).

## `GET /voices/:voice/recap-plan`

Everything a session needs for `/remember`, worked out from config and the live session: context and headroom, the recap stack, the next recap number, id and body path, the sentinel values to copy, a `suggested_before_timestamp` (now minus five minutes) for the finder, the restart command with the live session id filled in, and `self_restart`: whether `recap.ts --go --restart` can restart this session itself (`available`, and the `reason` when it cannot: not Windows, no restart command, or one that fails its checks). `npx tsx scripts/recap.ts <voice> --plan` prints it. Session paths are base names unless `expose_paths`; the body path is always given in full (the session writes there), with forward slashes.

`?draft=1` (or `true`) adds `draft`, the [draft](../README.md#the-draft-and-the-check-opt-in) for the next recap: its path in `<recaps>/drafts/`, its size once written, or an estimate (`estimated: true`, about a tenth of the period's timeline) up to `?cut=<uuid>`, else up to the pending cut the server finds in its own log folder, else to the end of the session, with `body_budget_after_chars`. A written draft not yet read (Read calls since it was written count as read) is counted in `headroom.draft_tokens` and so in the body budget. `?draft=0` (or `false`) leaves it out (`draft: null`, `draft_tokens: 0`); without the parameter the server's own setting decides: `SELFRECAP_DRAFT` in the server's environment, else its `draft.enabled`. `recap.ts` always passes its own setting. A `cut` that is not a uuid is refused (400, `bad_cut`).

```json
{
  "voice": "my-session",
  "name": "My-session",
  "sentinel_name": "RECAP-CYCLE",
  "recaps_dir": "/Users/you/selfrecap-voices/my-session",
  "memories_dir": null,
  "session": { "configured_path": "0000….jsonl", "live_path": "0000….jsonl", "live_session_id": "00000000-…", "exists": true, "continuation_hops": 0 },
  "context": { "tokens_total": 812000, "percent_of_1m": 81.2, "last_usage_ts": "2026-01-08T12:00:00.000Z" },
  "headroom": { "ceiling_percent": 97, "tokens_to_ceiling": 158000, "reserve_tokens": 40000, "draft_tokens": 0, "body_budget_chars": 295000, "tight": false },
  "draft": null,
  "self_restart": { "available": false, "reason": "selfrecap restart is Windows-only: after --go the operator restarts the session with the restart command" },
  "stack": [{ "line_idx": 3, "id": "my-session-recap-001", "period_covered": "2026-01-01_to_2026-01-05", "cut_through_uuid": "…", "applied_at": "…" }],
  "next": { "number": 2, "id": "my-session-recap-002", "predecessor_id": "my-session-recap-001", "body_path": "/Users/you/selfrecap-voices/my-session/recap-002.body.txt", "body_exists": false, "body_chars": null },
  "bodies_on_disk": [1],
  "suggested_before_timestamp": "2026-01-08T11:55:00.000Z",
  "restart_command": "cd ~/projects/my-app && claude --resume 00000000-… --name My-session",
  "warnings": []
}
```

The next number comes from the session's recap stack, not from the folder: the stack is what surgery keeps. `body_chars` counts characters, not bytes.

## `GET /voices/:voice/records?around=<line>&span=<n>`

The records around a line of the live session, summarized (line, `type`/`subtype`, uuid, parent uuid, time, a preview, whether it is a tool result), for reading a seam before choosing the cut. `span` defaults to 30, max 200. `npx tsx scripts/recap.ts <voice> --around <line>` prints it.

## `GET /lifecycle`

Per voice: whether it is live, its last nudge/restart event, and what the nudger would do right now (read-only; nothing is sent). `supported: false` off Windows, where `live` and `nudge` are `null` and only the recorded events come back.

```bash
curl http://127.0.0.1:9090/lifecycle
```

```json
{
  "supported": true,
  "nudge": { "enabled": true, "at": 83, "every_minutes": 5, "cooldown_minutes": 10, "model": "haiku" },
  "voices": {
    "my-session": {
      "name": "My-session",
      "live": [{ "pid": 4242, "session_id": "00000000-0000-0000-0000-000000000000", "status": "busy", "waiting_for": null }],
      "lifecycle": { "event": "nudged", "ok": true, "at": "2026-01-15T10:05:00.201Z", "detail": "at 83.4% (line 83%)" },
      "nudge": { "action": "skip", "reason": "cooling down" }
    }
  }
}
```

`lifecycle` is the voice's last recorded event (also `lifecycle` in `/contexts`): `event`, `ok` (good news or not), `at`, `session_id` where known, and `detail`. The events:

| Event | `ok` | Meaning |
| --- | --- | --- |
| `nudged` | true | the nudger's courier delivered its message |
| `nudge_failed` | false | the courier did not deliver it (retried at the next check) |
| `restart_overdue` | false | a recap was applied, but the old process is still running long after |
| `over_ceiling` | false | past 95% (or no room for a body): too tight to recap, needs the operator |
| `restart_scheduled` | true | the session ran `selfrecap restart`; the helper waits for it to go idle |
| `resumed` | true | the session is back: expected id, expected name, live, not stuck |
| `resume_failed` | false | the resume did not come up, came up stuck, or its helper died |
| `aborted` | false | nothing was killed or resumed (never idle, closed by someone else, a lock, a check) |
| `id_drift` | false | the running session id is not the one `config.yaml` leads to |

A `nudged` event never replaces a failure as the voice's last event: the failure stays until an event of another kind is recorded. A `restart_scheduled` with no outcome after 25 minutes is returned as failed (`ok: false`, its `detail` saying the helper died or never ran). `nudge.action` is `nudge`, `overdue`, `ceiling` or `skip`, with the `reason`. Every event is also a line in `logs/lifecycle.log` (`npx tsx scripts/selfrecap.ts log`).

## `POST /find-cut-point`

Locate a record in a session by description. The session describes a target moment by phrase, timestamp, or anchor-plus-offset; the server returns matching records — each with its `uuid` (the handoff key for surgery) plus a surrounding context window for verification.

```bash
curl -X POST http://127.0.0.1:9090/find-cut-point \
  -H "Content-Type: application/json" \
  -H "X-Recap-Token: $(cat ~/.selfrecap/token)" \
  -d '{
    "voice": "my-session",
    "method": "marker_phrase",
    "phrase": "now let's move on to the dashboard",
    "exclude_recap": true,
    "limit": 50
  }'
```

`method` options:

- `marker_phrase` — exact substring search across all record text (message text, tool_use input, tool_result content, thinking blocks). Specify `phrase`.
- `timestamp` — the last record before a given ISO timestamp. Specify `before`.
- `anchor_offset` — find `anchor_phrase`, then move `offset` records in `direction` (`before` / `after`).

Other fields: `exclude_recap` (default `true`, skips injected recap records), `limit` (default 50, max 500), `before_timestamp` (drop matches at or after this ISO time — useful for filtering out your current session's own activity). Like every POST, it needs the `X-Recap-Token` header; `scripts/recap.ts --find` sends it for you.

```json
{
  "method": "marker_phrase",
  "spec": { "method": "marker_phrase", "phrase": "...", "limit": 50 },
  "exclude_recap": true,
  "total_matches": 1,
  "returned_count": 1,
  "limit": 50,
  "truncated": false,
  "matches": [
    {
      "line_index": 1032,
      "uuid": "aaaaaaaa-0000-0000-0000-000000000000",
      "parent_uuid": "bbbbbbbb-0000-0000-0000-000000000000",
      "timestamp": "2026-01-07T10:39:09.219Z",
      "type": "user",
      "role": "user",
      "content_preview": "now let's move on to the dashboard...",
      "selectable": true,
      "context_before": [],
      "context_after": []
    }
  ],
  "voice": "my-session",
  "file": "/.../session.jsonl",
  "total_lines": 2050
}
```

Only records with `selectable: true` (those with a `uuid`) can be used as a cut target. For a boundary `user` message, the cut goes through its `parent_uuid` (the record the conversation stood on when it arrived), not the message itself. See [walkthrough.md](./walkthrough.md) for tips on writing distinctive phrases and handling multibyte content.

## `POST /surgery`

Cut, inject, and repair in one operation. Removes records from the start of the file through `cut_through_uuid` (preserving any header records and prior recaps already at the top), injects `recap_content` as a new user message, and re-points every survivor whose parent was cut.

```bash
curl -X POST http://127.0.0.1:9090/surgery \
  -H "Content-Type: application/json" \
  -H "X-Recap-Token: $(cat ~/.selfrecap/token)" \
  -d '{
    "voice": "my-session",
    "cut_through_uuid": "aaaaaaaa-0000-0000-0000-000000000000",
    "recap_content": "Here is where you were... <full recap, ending with the sentinel JSON block>",
    "dry_run": true,
    "force_overwrite_recap": false
  }'
```

**`dry_run` defaults to `false`: a request without `"dry_run": true` executes the surgery.** Send `"dry_run": true` first, every time — it computes and returns full diagnostics without touching the file. (`recap.ts` always sends `dry_run` explicitly: `true` for the dry run, `false` only with `--go`.)

Fields: `voice` or `file_path` (one of them), `cut_through_uuid` (at least 8 characters), `recap_content` (50 to 1,048,576 characters), `dry_run`, `force_overwrite_recap` (both optional booleans, default `false`). A request outside these is refused with 400 `invalid_request`; the whole request body is capped at 2 MB.

`recap_content` must end with the recap sentinel JSON (default marker `RECAP-CYCLE`); the server rejects the request with a format hint if it is missing. For a voice, the sentinel's `voice`, if given, must be this voice. If the sentinel has an `id`, it must be the next one in the session's recap stack (`<voice>-recap-NNN`; the recap plan names it); without one, surgery runs with a warning. (The id is checked only while every recap id in the stack carries a number.)

Besides the sentinel, the server refuses (400, `ok: false`, a `reason`, and every problem in `diagnostics.problems`) a cut that would split a tool call from its surviving result, cut through the boundary user message itself, delete a recap outside the leading stack (unless `force_overwrite_recap`), leave the newest message unable to reach the recap through its parent chain, or cut through the newest message itself (`cut_at_the_end`: nothing would be left for the next message to hang off). A swap that could not be finished because the file kept changing is 409 (nothing was changed; retry); a backup that could not be written is 500.

```json
{
  "ok": true,
  "dry_run": true,
  "diagnostics": {
    "file_path": "/.../session.jsonl",
    "backup_path": null,
    "total_lines_before": 2050,
    "total_lines_after": 1018,
    "cut_through_line_idx": 1032,
    "cut_through_record": { "type": "system/turn_duration", "preview": "" },
    "lines_cut": 1033,
    "new_recap_uuid": "cccccccc-0000-0000-0000-000000000000",
    "sentinel_invariant_passed": true,
    "recap_id": "my-session-recap-001",
    "expected_recap_id": "my-session-recap-001",
    "cut_range_has_existing_recap": false,
    "leading_recaps_preserved": 0,
    "new_recap_position": 0,
    "repointed_records": 1,
    "chain_reaches_recap": true,
    "chain_break": null,
    "cut_orphaned_tool_results": [],
    "file_size_before_bytes": 3440000,
    "file_size_after_bytes": 1700000,
    "carried_tail_lines": null,
    "rename_attempts": null,
    "backups_compressed": [],
    "pair_balance": {
      "tool_use": 491,
      "tool_result": 491,
      "orphans": 0,
      "tail_orphan_only": false
    },
    "problems": []
  },
  "warnings": [],
  "voice": "my-session",
  "live_session_id": "00000000-0000-0000-0000-000000000000",
  "restart_command": "cd ~/projects/my-app && claude --resume 00000000-0000-0000-0000-000000000000 --name My-session"
}
```

When `dry_run: false` and surgery succeeds, a verified backup is written first (fsynced and read back), the new file is built beside the live one, and it is swapped in by rename while the session may still be writing: complete lines it appends in the meantime are carried into the new file (`carried_tail_lines`), a half-written line is waited out, and the rename is retried while another process holds the file. If the live file shrank or changed before the point surgery read, nothing is swapped. When a swap fails, the server leaves the live file as it was and never copies the backup back over it on its own: that would erase what the session wrote since. `backup_path` points to the pre-surgery copy (lines the session wrote during the swap are appended to it). Restoring it by hand is your decision; [walkthrough step 8](./walkthrough.md#8-verify) says what a restore loses.

The CLI helper `scripts/recap.ts` wraps this endpoint, reads the body from the plan's path and the cut point from its sentinel, and prints the diagnostics as a checklist — see [the scripts](../README.md#scripts).

For the full diagnostics field reference and the safety invariants, see [protocol.md](./protocol.md).

## Errors

An error is JSON with an `error` code and, for most, a `message` (`invalid_request` carries `details` instead). A surgery refusal is different: it is the full surgery response with `ok: false`, a `reason` and the `diagnostics` (see [`POST /surgery`](#post-surgery)).

| Status | `error` | When |
| --- | --- | --- |
| 403 | `forbidden_origin` | the request carries an `Origin` header (any route) |
| 403 | `forbidden_host` | the `Host` header is not loopback (any route) |
| 401 | `unauthorized` | a POST without the right `X-Recap-Token` |
| 400 | `invalid_request` | the body or query does not fit the route (POST routes, `/records`) |
| 400 | `path_resolution_failed` | the file is not a `.jsonl`, is outside `allowed_roots`, or both `voice` and `file_path` were given; on `/find-cut-point` also an unknown voice. The message names the path it refused. |
| 404 | `voice_not_found` | an unknown voice (`/surgery`, `/records`, `/context/:voice`, the recap plan) |
| 404 | `file_not_found` | `/context`: the session file is not there |
| 400 | `missing_path` | `GET /context` without `?path=` |
| 400 | `bad_cut` | the recap plan's `?cut=` is not a uuid |
| 500 | `plan_failed`, `find_failed`, `read_failed` | the recap plan, `/find-cut-point` or `/records` failed while reading the session |
| 500 | `surgery_failed` | surgery stopped unexpectedly: whether the file was swapped is not known; check the recap stack (`recap.ts <voice> --plan`) before retrying |

`/contexts` reports a per-voice problem inside that voice's entry (`exists: false` and an `error`), `/voices` with `exists: false`; both answer 200.
