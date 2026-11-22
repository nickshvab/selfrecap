# Operations

Three things that run around the recap cycle: how a voice follows its session into a new file ([session continuation](#session-continuation)), the opt-in [plan-usage bars](#plan-usage-bars-opt-in), and the opt-in, Windows-only [nudger and `selfrecap restart`](#optional-windows-only-the-nudger-and-selfrecap-restart). Every optional feature, with its default, switch, cost and platform, is summarized in [options.md](./options.md).

---

## Session continuation

A voice's session file is an anchor, not a guarantee. When Claude Code continues a session, it freezes the old file, starts a new one under a new session id, and appends a `continued-in` record to the old one. Anything still reading the old file reports the context as it was at the moment of the continuation — frozen, and wrong, for as long as nobody notices. selfrecap follows that chain from the configured file to the live one for every voice lookup: readings, the recap plan and surgery alike (an explicit `file_path` is taken literally). `/voices` and `/contexts` report the hops; a chain that points at a file that no longer exists is reported as `broken_link`, and surgery refuses that frozen ancestor until `config.yaml` points at the live file.

---

## Plan-usage bars (opt-in)

With `usage.enabled: true`, `/contexts` adds `account_usage`: per Claude Code account, its plan-usage windows (a *bar* each: label, used percentage, reset time), each entry saying its `source`. There are two sources; `usage.source` picks one. `documented` (the default) reads what Claude Code hands its [status line](https://code.claude.com/docs/en/statusline) command, saved by `scripts/usage-statusline.mjs`: no credentials, no network. `undocumented` reads each account's login token and calls the endpoint Claude Code's own `/usage` screen uses, which is not a public API.

How to turn them on (the status line on Windows and elsewhere, and next to a status line you already have), an example of what comes back, who reads the numbers, and what each source reads, sends and writes: [options.md, Plan-usage bars](./options.md#plan-usage-bars).

---

## Optional, Windows-only: the nudger and `selfrecap restart`

Both are **off unless you set them up**, and both **work on Windows only**. They read Claude Code's own session registry (`<account>/sessions/<pid>.json`, the files its cross-session messaging uses) and decide whether a session is running by whether its messaging pipe (`\\.\pipe\LOCAL\cc-msg-*`) exists. On macOS and Linux Claude Code uses a Unix socket instead, so selfrecap cannot tell there whether a session is live, and neither feature starts. If you want them elsewhere, the place to adapt is `listPipes` / `pipeExists` in [`src/lib/sessions.ts`](../src/lib/sessions.ts) (check the socket path in `messagingSocketPath` instead), plus the process handling in [`src/lib/lifecycle.ts`](../src/lib/lifecycle.ts) (WMI, PowerShell, taskkill).

They need Claude Code with cross-session messaging (v2.1.224+; native Windows v2.1.234+), and each session started with a name (`claude --name <Name>`, matching the voice's `name`). The registry and the environment variables they read (`CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`) are Claude Code internals, not a documented interface: a Claude Code update can change them, and then both features see no live sessions and do nothing.

**The nudger** (`nudge.enabled: true`). Every few minutes the server reads each voice's context; a live session past `nudge.at` percent gets a message asking it to run `/remember` at its next clean seam and then restart. A session past 95% is told not to recap and to wait for you; one whose recap landed but which was never restarted is told to restart. Each message is carried by a courier: a one-shot `claude -p` on a small model (`nudge.model`, default `haiku`) in the session's own account, with the SendMessage tool pre-approved (`--allowedTools SendMessage`; no other tool is approved, and a headless run cannot ask); it carries a fixed text ([shown in options.md](./options.md#context-nudger)). Claude Code treats the nudge like any cross-session message: a session running in a different permission mode from the courier may hold it until its operator approves it (a session in bypass-permissions mode takes it at once). Each courier is an ordinary `claude -p` run, billed to that account like any other. How `claude -p` usage is billed has been subject to change; check your plan's current terms before turning the nudger on.

**`selfrecap restart`** (a voice with a `restart` command). Run by the session itself, from its own shell tool, after `--go`, or scheduled by `recap.ts <voice> --go --restart` in the same call as the surgery (one code path, `src/lib/restart.ts`). `--go --restart` checks everything first: Windows, a calling session that is this voice, a restart command that is safe and parses in PowerShell, no restart already pending. If any of it fails, nothing is cut, and it prints the plain `--go` command and how the operator restarts the session by hand. The plan's `self_restart` says ahead of time whether it is available. It does not kill a busy session: a helper in a new console waits for the session's turn to end, closes it, and resumes the same session id with the voice's `restart` command plus a resume prompt as its first prompt, so the session carries on unattended. It then checks that the session came back (right id, right name, not stuck on a dialog) and records the outcome in `logs/lifecycle.log` (`npx tsx scripts/selfrecap.ts log`) and in `/contexts` `lifecycle`. It acts only on the session that runs it, never on another. Without it, the operator restarts by hand with the command `--go` prints — that is the default ending. What appears on screen, what a failure looks like, and the lock in `logs/run/`: [options.md, Self-restart](./options.md#self-restart).

