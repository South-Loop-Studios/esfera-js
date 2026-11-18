/** `esfera usage [--json]` — what the key's team has used in the key's mode, and its limits. */
import { EXIT, CliExit, type ExitCode } from "../exit.js";
import { renderUsage } from "../ui/index.js";
import { openSession, parseOptions, runGuarded, type CommandDeps } from "./shared.js";

const USAGE = "usage: esfera usage [--json]";

export function runUsage(args: string[], deps: CommandDeps): Promise<ExitCode> {
  return runGuarded(deps, "usage", async () => {
    const { json, positional } = parseOptions(args, [], USAGE);
    if (positional.length) throw new CliExit(EXIT.usage, USAGE);
    const s = openSession(deps);
    const usage = await s.sdk.usage.get();
    if (json) { deps.stdout(JSON.stringify(usage) + "\n"); return EXIT.ok; }
    deps.stdout(renderUsage(s.theme, s.width, { env: s.env, usage, now: deps.now() }) + "\n");
    return EXIT.ok;
  });
}
