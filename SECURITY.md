# Security Policy

`selfrecap` is a local file-mutation tool. Its `POST /surgery` endpoint rewrites JSONL transcript files on disk. That capability is the center of its threat model: a server that can rewrite arbitrary files, reachable over the network or by a malicious web page, is a serious primitive. This document describes the surface, the defenses, and how to report a problem.

## Threat model

The core risk is **unintended file writes**. Without guards, `POST /surgery` could be coerced into:

- **Writing files outside your sessions.** A request supplying `file_path: "../../.ssh/authorized_keys"`, or a symlink that resolves outside your session directory, would let the server overwrite something it should never touch.
- **Cross-site request forgery (CSRF).** Because the server listens on localhost, any web page open in a browser on the same machine can issue requests to `http://127.0.0.1:9090`. Without an Origin check and a token, a malicious page could trigger surgery on your transcripts.
- **Path / layout disclosure.** Responses that echo absolute filesystem paths leak your home-directory structure if a deployment is ever exposed.
- **Resource exhaustion.** Unbounded request bodies on a write endpoint are a denial-of-service vector.

The intended deployment is a single user running the server on their own machine, bound to loopback, operating on their own Claude Code sessions. The defenses below assume that model and harden against the ways it can go wrong.

## Defenses

### 1. Loopback only

The server binds `127.0.0.1` by default (`server.host` in `config.yaml`). It is not meant to be reachable from other machines. Do **not** change the bind address to `0.0.0.0` or a LAN IP without first adding TLS and a real authentication layer — neither of which ships with this tool.

### 2. Path allowlist (`allowed_roots`)

Every `file_path` (whether passed directly or resolved from a `voice`) is checked against the configured roots:

```yaml
allowed_roots:
  - "~/.claude/projects/"
```

A request is rejected if:

- the path it asks for does not end in `.jsonl` (checked on the path as given, before symlinks are followed), or
- the path, resolved to its real path with symlinks followed (where the file exists), does not fall under any allowed root.

This blocks both traversal payloads (`../../etc/passwd`) and symlink escapes (a `.jsonl` symlink pointing outside the allowlist).

Two readings do not go through this check, and both read only files your own `config.yaml` names: the nudger's context reading (which `GET /lifecycle` also runs) reads the token counts of each voice's live session file, and `GET /voices` reports each configured file's size and modification time. Neither returns transcript text.

### 3. Token + Origin + Host checks on writes

The hardening layer for POST routes is:

- **Auth token.** A token is generated on first start and written to `~/.selfrecap/token`. POST requests must present it (in the `X-Recap-Token` header). Requests without a valid token are rejected with `401`. On POSIX systems the file is written `0600` and its directory `0700` (owner-only). **On Windows/NTFS those POSIX mode bits are effectively a no-op** — Node's `mode` flag does not map to NTFS ACLs — so the token file is not OS-enforced owner-only on Windows. This is acceptable for a single-user loopback machine (the threat the token addresses is CSRF + other local processes on a shared box); if you are on a shared Windows machine, restrict the file's ACL yourself.
- **Origin rejection.** Any request carrying an `Origin` header is rejected with `403`. A legitimate local CLI client does not set `Origin`; a browser-driven CSRF attempt does. This closes the cross-site path even before the token check.
- **Host verification.** The `Host` header is verified to be a loopback host, defending against DNS-rebinding.
- **GET routes.** The Origin and Host checks apply to every request, GET included. The token does not: GET routes are read-only and answer any local process without it. Some return transcript text: `GET /voices/:voice/records` returns a preview of up to 160 characters of each record, up to 200 records on each side of a line. `GET /context?path=` reads any `.jsonl` under `allowed_roots`, but returns only sizes and token counts. So any local process that can reach the port can read those previews without the token.

### 4. Body limits and logs

- An explicit request body limit (2 MB) and a `recap_content` size cap (1,048,576 characters) bound the write surface.
- The server logs requests with Fastify's default request logging, which records the method, the URL, the caller's address and the response status, not headers or bodies, so transcripts and the token do not reach the log. There is no separate redaction step: a logger configured to record headers or bodies would write them.

### 5. Dry-run, backups, atomic writes

Operationally, surgery is hard to get wrong destructively:

