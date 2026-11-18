# esfera

Convert spatial audio masters to IAMF / Eclipsa from the terminal, on the Esfera Converter API.

The CLI is coming to npm (`@esfera/cli`). Until it is published, build it from this repo: `pnpm install && pnpm build`, then run `node packages/cli/dist/index.js`.

```
esfera login                       # opens your browser; the key is stored 0600 under ~/.config/esfera, never echoed
esfera presets                     # the profiles and presets the encoder accepts
esfera convert master.wav --preset esfera --profile advanced-2 -o master.iamf
esfera conversions list --status ready
esfera conversions get 3f6c1a9e-2b47-4d1e-9a0c-5e8b7d2f4a61
```

## Commands

| Command | What it does |
|---|---|
| `login` | Signs in through your browser (device flow). For CI: `--key <secret>`, piped stdin, or `$ESFERA_API_KEY`. If the host has no device flow yet, falls back to a masked paste prompt. The key is checked against the host before it is saved. `auth login` is an alias. |
| `logout` | Forgets the stored key; revokes it on the server only if browser sign-in created it. Revoke any other key in the Esfera Console. |
| `status` | Which key id and host this machine uses. `auth status` is an alias. |
| `convert <file.wav>` | Pre-flights the master locally (WAV/RF64/BW64 header, ADM or ambisonic (4/9/16 ch), under the per-file cap for your team and the key's mode), uploads it straight to storage (masters over 16 MiB upload in parallel parts), waits with live stages, downloads the IAMF. `--preset esfera\|youtube\|bed714_3oa\|oa3` (default `esfera`), `--profile <id>\|auto`, `--programme <n>` (0-based, only when the file declares several), `--normalization sn3d\|n3d\|fuma` (ambisonic sources only; fuma is first order only), `-o <out.iamf>`. Give a folder instead of a file to convert every `.wav`, `.bwf`, `.bw64` and `.rf64` master in it. |
| `conversions list` | Your conversions, newest first. `--status`, `--page`, `--page-size`. |
| `conversions get <id>` | One conversion. Ids are UUIDs. |
| `events list` / `events get <evt_id>` | Your team's events of the last 30 days. `--type`, `--since`, `--until`, `--limit`, `--starting-after`. |
| `webhooks update <id>` | Change an endpoint's `--url`, `--events` or `--description`. |
| `webhooks rotate-secret <id>` | New signing secret. Warns and asks first; `--expire-old-now`, `--yes`. |
| `usage` | What your team has used in the key's mode, and its limits. In Sandbox that is conversions today out of 25, not minutes. |
| `presets` | Profiles grouped Eclipsa / IAMF 2.0 with what the encoder will declare, and the presets with what each declares by default. |

Every command takes `--json` and then prints machine output only. `conversions list --json` prints the items array.

## Session

Run `esfera` with no arguments in a terminal to open the interactive session.

```
●  E S F E R A                                                        session
──────────────────────────────────────────────────────────────────────────────
  convert · presets · list · get <id> · help · quit

› 
──────────────────────────────────────────────────────────────────────────────
  esf_k_test_3qrMTinZjc · PRODUCTION · SANDBOX · api.esfera.audio · no jobs running · help ^C quit
```

Prompt commands: `convert · presets · list · get <id> · open · login · logout · help · quit`. `convert` walks file, preset, profile, output one step at a time. Jobs run in the background and print a `✓ …` or `✗ …` line when they finish, with a terminal bell. Turn the bell off with `--no-bell`, `ESFERA_NO_BELL=1`, or `{ "bell": false }` in `~/.config/esfera/config.json`. The last ten masters are remembered in `~/.config/esfera/recent.json`. Press `^C` twice within two seconds to quit; running jobs keep going on the server.

## Exit codes

They are the contract; half of this tool's use is inside someone else's script.

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | usage error |
| 2 | pre-flight refused the file — nothing was uploaded |
| 3 | the API refused, at any stage (a Sandbox limit, quota, a revoked key, a team not approved for the API, a profile the encoder won't write) |
| 4 | the conversion failed, stalled (no progress for 5 minutes outside `queued`), or something unexpected |
| 130 | interrupted — the job keeps running; `esfera conversions get <id>` |

## Environment

- `ESFERA_API_KEY` — overrides the stored key (CI), e.g. `ESFERA_API_KEY=esf_sk_test_v1_… esfera convert master.wav`.
- `ESFERA_NO_BELL` — set to anything non-empty to silence the session bell.
- `ESFERA_API_URL` — overrides the host, even a stored one. Without it every key goes to `https://api.esfera.audio`, which takes Sandbox keys (`esf_sk_test_…`); Live keys are coming soon. Set it only to point a command somewhere else.
- `NO_COLOR`, `TERM=dumb`, or a non-TTY stdout — plain text, no spinner. `COLORTERM=truecolor` — the full brand ramp.

Docs: https://developers.esfera.audio
