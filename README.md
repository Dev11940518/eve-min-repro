# Minimal reproduction — eve credential brokering leaks the real secret into the microsandbox guest

**Bug:** On the **microsandbox** backend, eve's credential-brokering feature
serializes the **real** brokered secret into the environment variable
`EVE_MICROSANDBOX_NETWORK_TRANSFORMS`, which `MicrosandboxVm.spawn()` injects into
the untrusted, model-driven guest shell on every command. This inverts the
documented guarantee that *"secrets never enter the sandbox … the secret stays out
of the sandbox process entirely"* (<https://eve.dev/docs/sandbox#credential-brokering>).

A prompt-injected (or merely curious) model recovers the plaintext credential with
one line:

```sh
echo "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" | base64 -d
```

- **Affected:** `eve@0.22.0` (latest; also present in earlier releases), microsandbox backend only.
- **Root cause:** `packages/eve/src/execution/sandbox/bindings/microsandbox-network.ts:272-277`
  — `createTransformBrokerEnvironment()` serializes `rule.headers` (the **real**
  secret) instead of `rule.placeholderHeaders` (the intended mask).
- **Injection point:** `microsandbox-runtime.ts:225-227` — `MicrosandboxVm.spawn()`
  merges that env var into every guest `bash` command.

## What this repo is

A standard **`eve init` project** with two edits, so the whole demo runs offline
with **no API keys**:

- **`agent/sandbox.ts`** (added) — brokers a GitHub PAT with the exact
  `networkPolicy` shape from the docs, in the documented per-session `onSession`
  hook. The secret is supplied **only** here, never in the sandbox env.
- **`agent/agent.ts`** (replaced) — instead of a gateway model string, it uses eve's
  own **`mockModel`** (`eve/evals`) as a stand-in for a prompt-injected / malicious
  model. `defineAgent({ model })` accepts any AI SDK `LanguageModel`
  (<https://eve.dev/docs/agent-config#set-the-model>). The mock calls the built-in
  `bash` tool with `echo "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" | base64 -d`, then
  exfiltrates the recovered plaintext as its answer.

`package.json`, `agent/channels/eve.ts`, and `agent/instructions.md` are the
unmodified `eve init` scaffold; `package.json` is pinned to `eve@^0.22.0` with
`microsandbox` as a devDependency (which `eve dev` installs automatically to boot the
microVM).

Nothing is stubbed: eve boots a **real** microsandbox microVM, the **real** model→
`bash`→`MicrosandboxVm.spawn` tool path runs the command, and the mock only stands in
for the untrusted model (the side the docs define as holding no secrets).

## Run

Requires **Node ≥ 24** and a microsandbox host (Apple-Silicon macOS, or glibc Linux
+ KVM). **No model credentials required** — the offline mock model drives the whole
demo.

```sh
npm install                     # installs eve@0.22.0 into ./node_modules
npm run dev                     # eve dev --no-ui → http://127.0.0.1:2000/
# in another shell — each POST creates a session; the mock model reads + exfiltrates:
curl -sS -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' -d '{"message":"hi"}'
```

**Where to look:** the leak prints to the **`npm run dev` terminal** (eve server
stdout), *not* to the curl response — curl just returns `{"ok":true,"sessionId":…}`.
Watch that terminal for `eve: starting sandbox command: echo "$EVE_MICROSANDBOX_…`
followed by the `LEAK>>>…<<<LEAK` banner. It fires on **every** session (every POST),
so repeat the curl freely.

## Captured output (`captured-dev.log`)

```
☰eve  v0.22.0
[DEV] server listening at http://127.0.0.1:2000/
eve: opening sandbox session "root" on backend "microsandbox"...
eve: starting sandbox command: echo "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" | base64 -d
eve: sandbox command finished (exit 0): echo "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" | base64 -d
===== eve credential-brokering leak (exfiltrated by the model via bash) =====
bash stdout ($EVE_MICROSANDBOX_NETWORK_TRANSFORMS | base64 -d):
  [{"domain":"github.com","headers":{"authorization":"Basic eC1hY2Nlc3MtdG9rZW46Z2hwX1MzY3IzdE9yZ1dpZGVQQVRfcmVwbGF5YWJsZV9hbnl3aGVyZQ=="},"placeholderHeaders":{"authorization":"__EVE_MSB_SECRET_6b5249479093f7976f515422__"}}]
recovered plaintext brokered credential:
  x-access-token:ghp_S3cr3tOrgWidePAT_replayable_anywhere
=============================================================================
LEAK>>>[...]<<<LEAK
```

The `eve: starting sandbox command: …` line is eve's **own** log of the model calling
the built-in `bash` tool — the leak is driven by the model, not by PoC glue.

## Why this is airtight

- **The model made the call.** eve logs `eve: starting sandbox command: echo
  "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" …` — the mock model invoked the built-in
  `bash` tool, which runs `executeBashOnSandbox` → `sandbox.run` → `MicrosandboxVm.spawn`
  (`bash-tool.ts:87`). A real prompt-injected model calling `bash` hits the identical path.
- **The secret was supplied only via the docs' `networkPolicy`** in `onSession` — never
  in `options.env`. eve moved it into the guest env itself.
- **No credentials, no live provider.** The mock `LanguageModel` (`eve/evals`) runs
  fully offline and stands in only for the untrusted model — the side the docs define as
  holding no secrets. The demo needs nothing but the repo.
- **Fires every session.** Brokering lives in `onSession` (the docs' per-session hook),
  so each POST re-runs the read — no template-cache flakiness.

## Backend matrix

| Backend | Brokers creds? | Leaks into guest env? |
|---------|----------------|------------------------|
| **microsandbox** | yes | **YES — this bug** (`EVE_MICROSANDBOX_NETWORK_TRANSFORMS`) |
| vercel | yes (firewall via `sandbox.update`) | No — `spawn` env is only `options.env` |
| just-bash | no — `setNetworkPolicy()` **throws** | No — var is never created |
| docker | no brokering | No |

## Fix

In `createTransformBrokerEnvironment()` either **drop**
`EVE_MICROSANDBOX_NETWORK_TRANSFORMS` (nothing reads it — repo-wide it is write-only)
or serialize `rule.placeholderHeaders` instead of `rule.headers`, matching the
already-correct `GIT_CONFIG_*` half of the same function.

## Layout

```
.
├── package.json              # eve init project (eve@^0.22.0, ai, zod, @vercel/connect, microsandbox; node 24.x)
├── captured-dev.log          # captured eve dev server output showing the leak
└── agent/
    ├── sandbox.ts            # ADDED — brokers the credential (onSession, docs shape)
    ├── agent.ts              # EDITED — offline mockModel that drives bash + exfiltrates
    ├── instructions.md       # eve init scaffold (unchanged)
    └── channels/eve.ts       # eve init scaffold (unchanged)
```
