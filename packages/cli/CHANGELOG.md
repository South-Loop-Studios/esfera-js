# @esfera/cli

## 0.3.1 — 2026-11-18

Released from the public [esfera-js](https://github.com/orbitspatial/esfera-js) repo through npm trusted publishing. No API changes. Depends on `@esfera/sdk` 0.3.1.

## 0.3.0 — 2026-11-18

Licensed Apache-2.0 (LICENSE and NOTICE ship in the package). Includes everything listed under 0.2.0 and 0.1.0 below, which were never published.

## 0.2.0 — never published

- `esfera events list` (`--type`, `--since`, `--until`, `--limit`, `--starting-after`) and `esfera events get <evt_id>`.
- `esfera webhooks update <id>` (`--url`, `--events`, `--description`, `--clear-description`) and `esfera webhooks rotate-secret <id>` (`--expire-old-now`): prints what changes for your receiver and asks y/N; `--yes` without a terminal.
- Every API error shows its `Request-Id`.
- Interactive session: bare `esfera` on a TTY opens it. `convert` walks file, preset, profile, output; jobs run in the background and print `✓ …` / `✗ …` lines, with an optional bell (`--no-bell`, `ESFERA_NO_BELL=1`, `"bell": false` in `~/.config/esfera/config.json`). The last ten masters are kept in `~/.config/esfera/recent.json`. Prompt: `convert · presets · list · get <id> · open · login · logout · help · quit`. `^C` twice within two seconds quits; jobs keep running server-side.
- Session banner: `●`, white wordmark, full-width orange to pink bar.
- `esfera login`: browser sign-in (device flow) by default; `--key <secret>`, piped stdin or `$ESFERA_API_KEY` for CI; paste fallback when the host has no device flow yet.
- `esfera logout`: forgets the key and revokes it only when the browser sign-in minted it.
- `esfera status`; `auth login` / `auth status` remain as aliases.
- Local pre-flight shows the object count for ADM masters.
- Folder mode and the file picker take `.bw64` and leave out `.w64` (Sony Wave64, which the converter cannot read).
- Requests send `X-Esfera-Client: esfera-cli/<version>`.
- `logout` points at the Esfera Console for keys it cannot revoke.

## 0.1.0 — never published

Rebuilt on @esfera/sdk with the direction-D terminal UI: `auth login|status`, `convert` (`--preset`, `--profile`, `--programme`), `conversions list|get`, `presets`. Exit codes unchanged. npm + Homebrew.