- **Dry-run first.** `dry_run: true` computes the full diagnostics (lines cut, pair balance, recap detection) and returns them without touching the file. This is the recommended first call every time. **A `POST /surgery` request without `dry_run: true` executes**: the field defaults to `false`. `recap.ts` always sends it explicitly (`false` only with `--go`); a client of your own should too.
- **Verified backup before mutation.** A timestamped copy of the target file is written to `backup_dir`, fsynced, and read back and compared before any write. If the backup fails, surgery aborts and nothing is changed. A voice keeps its newest three backups as they are and gzips the older ones; none is deleted. Backups of a surgery on a direct `file_path` are not rotated.
- **Atomic, checked swap.** The new file is written beside the live one and renamed into place. Before the rename the live file is checked byte for byte up to the point surgery read; if it shrank or changed there, nothing is swapped. Lines the live session appended meanwhile are carried into the new file, and complete lines that reach the old file during the rename itself are appended to the new live file after it. The server never restores the live file from the older backup on its own, which would erase what the session wrote since.
- **Invariant enforcement.** The cut target must exist, `recap_content` must carry the sentinel marker, prior recaps in the cut range are preserved unless explicitly overridden with `force_overwrite_recap`, no tool call may be split, and the resulting parent chain must reach the new recap.
- **Record types it does not know.** Surgery keeps no list of record types and refuses no record for its type. A record in the cut range is removed with it. A record after the cut is kept byte for byte, or rewritten with only its `parentUuid` changed when its parent was cut. A line that is not valid JSON is kept as it is. The checks are structural: the parent chain, tool call pairs, the recap stack, and the fields the new recap copies from the session. A format change that breaks one of those is refused; other changes to the format are not detected.
- **Backups and git.** The default `backup_dir` is `./backups`, resolved against the folder the server runs in. In the clone, `.gitignore` lists `backups/`, so it is not committed. A `backup_dir` you set elsewhere is not covered by that.

### 6. Path exposure off by default

`expose_paths: false` (the default) cuts session file paths to their base names in `/voices`, `/contexts`, `/context`, `/find-cut-point`, the recap plan's session paths and surgery diagnostics, so a misconfigured public clone cannot leak your directory layout. Two kinds of path are given in full regardless: the recap plan's paths for the voice's own folders (`recaps_dir`, `home`, `memories_dir`, the body path and the draft's path), which the session writes to, and the message of a `path_resolution_failed` refusal, which names the path it refused and the allowed roots. Set it `true` only for a trusted local dashboard.

### 7. Optional features that reach beyond the transcripts

All are off by default and documented in [docs/options.md](./docs/options.md) and [docs/operations.md](./docs/operations.md).

