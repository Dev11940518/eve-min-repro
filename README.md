# Minimal reproduction — eve credential brokering leaks the real secret into the microsandbox guest

**Bug:** On the **microsandbox** backend, eve's credential-brokering feature
serializes the **real** brokered secret into the environment variable
`EVE_MICROSANDBOX_NETWORK_TRANSFORMS`, which `MicrosandboxVm.spawn()` injects into
the untrusted, model-driven guest shell on every command. This inverts the
documented guarantee that *"secrets never enter the sandbox … the secret stays out
of the sandbox process entirely"* (<https://eve.dev/docs/sandbox#credential-brokering>).

A prompt-injected (or merely curious) model recovers the plaintext credential with:

```sh
echo "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" | base64 -d
```

- **Affected:** `eve@0.21.1`, microsandbox backend only.
- **Root cause:** `packages/eve/src/execution/sandbox/bindings/microsandbox-network.ts:272-277`
  — `createTransformBrokerEnvironment()` serializes `rule.headers` (the **real**
  secret) instead of `rule.placeholderHeaders` (the intended mask).
- **Injection point:** `microsandbox-runtime.ts:225-227` — `MicrosandboxVm.spawn()`
  merges that env var into every guest `bash` command.

This folder contains **two** reproductions of the same defect.

---

## 1. Deterministic minimal PoC (recommended — runs anywhere, no microVM)

Exercises the **real, unmodified eve 0.21.1 source** directly. `src/microsandbox-network.ts`
is byte-for-byte identical to the eve source file (its only runtime import is
`node:crypto`; every other import is `import type` and is erased by type-stripping),
so this runs the *actual* vulnerable code — just the two functions
`MicrosandboxVm.spawn()` calls — with **no microVM, no model, and no credentials**.

```sh
npm run poc
# or directly:
node --experimental-strip-types poc.ts
```

Requires **Node ≥ 22.6** (type-stripping; no flag needed on Node ≥ 23.6). Expected
output is in [`expected-output.txt`](./expected-output.txt); the process exits `0`
when the leak is present, `1` if a fix removes it. Verbatim run:

```
Injected guest env var (EVE_MICROSANDBOX_NETWORK_TRANSFORMS):
  W3siZG9tYWluIjoiZ2l0aHViLmNvbSIsImhlYWRlcnMiOnsiYXV0aG9yaXphdGlvbiI6IkJhc2ljIGVDMWhZMk5s...

Model runs: echo "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" | base64 -d
  [{"domain":"github.com","headers":{"authorization":"Basic eC1hY2Nlc3MtdG9rZW46Z2hwX1Mz...=="},"placeholderHeaders":{"authorization":"__EVE_MSB_SECRET_6b5249479093f7976f515422__"}}]

Recovered plaintext credential:
  x-access-token:ghp_S3cr3tOrgWidePAT_replayable_anywhere

VULNERABLE: the real brokered secret is present in the guest env var.
  (the intended placeholder mask was __EVE_MSB_SECRET_6b5249479093f7976f515422__)
```

Note that `headers.authorization` carries the **real** `Basic …` value while
`placeholderHeaders.authorization` carries the mask the guest was *supposed* to
receive — the two sit side by side, proving `transformHeaderRules` was serialized by
mistake.

## 2. Full end-to-end PoC (through eve's runtime + a real microVM)

[`e2e/`](./e2e) is a standard **`eve init` scaffold with exactly one file added**
(`agent/sandbox.ts`). eve boots a real microsandbox microVM and runs the sandbox
command through its own `MicrosandboxVm.spawn` pipeline. Requires **Node ≥ 24** and
a microsandbox host (Apple-Silicon macOS, or glibc Linux + KVM). See
[`e2e/REPRO.md`](./e2e/REPRO.md) for full steps and the captured server log.

```sh
cd e2e && npm install && npx eve dev --no-ui
curl -sS -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' -d '{"message":"hi"}'
# → server log prints LEAK>>>...<<<LEAK
```

---

## Backend matrix

| Backend | Brokers creds? | Leaks into guest env? |
|---------|----------------|------------------------|
| **microsandbox** | yes | **YES — this bug** (`EVE_MICROSANDBOX_NETWORK_TRANSFORMS`) |
| vercel | yes (firewall via `sandbox.update`) | No — `spawn` env is only `options.env` |
| just-bash | no — `setNetworkPolicy()` **throws** | No — var is never created |
| docker | no brokering | No |

## Fix

In `createTransformBrokerEnvironment()` either **drop**
`EVE_MICROSANDBOX_NETWORK_TRANSFORMS` (nothing reads it — repo-wide it is
write-only) or serialize `rule.placeholderHeaders` instead of `rule.headers`,
matching the already-correct `GIT_CONFIG_*` half of the same function. After the
fix, `npm run poc` exits `1`.

## Layout

```
min_repo/
├── README.md                     # this file
├── package.json                  # `npm run poc`
├── poc.ts                        # driver: calls the real eve functions, decodes, asserts
├── expected-output.txt           # captured output of the deterministic PoC
├── src/
│   └── microsandbox-network.ts   # VERBATIM eve 0.21.1 source (the vulnerable file)
└── e2e/                          # full `eve init` project + added agent/sandbox.ts
    ├── package.json
    ├── REPRO.md
    ├── captured-dev.log
    └── agent/
        ├── sandbox.ts            # THE ONE ADDED FILE (brokering + the one-liner)
        ├── agent.ts              # eve init scaffold (unchanged)
        ├── instructions.md       # eve init scaffold (unchanged)
        └── channels/eve.ts       # eve init scaffold (unchanged)
```
