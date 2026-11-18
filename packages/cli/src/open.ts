import { spawn as nodeSpawn } from "node:child_process";
import { dirname } from "node:path";

/** Exit code; rejects when the binary is missing. */
export type Spawn = (cmd: string, args: string[]) => Promise<number>;

/** How long to wait for `open`/`xdg-open` to hand off before assuming it did. */
const HANDOFF_MS = 1500;

/**
 * The child is detached so the browser outlives us, but it is NOT unref'd while
 * we wait: an unref'd child is invisible to the event loop, and when nothing
 * else is pending (the device flow has just finished its first request) Node
 * exits with "unsettled top-level await" before `open` even returns. The helper
 * commands hand off in milliseconds; one that is still running after a moment
 * is treated as opened and let go.
 */
export const defaultSpawn: Spawn = (cmd, args) =>
  new Promise<number>((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { stdio: "ignore", detached: true });
    const settle = (fn: () => void) => { clearTimeout(timer); child.unref(); fn(); };
    const timer = setTimeout(() => settle(() => resolve(0)), HANDOFF_MS);
    child.on("error", (err) => settle(() => reject(err)));
    child.on("exit", (code) => settle(() => resolve(code ?? 1)));
  });

async function run(spawn: Spawn, cmd: string, args: string[]): Promise<boolean> {
  try {
    return (await spawn(cmd, args)) === 0;
  } catch {
    return false;
  }
}

/** Opens a URL in the default browser. Resolves false on any failure. */
export function openUrl(url: string, platform: NodeJS.Platform, spawn: Spawn = defaultSpawn): Promise<boolean> {
  if (platform === "darwin") return run(spawn, "open", [url]);
  if (platform === "win32") return run(spawn, "cmd", ["/c", "start", "", url]);
  return run(spawn, "xdg-open", [url]);
}

/** Reveals a file in Finder/Explorer/file manager. */
export function revealPath(path: string, platform: NodeJS.Platform, spawn: Spawn = defaultSpawn): Promise<boolean> {
  if (platform === "darwin") return run(spawn, "open", ["-R", path]);
  if (platform === "win32") return run(spawn, "explorer", [`/select,${path}`]);
  return run(spawn, "xdg-open", [dirname(path)]);
}
