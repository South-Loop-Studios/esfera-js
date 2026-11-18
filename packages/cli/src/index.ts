#!/usr/bin/env node
/**
 * esfera — convert spatial audio masters to IAMF / Eclipsa from the terminal.
 * Everything testable lives in cli.ts; this file only touches the process.
 */
import { dispatch } from "./cli.js";
import { EXIT, currentJob } from "./exit.js";
import { detectTerminal } from "./ui/index.js";

const terminal = detectTerminal(process.env, process.stdout);
const args = process.argv.slice(2);
// Inside the session raw mode delivers ^C as a key; the handler is for one-shot commands only.
if (args.length > 0 && args[0] !== "session") {
  process.on("SIGINT", () => {
    const id = currentJob();
    process.stderr.write(id ? `\n  ${id} keeps running · esfera conversions get ${id}\n` : "\n");
    process.exit(EXIT.interrupted);
  });
}

const code = await dispatch(args, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  terminal,
  env: process.env,
});
process.exitCode = code;
// The session has already restored the terminal and stopped drawing. Anything it
// leaves on the event loop (a poll mid-sleep, a download being abandoned) must not
// hold the shell: exit as soon as stdout has drained.
if (args.every((a) => a === "session" || a === "--no-bell")) process.stdout.write("", () => process.exit(code));
