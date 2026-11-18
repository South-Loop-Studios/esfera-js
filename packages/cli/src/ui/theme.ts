/**
 * The colour rules, in one place (spec §15.4 + the Figma D frames):
 *   brand ramp #f97316 → #ec4899  = the active thing only
 *   green  #22c55e                 = success only
 *   cyan   #22d3ee                 = data columns
 *   everything else white at 92 / 45 / 22 %
 * `none` returns its input untouched, so plain output is byte-stable.
 */
import type { Terminal } from "./tty.js";

export type Paint = (s: string) => string;

export interface Theme {
  colour: Terminal["colour"];
  fg: Paint;
  dim: Paint;
  faint: Paint;
  /** The orange→pink ramp across the characters of the string. */
  brand: Paint;
  /** The ramp's two ends, for family labels (eclipsa / iamf-2). */
  brandOrange: Paint;
  brandPink: Paint;
  success: Paint;
  danger: Paint;
  warning: Paint;
  data: Paint;
  bold: Paint;
  /** A full-width orange→pink bar of `width` cells (▀ truecolor, ─ otherwise). */
  rampBar: (width: number) => string;
}

const RESET = "\x1b[0m";
const ORANGE: RGB = [249, 115, 22];
const PINK: RGB = [236, 72, 153];
type RGB = [number, number, number];

const rgb = (c: RGB) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const c256 = (n: number) => `\x1b[38;5;${n}m`;
const wrap = (open: string) => (s: string) => (s ? open + s + RESET : s);
const identity: Paint = (s) => s;

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

export function makeTheme(t: Terminal): Theme {
  if (t.colour === "none") {
    return { colour: "none", fg: identity, dim: identity, faint: identity, brand: identity, brandOrange: identity, brandPink: identity, success: identity, danger: identity, warning: identity, data: identity, bold: identity, rampBar: (width) => "─".repeat(Math.max(0, width)) };
  }
  const tc = t.colour === "truecolor";
  const bold: Paint = (s) => (s ? `\x1b[1m${s}\x1b[22m` : s);
  const brand: Paint = (s) => {
    if (!s) return s;
    if (!tc) {
      // Alternate the ramp's two 256-colour ends across words.
      return s.split(" ").map((w, i) => (w ? c256(i % 2 ? 205 : 208) + w : w)).join(" ") + RESET;
    }
    const chars = [...s];
    const n = Math.max(1, chars.length - 1);
    return chars.map((ch, i) => rgb(lerp(ORANGE, PINK, i / n)) + ch).join("") + RESET;
  };
  const rampBar = (width: number): string => {
    if (width <= 0) return "";
    if (tc) {
      const n = Math.max(1, width - 1);
      let out = "";
      for (let i = 0; i < width; i++) out += rgb(lerp(ORANGE, PINK, i / n)) + "▀";
      return out + RESET;
    }
    const half = Math.ceil(width / 2);
    return c256(208) + "─".repeat(half) + c256(205) + "─".repeat(width - half) + RESET;
  };
  return {
    colour: t.colour,
    fg: wrap(tc ? rgb([235, 235, 235]) : c256(255)),
    dim: wrap(tc ? rgb([140, 140, 140]) : c256(245)),
    faint: wrap(tc ? rgb([80, 80, 84]) : c256(240)),
    brand,
    brandOrange: wrap(tc ? rgb(ORANGE) : c256(208)),
    brandPink: wrap(tc ? rgb(PINK) : c256(205)),
    success: wrap(tc ? rgb([34, 197, 94]) : c256(78)),
    danger: wrap(tc ? rgb([239, 68, 68]) : c256(203)),
    warning: wrap(tc ? rgb([245, 158, 11]) : c256(214)),
    data: wrap(tc ? rgb([34, 211, 238]) : c256(51)),
    bold,
    rampBar,
  };
}
