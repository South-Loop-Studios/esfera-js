/** `esfera presets [--json]` — the profiles and presets this deployment's encoder accepts. */
import { EXIT, CliExit, type ExitCode } from "../exit.js";
import { renderPresets } from "../ui/index.js";
import { openSession, parseOptions, runGuarded, type CommandDeps } from "./shared.js";

const USAGE = "usage: esfera presets [--json]";

export function runPresets(args: string[], deps: CommandDeps): Promise<ExitCode> {
  return runGuarded(deps, "presets", async () => {
    const { json, positional } = parseOptions(args, [], USAGE);
    if (positional.length) throw new CliExit(EXIT.usage, USAGE);
    const s = openSession(deps);
    const presets = await s.sdk.presets.get();
    if (json) { deps.stdout(JSON.stringify(presets) + "\n"); return EXIT.ok; }
    deps.stdout(renderPresets(s.theme, s.width, { env: s.env, presets }) + "\n");
    return EXIT.ok;
  });
}
