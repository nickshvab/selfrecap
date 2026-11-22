// Preloaded into a CLI run by tests/cli.test.ts (node --import): every call
// into child_process is appended to the file named by SPAWN_LOG, one JSON
// line each, and then goes ahead as usual. A test reads the file to prove
// what a command started, or that it started nothing.
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const log = process.env.SPAWN_LOG;
if (log) {
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    const original = cp[name];
    cp[name] = function recorded(command, ...rest) {
      fs.appendFileSync(log, `${JSON.stringify({ fn: name, command: String(command) })}\n`);
      return original.call(this, command, ...rest);
    };
  }
  syncBuiltinESMExports();
}
