/**
 * `esfera webhooks update <id> [--url u] [--events a,b] [--description text | --clear-description] [--json]`
 * `esfera webhooks rotate-secret <id> [--expire-old-now] [--yes] [--json]`
 *
 * Rotation asks first, because it changes what your receiver sees: for 24
 * hours every delivery carries two `v1=` signatures (a verifier that expects
 * one rejects them), or, with --expire-old-now, only the new secret signs from
 * that moment. Without a terminal to ask on, --yes is required.
 */
import { EVENT_TYPES, type EventType, type Webhook, type WebhookUpdate } from "@esfera/sdk";
import { EXIT, CliExit, type ExitCode } from "../exit.js";
import { banner, heading, ledger } from "../ui/index.js";
import { openSession, parseOptions, runGuarded, terminalConfirm, type CommandDeps, type Session } from "./shared.js";

const USAGE = [
  "usage: esfera webhooks update <id> [--url <https url>] [--events <type,type>] [--description <text> | --clear-description] [--json]",
  "       esfera webhooks rotate-secret <id> [--expire-old-now] [--yes] [--json]",
].join("\n");

export function runWebhooks(args: string[], deps: CommandDeps): Promise<ExitCode> {
  return runGuarded(deps, "webhooks", async () => {
    const [sub, ...rest] = args;
    if (sub === "update") return update(rest, deps);
    if (sub === "rotate-secret") return rotate(rest, deps);
    throw new CliExit(EXIT.usage, USAGE);
  });
}

/** Pull boolean flags out before parseOptions, which treats any other dash-word as unknown. */
function takeFlags(args: string[], flags: string[]): { rest: string[]; set: Set<string> } {
  const set = new Set<string>();
  const rest = args.filter((a) => (flags.includes(a) ? (set.add(a), false) : true));
  return { rest, set };
}

function endpointLedger(s: Session, w: Webhook): string {
  return ledger(s.theme, [
    ["id", s.theme.data(w.id)],
    ["url", s.theme.fg(w.url)],
    ["events", s.theme.fg(w.events.join(", "))],
    ["description", s.theme.fg(w.description ?? "—")],
    ["mode", s.theme.fg(w.mode)],
  ], s.width);
}

async function update(args: string[], deps: CommandDeps): Promise<ExitCode> {
  const { rest, set } = takeFlags(args, ["--clear-description"]);
  const { json, opts, positional } = parseOptions(rest, ["--url", "--events", "--description"], USAGE);
  const id = positional[0];
  if (!id || positional.length !== 1) throw new CliExit(EXIT.usage, USAGE);
  if (set.has("--clear-description") && opts.description !== undefined) {
    throw new CliExit(EXIT.usage, "use --description or --clear-description, not both");
  }
  const patch: WebhookUpdate = {};
  if (opts.url !== undefined) patch.url = opts.url;
  if (opts.events !== undefined) {
    const events = opts.events.split(",").map((e) => e.trim()).filter(Boolean);
    const bad = events.filter((e) => !(EVENT_TYPES as readonly string[]).includes(e));
    if (events.length === 0 || bad.length) throw new CliExit(EXIT.usage, `--events takes a comma-separated list of: ${EVENT_TYPES.join(", ")}`);
    patch.events = events as EventType[];
  }
  if (opts.description !== undefined) {
    if (opts.description.length > 200) throw new CliExit(EXIT.usage, "--description is at most 200 characters");
    patch.description = opts.description;
  }
  if (set.has("--clear-description")) patch.description = null;
  if (Object.keys(patch).length === 0) throw new CliExit(EXIT.usage, `nothing to change: give --url, --events or --description\n${USAGE}`);

  const s = openSession(deps);
  const w = await s.sdk.webhooks.update(id, patch);
  if (json) { deps.stdout(JSON.stringify(w) + "\n"); return EXIT.ok; }
  deps.stdout([banner(s.theme, s.width, `${s.env.label} · ${s.env.host}`), heading(s.theme, s.width, "webhook updated"), "", endpointLedger(s, w)].join("\n") + "\n");
  return EXIT.ok;
}

export const ROTATE_WARNING = [
  "Rotating gives this endpoint a new signing secret, shown once.",
  "For the next 24 hours every delivery is signed with both secrets: X-Esfera-Signature: t=…,v1=<new>,v1=<old>.",
  "A verifier that expects exactly one v1= part will reject those deliveries. The SDK's verifier accepts either.",
  "Deploy the new secret to your receiver within the 24 hours.",
];

export const EXPIRE_NOW_WARNING = [
  "--expire-old-now: the old secret stops signing immediately. Use this if it leaked.",
  "From now on deliveries carry one signature, made with the new secret.",
  "Your receiver rejects them until it has the new secret, and rejected deliveries are retried on the usual schedule.",
];

async function rotate(args: string[], deps: CommandDeps): Promise<ExitCode> {
  const { rest, set } = takeFlags(args, ["--expire-old-now", "--yes", "-y"]);
  const { json, positional } = parseOptions(rest, [], USAGE);
  const id = positional[0];
  if (!id || positional.length !== 1) throw new CliExit(EXIT.usage, USAGE);
  const expireOldNow = set.has("--expire-old-now");
  const s = openSession(deps);

  // The warning goes to stderr, so `--json` output stays clean.
  const warning = expireOldNow ? EXPIRE_NOW_WARNING : ROTATE_WARNING;
  // Not fitted to the width: a clipped warning is worse than a wrapped one.
  deps.stderr(warning.map((l) => `  ${s.theme.warning("!")} ${l}`).join("\n") + "\n");
  if (!set.has("--yes") && !set.has("-y")) {
    const answer = await (deps.confirm ?? terminalConfirm)(`  Rotate the secret for ${id}${expireOldNow ? " and expire the old one now" : ""}?`);
    if (answer === null) throw new CliExit(EXIT.usage, "no terminal to confirm on: pass --yes to rotate");
    if (!answer) { deps.stderr("  Not rotated.\n"); return EXIT.ok; }
  }

  const r = await s.sdk.webhooks.rotateSecret(id, expireOldNow ? { expireOldNow: true } : {});
  if (json) { deps.stdout(JSON.stringify(r) + "\n"); return EXIT.ok; }
  deps.stdout([
    banner(s.theme, s.width, `${s.env.label} · ${s.env.host}`),
    heading(s.theme, s.width, "secret rotated", expireOldNow ? "old secret expired" : "old secret signs for 24 hours"),
    "",
    endpointLedger(s, r),
    "",
    `  ${s.theme.dim("new secret")}  ${s.theme.brandOrange(r.secret)}`,
    `  ${s.theme.faint("shown once · store it now")}`,
  ].join("\n") + "\n");
  return EXIT.ok;
}
