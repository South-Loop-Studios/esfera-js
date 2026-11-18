/** The session's command vocabulary: parsing what is typed at the prompt, and the help text. */
import { CONVERSION_STATUSES, type ConversionStatus } from "@esfera/sdk";
import { eyebrow, fit, heading, type Theme } from "../ui/index.js";

export type Command =
  | { name: "convert" }
  | { name: "presets" }
  | { name: "usage" }
  | { name: "list"; status?: ConversionStatus }
  | { name: "get"; id: string }
  | { name: "open"; id?: string }
  | { name: "login" }
  | { name: "logout" }
  | { name: "help" }
  | { name: "quit" }
  | { name: "unknown"; text: string };

/** Tab completion at the prompt. */
export const VOCABULARY = ["convert", "presets", "usage", "list", "get", "open", "login", "logout", "help", "quit"] as const;

export function parseCommand(text: string): Command {
  const trimmed = text.trim();
  const [word = "", ...args] = trimmed.split(/\s+/);
  const unknown: Command = { name: "unknown", text: trimmed };
  switch (word.toLowerCase()) {
    case "convert": return args.length === 0 ? { name: "convert" } : unknown;
    case "presets": case "usage": case "login": case "logout": case "help":
      return args.length === 0 ? { name: word.toLowerCase() as "presets" | "usage" | "login" | "logout" | "help" } : unknown;
    case "quit": case "exit": case "q":
      return args.length === 0 ? { name: "quit" } : unknown;
    case "list": {
      if (args.length === 0) return { name: "list" };
      if (args.length === 1 && (CONVERSION_STATUSES as readonly string[]).includes(args[0]!)) {
        return { name: "list", status: args[0] as ConversionStatus };
      }
      return unknown;
    }
    case "get": return args.length === 1 ? { name: "get", id: args[0]! } : unknown;
    case "open": return args.length <= 1 ? (args[0] ? { name: "open", id: args[0] } : { name: "open" }) : unknown;
    default: return unknown;
  }
}

const HELP_ROWS: [string, string][] = [
  ["convert", "pick a master, a preset and a profile, then encode it to IAMF"],
  ["presets", "the profiles and presets the encoder accepts"],
  ["usage", "how much of the plan's minutes you have used"],
  ["list [status]", "your recent conversions"],
  ["get <id>", "one conversion"],
  ["open [id]", "reveal the last finished output in the file manager"],
  ["login", "sign in again, or as someone else"],
  ["logout", "forget the stored key and leave"],
  ["help", "this list"],
  ["quit", "leave — running jobs keep running (also ^C twice)"],
];

export function renderSessionHelp(theme: Theme, width: number): string {
  const col = Math.max(...HELP_ROWS.map(([c]) => c.length)) + 2;
  return [
    heading(theme, width, "help"),
    "",
    eyebrow(theme, "commands"),
    ...HELP_ROWS.map(([c, d]) => fit(`  ${theme.fg(c.padEnd(col))}${theme.dim(d)}`, width)),
  ].join("\n");
}
