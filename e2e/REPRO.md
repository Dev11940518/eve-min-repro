# End-to-end reproduction — through eve's own runtime + a real microVM

This directory is a standard **`eve init` scaffold** with exactly **one file added**:
`agent/sandbox.ts`. `eve init` generates `agent/agent.ts`, `agent/channels/eve.ts`,
`agent/instructions.md`, and `package.json` (with the `eve`, `ai`, `zod`, and
`@vercel/connect` dependencies and `engines.node: "24.x"`). It does **not** create
`agent/sandbox.ts` — the operator adds that, following the credential-brokering
example at <https://eve.dev/docs/sandbox#credential-brokering>. The three scaffold
files here are byte-for-byte identical to a fresh `eve init`.

eve then boots a **real** microsandbox microVM and runs the sandbox command through
its real `MicrosandboxVm.spawn` pipeline — nothing is stubbed.

**Confirmed on:** eve 0.21.1, microsandbox 0.5.5, Node 24.18, macOS 26.5.1
(Apple Silicon). Requires **Node ≥ 24** and a microsandbox host (Apple-Silicon
macOS, or glibc Linux + KVM). **No model credentials required** — the leak prints
during sandbox setup, before the model step.

## How this was created (reproduce the scaffold from scratch)

```sh
mkdir eve-poc && cd eve-poc && npm init -y
npx eve@0.21.1 init .          # generates package.json + agent/{agent.ts,channels/eve.ts,instructions.md}
cp <this-dir>/agent/sandbox.ts agent/sandbox.ts   # the ONE added file (brokering + the one-liner)
```

## Run

```sh
npm install                    # or: eve dev auto-installs on first run
npx eve dev --no-ui            # → http://127.0.0.1:2000/
curl -sS -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' -d '{"message":"hi"}'
# → watch the eve server output for the LEAK>>>...<<<LEAK line
```

## Captured output (`captured-dev.log`)

```
☰eve  v0.21.1
[DEV] server listening at http://127.0.0.1:2000/
LEAK>>>[{"domain":"github.com","headers":{"authorization":"Basic eC1hY2Nlc3MtdG9rZW46Z2hwX1MzY3IzdE9yZ1dpZGVQQVRfcmVwbGF5YWJsZV9hbnl3aGVyZQ=="},"placeholderHeaders":{"authorization":"__EVE_MSB_SECRET_6b5249479093f7976f515422__"}}]<<<LEAK
[eve:harness.tool-loop] AI Gateway authentication failed: AI Gateway received no credentials...
```

`echo <the authorization value> | base64 -d` → `x-access-token:ghp_S3cr3tOrgWidePAT_replayable_anywhere`.

## Why this is airtight

- **eve made the call, not the PoC.** `sandbox.run({ command })` is the *same*
  pipeline the built-in `bash` tool uses (`executeBashOnSandbox` → `sandbox.run`,
  `bash-tool.ts:87` → `MicrosandboxVm.spawn`). A prompt-injected model calling
  `bash` hits the identical path.
- **The secret was supplied only via the docs' `networkPolicy`** — never in `options.env`.
- **The model was never reached.** The leak prints during eve's sandbox setup; the
  subsequent "AI Gateway authentication failed" is the model step failing afterward,
  which is why no API key is needed.
- The probe here runs in `bootstrap` (fires at session start, no model). `onSession`
  — the docs' hook — uses the same brokering policy but fires lazily on the first
  sandbox tool call, i.e. once the model runs `bash`.
