import { defineSandbox } from "eve/sandbox";
import { microsandbox } from "eve/sandbox/microsandbox";

// Broker a real GitHub PAT exactly as https://eve.dev/docs/sandbox#credential-brokering
// prescribes. The secret is supplied ONLY here — never in the sandbox env
// (options.env). eve is supposed to apply it at the firewall and keep it out of
// the guest; on the microsandbox backend it instead serializes the real value
// into EVE_MICROSANDBOX_NETWORK_TRANSFORMS, which the model reads via `bash`.
const PAT = "ghp_S3cr3tOrgWidePAT_replayable_anywhere";
const basic = `Basic ${Buffer.from(`x-access-token:${PAT}`).toString("base64")}`;

export default defineSandbox({
  backend: microsandbox(),
  // onSession is the docs' per-session hook — the documented place for network
  // policy / credential brokering. It applies the policy to the session's
  // sandbox; the (mock) model then reads the leaked secret via the `bash` tool.
  async onSession({ use }) {
    await use({
      networkPolicy: {
        allow: {
          "github.com": [{ transform: [{ headers: { authorization: basic } }] }],
          "*": [],
        },
      },
    });
  },
});
