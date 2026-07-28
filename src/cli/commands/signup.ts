/**
 * `zenrows signup` — help a new user obtain credentials.
 *
 * There is no documented programmatic signup API, so we never fake account
 * creation: we explain what is needed, open the signup URL, and hand off to
 * `login`.
 */
import { saveApiKey } from "../../core/auth.ts";
import { readAccount, signupAgent, writeAccount } from "../../core/agent-account.ts";
import { attributionEnabled } from "../../core/config.ts";
import { log } from "../../core/logger.ts";
import { openUrl, SIGNUP_URL, withParams } from "../../core/open-url.ts";
import { attributionParams } from "../../core/provenance.ts";
import { parse, type Command, type RunContext } from "../command.ts";

export const signup: Command = {
  name: "signup",
  summary: "Create a ZenRows account / obtain an API key (opens the browser).",
  usage: "zenrows signup [--agent] [--no-open]",
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const { values } = parse(argv, { "no-open": { type: "boolean" }, agent: { type: "boolean" } });

    if (values.agent) {
      const account = readAccount();
      if (account) { log.info("An agent account already exists. Claim it: " + account.claimUrl); return 0; }
      const res = await signupAgent();
      saveApiKey(res.apiKey);
      writeAccount({ accountId: res.accountId, unclaimed: true, claimUrl: res.claimUrl, createdAt: new Date().toISOString() });
      log.success("Created a ZenRows Free plan account.");
      log.dim(`Claim it anytime: ${res.claimUrl}`);
      if (ctx.json) log.out(JSON.stringify({ ok: true, accountId: res.accountId, claimUrl: res.claimUrl }, null, 2));
      return 0;
    }

    log.info("To use the toolkit you need a ZenRows account and an API key.");
    log.info("1. Create a free account.");
    log.info("2. Copy your API key from the dashboard.");
    log.info("3. Run: zenrows login --api-key <your-key>");
    log.info("");
    // Attach anonymous utm attribution so the web app can attribute this signup
    // to the agent context (no separate request — it rides the URL we open).
    const signupUrl = attributionEnabled() ? withParams(SIGNUP_URL, attributionParams()) : SIGNUP_URL;
    if (!values["no-open"]) {
      log.step(`Opening ${signupUrl} …`);
      await openUrl(signupUrl);
    } else {
      log.info(`Sign up at: ${signupUrl}`);
    }
    if (ctx.json) log.out(JSON.stringify({ ok: true, signupUrl, fakeAccountCreation: false }, null, 2));
    return 0;
  },
};
