/**
 * `esfera events list [--type t] [--since unix] [--until unix] [--limit n] [--starting-after evt_…] [--json]`
 * `esfera events get <evt_…> [--json]`
 *
 * The key's team and mode, newest first, the last 30 days. `list --json`
 * prints the `data` array; the footer gives a human the next cursor.
 */
import { EVENT_TYPES, type Event, type EventType } from "@esfera/sdk";
import { EXIT, CliExit, type ExitCode } from "../exit.js";
import { banner, heading, ledger, table, fit, relTime } from "../ui/index.js";
import { openSession, parseOptions, runGuarded, type CommandDeps } from "./shared.js";

const USAGE = "usage: esfera events <list [--type t] [--since unix] [--until unix] [--limit n] [--starting-after evt_…] | get <evt_…>> [--json]";

export function runEvents(args: string[], deps: CommandDeps): Promise<ExitCode> {
  return runGuarded(deps, "events", async () => {
    const [sub, ...rest] = args;
    if (sub === "list") return list(rest, deps);
    if (sub === "get") return get(rest, deps);
    throw new CliExit(EXIT.usage, USAGE);
  });
}

function unixArg(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{1,12}$/.test(v)) throw new CliExit(EXIT.usage, `${name} must be unix seconds`);
  return Number(v);
}

function limitArg(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new CliExit(EXIT.usage, "--limit must be an integer from 1 to 100");
  return n;
}

const iso = (e: Event) => new Date(e.created * 1000).toISOString();

async function list(args: string[], deps: CommandDeps): Promise<ExitCode> {
  const { json, opts, positional } = parseOptions(args, ["--type", "--since", "--until", "--limit", "--starting-after"], USAGE);
  if (positional.length) throw new CliExit(EXIT.usage, USAGE);
  if (opts.type !== undefined && !(EVENT_TYPES as readonly string[]).includes(opts.type)) {
    throw new CliExit(EXIT.usage, `--type must be one of: ${EVENT_TYPES.join(", ")}`);
  }
  const s = openSession(deps);
  const page = await s.sdk.events.list({
    type: opts.type as EventType | undefined,
    createdGte: unixArg(opts.since, "--since"),
    createdLt: unixArg(opts.until, "--until"),
    limit: limitArg(opts.limit),
    startingAfter: opts["starting-after"],
  });
  if (json) { deps.stdout(JSON.stringify(page.data) + "\n"); return EXIT.ok; }
  const now = deps.now();
  const head = [banner(s.theme, s.width, `${s.env.label} · ${s.env.host}`), heading(s.theme, s.width, "events", "newest first · kept 30 days"), ""];
  if (page.data.length === 0) {
    deps.stdout([...head, "  " + s.theme.dim("No events in this range.")].join("\n") + "\n");
    return EXIT.ok;
  }
  const rows = table(s.theme, {
    width: s.width,
    rows: page.data,
    columns: [
      { key: "id", paint: (t) => s.theme.data(t) },
      { key: "type", paint: (t) => s.theme.fg(t) },
      { key: (e) => e.data.object.id, paint: (t) => s.theme.dim(t) },
      { key: (e) => relTime(iso(e), now), paint: (t) => s.theme.faint(t) },
    ],
  });
  const more = page.has_more && page.next_cursor
    ? s.theme.faint(`   ·   more: --starting-after ${page.next_cursor}`)
    : s.theme.faint("   ·   end of the list");
  deps.stdout([...head, rows, "", fit(`  ${s.theme.dim(`${page.data.length} shown`)}${more}`, s.width)].join("\n") + "\n");
  return EXIT.ok;
}

async function get(args: string[], deps: CommandDeps): Promise<ExitCode> {
  const { json, positional } = parseOptions(args, [], USAGE);
  const id = positional[0];
  if (!id || positional.length !== 1) throw new CliExit(EXIT.usage, USAGE);
  const s = openSession(deps);
  const e = await s.sdk.events.get(id);
  if (json) { deps.stdout(JSON.stringify(e) + "\n"); return EXIT.ok; }
  const c = e.data.object;
  deps.stdout([
    banner(s.theme, s.width, `${s.env.label} · ${s.env.host}`),
    heading(s.theme, s.width, "event", e.type),
    "",
    ledger(s.theme, [
      ["id", s.theme.data(e.id)],
      ["type", s.theme.fg(e.type)],
      ["created", s.theme.fg(iso(e)), relTime(iso(e), deps.now())],
      ["request", s.theme.data(e.request_id ?? "—"), e.request_id ? "the API call that caused it" : "not caused by a call"],
      ["conversion", s.theme.data(c.id), c.name],
      ["status then", s.theme.fg(c.status), c.stage ?? ""],
    ], s.width),
  ].join("\n") + "\n");
  return EXIT.ok;
}
