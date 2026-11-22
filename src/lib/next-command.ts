/**
 * The recap.ts command lines the CLI prints for the session to run next
 * ("Read the seam first: ...", "Then: ..."). Every one is built here, so a
 * line copied from the output runs the way the command before it ran. It
 * carries what the caller passed that the next command needs:
 *
 *   --server <url>     when it is not the default: without it the next command
 *                      goes to the default port (another server, or none)
 *   --operator <name>  on --draft, --check and --entry: the timeline and the
 *                      briefs name the operator by it, so without it the entry
 *                      or the record reads under another tag
 *   <body-file>        an explicit body file, on --check, the dry run and
 *                      --go: without it they take the plan's body path
 *
 * Nothing else: --split, --part, --reader-model, --check-model, --before,
 * --span, --json and --prepare-only shape one run, not the next.
 */

export const DEFAULT_SERVER = "http://127.0.0.1:9090";

/** What the caller passed that a printed command carries on. */
export interface Carried {
  /** The server URL in use (the default is left out). */
  server?: string;
  /** --operator, when given. */
  operator?: string;
  /** An explicit body file, when given. */
  body?: string;
}

const NEEDS_OPERATOR = new Set(["--draft", "--check", "--entry"]);

/** An argument as a shell takes it: as it is when plain, else in quotes. */
export function shellArg(a: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(a)) return a;
  // Single quotes are literal in bash and in PowerShell alike.
  if (!a.includes("'")) return `'${a}'`;
  return `"${a.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** `npx tsx scripts/recap.ts <voice> [<body-file>] <args> [--operator <name>] [--server <url>]`. */
export function recapCommand(voice: string, args: readonly string[], carried: Carried = {}): string {
  const usesBody = args.length === 0 || args.includes("--go") || args.includes("--check");
  const parts = ["npx tsx scripts/recap.ts", shellArg(voice)];
  if (carried.body && usesBody) parts.push(shellArg(carried.body));
  parts.push(...args.map(shellArg));
  if (carried.operator && args.some((a) => NEEDS_OPERATOR.has(a))) parts.push("--operator", shellArg(carried.operator));
  const server = carried.server?.replace(/\/+$/, "");
  if (server && server !== DEFAULT_SERVER) parts.push("--server", shellArg(server));
  return parts.join(" ");
}
