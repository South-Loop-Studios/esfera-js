# Esfera for JavaScript

The official JavaScript SDK and command-line tool for the [Esfera Converter API](https://developers.esfera.audio), which turns spatial audio masters (ADM BWF) into IAMF / Eclipsa Audio.

| Package | What it is |
|---|---|
| [`@esfera/sdk`](packages/sdk) | Typed client for Node 20+. Create conversions, upload large masters, wait for results, verify webhooks. Server-side only: it carries your API key. |
| [`@esfera/cli`](packages/cli) | The `esfera` command. Sign in, convert a file or a folder, and check usage from the terminal. |

```sh
npm install @esfera/sdk
npm install -g @esfera/cli
# or
brew install orbitspatial/esfera/esfera
```

You need an API key from the [Esfera Console](https://console.esfera.audio). Guides, the API reference and examples are at [developers.esfera.audio](https://developers.esfera.audio).

## Working on this repo

```sh
pnpm install
pnpm check   # build, test, smoke-test on bare Node, and compare the API snapshot
```

`openapi/v1.json` is a copy of the document the API serves at `/v1/openapi.json`. The SDK's contract test checks its types against it, and `pnpm openapi:check` fails when the copy drifts from what the API actually returns.

Releases are cut from tags: `sdk-v<version>` publishes `@esfera/sdk`, then `cli-v<version>` publishes `@esfera/cli`, both with npm provenance. The [Homebrew tap](https://github.com/orbitspatial/homebrew-esfera) picks up a new CLI release by itself about a day later.

## Issues

Found a bug in the SDK or CLI? [Open an issue](https://github.com/orbitspatial/esfera-js/issues). For questions about your account or a conversion, email support@esfera.audio.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