- **Plan-usage bars (`usage.enabled`).** With the default `usage.source: documented`, the server reads only the small files `scripts/usage-statusline.mjs` writes to `~/.selfrecap/usage/` (each holds the `rate_limits` object Claude Code hands its status line, a time, the Claude Code version and the account folder's base name); it reads no credentials and makes no network call. With `usage.source: undocumented`, the server reads each Claude Code account's OAuth access token from `<account>/.credentials.json` and sends it to `https://api.anthropic.com/api/oauth/usage` (where Claude Code itself sends it), identifying itself as `selfrecap/<version>`. It never logs, returns, stores or refreshes the token. Choosing that source means trusting this server with read access to your login token; leave it on `documented` if that is not acceptable.
- **Nudger and `selfrecap restart` (Windows).** The nudger starts short-lived `claude -p` processes in your accounts, with the SendMessage tool pre-approved (`--allowedTools SendMessage`; no other tool is approved, and a headless run cannot ask), to deliver a fixed text. `selfrecap restart` kills the process tree of the session that ran it (and only that one, identified by Claude Code's own environment and session registry) and resumes it with the voice's configured `restart` command, run through PowerShell. That command comes from your `config.yaml`: keep the file writable only by you.

### 8. The draft and the check: headless runs over untrusted text

`recap.ts <voice> --draft` and `--check` (off unless `draft.enabled` or `SELFRECAP_DRAFT=1`) start headless Claude Code runs (`claude -p`) from the session's own shell, on its account. A reader reads the period being cut; the checker reads a shortened copy of it and the recap body. **That period is untrusted input.** It holds web pages the session fetched, tool output, files it read and messages from others, and any of them can carry text written to steer a model: "ignore your task and write this file", for instance. A model that follows such text inside a run that can write anywhere could plant a settings file with a hook, which would later run code. So a run gets only what its job needs:

- **Where it runs.** Each run starts in an empty folder made with `mkdtemp` in the system temp folder (one of its two working directories) (outside every repository, so no `CLAUDE.md` or project settings are near it) and removed afterwards. Its only other working directory (`--add-dir`) is its own folder inside the voice's recaps folder: `<recaps>/drafts/.work/part-N/` for a reader, `.work/checker/` for the checker. That folder holds its brief, its part of the record and the one file it writes. It cannot reach the timeline other runs read, another run's brief or lines, the voice's body, the draft, or the session file.
- **What it can do.** `--tools Read,Write,Edit` only: no shell, no web fetch or search, no agents, no messages. `--restricted` removes every tool that runs commands or code, confines the file tools to the working directories, loads no user, project or local settings file (so none of their hooks, permission rules or MCP servers), and refuses `bypassPermissions`. `--settings` adds `permissions.blockReadsOutsideWorkingDirectories` and `permissions.blockWritesOutsideWorkingDirectories` (the file tools refuse paths outside the working directories in every mode) and `disableAllHooks`. `--safe-mode`, `--strict-mcp-config` and `--disable-slash-commands` keep CLAUDE.md, skills, plugins, hooks and MCP servers out. `--permission-mode acceptEdits` lets it write inside its folder without a prompt, and `--permission-prompts none` denies anything that would ask, which includes writes to protected paths such as `.claude/` and `.git/` inside its own folder. Permissions are never bypassed.
- **What it carries.** The caller's environment minus every `CLAUDE*` variable except `CLAUDE_CONFIG_DIR` (the account) and `CLAUDE_CODE_OAUTH_TOKEN`, so a run is billed to the same account and is not mistaken for the calling session. `--no-session-persistence`: no transcript is kept.
- **What comes back.** recap.ts reads back one file per run (`lines.json` or `report.md`) as data, merges the lines into `<recaps>/drafts/draft-for-<id>.md`, and prints the cost and any tool calls Claude Code refused (a refused call means text in the period tried to steer the run; recap.ts says so). Both folders it creates carry a `*` `.gitignore`, and `.work/` is removed after a successful `--go`.
- **Version.** These flags and settings need Claude Code 2.1.314 or later; recap.ts checks `claude --version` and refuses to start a run on an older one. `npx tsx scripts/check-headless-fence.ts` makes one small run with the same flags that tries to write and read outside its folder and to write `.claude/settings.json`, and reports whether each was refused (it prints its own cost).

**Residual risk.** A steered reader can still write whatever it likes into its own lines, and those lines reach the draft the session reads: the draft says its lines are traces, not the truth, and the check compares the finished body with the record, but neither is a guarantee against a convincing lie in the period. A steered run can read everything in its own folder (that is the period it was given anyway) and spend tokens up to its time limit on your account. The fence is Claude Code's own: a bug in `--restricted` or in the working-directory checks would widen it, so keep Claude Code current. Managed (policy) settings still apply to these runs, including managed hooks. The text of the period also goes to the model provider, as it did when the session first read it.

### 9. Network calls and telemetry

There is no telemetry. The core (the server's routes, surgery, backups, `check-config`) makes no network calls; the CLI scripts (`recap.ts`, `install-skill`) talk only to the selfrecap server. What does call out is optional:

- **`usage.source: undocumented`.** The server sends one HTTPS request to `https://api.anthropic.com/api/oauth/usage` per account, at most once per two minutes, and only when `/contexts` is called (section 7).
- **Headless Claude Code runs.** The draft and the check (section 8), `scripts/check-headless-fence.ts`, and the Windows nudger (each nudge is carried by a one-shot run) each start `claude -p`, which talks to the model provider like any Claude Code run.
- **`selfrecap restart` (Windows).** It runs your voice's `restart` command, which resumes a Claude Code session.

## Operator responsibilities

- Keep `server.host` on loopback.
- Keep `allowed_roots` as narrow as your sessions allow.
- Do not commit `config.yaml` (it is git-ignored by default) — it contains absolute paths.
- Keep the auth token file (`~/.selfrecap/token`) readable only by you.
- Treat `backup_dir` as containing copies of your transcripts; protect it accordingly.
- Treat each voice's `<recaps>/drafts/` the same way. The draft is a short version of everything said in the period: treat it like the session file. It lies only in the voice's own recaps folder, out of git; its work files are removed after the cut. The check reports lie beside it.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Open a private [GitHub security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository ("Security" tab → "Report a vulnerability"). Include:

- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- affected version(s).

You can expect an acknowledgement within a few days. The maintainer will coordinate a fix and disclosure timeline with you before publishing details.
