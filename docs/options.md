# Optional features

Without the options below, selfrecap (the server, `recap.ts`, surgery and backups) makes no model calls. Keys go in `config.yaml`, which the server reads once at startup: after a change run `npm run check-config` and restart the server. The draft and the check are the exception: `recap.ts` reads `config.yaml` itself on every run.

| Feature | Default | Turn it on with | Spends model usage? | Platform |
| --- | --- | --- | --- | --- |
| [The draft](#the-draft) | off | `draft.enabled: true`, or `SELFRECAP_DRAFT=1` | yes: `claude -p` readers | any |
| [The check](#the-check) | off | the draft's switch | yes: one `claude -p` checker | any |
| [Context nudger](#context-nudger) | off | `nudge.enabled: true` | yes: one small `claude -p` per message | Windows only |
| [Self-restart](#self-restart) | off (no `restart` command) | a voice's `restart` command | no `claude -p`; the resumed session takes one turn | Windows only |
| [Plan-usage bars](#plan-usage-bars) | off | `usage.enabled: true` | no | any |

Every `claude -p` run is billed to the account it runs on, like any other `claude -p` run there (to API credit when `ANTHROPIC_API_KEY` is set). On Windows these runs need a native `claude.exe` (in `~/.local/bin` or on `PATH`); an npm `claude.cmd` cannot be started.

Running several sessions, or a session on a second Claude Code account: [Several sessions, a second account](#several-sessions-a-second-account). Plain settings and the rules `config.yaml` is checked against: [Other settings](#other-settings).

## The draft

`recap.ts <voice> --draft`, after `--find` has saved the pending cut. A cold reader, a headless `claude -p` run that has never seen the session, reads the period being cut and writes short lines (what was learned and decided, and who said it); the session reads all of them, then writes its recap body itself.

- **On:** off by default; `--draft` then refuses with one line and starts nothing.

  ```yaml
  draft:
    enabled: true
  ```

  Or `SELFRECAP_DRAFT=1` in the environment of the session that runs `recap.ts` (`0` turns it off). The environment wins over the file. No server restart is needed; `npm run check-config` says whether it is on.
- **Choices:** by default one reader on `reader_model` (`opus`) reads the whole period; it assumes a context window of about 1M tokens, and a timeline over 1,000,000 characters goes to the fewest parts under that size. `--split` reads in parts of about 230,000 characters on `split_reader_model` (default `sonnet`), up to four at once: use it with a smaller-window model. `operator` (default `the operator`, at most 60 characters) is what the readers' instructions (their briefs) call you. For one run: `--reader-model`, `--operator`, `--part N` (rerun one part), `--prepare-only` (start nothing).
- **What you get:** `DRAFT READY`, the draft's path, its size and the cost; the draft is a list of lines by day, the weightiest in bold. Both are shown in [the skill, Step 3b](../skills/remember/SKILL.md#step-3b--the-draft-only-if-your-plan-has-a-draft-line).
- **Cost:** one run per reader, on the account of the session that runs `recap.ts`; a reader whose file does not parse runs once more. Each run prints its time, tokens and cost. Measured once, on about 770,000 characters: about ten minutes and about half a million tokens. A reader is stopped after 40 minutes (25 with `--split`).
- **Needs:** Claude Code 2.1.314 or later (checked before any run), an existing recaps folder for the voice (`recaps` or `home`), a pending cut.
- **Writes:** `<recaps>/drafts/draft-for-<id>.md`; the raw period and each run's folder in `<recaps>/drafts/.work/`, removed after a successful `--go` or by `--draft-clean`. Both folders get a `*` `.gitignore`.
- **More:** [README](../README.md#the-draft-and-the-check-opt-in), [why-the-draft.md](./why-the-draft.md), [SECURITY.md section 8](../SECURITY.md#8-the-draft-and-the-check-headless-runs-over-untrusted-text) (the fence around the runs; `npx tsx scripts/check-headless-fence.ts` tests it with one small run).

## The check

`recap.ts <voice> --check`, after the body is written. One cold checker compares the body with a shortened record of the period and reports what is wrong, unsupported or missing; one round, and the session decides what to change.

- **On:** the draft's switch; there is no separate key, and no draft need exist. Model: `draft.check_model` (default `opus`), or `--check-model` for one run.
- **What you get:** a report of under 400 words in five parts (wrong against the record, from after the cut, lines about the session the record does not support, still owed, decisions the body misses), printed and kept; an example is in [the skill, Step 5b](../skills/remember/SKILL.md#step-5b--the-check-only-if-your-plan-has-a-draft-line).
- **Cost:** one run, and one more if it writes no report; a few minutes on the measured period, each stopped after 25 minutes. It prints its cost.
- **Needs:** Claude Code 2.1.314 or later, an existing recaps folder, a body whose sentinel parses, and a cut (the pending cut, or one written in the sentinel).
- **Writes:** `<recaps>/drafts/check-for-<id>.md`, `<recaps>/drafts/.work/checker/`, and the pending cut into a `CUT_UUID` placeholder in the body's sentinel.
- **More:** [README](../README.md#the-draft-and-the-check-opt-in).

## Context nudger

Every few minutes the server reads each voice's context, and a live session past `nudge.at` percent gets a message: run `/remember` at the next clean seam, then restart. A session busy with its work does not watch its own context; the nudge tells it in time to recap at a seam of its choosing rather than at the limit.

- **On:** off by default; set it, then restart the server. There is no environment variable.

  ```yaml
  nudge:
    enabled: true
    # the rest are the defaults
    at: 83               # percent of the 1M-token window
    every_minutes: 5
    cooldown_minutes: 10 # least time between two messages to one voice
    model: haiku         # model of the one-shot run that carries each message
  ```

- **Needs:** Windows (elsewhere the server logs that it did not start it); Claude Code with cross-session messaging (v2.1.224+, native Windows v2.1.234+); each session started with `claude --name` matching the voice's `name` (default: the key, capitalized), and one running session per name on its account. To see whether the nudger can see a session: `curl http://127.0.0.1:9090/lifecycle` ([api.md](./api.md#get-lifecycle)); a voice whose `nudge` entry says `"reason": "not live"` is out of its reach.
- **What the session sees:** a cross-session message from a short-lived session named `Nudge-<Name>`, for example:

  > From the selfrecap server (the /remember skill describes this): you are at 83.4% of your context window (the nudge line is 83%). At the next clean seam in your work: pause, run /remember, and when --go has succeeded restart as its last step says (`selfrecap restart` if your plan has a restart command, otherwise the operator restarts you), then report and end your turn. If you are already on it, ignore this. Next check in 10 min.

  Two other messages start the same way. Past 95%, or with no room left for a body, the session is told not to run `/remember`, to reply with one line and to wait for you; it is told once per crossing. A session whose recap was applied but which has not restarted 20 minutes later (or whose restart failed) is told to restart and not to recap again.
- **A held message:** Claude Code treats the nudge like any cross-session message. A session running in a different permission mode from the courier may hold it until you approve it in that session's window (a session in bypass-permissions mode takes it at once). Approve it, or type `/remember` yourself. The nudger records `nudged` once the courier run exits cleanly; whether the session has read the message is not known.
- **What you do:** usually nothing; the `/remember` skill does the rest. `npx tsx scripts/selfrecap.ts log` and `lifecycle` in `/contexts` show each message; `nudge_failed`, `restart_overdue` and `over_ceiling` are the events that want you.
- **Cost:** each message is a courier: a one-shot `claude -p` on `nudge.model` in the session's own account, started with `--allowedTools SendMessage`, stopped after two minutes. A failed delivery is retried at the next check. Each message also costs the nudged session a turn.
- **Courier runs:** Claude Code keeps each courier run as a session on that account (the courier is not started with `--no-session-persistence`), in the `projects/` folder for the selfrecap folder, where the courier runs. selfrecap never reads them; delete them when you like.
- **Writes:** `logs/lifecycle.log` and `logs/lifecycle-state.json`. `npx tsx scripts/selfrecap.ts log` prints the log; the last event per voice is `lifecycle` in `/contexts`, and `GET /lifecycle` shows it with what the nudger would do now ([api.md](./api.md#get-lifecycle)).
- **More:** [operations.md](./operations.md#optional-windows-only-the-nudger-and-selfrecap-restart).

## Self-restart

After its surgery the session restarts itself, so it comes back on the rewritten file without you closing and resuming it. `recap.ts <voice> --go --restart` does the dry run, the surgery (only if the dry run is clean) and the scheduling in one call; `npx tsx scripts/selfrecap.ts restart` schedules it after a plain `--go`.

- **On:** off by default: a voice has no `restart` command until you add one, and `--go` then prints `claude --resume <id>` for the operator. (The examples in `config.example.yaml` and the Quickstart do add one.) Nothing restarts unless the session runs one of the two commands; the `/remember` skill runs `--go --restart` when the plan's Self-restart line says yes.

  ```yaml
  voices:
    my-session:
      # session: ... as before
      restart: 'cd C:\Users\you\projects\my-app; claude --resume {session_id} --name My-session'
      name: My-session
  ```

  The command resumes by id (`--resume {session_id}`, never `--continue` or `--fork-session`), `cd`s into the session's own folder, and runs in Windows PowerShell 5.1 (`;`, not `&&`). `npm run check-config` checks it. There is no environment variable.
- **What you see:** the session's `--go --restart` output ends with a `RESTART` block ([example in the skill, Step 8](../skills/remember/SKILL.md#step-8--restart-report-stop)). A new console window opens: the helper. It prints `selfrecap: My-session asked to restart. Waiting for its turn to end (pid 4242)...`. When the session has been idle for three seconds, the helper ends its Claude Code process (with everything under it, MCP servers included), prints `selfrecap: My-session closed. Resuming it by id <id>.`, and runs the restart command in its own window, with this first prompt:

  > selfrecap restart resumed this session at 10:34 UTC after my-session-recap-002, which now replaces the period it covers. Continue the work.

  The resumed session runs in that new window and carries on by itself. The helper checks that it came back (the same id and name within 90 seconds, not held by a dialog for a minute) and watches it three minutes more.
- **If it fails:** the helper window shows a red `selfrecap restart: DID NOT HAPPEN` with the reason and, where it applies, the command to resume by hand, and waits for Enter. The outcome is in the log:

  ```text
  $ npx tsx scripts/selfrecap.ts log
  2026-01-15T10:31:02.114Z my-session   restart_scheduled 00000000-0000-0000-0000-000000000000 helper pid 18244
  2026-01-15T10:33:41.530Z my-session   resumed           00000000-0000-0000-0000-000000000000 up as My-session, pid 20112, .claude
  ```

  A failure is `aborted` or `resume_failed` with its reason, and `lifecycle` in `/contexts` shows it with `"ok": false`. A restart scheduled 25 minutes ago with no outcome is reported as failed (its helper died). If the session is not running, resume it by hand with the restart command `--go` printed. The helper never kills a session that does not go idle within 20 minutes: it gives up and leaves it running.
- **The lock:** `logs/run/lock-<name>.json` holds a name's restart from launch until its outcome is known, so a doubled `selfrecap restart` cannot start two sessions on one name; a second one exits 6 (`a restart is already pending`). A lock older than 30 minutes belongs to a dead helper and the next restart takes it over. To clear it sooner, make sure no helper window is still open, then delete the file. The job file beside it (`restart-<id>.json`) is removed by the helper when it starts.
- **Cost:** no `claude -p` run; the resumed session answers its resume prompt, one ordinary turn.
- **Needs:** Windows (liveness comes from Claude Code's named pipes, the new console from WMI; elsewhere `--go --restart` refuses before anything is cut); Claude Code with cross-session messaging (as for the nudger); the session started with `--name` matching the voice, and the command run from inside that session, not from a terminal.
- **Writes:** a job file and a lock in `logs/run/`; the outcome in `logs/lifecycle.log` and `logs/lifecycle-state.json`.
- **More:** [operations.md](./operations.md#optional-windows-only-the-nudger-and-selfrecap-restart).

## Plan-usage bars

Claude Code plans limit usage over time windows: a five-hour window (Claude Code's `/usage` screen calls it "Current session") and a seven-day one ("Current week (all models)"). A *bar* is one such window of one account: its label, the percentage used, and when it resets. With this on, `GET /contexts` adds `account_usage`: the bars of every Claude Code account the server knows (the `accounts` key, plus the accounts your voices run on).

- **Who reads them:** nothing in selfrecap acts on these numbers. The recap plan, the nudger, `recap.ts` and the `/remember` skill never read them; only `/contexts` returns them, for you or for a dashboard that polls `/contexts`. Use them to see how much of a window is left before a long autonomous run, or before turning on the draft, whose reader took about half a million tokens on the period measured.
- **On (the documented source, the default):**
  1. In `config.yaml`:

     ```yaml
     usage:
       enabled: true
       source: documented   # the default; or undocumented, below
     ```

     Then `npm run check-config` (it prints `Usage bars: on, source documented ...`) and restart the server.
  2. In each account's `settings.json` (`~/.claude/settings.json`, or the one in the folder `CLAUDE_CONFIG_DIR` points to), set the script as the status line, with the absolute path of your clone:

     ```json
     { "statusLine": { "type": "command", "command": "node /home/you/selfrecap/scripts/usage-statusline.mjs" } }
     ```

     On Windows write the path with forward slashes, which need no escaping in JSON and work in every shell: `"command": "node C:/Users/you/selfrecap/scripts/usage-statusline.mjs"`.
  3. Send a message in a session on that account. After the reply Claude Code runs the status line, which prints a short line such as `5h 23% · 7d 41%` and saves the reading.
- **If the account already has a status line:** Claude Code runs one command, so point it at a small script that hands the same input to both. With `--quiet` this one prints nothing, and your line stays as it was.

  bash (macOS, Linux; `"command": "bash /home/you/.claude/statusline.sh"`):

  ```bash
  input=$(cat)
  printf '%s' "$input" | node /home/you/selfrecap/scripts/usage-statusline.mjs --quiet
  printf '%s' "$input" | /home/you/.claude/my-statusline.sh   # your status line
  ```

  Windows PowerShell (`"command": "powershell -NoProfile -File C:/Users/you/.claude/statusline.ps1"`):

  ```powershell
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Text.UTF8Encoding]::new($false)
  $json = [Console]::In.ReadToEnd()
  $json | node C:/Users/you/selfrecap/scripts/usage-statusline.mjs --quiet
  $json | node C:/Users/you/.claude/my-statusline.js   # your status line
  ```

- **What comes back:** `curl http://127.0.0.1:9090/contexts` (`curl.exe` in Windows PowerShell 5.1). The `account_usage` part, keyed by the account folder's name:

  ```json
  "account_usage": {
    ".claude": {
      "account": ".claude",
      "source": "documented",
      "plan": null,
      "ok": true,
      "fetched_at": "2026-01-15T10:02:41.000Z",
      "checked_at": "2026-01-15T10:04:00.000Z",
      "windows": [
        { "label": "Current session", "kind": "session", "percent": 23, "resets_at": "2026-01-15T13:00:00.000Z", "severity": null },
        { "label": "Current week (all models)", "kind": "weekly_all", "percent": 41, "resets_at": "2026-01-19T08:00:00.000Z", "severity": null }
      ]
    },
    ".claude-work": {
      "account": ".claude-work",
      "source": "documented",
      "plan": null,
      "ok": false,
      "error": "no status-line reading for this account yet: set scripts/usage-statusline.mjs as its status line (see docs/operations.md); Claude Code hands it the limits only for Pro, Max and Ultra subscriptions, after a session's first reply",
      "fetched_at": null,
      "checked_at": "2026-01-15T10:04:00.000Z",
      "windows": []
    }
  }
  ```

  `percent` is the share of the window used; `resets_at` is UTC; `fetched_at` is when the numbers were taken, `checked_at` when the server last looked. A window whose reset time has passed is left out. When the status line's input carries a spend limit, a third window appears, `"label": "Spend limit"`. `plan` and `severity` are filled only by the undocumented source. When `ok` is false, `error` says why.
- **Cost and what is sent:** no model call with either source.
  - `documented`: no network, no credentials. The script writes one small file per account, `~/.selfrecap/usage/<hash>.json` (`%USERPROFILE%\.selfrecap\usage\` on Windows; the name is a hash of the account folder's path), holding only the `rate_limits` object, the time, the Claude Code version and the account folder's base name. `SELFRECAP_USAGE_DIR` moves the folder: set it for the server and for the status line alike. The numbers are as fresh as the last status line update on that account; there is no per-model week, and an account without `rate_limits` (an API key) gets none.
  - `undocumented` (`usage.source: undocumented`): the bars of Claude Code's `/usage` screen, the per-model week included (a seven-day window for one model, labelled `Current week (<model>)`). The server reads each account's OAuth access token from `<account>/.credentials.json` and sends it in a `GET https://api.anthropic.com/api/oauth/usage` request (with `User-Agent: selfrecap/<version>`), at most once per two minutes and only when `/contexts` is asked. That endpoint is not a public API: it may change, refuse this client (reported as `usage endpoint refused this client (HTTP 429 with no retry time): it may answer Claude Code only`), or stop answering; the bars then show the error and everything else keeps working. The token is never refreshed, logged, returned or stored. An account whose login is kept in the macOS Keychain is left out. It writes nothing. Read [SECURITY.md section 7](../SECURITY.md#7-optional-features-that-reach-beyond-the-transcripts) before choosing it.
- **More:** [operations.md](./operations.md#plan-usage-bars-opt-in).

## Several sessions, a second account

One server serves every voice under `voices:`, and `/contexts` shows them all. Give each voice its own session, its own `recaps` folder and its own `name`. For the nudger and self-restart, start each session with `claude --name <its name>` and keep one running session per name on an account: with two, the nudger skips the voice and a restart does not resume it.

A second Claude Code account is a second config folder, used when Claude Code starts with `CLAUDE_CONFIG_DIR` pointing to it (say `~/.claude-work`). A voice on it needs:

1. that account's `projects/` folder in `allowed_roots`;
2. a restart command that selects the account when the operator runs it by hand (`selfrecap restart` selects it itself). `check-config` warns when a command for another account does not, and refuses a command for the default `~/.claude` account that sets `CLAUDE_CONFIG_DIR`;
3. `npm run install-skill` once more: it installs the skill into every account a voice runs on, plus those under `accounts`;
4. for plan-usage bars, the status line in that account's `settings.json` too.

The accounts your voices run on are read off their session paths; list an account under `accounts` only when no voice runs on it. A complete example on Windows:

```yaml
allowed_roots:
  - "~/.claude/projects/"
  - "~/.claude-work/projects/"

voices:
  my-session:
    session: "C:/Users/you/.claude/projects/C--Users-you-projects-my-app/00000000-0000-0000-0000-000000000000.jsonl"
    recaps: "C:/Users/you/selfrecap-voices/my-session"
    restart: 'cd C:\Users\you\projects\my-app; claude --resume {session_id} --name My-session'
    name: My-session
  research:
    session: "C:/Users/you/.claude-work/projects/C--Users-you-projects-research/11111111-1111-1111-1111-111111111111.jsonl"
    recaps: "C:/Users/you/selfrecap-voices/research"
    restart: '$env:CLAUDE_CONFIG_DIR="C:\Users\you\.claude-work"; cd C:\Users\you\projects\research; claude --resume {session_id} --name Research'
    name: Research
```

Start the second session the same way: `$env:CLAUDE_CONFIG_DIR="C:\Users\you\.claude-work"; claude --name Research`. On macOS or Linux the restart command is `'cd ~/projects/research && CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude --resume {session_id} --name Research'`; there the operator runs it, since self-restart is Windows-only.

## Other settings

Plain settings with safe defaults.

| Key | Default | What it does |
| --- | --- | --- |
| `server.port` | `9090` | The server's port (`recap.ts --server <url>` for another). |
| `server.host` | `127.0.0.1` | The bind address. Keep it on loopback: there is no TLS. |
| `allowed_roots` | `~/.claude/projects/` | The folders whose `.jsonl` files requests may read or rewrite. |
| `expose_paths` | `false` | `true` shows full paths in responses instead of base names. |
| `sentinel_name` | `RECAP-CYCLE` | The recap marker. Change it only to match older recaps. |
| `backup_dir` | `./backups` | Where pre-surgery backups go. |
| `accounts` | `~/.claude` | Account folders for live sessions, plan usage and `install-skill`; the voices' own are added by themselves. |
| `voices.<voice>.home` | none | The session's own folder. Its recap plan then names a memories folder, `<home>/memories/`, where the session keeps notes too long for its recap body; recap bodies go there too when `recaps` is not set. |
| `RECAP_CONFIG` (env) | `config.yaml` | Another config file. |
| `RECAP_LOG_DIR` (env) | `logs/` | Where the pending cut, the lifecycle log and the restart lock live. |

Always on, nothing to set: the auth token (`~/.selfrecap/token`, required on every POST), the Origin and Host checks, and [session continuation](./operations.md#session-continuation).

**How `config.yaml` is checked.** Every problem is reported by `check-config`, in the server's startup log, and in `/health` and `/voices`; what it does to the rest:

- A voice's `name` must start with a letter and hold only letters, digits, `-` and `_` (`^[A-Za-z][A-Za-z0-9_-]*$`); a voice whose `name` does not, or which has no `session`, is skipped, and the others keep working. Voice keys are case-insensitive: a second key that differs from another only in case is skipped.
- `draft.operator` is at most 60 characters.
- A `nudge`, `usage` or `draft` block that does not parse (a wrong type, an unknown key) is replaced by the defaults and never switches anything on by mistake: the nudger and the usage bars stay on only if the block says `enabled: true` plainly, the usage bars then use the `documented` source whatever the block says, and the draft and the check are off.
- Unknown keys, at the top or in a voice, are reported and ignored.
- `SELFRECAP_DRAFT` takes `1`, `true`, `on`, `yes` or `0`, `false`, `off`, `no`; any other value is ignored with a warning, and `draft.enabled` decides.
