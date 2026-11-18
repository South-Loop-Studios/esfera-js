/**
 * `esfera conversions list [--status s] [--page n] [--page-size n] [--json]`
 * `esfera conversions get <id> [--json]`
 *
 * `list --json` prints the raw ITEMS array (what `jq` and a shell loop want);
 * the page envelope's counts are in the footer for a human.
 */
import type { ConversionStatus } from "@esfera/sdk";
import { CONVERSION_STATUSES } from "@esfera/sdk";
import { EXIT, CliExit, type ExitCode } from "../exit.js";
import { describeOutput, renderConversions, banner, heading, ledger, fmtBytes, fmtClock, hoursUntil, profileLabel, relTime } from "../ui/index.js";
import { openSession, parseOptions, runGuarded, type CommandDeps } from "./shared.js";

const USAGE = "usage: esfera conversions <list [--status s] [--page n] [--page-size n] | get <id>> [--json]";

export function runConversions(args: string[], deps: CommandDeps): Promise<ExitCode> {
  return runGuarded(deps, "conversions", async () => {
    const [sub, ...rest] = args;
    if (sub === "list") return list(rest, deps);
    if (sub === "get") return get(rest, deps);
    throw new CliExit(EXIT.usage, USAGE);
  });
}

function int(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new CliExit(EXIT.usage, `${name} must be a positive integer`);
  return n;
}

async function list(args: string[], deps: CommandDeps): Promise<ExitCode> {
  const { json, opts, positional } = parseOptions(args, ["--status", "--page", "--page-size"], USAGE);
  if (positional.length) throw new CliExit(EXIT.usage, USAGE);
  if (opts.status !== undefined && !(CONVERSION_STATUSES as readonly string[]).includes(opts.status)) {
    throw new CliExit(EXIT.usage, `--status must be one of: ${CONVERSION_STATUSES.join(", ")}`);
  }
  const s = openSession(deps);
  const page = await s.sdk.conversions.list({
    status: opts.status as ConversionStatus | undefined,
    page: int(opts.page, "--page"),
    pageSize: int(opts["page-size"], "--page-size"),
  });
  if (json) { deps.stdout(JSON.stringify(page.items) + "\n"); return EXIT.ok; }
  if (page.items.length === 0) {
    deps.stdout(banner(s.theme, s.width, `0 conversions`) + "\n" + heading(s.theme, s.width, "conversions") + "\n\n  " + s.theme.dim("No conversions yet — `esfera convert master.wav` makes the first.") + "\n");
    return EXIT.ok;
  }
  deps.stdout(renderConversions(s.theme, s.width, {
    env: s.env, items: page.items, total: page.total ?? page.items.length, page: page.page ?? 1, pageSize: page.pageSize ?? Math.max(1, page.items.length), now: deps.now(),
  }) + "\n");
  return EXIT.ok;
}

async function get(args: string[], deps: CommandDeps): Promise<ExitCode> {
  const { json, positional } = parseOptions(args, [], USAGE);
  const id = positional[0];
  if (!id || positional.length !== 1) throw new CliExit(EXIT.usage, USAGE);
  const s = openSession(deps);
  const c = await s.sdk.conversions.get(id);
  if (json) { deps.stdout(JSON.stringify(c) + "\n"); return EXIT.ok; }
  const now = deps.now();
  deps.stdout([
    banner(s.theme, s.width, `${s.env.label} · ${s.env.host}`),
    heading(s.theme, s.width, "conversion", c.name),
    "",
    ledger(s.theme, [
      ["id", s.theme.data(c.id)],
      ["status", (c.status === "ready" ? s.theme.success : c.status === "error" ? s.theme.danger : s.theme.brandOrange)(c.status), c.status === "ready" ? "" : `${Math.round(c.progress)}%${c.stage ? ` · ${c.stage}` : ""}`],
      ["preset", s.theme.fg(c.preset ?? "—"), c.programme !== null ? `programme ${c.programme}` : ""],
      ["profile", s.theme.brandOrange(profileLabel(c.outputProfile ?? c.profile)), c.outputProfile ? "declared" : "requested"],
      ...(c.status === "ready" && c.output ? [["holds", s.theme.fg(describeOutput(c.output))] as [string, string]] : []),
      ["loudness", s.theme.data(c.outputLoudnessLufs !== null ? `${c.outputLoudnessLufs.toFixed(1)} LUFS` : "—")],
      ["output", s.theme.fg(c.outputSizeBytes !== null ? `${fmtBytes(c.outputSizeBytes)} · ${c.outputChannels ?? "—"} ch · ${fmtClock(c.outputDurationSec)}` : "—")],
      ["created", s.theme.fg(relTime(c.createdAt, now)), c.expiresAt ? `expires in ${hoursUntil(c.expiresAt, now)}` : ""],
      ...(c.errorMessage ? [["error", s.theme.danger(c.errorMessage)] as [string, string]] : []),
    ], s.width),
  ].join("\n") + "\n");
  return EXIT.ok;
}
